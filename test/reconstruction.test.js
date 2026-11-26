import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initialPlan } from "../src/models/plan.js";
import {
  applyReconstruction,
  reconstructionToPlan,
} from "../src/utils/reconstruction.js";
import { buildWalls } from "../src/utils/wallGraph.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";

const result = JSON.parse(
  await readFile(new URL("./fixtures/floorplan-office-result.json", import.meta.url), "utf8"),
);

test("a reconstruction becomes rooms, doors and windows in metres", () => {
  const c = reconstructionToPlan(result, "level-1");
  assert.equal(c.rooms.length, 9);
  assert.ok(c.rooms.every((r) => r.shape === "rectangle"));
  assert.equal(c.doors.length, 8);
  assert.equal(c.windows.length, 8);
  // the columns: one sits under a room label that OCR erased, so 2 of 3 remain
  assert.ok(c.furniture.length >= 2 && c.furniture.every((f) => f.kind === "column"));
  const offices = c.rooms.filter((r) => /OFFICE \d/.test(r.name));
  assert.equal(offices.length, 4);
  for (const o of offices) assert.ok(Math.abs(o.width - 10) < 0.2, `${o.name} ${o.width}`);
  assert.ok(c.wallThickness >= 0.1 && c.wallThickness <= 0.2);
  assert.ok(c.rooms.every((r) => r.confidence > 0.7));
  assert.equal(c.review.rooms, 0);
});

test("without a scale nothing is converted (no invented dimensions)", () => {
  assert.throws(
    () => reconstructionToPlan({ ...result, scale: { ...result.scale, pxPerM: null } }, "level-1"),
    /scale/i,
  );
});

test("openings are real openings in the merged wall model and in the 3D export", async () => {
  const c = reconstructionToPlan(result, "level-1");
  const plan = applyReconstruction(
    { ...initialPlan(), floors: [{ id: "level-1", name: "Level 1", elevation: 0 }] },
    c,
    "level-1",
  );
  const walls = buildWalls(plan, "level-1");
  const gaps = walls.reduce((n, w) => n + w.openings.length, 0);
  assert.equal(gaps, 16); // 8 doors + 8 windows, none dropped or doubled
  const files = await buildSceneFiles(plan, {});
  assert.equal(files.config.stats.openings >= 16, true);
});

test("a polygon room keeps its openings on the right edge", () => {
  const L = {
    ...result,
    rooms: [
      {
        id: "r0", label: "L ROOM", confidence: 0.9, notes: [],
        polygonM: [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]],
      },
    ],
    openings: [
      { id: "o0", kind: "door", startM: [3.5, 3], endM: [4.5, 3], widthM: 1, confidence: 0.9 },
    ],
    walls: [],
    columns: [],
  };
  const c = reconstructionToPlan(L, "f");
  assert.equal(c.rooms[0].shape, "polygon");
  assert.equal(c.doors.length, 1);
  // edge 2 runs (6,3) -> (3,3); the door starts 1.5 m after (6,3)... measured
  // from the vertex the edge starts at
  assert.equal(c.doors[0].edgeIndex, 2);
  const plan = applyReconstruction({ ...initialPlan(), floors: [{ id: "f", name: "F", elevation: 0 }] }, c, "f");
  const wall = buildWalls(plan, "f").find((w) => w.openings.length);
  assert.ok(wall, "the door cuts a gap in the wall");
  assert.ok(Math.abs(wall.openings[0].end - wall.openings[0].start - 1) < 1e-6);
});

test("applying replaces only the chosen floor", () => {
  const base = {
    ...initialPlan(),
    rooms: [{ id: "keep", floorId: "level-2" }, { id: "gone", floorId: "level-1" }],
    wallTypes: { "gone:north": "glass", "keep:north": "wood" },
  };
  const c = reconstructionToPlan(result, "level-1");
  const next = applyReconstruction(base, c, "level-1", { replace: true });
  assert.ok(next.rooms.some((r) => r.id === "keep"));
  assert.ok(!next.rooms.some((r) => r.id === "gone"));
  assert.deepEqual(next.wallTypes, { "keep:north": "wood" });
});

test("an open plan with only small closed rooms gets one room for the whole floor", () => {
  const wall = (a, b) => ({ aM: a, bM: b, role: "exterior", confidence: 0.9, thicknessM: 0.2 });
  const open = {
    scale: { pxPerM: 40, widthM: 30, heightM: 20 },
    walls: [wall([1, 1], [29, 1]), wall([29, 1], [29, 19]), wall([29, 19], [1, 19]), wall([1, 19], [1, 1])],
    rooms: [
      { id: "r0", polygonM: [[2, 2], [5, 2], [5, 5], [2, 5]], label: "Lift", confidence: 0.9, notes: [] },
    ],
    openings: [],
    columns: [],
    markers: [],
    warnings: [],
  };
  const converted = reconstructionToPlan(open, "level-1");
  const floor = converted.rooms.find((r) => r.name === "Floor");
  assert.ok(floor, "the whole floor is a room");
  assert.deepEqual([floor.x, floor.z, floor.width, floor.depth], [1, 1, 28, 18]);
  assert.ok(converted.rooms.some((r) => r.name === "Lift"), "the enclosure is kept inside it");
  // a plan whose rooms already fill the walls gets no extra room
  const full = { ...open, rooms: [{ id: "r1", polygonM: [[1, 1], [29, 1], [29, 19], [1, 19]], label: "Hall", confidence: 0.9, notes: [] }] };
  assert.equal(reconstructionToPlan(full, "level-1").rooms.some((r) => r.name === "Floor"), false);
});

test("every wall the detection shows reaches the editor, even with no closed room", () => {
  // a drawing whose walls never closed into a room: before, all of them were dropped
  const free = (a, b, extra = {}) => ({ aM: a, bM: b, role: "free", anchored: false, confidence: 0.8, thicknessM: 0.2, notes: [], ...extra });
  const open = {
    scale: { pxPerM: 20, widthM: 60, heightM: 40 },
    walls: [
      free([0, 0], [20, 0]), free([20, 0.4], [20, 12]), free([0, 12], [19.5, 12]),
      free([5, 5], [5.3, 5]),                       // a 0.3 m mark: not a wall
      free([8, 8], [9, 8]),                         // 1 m, joined to nothing: a symbol
      free([2, 3], [2, 9], { confidence: 0.2 }),    // too faint to be a wall
    ],
    rooms: [], openings: [], columns: [], markers: [], warnings: [],
  };
  const c = reconstructionToPlan(open, "f");
  assert.equal(c.interiorWalls.length, 3);
  assert.ok(c.interiorWalls.every((w) => w.needsReview), "loose walls are marked for review, not dropped");
  assert.ok(c.warnings.some((w) => /3 tiny or very faint/.test(w)));
});

test("the whole floor follows the building's walls, not the title block or the legends", () => {
  const wall = (a, b) => ({ aM: a, bM: b, role: "free", anchored: true, confidence: 0.9, thicknessM: 0.2 });
  const box = (x0, z0, x1, z1) => [wall([x0, z0], [x1, z0]), wall([x1, z0], [x1, z1]), wall([x1, z1], [x0, z1]), wall([x0, z1], [x0, z0])];
  const sheet = {
    scale: { pxPerM: 7, widthM: 230, heightM: 150 },
    walls: [
      ...box(20, 30, 200, 110),                     // the building
      wall([60, 30], [60, 110]), wall([120, 30], [120, 110]),
      ...box(90, 0, 150, 10),                       // "Ground Floor" title block
      ...box(150, 120, 225, 148),                   // the legends
    ],
    rooms: [], openings: [], columns: [], markers: [], warnings: [],
  };
  const floor = reconstructionToPlan(sheet, "f").rooms.find((r) => r.name === "Floor");
  assert.deepEqual([floor.x, floor.z, floor.width, floor.depth], [20, 30, 180, 80]);
});

test("a drawn line on a coarse picture does not become a thick wall: the material's typical thickness is used", () => {
  // 1 px = 0.16 m: a drawn line says nothing about the real wall
  const coarse = { ...result, scale: { ...result.scale, pxPerM: 6.2 }, walls: result.walls.map((w) => ({ ...w, thicknessM: 0.66 })) };
  const c = reconstructionToPlan(coarse, "level-1");
  assert.equal(c.wallThickness, 0.12);
  assert.match(c.thicknessNote, /typical value for drywall/);
});

test("a fine picture gives the measured wall thickness", () => {
  // 1 px = 1 cm: the drawn width is the wall's width
  const fine = { ...result, scale: { ...result.scale, pxPerM: 100 }, walls: result.walls.map((w) => ({ ...w, thicknessM: 0.24 })) };
  const c = reconstructionToPlan(fine, "level-1");
  assert.equal(c.wallThickness, 0.24);
  assert.match(c.thicknessNote, /measured on the drawing/);
});

test("walls drawn in a legend colour take that material and its thickness", () => {
  const withLegend = {
    ...result,
    scale: { ...result.scale, pxPerM: 6.2 },
    walls: result.walls.map((w) => ({ ...w, material: "concrete", materialLabel: "Concrete [Heavy]" })),
  };
  const c = reconstructionToPlan(withLegend, "level-1");
  assert.deepEqual(c.materialThickness, { concrete: 0.3 });
  const plan = applyReconstruction({ ...initialPlan(), materialOverrides: {} }, c, "level-1");
  assert.equal(plan.materialOverrides.concrete.thicknessM, 0.3);
  // a thickness you set yourself is kept
  const mine = applyReconstruction({ ...initialPlan(), materialOverrides: { concrete: { thicknessM: 0.45 } } }, c, "level-1");
  assert.equal(mine.materialOverrides.concrete.thicknessM, 0.45);
});

test("furniture found by the model becomes sized boxes with default heights", () => {
  const withFurniture = {
    ...result,
    furniture: [
      { kind: "desk", xM: 5, yM: 4, widthM: 1.2, depthM: 0.8 },
      { kind: "chair", xM: 5, yM: 5, widthM: 0.45, depthM: 0.4 },
      { kind: "chair", xM: 6, yM: 5, widthM: 0.45, depthM: 0.4 },
      { kind: "plant", left: 1, top: 1, widthPx: 5, depthPx: 5 }, // no scale -> skipped
    ],
  };
  const c = reconstructionToPlan(withFurniture, "level-1");
  const desk = c.furniture.find((f) => f.kind === "desk");
  assert.deepEqual([desk.x, desk.z, desk.width, desk.depth, desk.height], [4.4, 3.6, 1.2, 0.8, 0.75]);
  assert.deepEqual(c.furnitureCounts, { desk: 1, chair: 2 });
  assert.deepEqual(c.furniture.filter((f) => f.kind === "chair").map((f) => f.name), ["Chair 1", "Chair 2"]);
});
