import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectStore } from "../server/repositories/projectStore.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "planner-db-"));
  const options = {
    databaseFile: path.join(dir, "projects.sqlite"),
    legacyFile: path.join(dir, "projects.json"),
  };
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ...options,
    open() {
      const store = openProjectStore(options);
      handles.push(store);
      return store;
    },
    inspect() {
      const db = new DatabaseSync(options.databaseFile);
      handles.push(db);
      return db;
    },
  };
}
const project = (id = "p1") => ({
  id,
  name: "Office",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  plan: {
    floors: [{ id: "f1" }],
    rooms: [],
    images: { f1: "data:image/png;base64,AA==" },
    savedResults: {
      prediction: { jobId: "a" },
      optimization: {
        jobId: "b",
        runs: { 5: { jobId: "b" }, 2.4: { jobId: "c" } },
      },
    },
  },
});

test("legacy migration preserves complete plans and runs exactly once, even after deletion", (t) => {
  const f = fixture(t);
  const item = project();
  const original = JSON.stringify({ projects: [item] });
  writeFileSync(f.legacyFile, original);
  const store = f.open();
  assert.deepEqual(store.get(item.id), item);
  assert.equal(readFileSync(f.legacyFile, "utf8"), original);
  assert.deepEqual(store.list(), [
    {
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      floorCount: 1,
      roomCount: 0,
    },
  ]);
  const db = f.inspect();
  assert.deepEqual(
    db
      .prepare("SELECT job_id FROM simulation_runs ORDER BY job_id")
      .all()
      .map((r) => r.job_id),
    ["a", "b", "c"],
  );
  assert.equal(store.delete(item.id), true);
  assert.equal(f.open().get(item.id), null);
});

test("malformed or duplicate legacy data rolls back the entire import and can be retried", (t) => {
  const f = fixture(t);
  writeFileSync(
    f.legacyFile,
    JSON.stringify({ projects: [project(), project()] }),
  );
  assert.throws(() => f.open(), /UNIQUE/);
  const db = f.inspect();
  assert.equal(db.prepare("SELECT count(*) AS n FROM projects").get().n, 0);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM storage_metadata").get().n,
    0,
  );
  writeFileSync(f.legacyFile, "broken json");
  assert.throws(() => f.open(), SyntaxError);
  writeFileSync(f.legacyFile, JSON.stringify({ projects: [project()] }));
  assert.deepEqual(f.open().get("p1"), project());
});

test("CRUD persists across connections, updates only its project, and cascades child rows", (t) => {
  const f = fixture(t);
  const store = f.open();
  const second = f.open();
  store.create(project());
  second.create(project("p2"));
  const plan = {
    floors: [],
    rooms: [{ id: "r" }],
    savedResults: { prediction: "new-job" },
  };
  const saved = second.save("p1", {
    name: "Updated",
    plan,
    updatedAt: "2026-02-01",
  });
  assert.equal(saved.createdAt, project().createdAt);
  assert.deepEqual(store.get("p1").plan, plan);
  assert.deepEqual(store.get("p2"), project("p2"));
  assert.equal(store.list()[0].id, "p1");
  assert.equal(store.list()[0].roomCount, 1);
  assert.equal(
    store.save("missing", { name: "Missing", plan, updatedAt: "2026-02-01" }),
    null,
  );
  const db = f.inspect();
  assert.deepEqual(
    db
      .prepare("SELECT job_id FROM simulation_runs WHERE project_id = 'p1'")
      .all()
      .map((r) => r.job_id),
    ["new-job"],
  );
  assert.throws(
    () =>
      db.prepare("INSERT INTO project_plans VALUES ('missing', 1, '{}')").run(),
    /FOREIGN KEY/,
  );
  assert.equal(store.delete("p1"), true);
  assert.equal(store.delete("p1"), false);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM project_plans WHERE project_id = 'p1'",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM simulation_runs WHERE project_id = 'p1'",
      )
      .get().n,
    0,
  );
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});

test("a failed plan write rolls back metadata and saved-result references", (t) => {
  const f = fixture(t);
  const store = f.open();
  store.create(project());
  const cyclicPlan = { floors: [], rooms: [] };
  cyclicPlan.self = cyclicPlan;
  assert.throws(
    () =>
      store.save("p1", {
        name: "Broken",
        plan: cyclicPlan,
        updatedAt: "later",
      }),
    /circular/i,
  );
  assert.deepEqual(store.get("p1"), project());
  assert.equal(
    f.inspect().prepare("SELECT count(*) AS n FROM simulation_runs").get().n,
    3,
  );
});

test("newer database schemas are rejected without being modified", (t) => {
  const f = fixture(t);
  const db = f.inspect();
  db.exec("PRAGMA user_version = 99");
  assert.throws(() => f.open(), /Unsupported project database version/);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 99);
});
