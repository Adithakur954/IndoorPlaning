import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { generateCandidates } from "../src/utils/apCandidates.js";
import { inside } from "../src/utils/geometry.js";

const room = (over) => ({
  id: "r1",
  floorId: "f1",
  name: "R1",
  shape: "rectangle",
  x: 0,
  z: 0,
  width: 10,
  depth: 6,
  height: 3,
  material: "drywall",
  ...over,
});
const plan = (over = {}) => ({
  ...initialPlan(),
  floors: [{ id: "f1", name: "L1", elevation: 0 }],
  rooms: [room({})],
  ...over,
});
const dist = (p, a, b) => {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)),
  );
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
};

test("wall candidates sit inside the room, offset from the wall, at the mounting height", () => {
  const { valid } = generateCandidates(plan(), "f1", { wallHeightM: 2.5 });
  assert.ok(valid.length > 8);
  const r = room({});
  for (const c of valid) {
    assert.equal(c.kind, "wall");
    assert.equal(c.heightM, 2.5);
    assert.ok(inside(c.x, c.z, r), `${c.id} is not inside the room`);
    const wallDistance = Math.min(c.x, 10 - c.x, c.z, 6 - c.z);
    assert.ok(
      Math.abs(wallDistance - 0.15) < 0.02,
      `${c.id} is ${wallDistance} m from the wall`,
    );
  }
});

test("candidates near corners and doors are rejected with a reason", () => {
  const p = plan({
    doors: [
      {
        id: "d",
        floorId: "f1",
        roomId: "r1",
        wallSide: "north",
        offset: 4,
        width: 1,
        height: 2,
      },
    ],
  });
  const { valid, rejected, stats } = generateCandidates(p, "f1");
  assert.ok(stats.byReason.opening > 0);
  // no valid candidate within 0.5 m of the door (x 4..5 on the north wall z=0)
  for (const c of valid)
    assert.ok(
      dist({ x: c.x, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }) >= 0.5 ||
        c.z > 0.5,
      c.id,
    );
  assert.ok(rejected.every((c) => c.reasonText));
});

test("a wall lower than the mounting height rejects wall candidates", () => {
  const p = plan({ rooms: [room({ height: 2.5 })] });
  const { valid, stats } = generateCandidates(p, "f1", { wallHeightM: 2.5 });
  assert.equal(valid.length, 0);
  assert.ok(stats.byReason.lowWall > 0);
});

test("excluded rooms, non-mountable walls and furniture are rejected", () => {
  const base = generateCandidates(plan(), "f1").valid.length;
  const excluded = generateCandidates(
    plan({ rooms: [room({ apMounting: "excluded" })] }),
    "f1",
  );
  assert.equal(excluded.valid.length, 0);
  assert.ok(excluded.stats.byReason.excludedRoom > 0);
  const wall = generateCandidates(
    plan({ wallMountable: { "r1:north": false } }),
    "f1",
  );
  assert.ok(wall.valid.length < base);
  assert.ok(wall.stats.byReason.excludedWall > 0);
  const furn = generateCandidates(
    plan({
      furniture: [
        { id: "f", floorId: "f1", x: 0, z: 0, width: 10, depth: 1, height: 1 },
      ],
    }),
    "f1",
  );
  assert.ok(furn.valid.length < base);
  assert.ok(furn.stats.byReason.furniture > 0);
});

test("ceiling candidates are on a grid below the ceiling and away from walls", () => {
  const { valid } = generateCandidates(plan(), "f1", {
    mounting: ["ceiling"],
    ceilingSpacingM: 2.5,
  });
  assert.ok(valid.length >= 4);
  for (const c of valid) {
    assert.equal(c.kind, "ceiling");
    assert.equal(c.heightM, 2.95);
    assert.ok(Math.min(c.x, 10 - c.x, c.z, 6 - c.z) >= 0.5 - 1e-9);
  }
});

test("both mounting types, shared walls and boundaries: unique ids, per-room ownership", () => {
  const p = plan({
    rooms: [room({}), room({ id: "r2", name: "R2", x: 10 })],
    boundaries: [
      {
        id: "b",
        floorId: "f1",
        points: [
          { x: 0, z: 0 },
          { x: 20, z: 0 },
          { x: 20, z: 6 },
          { x: 0, z: 6 },
        ],
        height: 3,
      },
    ],
  });
  const { valid } = generateCandidates(p, "f1", {
    mounting: ["wall", "ceiling"],
  });
  assert.equal(new Set(valid.map((c) => c.id)).size, valid.length);
  assert.ok(
    valid.some((c) => c.roomId === "r1") &&
      valid.some((c) => c.roomId === "r2"),
  );
  // none inside the shared wall at x=10
  assert.ok(valid.every((c) => Math.abs(c.x - 10) > 0.1));
  // deterministic
  const again = generateCandidates(p, "f1", {
    mounting: ["wall", "ceiling"],
  }).valid;
  assert.deepEqual(
    again.map((c) => c.id),
    valid.map((c) => c.id),
  );
});

test("no candidate on a floor without rooms", () => {
  assert.equal(generateCandidates(plan({ rooms: [] }), "f1").valid.length, 0);
});

test("a very short wall (closer than the corner clearance) is rejected as a corner", () => {
  const p = plan({ rooms: [room({ width: 0.8, depth: 6 })] });
  const { stats } = generateCandidates(p, "f1");
  assert.ok(stats.byReason.corner > 0);
});

test("mounting heights follow the user's settings", () => {
  const wall = generateCandidates(plan(), "f1", { mounting: ["wall"], wallHeightM: 2.2 });
  assert.ok(wall.valid.length > 0);
  assert.ok(wall.valid.every((c) => c.heightM === 2.2));
  const ceiling = generateCandidates(plan(), "f1", { mounting: ["ceiling"], ceilingDropM: 0.4 });
  assert.ok(ceiling.valid.length > 0);
  assert.ok(ceiling.valid.every((c) => Math.abs(c.heightM - 2.6) < 1e-9));
});

test("no position in a small room standing apart from the building (an import's mark on the road)", async () => {
  const { generateCandidates, buildingScope } = await import("../src/utils/apCandidates.js");
  const plan = {
    floors: [{ id: "f", elevation: 0 }],
    rooms: [
      { id: "hall", floorId: "f", name: "Hall", shape: "rectangle", x: 10, z: 0, width: 40, depth: 20, height: 3 },
      { id: "office", floorId: "f", name: "Office", shape: "rectangle", x: 20, z: 5, width: 6, depth: 5, height: 3 },
      { id: "road", floorId: "f", name: "Room 10", shape: "rectangle", x: 0, z: 8, width: 3, depth: 2, height: 3 },
    ],
    boundaries: [], doors: [], windows: [], furniture: [], interiorWalls: [], wallTypes: {},
  };
  const scope = buildingScope(plan, "f");
  assert.deepEqual([...scope.outsideRoomIds], ["road"]);
  const { valid, rejected } = generateCandidates(plan, "f", { mounting: ["wall", "ceiling"] });
  assert.equal(valid.filter((c) => c.roomId === "road").length, 0);
  assert.ok(rejected.some((c) => c.reason === "outside" && c.roomId === "road"));
  assert.ok(valid.some((c) => c.roomId === "office"));
});
