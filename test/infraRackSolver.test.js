import test from "node:test";
import assert from "node:assert/strict";
import { solveRacks, suggestRacks } from "../src/infra/wifi/racks.js";

const cand = (name, links, preferred = false) => ({ name, x: 0, z: 0, links, preferred });
const names = (set) => set.map((c) => c.name).sort();

test("one rack when one rack can serve every AP", () => {
  const set = solveRacks([cand("A", [10, 10, 100, 100]), cand("B", [100, 100, 10, 10]), cand("C", [30, 30, 30, 30])], 4, { limit: 90, maxRacks: 3 });
  assert.deepEqual(names(set), ["C"]);
  assert.equal(set[0].reach, 4);
});

test("two racks are the cheapest pair, not just a pair that covers", () => {
  // no single rack reaches all four within 50 m; A + B total 40 m, A + E total 110 m
  const set = solveRacks(
    [cand("A", [10, 10, 100, 100]), cand("B", [100, 100, 10, 10]), cand("C", [60, 60, 60, 60]), cand("E", [100, 100, 45, 45])],
    4, { limit: 50, maxRacks: 3 },
  );
  assert.deepEqual(names(set), ["A", "B"]);
  near(set.reduce((s, c) => s + c.linkM, 0), 40);
});

function near(a, b, tol = 1e-9) { assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`); }

test("a rack's capacity forces a second rack even when one is close enough to all", () => {
  const six = [10, 10, 10, 10, 10, 10];
  const set = solveRacks([cand("near", six), cand("far", [40, 40, 40, 40, 40, 40])], 6, { limit: 90, maxRacks: 3, capacity: 4 });
  assert.deepEqual(names(set), ["far", "near"]);
  assert.equal(set.find((c) => c.name === "near").reach, 4);
  assert.equal(set.find((c) => c.name === "far").reach, 2);
});

test("a room that suits equipment wins when the cable is equal", () => {
  const set = solveRacks([cand("plain", [20, 20, 20]), cand("server room", [20, 20, 20], true)], 3, { limit: 90, maxRacks: 2 });
  assert.deepEqual(names(set), ["server room"]);
});

test("nothing serves an AP within the limit: no solution, so the caller can report it", () => {
  assert.equal(solveRacks([cand("A", [10, 200]), cand("B", [200, 10])], 2, { limit: 90, maxRacks: 1 }), null);
  assert.equal(solveRacks([cand("A", [10, 200])], 2, { limit: 90, maxRacks: 3 }), null);
});

test("many candidates: the search stays fast and still gives a feasible, small set", () => {
  // 80 candidates and 3 racks is more combinations than the exact search will try
  const n = 80;
  const candidates = Array.from({ length: n }, (_, c) => cand(`c${c}`, Array.from({ length: 12 }, (_, i) => (Math.abs(c - i * 6) * 2.5 + 5))));
  const started = Date.now();
  const set = solveRacks(candidates, 12, { limit: 60, maxRacks: 3 });
  assert.ok(Date.now() - started < 5000, "finishes quickly");
  assert.ok(set && set.length >= 1 && set.length <= 3);
  assert.equal(set.reduce((s, c) => s + c.reach, 0), 12); // every AP is served
});

// ---- in the suggestion -----------------------------------------------------------------------------

const plan = (sources) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 60, depth: 20, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });

test("the suggestion respects 'most APs per rack' and adds racks to serve them all", () => {
  const sources = Array.from({ length: 10 }, (_, i) => ap(`a${i}`, 20.25 + i * 2, 10.25));
  const free = suggestRacks({ plan: plan(sources) });
  assert.equal(free.racks.length, 1);
  const limited = suggestRacks({ plan: plan(sources), rules: { maxApsPerRack: 4 } });
  assert.ok(limited.racks.length >= 3, `racks: ${limited.racks.length}`);
  assert.deepEqual(limited.uncovered, []);
  assert.ok(limited.racks.every((r) => r.covers <= 4));
  assert.equal(limited.racks.reduce((s, r) => s + r.covers, 0), 10);
});
