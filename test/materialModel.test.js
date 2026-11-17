import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import {
  defaultLossDb,
  sanitizeOverrides,
  slabLossDb,
} from "../src/utils/materialModel.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";

// Same table as worker/tests/test_materials.py (values from the Python model).
const PARITY = [
  [5.24, 0.17, 0.2, 5180, 25.713151825],
  [2.73, 0.04, 0.1, 2437, 4.536952843],
  [6.31, 0.02, 0.01, 6175, 0.247833758],
  [3.91, 0.0238, 0.2, 5180, 5.111451889],
];

test("slab loss matches the worker's Python model", () => {
  for (const [eps, sigma, d, f, expected] of PARITY)
    assert.ok(
      Math.abs(slabLossDb(eps, sigma, d, f) - expected) < 1e-6,
      `${eps} ${f}`,
    );
});

test("default losses are sensible and ordered", () => {
  const at = (m) => defaultLossDb(m, 0.2, 5180);
  assert.ok(Math.abs(at("concrete") - 25.3) < 0.1);
  assert.ok(at("concrete") > at("drywall") && at("drywall") > at("glass"));
  assert.ok(defaultLossDb("concrete", 0.3, 5180) > at("concrete"));
});

test("manual values are validated and empty fields keep the defaults", () => {
  const { overrides, errors } = sanitizeOverrides(
    {
      concrete: { lossDb: "12", thicknessM: "" },
      glass: { lossDb: -3 },
      wood: { thicknessM: "0.05" },
      brick: { permittivity: 4, conductivity: 0.02, lossDb: 50 },
      metal: {},
    },
    0.15,
  );
  assert.deepEqual(overrides.concrete, {
    lossDb: 12,
    referenceThicknessM: 0.15,
  });
  assert.deepEqual(overrides.wood, { thicknessM: 0.05 });
  assert.deepEqual(overrides.brick, { permittivity: 4, conductivity: 0.02 });
  assert.ok(!overrides.glass && !overrides.metal);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /glass/);
});

const room = {
  id: "r",
  floorId: "level-1",
  name: "R",
  shape: "rectangle",
  x: 0,
  z: 0,
  width: 5,
  depth: 4,
  height: 3,
  material: "concrete",
};
const planWith = (extra) => ({ ...initialPlan(), rooms: [room], ...extra });

test("the export carries overrides, applies thickness to walls and changes the hash", async () => {
  const base = await buildSceneFiles(planWith({}));
  assert.equal(base.config.materialOverrides, undefined);
  const plan = planWith({
    materialOverrides: { concrete: { thicknessM: 0.1, lossDb: 8 } },
  });
  const out = await buildSceneFiles(plan);
  assert.deepEqual(out.config.materialOverrides.concrete, {
    thicknessM: 0.1,
    lossDb: 8,
    referenceThicknessM: 0.1,
  });
  const wall = out.config.meshes.find((m) => m.role === "wall");
  assert.equal(wall.thicknessM, 0.1, "wall thickness override");
  const slab = out.config.meshes.find((m) => m.role === "slab");
  assert.equal(slab.thicknessM, 0.2, "slabs keep their own thickness");
  assert.notEqual(out.config.contentSha256, base.config.contentSha256);
});

test("the wall thickness setting reaches the export and bad overrides are rejected", async () => {
  const thin = await buildSceneFiles(planWith({ wallThickness: 0.05 }));
  assert.equal(
    thin.config.meshes.find((m) => m.role === "wall").thicknessM,
    0.05,
  );
  await assert.rejects(
    buildSceneFiles(
      planWith({ materialOverrides: { concrete: { lossDb: -5 } } }),
    ),
    /loss/,
  );
});
