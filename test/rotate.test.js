import test from "node:test";
import assert from "node:assert/strict";
import { rotateBuilding, rotateRoom, rotationLosesData } from "../src/utils/rotate.js";
import { geographicToLocal, localToGeographic } from "../src/utils/geographicAlignment.js";
import { buildWalls } from "../src/utils/wallGraph.js";

const base = () => ({
  floors: [{ id: "f", name: "L1", elevation: 0 }],
  rooms: [{ id: "a", floorId: "f", name: "A", shape: "rectangle", x: 0, z: 0, width: 10, depth: 4, height: 3 }],
  doors: [{ id: "d1", floorId: "f", roomId: "a", wallSide: "north", offset: 1, width: 1, height: 2 }],
  windows: [{ id: "w1", floorId: "f", roomId: "a", wallSide: "east", offset: 0.5, width: 1, height: 1, sillHeight: 1 }],
  wallTypes: { "a:north": "glass" },
  furniture: [{ id: "f1", floorId: "f", x: 1, z: 1, width: 2, depth: 1 }],
  sources: [{ id: "s1", floorId: "f", x: 8, z: 2, azimuthDeg: 0 }],
  interiorWalls: [],
  boundaries: [],
  wallThickness: 0.2,
  alignment: { lat: 12.9, lng: 77.6, x: 0, z: 0, rotationDeg: 20, unit: "m" },
});

test("a quarter turn keeps a rectangle and carries doors, windows and materials", () => {
  const p = rotateRoom(base(), "a", 90);
  const r = p.rooms[0];
  assert.equal(r.shape, "rectangle");
  assert.deepEqual([r.width, r.depth], [4, 10]);
  assert.equal(p.doors[0].wallSide, "east");
  assert.equal(p.doors[0].offset, 1);
  assert.equal(p.windows[0].wallSide, "south");
  // the east wall ran top-to-bottom; on the south wall it runs right-to-left
  assert.equal(p.windows[0].offset, 4 - 0.5 - 1);
  assert.equal(p.wallTypes["a:east"], "glass");
  assert.equal(p.sources[0].azimuthDeg, 90);
});

test("four quarter turns return to the start", () => {
  let p = base();
  for (let i = 0; i < 4; i += 1) p = rotateRoom(p, "a", 90);
  assert.deepEqual(p.rooms[0], base().rooms[0]);
  assert.equal(p.doors[0].wallSide, "north");
  assert.equal(p.doors[0].offset, 1);
  assert.equal(p.windows[0].offset, 0.5);
});

test("a turned room still builds a valid merged wall model", () => {
  assert.equal(buildWalls(rotateRoom(base(), "a", 270), "f").length, 4);
});

test("a free angle makes a polygon and warns that doors go", () => {
  assert.equal(rotationLosesData(base(), ["a"], 30), true);
  assert.equal(rotationLosesData(base(), ["a"], 90), false);
  const p = rotateRoom(base(), "a", 30);
  assert.equal(p.rooms[0].shape, "polygon");
  assert.equal(p.doors.length, 0);
  assert.equal(p.rooms[0].polygonPoints.length, 4);
});

test("rotating the building keeps a map location on the same room spot", () => {
  const before = base();
  const spot = { x: 3, z: 1 };
  const geo = localToGeographic(spot, before.alignment);
  const after = rotateBuilding(before, 90);
  const local = geographicToLocal(geo, after.alignment);
  const c = { x: 5, z: 2 }; // building centre
  const expected = { x: c.x - (spot.z - c.z), z: c.z + (spot.x - c.x) };
  assert.ok(Math.abs(local.x - expected.x) < 1e-3, `${local.x} vs ${expected.x}`);
  assert.ok(Math.abs(local.z - expected.z) < 1e-3, `${local.z} vs ${expected.z}`);
});

test("rotating the building turns the floor image with it", () => {
  const p = { ...base(), images: { f: { widthM: 10, heightM: 4, offsetX: 0, offsetZ: 0, rotationDeg: 0 } } };
  const after = rotateBuilding(p, 90);
  // the building centre is (5, 2) and the image centre is the same point
  assert.equal(after.images.f.rotationDeg, 90);
  assert.equal(after.images.f.offsetX + 5, 5);
  assert.equal(after.images.f.offsetZ + 2, 2);
});
