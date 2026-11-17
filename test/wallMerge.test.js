import test from "node:test";
import assert from "node:assert/strict";
import {
  findWallCollisions,
  mergeSharedWall,
  snapCollidingWalls,
} from "../src/utils/wallMerge.js";
import { buildWalls } from "../src/utils/wallGraph.js";

const room = (id, x, z, width, depth, extra = {}) => ({
  id, floorId: "f", name: id, shape: "rectangle", x, z, width, depth, height: 3, material: "drywall", ...extra,
});
const plan = (rooms, extra = {}) => ({
  floors: [{ id: "f" }], selectedFloorId: "f", rooms, doors: [], windows: [],
  interiorWalls: [], furniture: [], sources: [], boundaries: [], wallTypes: {}, wallThickness: 0.2, ...extra,
});

test("a wall shared by two rooms is listed and gets one material when merged", () => {
  const p = plan([
    room("a", 0, 0, 5, 4, { material: "drywall" }),
    room("b", 5, 0, 5, 4, { material: "glass" }),
  ]);
  const shared = findWallCollisions(p, "f").filter((c) => c.kind === "shared");
  assert.equal(shared.length, 1);
  assert.deepEqual([...shared[0].materials].sort(), ["drywall", "glass"]);
  const merged = mergeSharedWall(p, shared[0], "brick");
  const wall = buildWalls(merged, "f").find((w) => w.shared);
  assert.equal(wall.material, "brick");
  assert.equal(wall.materialConflict, null);
});

test("walls that are closer than a wall is thick are found and snapped into one", () => {
  const p = plan([room("big", 0, 0, 10, 6), room("small", 10.12, 1, 4, 3)]);
  const close = findWallCollisions(p, "f").filter((c) => c.kind === "close");
  assert.equal(close.length, 1);
  assert.ok(Math.abs(close[0].gap - 0.12) < 1e-6);
  const snapped = snapCollidingWalls(p, close[0]);
  const small = snapped.rooms.find((r) => r.id === "small");
  // the smaller room grew to meet the bigger one: its west wall is now at x = 10
  assert.equal(small.x, 10);
  assert.equal(small.width, 4.12);
  assert.equal(findWallCollisions(snapped, "f").filter((c) => c.kind === "close").length, 0);
  assert.equal(buildWalls(snapped, "f").filter((w) => w.shared).length, 1);
});

test("rooms that only touch, or are far apart, do not collide", () => {
  const touching = plan([room("a", 0, 0, 5, 4), room("b", 5.01, 0, 5, 4)]);
  assert.equal(findWallCollisions(touching, "f").filter((c) => c.kind === "close").length, 0);
  const apart = plan([room("a", 0, 0, 5, 4), room("b", 7, 0, 5, 4)]);
  assert.equal(findWallCollisions(apart, "f").length, 0);
});

import { setSideMaterial, sideSharedWith } from "../src/utils/wallMerge.js";

test("changing one side of a shared wall changes the whole wall", () => {
  const p = plan([room("a", 0, 0, 5, 4), room("b", 5, 0, 5, 4, { material: "glass" })]);
  assert.deepEqual(sideSharedWith(p, "b", "west"), ["a"]);
  assert.deepEqual(sideSharedWith(p, "b", "east"), []);
  // before the fix a's drywall side could still win; now both follow the edit
  const next = setSideMaterial(p, "b", "west", "concrete");
  const wall = buildWalls(next, "f").find((w) => w.shared);
  assert.equal(wall.material, "concrete");
  assert.equal(wall.materialConflict, null);
  // the other, unshared sides of b are untouched
  assert.equal(buildWalls(next, "f").filter((w) => w.material === "concrete").length, 1);
});
