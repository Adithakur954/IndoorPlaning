import test from "node:test";
import assert from "node:assert/strict";
import { roomContents, shiftRoomContents } from "../src/utils/geometry.js";

const room = (id, x, z, w, d, floorId = "f") => ({ id, floorId, shape: "rectangle", x, z, width: w, depth: d });
const plan = {
  rooms: [room("a", 0, 0, 10, 10), room("inner", 2, 2, 3, 3), room("other", 20, 0, 5, 5), room("up", 0, 0, 10, 10, "g")],
  furniture: [
    { id: "in", floorId: "f", x: 1, z: 1, width: 2, depth: 1 },
    { id: "out", floorId: "f", x: 30, z: 30, width: 1, depth: 1 },
    { id: "upstairs", floorId: "g", x: 1, z: 1, width: 1, depth: 1 },
  ],
  sources: [
    { id: "ap", floorId: "f", x: 8, z: 8 },
    { id: "far", floorId: "f", x: 40, z: 8 },
  ],
  interiorWalls: [
    { id: "w1", floorId: "f", x1: 1, z1: 5, x2: 9, z2: 5 },
    { id: "w2", floorId: "f", x1: 30, z1: 5, x2: 39, z2: 5 },
  ],
};

test("finds what sits inside a room on its own floor", () => {
  const c = roomContents(plan, plan.rooms[0]);
  assert.deepEqual(c.furniture, ["in"]);
  assert.deepEqual(c.sources, ["ap"]);
  assert.deepEqual(c.walls, ["w1"]);
  assert.deepEqual(c.rooms, ["inner"]);
});

test("shifting moves the contents but not the room or other things", () => {
  const next = shiftRoomContents(plan, plan.rooms[0], 3, -1);
  assert.equal(next.furniture[0].x, 4);
  assert.equal(next.furniture[0].z, 0);
  assert.equal(next.furniture[1].x, 30);
  assert.equal(next.furniture[2].x, 1);
  assert.equal(next.sources[0].x, 11);
  assert.equal(next.sources[1].x, 40);
  assert.equal(next.interiorWalls[0].x2, 12);
  assert.equal(next.interiorWalls[1].x1, 30);
  assert.equal(next.rooms[0].x, 0);
  assert.equal(next.rooms[1].x, 5);
  assert.equal(next.rooms[2].x, 20);
});
