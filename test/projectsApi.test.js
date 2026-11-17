import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("project HTTP API preserves its contract using SQLite storage", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "planner-api-db-"));
  process.env.INDOOR_DATA_DIR = dir;
  process.env.INDOOR_LICENSE_MODE = "development";
  const { app } = await import("../server/app.js");
  const { projectStore } =
    await import("../server/repositories/projectRepository.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  const send = (url, method, body) =>
    fetch(base + url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send("", "POST", { name: "Invalid" })).status, 400);
    const plan = {
      floors: [{ id: "f" }],
      rooms: [],
      preferences: { view: "3d" },
    };
    const response = await send("", "POST", { name: " Office ", plan });
    assert.equal(response.status, 201);
    const item = await response.json();
    assert.equal(item.name, "Office");
    assert.deepEqual(item.plan, plan);
    assert.deepEqual(await (await fetch(base + "/" + item.id)).json(), item);
    const list = await (await fetch(base)).json();
    assert.equal(list[0].floorCount, 1);
    assert.equal(list[0].roomCount, 0);
    assert.equal("plan" in list[0], false);
    const saved = await (
      await send("/" + item.id, "PUT", {
        name: "Renamed",
        plan: { ...plan, rooms: [{ id: "r" }] },
      })
    ).json();
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.createdAt, item.createdAt);
    assert.equal(
      (await send("/missing", "PUT", { name: "Missing", plan })).status,
      404,
    );
    assert.equal((await send("/" + item.id, "DELETE")).status, 204);
    assert.equal((await fetch(base + "/" + item.id)).status, 404);
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    projectStore().close();
    rmSync(dir, { recursive: true, force: true });
  }
});
