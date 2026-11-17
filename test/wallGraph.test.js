import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { buildWalls } from "../src/utils/wallGraph.js";

const room = (id, x, z, width, depth, over = {}) => ({
  id,
  floorId: "f",
  name: id,
  shape: "rectangle",
  x,
  z,
  width,
  depth,
  height: 3,
  material: "drywall",
  ...over,
});
const plan = (rooms, over = {}) => ({ ...initialPlan(), rooms, ...over });
const total = (walls) => walls.reduce((s, w) => s + w.length, 0);

test("two rooms side by side have one shared wall, not two", () => {
  const walls = buildWalls(
    plan([room("a", 0, 0, 5, 4), room("b", 5, 0, 5, 4)]),
    "f",
  );
  // perimeter of the 10 x 4 block plus one 4 m partition
  assert.ok(Math.abs(total(walls) - (2 * (10 + 4) + 4)) < 1e-6, total(walls));
  assert.equal(walls.filter((w) => w.shared).length, 1);
  assert.equal(walls.find((w) => w.shared).length, 4);
});

test("a floating-point gap between side-by-side rooms is still one wall", () => {
  const walls = buildWalls(
    plan([room("a", 0, 0, 5.0000001, 4), room("b", 5, 0, 5, 4)]),
    "f",
  );
  assert.equal(walls.filter((w) => w.shared).length, 1);
});

test("a room inside a building shell: shared parts merge, inner walls stay", () => {
  // shell 6 x 10, room flush with its north and east walls
  const walls = buildWalls(
    plan([room("shell", 0, 0, 6, 10), room("inner", 2, 0, 4, 3)]),
    "f",
  );
  // shell perimeter 32 + the inner room's west (3) and south (4) walls
  assert.ok(Math.abs(total(walls) - (32 + 3 + 4)) < 1e-6, total(walls));
  assert.equal(
    walls.filter((w) => w.shared).reduce((s, w) => s + w.length, 0),
    4 + 3,
  );
});

test("partial overlap along a wall splits it into shared and single stretches", () => {
  const walls = buildWalls(
    plan([room("a", 0, 0, 5, 4), room("b", 5, 1, 5, 6)]),
    "f",
  );
  const shared = walls.filter((w) => w.shared);
  assert.equal(shared.length, 1);
  assert.ok(Math.abs(shared[0].length - 3) < 1e-6); // z 1..4 is common
  // the rest of room a's east wall (z 0..1) is its own wall
  assert.ok(walls.some((w) => !w.shared && Math.abs(w.length - 1) < 1e-6));
});

test("a door on a wall shared by two rooms appears once", () => {
  const p = plan([room("a", 0, 0, 5, 4), room("b", 5, 0, 5, 4)], {
    doors: [
      {
        id: "d1",
        floorId: "f",
        roomId: "a",
        wallSide: "east",
        offset: 1,
        width: 1,
        height: 2,
      },
      {
        id: "d2",
        floorId: "f",
        roomId: "b",
        wallSide: "west",
        offset: 1,
        width: 1,
        height: 2,
      },
    ],
  });
  const walls = buildWalls(p, "f");
  const doors = walls
    .flatMap((w) => w.openings)
    .filter((o) => o.kind === "door");
  assert.equal(
    doors.length,
    1,
    "the same door drawn from both rooms is one opening",
  );
  const wall = walls.find((w) => w.openings.length);
  assert.ok(
    wall.pieces.every(
      (pc) =>
        !(
          pc.from < doors[0].end &&
          pc.to > doors[0].start &&
          pc.bottom === 0 &&
          pc.top === 3
        ),
    ),
  );
});

test("a boundary wins the material and marks the wall exterior", () => {
  const p = plan([room("a", 0, 0, 6, 4)], {
    boundaries: [
      {
        id: "b",
        floorId: "f",
        height: 3,
        material: "brick",
        points: [
          { x: 0, z: 0 },
          { x: 10, z: 0 },
          { x: 10, z: 4 },
          { x: 0, z: 4 },
        ],
      },
    ],
  });
  const walls = buildWalls(p, "f");
  const north = walls.filter(
    (w) => Math.abs(w.a.z) < 1e-6 && Math.abs(w.b.z) < 1e-6,
  );
  assert.ok(north.every((w) => w.exterior && w.material === "brick"));
  assert.equal(north.length, 2); // 0..6 shared with the room, 6..10 boundary only
});

test("different materials on a shared wall are reported", () => {
  const p = plan([
    room("a", 0, 0, 5, 4, { material: "glass" }),
    room("b", 5, 0, 5, 4, { material: "brick" }),
  ]);
  const shared = buildWalls(p, "f").find((w) => w.shared);
  assert.deepEqual([...shared.materialConflict].sort(), ["brick", "glass"]);
});

test("other floors are ignored and degenerate rooms produce nothing", () => {
  assert.equal(buildWalls(plan([room("a", 0, 0, 5, 4)]), "other").length, 0);
});
