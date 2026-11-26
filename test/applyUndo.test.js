import test from "node:test";
import assert from "node:assert/strict";
import { applyOptimization, undoOptimization } from "../src/utils/applyOptimization.js";

const ap = (id, x) => ({ id, name: id, kind: "wifi", floorId: "f", x, z: 0, heightM: 2.5, channel: 36, txPowerDbm: 17 });
const plan = { sources: [ap("a", 1), ap("b", 10), ap("c", 20)] };
const result = {
  existingActions: [
    { id: "a", action: "keep" },
    { id: "b", action: "move" },
    { id: "c", action: "remove" },
  ],
  recommendations: [
    { action: "keep", existingId: "a", planX: 1, planZ: 0, floorId: "f", heightM: 2.5 },
    { action: "move", existingId: "b", planX: 12, planZ: 3, floorId: "f", heightM: 2.5 },
    { action: "new", existingId: null, planX: 30, planZ: 5, floorId: "f", heightM: 2.5, kind: "wall" },
  ],
};

test("apply moves, removes and adds; undo puts every AP back with its settings", () => {
  const applied = applyOptimization(plan, result, { channel: 1 });
  const ids = applied.sources.map((s) => s.id);
  assert.ok(!ids.includes("c"));
  assert.equal(applied.sources.find((s) => s.id === "b").x, 12);
  assert.equal(applied.sources.length, 3); // a, b, new
  const undone = undoOptimization(applied);
  assert.deepEqual(
    undone.sources.map((s) => s.id).sort(),
    ["a", "b", "c"],
  );
  assert.equal(undone.sources.find((s) => s.id === "b").x, 10);
  assert.equal(undone.sources.find((s) => s.id === "c").channel, 36);
  assert.equal(undone.optimizationBackup, undefined);
});

test("applying twice still undoes back to the first state", () => {
  const once = applyOptimization(plan, result, {});
  const twice = applyOptimization(once, { existingActions: [], recommendations: [] }, {});
  const undone = undoOptimization(twice);
  assert.deepEqual(undone.sources.map((s) => [s.id, s.x]).sort(), [["a", 1], ["b", 10], ["c", 20]]);
});

// ---- repeated Apply and dual-band radios ------------------------------------
const run = (band, spots) => ({
  existingActions: [],
  settings: { floor_ids: ["f"] },
  recommendations: spots.map(([x, z]) => ({ action: "new", existingId: null, planX: x, planZ: z, floorId: "f", heightM: 2.5, kind: "ceiling" })),
});

test("applying the same result twice does not stack copies: it replaces that band's optimised APs", () => {
  const r5 = run("5", [[10, 10], [60, 10], [110, 40]]);
  const once = applyOptimization({ sources: [] }, r5, { band: "5" });
  const twice = applyOptimization(once, r5, { band: "5" });
  assert.equal(twice.sources.length, 3);
  assert.deepEqual(twice.sources.map((s) => s.name).sort(), ["AP-opt-1", "AP-opt-2", "AP-opt-3"]);
  // undo still goes back to before the first Apply
  assert.equal(undoOptimization(twice).sources.length, 0);
});

test("a 5 GHz radio next to a 2.4 GHz optimised AP joins it as one dual-band AP", () => {
  const with24 = applyOptimization({ sources: [] }, run("2.4", [[103.6, 66.2], [147.4, 39.9]]), { band: "2.4" });
  const both = applyOptimization(with24, run("5", [[103.6, 64.7], [148.9, 39.9], [160, 112]]), { band: "5" });
  assert.equal(both.sources.length, 5);
  const a24 = both.sources.find((s) => s.band === "2.4" && s.x === 103.6);
  const a5 = both.sources.find((s) => s.band === "5" && s.deviceId === a24.deviceId);
  assert.ok(a5, "the 5 GHz radio shares the device");
  assert.deepEqual([a5.x, a5.z], [a24.x, a24.z]);
  assert.equal(a24.name, "AP-opt-1 (2.4 GHz)");
  assert.equal(a5.name, "AP-opt-1 (5 GHz)");
  // the far one stays a separate AP with its own number
  const lone = both.sources.find((s) => s.x === 160);
  assert.equal(lone.name, "AP-opt-3");
});

test("a band's result stays valid when another band's APs, or its own applied APs, are added", async () => {
  const { bandStamp, buildingStamp } = await import("../src/utils/savedResults.js");
  const base = { floors: [], rooms: [{ id: "r" }], sources: [{ id: "e5", kind: "wifi", band: "5", x: 1, z: 1 }] };
  const s5 = bandStamp(base, "5");
  const with24 = applyOptimization(base, run("2.4", [[10, 10]]), { band: "2.4" });
  assert.equal(bandStamp(with24, "5"), s5, "2.4 GHz APs do not touch the 5 GHz result");
  const with5 = applyOptimization(with24, run("5", [[30, 10]]), { band: "5" });
  assert.equal(bandStamp(with5, "5"), s5, "the 5 GHz result's own applied APs do not make it out of date");
  const moved = { ...base, sources: [{ ...base.sources[0], x: 2 }] };
  assert.notEqual(bandStamp(moved, "5"), s5, "moving an existing 5 GHz AP does");
  assert.notEqual(buildingStamp({ ...base, rooms: [] }), buildingStamp(base), "a building change does");
});
