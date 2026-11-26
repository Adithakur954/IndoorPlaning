import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const validPlan = (plan) =>
  Boolean(
    plan &&
    typeof plan === "object" &&
    !Array.isArray(plan) &&
    Array.isArray(plan.floors) &&
    Array.isArray(plan.rooms),
  );

// Portable schema: the future Tauri backend can open this same database.
export function openProjectStore({ databaseFile, legacyFile }) {
  mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  const transaction = (action) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    transaction(() => {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version > 1)
        throw new Error(`Unsupported project database version: ${version}`);
      if (version === 0)
        db.exec(`
        CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(trim(name)) > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          floor_count INTEGER NOT NULL CHECK(floor_count >= 0),
          room_count INTEGER NOT NULL CHECK(room_count >= 0)
        ) STRICT;
        CREATE INDEX projects_updated_at ON projects(updated_at DESC, id);
        CREATE TABLE project_plans (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version > 0),
          plan_json TEXT NOT NULL CHECK(json_valid(plan_json))
        ) STRICT;
        CREATE TABLE simulation_runs (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          slot TEXT NOT NULL,
          job_id TEXT NOT NULL,
          PRIMARY KEY(project_id, slot, job_id)
        ) STRICT;
        CREATE INDEX simulation_runs_job_id ON simulation_runs(job_id);
        PRAGMA user_version = 1;
      `);
    });

    const insertProject = db.prepare(`INSERT INTO projects
      (id, name, created_at, updated_at, floor_count, room_count) VALUES (?, ?, ?, ?, ?, ?)`);
    const putPlan =
      db.prepare(`INSERT INTO project_plans(project_id, plan_json) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET plan_json = excluded.plan_json`);
    const insertRun = db.prepare(
      "INSERT INTO simulation_runs(project_id, slot, job_id) VALUES (?, ?, ?)",
    );
    const deleteRuns = db.prepare(
      "DELETE FROM simulation_runs WHERE project_id = ?",
    );
    function writePlan(id, plan) {
      if (!validPlan(plan)) throw new Error("Invalid project plan");
      putPlan.run(id, JSON.stringify(plan));
      deleteRuns.run(id);
      for (const [slot, entry] of Object.entries(plan.savedResults || {})) {
        const ids = new Set([
          typeof entry === "string" ? entry : entry?.jobId,
          ...Object.values(entry?.runs || {}).map((run) => run?.jobId),
        ]);
        for (const jobId of ids) {
          if (typeof jobId === "string" && jobId)
            insertRun.run(id, slot, jobId);
        }
      }
    }
    function insert(item) {
      if (!validPlan(item.plan)) throw new Error("Invalid project plan");
      insertProject.run(
        item.id,
        item.name,
        item.createdAt,
        item.updatedAt,
        item.plan.floors.length,
        item.plan.rooms.length,
      );
      writePlan(item.id, item.plan);
      return item;
    }

    // Import once, all or nothing. The original JSON is deliberately untouched.
    transaction(() => {
      if (
        db
          .prepare(
            "SELECT 1 FROM storage_metadata WHERE key = 'legacy_json_import'",
          )
          .get()
      )
        return;
      let text;
      try {
        if (legacyFile) text = readFileSync(legacyFile, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (text !== undefined) {
        const legacy = JSON.parse(text);
        if (!Array.isArray(legacy.projects))
          throw new Error(
            "Invalid legacy projects file: expected projects array",
          );
        for (const item of legacy.projects) insert(item);
      }
      db.prepare(
        "INSERT INTO storage_metadata(key, value) VALUES ('legacy_json_import', ?)",
      ).run(
        JSON.stringify({
          completedAt: new Date().toISOString(),
          source: legacyFile || null,
        }),
      );
    });

    const find = db.prepare(`SELECT p.id, p.name, p.created_at AS createdAt,
      p.updated_at AS updatedAt, d.plan_json AS planJson
      FROM projects p JOIN project_plans d ON d.project_id = p.id WHERE p.id = ?`);
    // wifiCount / cellularCount: placed sources by kind, so the project list
    // can tag each project Wi-Fi, Cellular or both without loading plans.
    const list =
      db.prepare(`SELECT p.id, p.name, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.floor_count AS floorCount, p.room_count AS roomCount,
      json_extract(d.plan_json, '$.projectType') AS projectType,
      (SELECT count(*) FROM json_each(d.plan_json, '$.sources')
        WHERE json_extract(value, '$.kind') IS NOT 'cellular') AS wifiCount,
      (SELECT count(*) FROM json_each(d.plan_json, '$.sources')
        WHERE json_extract(value, '$.kind') = 'cellular') AS cellularCount
      FROM projects p JOIN project_plans d ON d.project_id = p.id
      ORDER BY p.updated_at DESC, p.id`);
    const update =
      db.prepare(`UPDATE projects SET name = ?, updated_at = ?, floor_count = ?,
      room_count = ? WHERE id = ?`);
    return {
      list: () => list.all().map((row) => ({ ...row })),
      get(id) {
        const row = find.get(id);
        if (!row) return null;
        const { planJson, ...details } = row;
        return { ...details, plan: JSON.parse(planJson) };
      },
      create: (item) => transaction(() => insert(item)),
      save(id, { name, plan, updatedAt }) {
        return transaction(() => {
          if (!validPlan(plan)) throw new Error("Invalid project plan");
          const result = update.run(
            name,
            updatedAt,
            plan.floors.length,
            plan.rooms.length,
            id,
          );
          if (!result.changes) return null;
          writePlan(id, plan);
          return this.get(id);
        });
      },
      delete: (id) =>
        transaction(() =>
          Boolean(
            db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes,
          ),
        ),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
