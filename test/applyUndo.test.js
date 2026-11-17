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
