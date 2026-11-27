import test from "node:test";
import assert from "node:assert/strict";
import { roomOutlineFromWalls } from "../src/utils/wallRoom.js";

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
