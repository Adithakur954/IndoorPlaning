import test from "node:test";
import assert from "node:assert/strict";
import { suggestRacks } from "../src/infra/wifi/racks.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";

const ap = (id, x, z, floorId = "f1") => ({
  id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5,
});
const room = (id, name, x, z, width, depth, floorId = "f1") => ({
  id, floorId, name, shape: "rectangle", x, z, width, depth, height: 3,
});
const plan = (rooms, sources) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms, doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});

// 2 x 2 rooms of 8 x 6 m
const four = (names, sources) =>
  plan(
    [
      room("r1", names[0], 0, 0, 8, 6),
      room("r2", names[1], 8, 0, 8, 6),
      room("r3", names[2], 0, 6, 8, 6),
      room("r4", names[3], 8, 6, 8, 6),
    ],
    sources,
  );
const one = [ap("a", 4, 3), ap("b", 12, 3), ap("c", 4, 9), ap("d", 12, 9)];

test("a compact floor gets one suggested rack that reaches every AP", () => {
  const result = suggestRacks({ plan: four(["A", "B", "C", "D"], one) });
  assert.equal(result.racks.length, 1);
  assert.equal(result.racks[0].covers, 4);
  assert.equal(result.racks[0].suggested, true);
  assert.deepEqual(result.uncovered, []);
  assert.ok(result.notes.some((n) => /Confirm each rack/.test(n)));
});

test("rooms such as bathrooms are never suggested, even when they are best placed", () => {
  const sources = [ap("a", 4, 3)];
  const result = suggestRacks({ plan: four(["Bath", "B", "C", "D"], sources) });
  assert.ok(result.racks.length >= 1);
  assert.ok(result.racks.every((r) => r.roomName !== "Bath"));
});

test("a room that suits a rack (for example a server room) is preferred", () => {
  const result = suggestRacks({ plan: four(["A", "B", "Server room", "D"], one) });
  assert.equal(result.racks[0].roomName, "Server room");
});

test("a very long floor needs more than one rack, and every AP ends up covered", () => {
  const long = plan(
    [room("L", "Long hall", 0, 0, 200, 6)],
    [ap("west", 5.25, 3), ap("mid", 100.25, 3), ap("east", 195.25, 3)],
  );
  const result = suggestRacks({ plan: long });
  assert.ok(result.racks.length >= 2);
  assert.deepEqual(result.uncovered, []);
  assert.ok(result.notes.some((n) => /racks are suggested/.test(n)));
  // the suggestion produces a design with no length errors
  const design = designWifiCabling({ plan: long, racks: result.racks });
  assert.deepEqual(design.violations.filter((v) => v.severity === "error"), []);
  assert.equal(design.runs.length, 3);
});

test("APs that no rack can reach are reported, not hidden", () => {
  const long = plan(
    [room("L", "Long hall", 0, 0, 200, 6)],
    [ap("west", 5.25, 3), ap("east", 195.25, 3)],
  );
  const result = suggestRacks({ plan: long, maxRacksPerFloor: 1 });
  assert.equal(result.racks.length, 1);
  assert.equal(result.uncovered.length, 1);
  assert.ok(result.notes.some((n) => /cannot be reached/.test(n)));
});

test("floors without APs get no rack, and the suggestion is repeatable", () => {
  const input = { plan: four(["A", "B", "C", "D"], one) };
  assert.deepEqual(suggestRacks(input), suggestRacks(input));
  assert.deepEqual(suggestRacks({ plan: four(["A", "B", "C", "D"], []) }).racks, []);
});

test("suggesting does not change the plan", () => {
  const p = four(["A", "B", "C", "D"], one);
  const before = JSON.stringify(p);
  suggestRacks({ plan: p });
  assert.equal(JSON.stringify(p), before);
});

test("a suggested rack keeps its distance from every AP", () => {
  const sources = [ap("a", 4, 3), ap("b", 12, 3), ap("c", 4, 9), ap("d", 12, 9)];
  const result = suggestRacks({ plan: four(["A", "B", "C", "D"], sources) });
  assert.ok(result.racks.length >= 1);
  for (const rack of result.racks)
    for (const s of sources)
      assert.ok(Math.hypot(rack.x - s.x, rack.z - s.z) >= 2, `${rack.name} is ${Math.hypot(rack.x - s.x, rack.z - s.z)} m from ${s.id}`);
});

test("a rack stands against a wall of its room, not in the middle of it", () => {
  const result = suggestRacks({ plan: four(["A", "B", "C", "D"], [ap("a", 4, 3)]) });
  const rack = result.racks[0];
  const room = { A: [0, 0, 8, 6], B: [8, 0, 16, 6], C: [0, 6, 8, 12], D: [8, 6, 16, 12] }[rack.roomName];
  assert.ok(room, `unexpected room ${rack.roomName}`);
  const [x0, z0, x1, z1] = room;
  const nearestWall = Math.min(rack.x - x0, x1 - rack.x, rack.z - z0, z1 - rack.z);
  assert.ok(nearestWall <= 0.7, `${nearestWall} m from the nearest wall`);
});

test("with no suitable room the rack goes along a wall and is flagged, never silently", () => {
  const onlyBaths = plan([room("b1", "Bath", 0, 0, 12, 8), room("b2", "Toilet", 12, 0, 12, 8)], [ap("a", 6, 4)]);
  const result = suggestRacks({ plan: onlyBaths });
  assert.equal(result.racks.length, 1);
  assert.equal(result.racks[0].needsRoom, true);
  assert.ok(result.notes.some((n) => /no suitable room/.test(n)));
});

test("when the APs leave no free spot, it says so", () => {
  const tiny = plan([room("t", "Office", 0, 0, 4, 4)], [ap("a", 1, 1), ap("b", 3, 1), ap("c", 1, 3), ap("d", 3, 3)]);
  const result = suggestRacks({ plan: tiny });
  assert.equal(result.racks.length, 0);
  assert.ok(result.notes.some((n) => /keeps 2 m clear/.test(n)));
});
