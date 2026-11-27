import test from "node:test";
import assert from "node:assert/strict";
import { distanceAlongWall, openingsAfterBreak, openingsOntoRoom, openingsOntoWalls, roomOutlineFromWalls, splitWall, wallsFromRoom } from "../src/utils/wallRoom.js";

const W = (id, x1, z1, x2, z2) => ({ id, x1, z1, x2, z2 });
const area = (pts) =>
  Math.abs(pts.reduce((s, p, i) => s + p.x * pts[(i + 1) % pts.length].z - pts[(i + 1) % pts.length].x * p.z, 0)) / 2;

test("four walls drawn in any direction make a closed 6 x 4 room", () => {
  const walls = [W("a", 0, 0, 6, 0), W("b", 6, 4, 6, 0), W("c", 6, 4, 0, 4), W("d", 0, 0, 0, 4)];
  for (const start of ["a", "b", "c", "d"]) {
    const r = roomOutlineFromWalls(walls, start);
    assert.equal(r.closed, true);
    assert.equal(r.points.length, 4);
    assert.equal(area(r.points), 24);
    assert.deepEqual(r.wallIds.sort(), ["a", "b", "c", "d"]);
  }
});

test("three sides of a box are closed with a straight side, from any wall", () => {
  const walls = [W("a", 0, 0, 0, 4), W("b", 0, 4, 5, 4), W("c", 5, 4, 5, 0)];
  for (const start of ["a", "b", "c"]) {
    const r = roomOutlineFromWalls(walls, start);
    assert.equal(r.closed, false);
    assert.equal(area(r.points), 20);
  }
});

test("a triangle of three walls and an L of six walls", () => {
  const tri = [W("a", 0, 0, 4, 0), W("b", 4, 0, 0, 3), W("c", 0, 3, 0, 0)];
  assert.equal(area(roomOutlineFromWalls(tri, "b").points), 6);
  const L = [W("1", 0, 0, 4, 0), W("2", 4, 0, 4, 2), W("3", 4, 2, 2, 2), W("4", 2, 2, 2, 4), W("5", 2, 4, 0, 4), W("6", 0, 4, 0, 0)];
  const r = roomOutlineFromWalls(L, "3");
  assert.equal(r.points.length, 6);
  assert.equal(area(r.points), 12);
});

test("ends that almost meet still join; a wall split in two is one side", () => {
  const walls = [W("a", 0, 0, 3, 0), W("a2", 3.1, 0, 6, 0), W("b", 6, 0.1, 6, 4), W("c", 6, 4, 0, 4), W("d", 0, 4, 0, 0)];
  const r = roomOutlineFromWalls(walls, "c", 0.3);
  assert.equal(r.closed, true);
  assert.equal(r.wallIds.length, 5);
  assert.ok(Math.abs(area(r.points) - 24) < 0.5);
});

test("a single wall or a straight line of walls is refused with a reason", () => {
  assert.match(roomOutlineFromWalls([W("a", 0, 0, 5, 0)], "a").error, /not joined/);
  assert.match(roomOutlineFromWalls([W("a", 0, 0, 5, 0), W("b", 5, 0, 9, 0)], "a").error, /do not enclose/);
});

test("a wall breaks into two pieces that meet at the chosen point", () => {
  const w = { id: "a", x1: 0, z1: 0, x2: 6, z2: 8, material: "brick", name: "Wall" };
  const [p, q] = splitWall(w, 4, "b");
  assert.deepEqual([p.id, q.id], ["a", "b"]);
  const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9));
  close([p.x2, p.z2], [2.4, 3.2]);
  close([q.x1, q.z1, q.x2, q.z2], [2.4, 3.2, 6, 8]);
  assert.equal(q.material, "brick");
  assert.equal(q.name, "Wall");
  assert.match(splitWall(w, 0, "b").error, /inside/);
  assert.match(splitWall(w, 10, "b").error, /inside/);
  assert.match(splitWall({ id: "s", x1: 0, z1: 0, x2: 0.05, z2: 0 }, 0.02, "b").error, /too short/);
});

test("a rectangle room becomes four walls with their side materials", () => {
  let n = 0;
  const room = { id: "r", floorId: "f", name: "Office", x: 0, z: 0, width: 6, depth: 4, height: 3, material: "drywall" };
  const walls = wallsFromRoom(room, { "r:east": "glass" }, () => `w${++n}`);
  assert.equal(walls.length, 4);
  assert.deepEqual(walls.map((w) => w.material), ["drywall", "glass", "drywall", "drywall"]);
  assert.equal(walls.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.z2 - w.z1), 0), 20);
  assert.equal(walls[0].height, 3);
  assert.equal(walls[0].floorId, "f");
  // and back to the same room
  assert.equal(area(roomOutlineFromWalls(walls, "w2").points), 24);
});

test("a polygon room gives one wall per side; a round room is refused", () => {
  const tri = { id: "t", shape: "polygon", polygonPoints: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 3 }] };
  assert.equal(wallsFromRoom(tri, {}, () => "x").length, 3);
  assert.match(wallsFromRoom({ shape: "circle" }, {}, () => "x").error, /round/);
});

test("the split point is the nearest point on the wall, kept on the wall", () => {
  const w = { x1: 0, z1: 0, x2: 10, z2: 0 };
  assert.equal(distanceAlongWall(w, { x: 3, z: 2 }), 3);
  assert.equal(distanceAlongWall(w, { x: -5, z: 0 }), 0);
  assert.equal(distanceAlongWall(w, { x: 15, z: 1 }), 10);
});

test("doors and windows stay where they are when a room becomes walls and back", () => {
  let n = 0;
  const room = { id: "r", floorId: "f", name: "Office", x: 0, z: 0, width: 6, depth: 4, height: 3 };
  const items = [
    { id: "d1", roomId: "r", wallSide: "south", offset: 1, width: 0.9 }, // 1 m from the left on the bottom side
    { id: "w1", roomId: "r", wallSide: "east", offset: 0.5, width: 1.2 },
    { id: "other", roomId: "x", wallSide: "north", offset: 0, width: 1 },
  ];
  const walls = wallsFromRoom(room, {}, () => `w${++n}`);
  const moved = openingsOntoWalls(room, walls, items);
  const south = walls.find((w) => w.name.includes("south")); // runs from x 6 to x 0
  assert.equal(moved[0].wallId, south.id);
  assert.ok(Math.abs(moved[0].offset - 4.1) < 1e-9);
  assert.equal(moved[0].roomId, undefined);
  assert.equal(moved[2], items[2]);
  const back = openingsOntoRoom(room, walls, moved);
  assert.equal(back[0].wallSide, "south");
  assert.ok(Math.abs(back[0].offset - 1) < 1e-9);
  assert.equal(back[1].wallSide, "east");
  assert.ok(Math.abs(back[1].offset - 0.5) < 1e-9);
  assert.equal(back[0].wallId, undefined);
});

test("breaking a wall moves the openings past the cut and refuses a cut through one", () => {
  const items = [
    { id: "a", wallId: "w", offset: 1, width: 1 },
    { id: "b", wallId: "w", offset: 5, width: 1 },
    { id: "c", wallId: "z", offset: 5, width: 1 },
  ];
  const r = openingsAfterBreak(items, "w", "w2", 3);
  assert.deepEqual(r.items.map((o) => [o.wallId, o.offset]), [["w", 1], ["w2", 2], ["z", 5]]);
  assert.match(openingsAfterBreak(items, "w", "w2", 1.5).error, /inside a door/);
});

test("a loose wall is cut around its own door, and the checks accept it", async () => {
  const { looseWallPieces } = await import("../src/utils/wallPieces.js");
  const { validateBuilding } = await import("../src/utils/buildingValidation.js");
  const wall = { id: "w", floorId: "f", x1: 0, z1: 0, x2: 6, z2: 0, height: 3 };
  const door = { id: "d", floorId: "f", wallId: "w", offset: 2, width: 1, height: 2.1 };
  const { pieces, openings } = looseWallPieces(wall, [door], []);
  assert.equal(openings.length, 1);
  assert.deepEqual([openings[0].start, openings[0].end], [2, 3]);
  assert.ok(pieces.some((p) => p.from === 0 && p.to === 2));
  assert.ok(pieces.some((p) => p.from === 3 && p.to === 6));
  assert.ok(pieces.some((p) => p.from === 2 && p.bottom === 2.1)); // above the door
  const plan = { rooms: [], doors: [door], windows: [], interiorWalls: [wall], boundaries: [] };
  const ok = validateBuilding(plan, "f");
  assert.ok(!ok.errors.some((e) => /door/.test(e)), ok.errors.join("; "));
  const bad = validateBuilding({ ...plan, doors: [{ ...door, offset: 5.5 }] }, "f");
  assert.ok(bad.errors.some((e) => /runs past/.test(e)));
});

test("two walls in one line merge into one, keeping their doors in place", async () => {
  const { mergeableWalls, mergeTwoWalls } = await import("../src/utils/wallRoom.js");
  const a = { id: "a", floorId: "f", x1: 0, z1: 0, x2: 3, z2: 0, material: "brick" };
  const b = { id: "b", floorId: "f", x1: 6, z1: 0.05, x2: 3.1, z2: 0, material: "drywall" }; // drawn the other way, a small gap
  const side = { id: "c", floorId: "f", x1: 3, z1: 0, x2: 3, z2: 4 }; // a corner, not a continuation
  const far = { id: "d", floorId: "f", x1: 8, z1: 0, x2: 10, z2: 0 }; // same line, 2 m away
  assert.deepEqual(mergeableWalls([a, b, side, far], "a").map((w) => w.id), ["b"]);
  const door = { id: "door", wallId: "b", offset: 1, width: 1 }; // 1 m from b's first end (x 6): x 5 .. 4
  const { wall, items } = mergeTwoWalls(a, b, [door]);
  assert.equal(wall.id, "a");
  assert.equal(wall.material, "brick");
  assert.deepEqual([wall.x1, wall.x2], [0, 6]);
  assert.equal(items[0].wallId, "a");
  assert.ok(Math.abs(items[0].offset - 4) < 0.01);
});
