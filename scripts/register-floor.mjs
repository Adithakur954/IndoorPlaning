import { existsSync, readFileSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";
import { openProjectStore } from "../server/repositories/projectStore.js";
import { registerFloorDrawing } from "../src/utils/floorRegistration.js";

const args = process.argv.slice(2);
const [databaseFile, controlFile, mode] = args;
if (args.length < 2 || args.length > 3 || (mode && mode !== "--apply")) {
  throw new Error("Usage: node scripts/register-floor.mjs <projects.sqlite> <controls.json> [--apply]");
}
if (!existsSync(databaseFile)) throw new Error(`Project database not found: ${databaseFile}`);

const { projectId, floorId, x, z, fixedIds } = JSON.parse(readFileSync(controlFile, "utf8"));
const reader = new DatabaseSync(databaseFile, { readOnly: true });
try {
  const row = reader.prepare(`
    SELECT p.name, p.updated_at AS updatedAt, d.plan_json AS planJson
    FROM projects p JOIN project_plans d ON p.id = d.project_id
    WHERE p.id = ?
  `).get(projectId);
  if (!row) throw new Error(`Project not found: ${projectId}`);
  const oldPlan = JSON.parse(row.planJson);
  const plan = registerFloorDrawing(oldPlan, floorId, { x, z, fixedIds });
  const floor = plan.floors.find((item) => item.id === floorId);
  const { offsetX, offsetZ, widthM, heightM } = plan.images[floorId];
  console.log({ project: row.name, floor: floor.name, offsetX, offsetZ, widthM, heightM });
  if (mode === "--apply") {
    const backupPath = path.join(path.dirname(databaseFile), `backup-before-floor-registration-${Date.now()}.sqlite`);
    await backup(reader, backupPath);
    console.log(`Backup: ${backupPath}`);
    const store = openProjectStore({ databaseFile });
    try {
      const saved = store.save(projectId, {
        name: row.name, plan, updatedAt: new Date().toISOString(), baseUpdatedAt: row.updatedAt,
      });
      if (!saved || saved.conflict) throw new Error("The project changed during registration. Review its current control points before retrying.");
      console.log(`Saved: ${saved.updatedAt}`);
    } finally {
      store.close();
    }
  }
} finally {
  reader.close();
}
