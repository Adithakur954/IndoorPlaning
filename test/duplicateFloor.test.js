import test from "node:test";
import assert from "node:assert/strict";
import { duplicateFloor } from "../src/utils/duplicateFloor.js";

let n = 0;
const newId = () => `new-${++n}`;
const plan = {
  floors: [{ id: "f1", name: "Floor 1", elevation: 0 }],
  rooms: [{ id: "r1", floorId: "f1", name: "Hall", x: 0, z: 0, width: 5, depth: 4 }],
  interiorWalls: [{ id: "w1", floorId: "f1", x1: 0, z1: 0, x2: 3, z2: 0 }],
  doors: [
    { id: "d1", floorId: "f1", roomId: "r1", wallSide: "north" },
    { id: "d2", floorId: "f1", wallId: "w1" },
  ],
  windows: [],
  furniture: [],
  boundaries: [],
  logs: [{ id: "l1", floorId: "f1" }],
  wallTypes: { "r1:north": "concrete" },
  images: { f1: { url: "data:x", widthM: 20, heightM: 10 } },
  sources: [
    { id: "bts", floorId: "f1", kind: "das", dasType: "source", name: "S1" },
    { id: "a1", floorId: "f1", kind: "cellular", name: "A1" },
  ],
  cellular: { cables: [{ id: "c1", from: "bts", to: "a1", points: [{ floorId: "f1", x: 1, z: 1 }] }] },
};

test("a copy of the floor with everything, linked to its own copies", () => {
  const p = duplicateFloor(plan, "f1", { id: "f2", name: "Floor 2", elevation: 3 }, newId);
  assert.deepEqual(p.floors.map((f) => [f.id, f.name, f.elevation]), [["f1", "Floor 1", 0], ["f2", "Floor 2", 3]]);
  const room = p.rooms.find((r) => r.floorId === "f2");
  const wall = p.interiorWalls.find((w) => w.floorId === "f2");
  const doors = p.doors.filter((d) => d.floorId === "f2");
  assert.equal(doors.find((d) => d.wallSide).roomId, room.id);
  assert.equal(doors.find((d) => !d.wallSide).wallId, wall.id);
  assert.equal(p.wallTypes[`${room.id}:north`], "concrete");
  const [bts, a1] = ["S1", "A1"].map((name) => p.sources.find((s) => s.floorId === "f2" && s.name === name));
  const cable = p.cellular.cables.find((c) => c.from === bts.id);
  assert.equal(cable.to, a1.id);
  assert.equal(cable.points[0].floorId, "f2");
  assert.deepEqual(p.images.f2, plan.images.f1);
  assert.equal(p.logs.length, 1, "measured logs stay on their floor");
  assert.equal(p.sources.length, 4);
  assert.equal(plan.sources.length, 2, "the original plan is not changed");
});

test("only the chosen parts are copied", () => {
  const p = duplicateFloor(plan, "f1", { id: "f3", name: "Floor 3", elevation: 6, components: false, image: false }, newId);
  assert.equal(p.rooms.length, 2);
  assert.equal(p.sources.length, 2);
  assert.equal(p.cellular.cables.length, 1);
  assert.equal(p.images.f3, undefined);
});
