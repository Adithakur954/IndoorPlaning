import test from "node:test";
import assert from "node:assert/strict";
import { loadOptimizationComparison, optimizationCells } from "../src/services/optimization.js";
import { replaceSavedResult, savedJobIds } from "../src/utils/savedResults.js";

const map = {
  floorId: "f", frequencyMHz: 5180, cellSizeM: 1,
  xCentersM: [0.5, 1.5, 2.5], zCentersM: [0.5],
  inTarget: [[true, true, false]], thresholdDbm: [[-67, -67, -67]],
  beforeDbm: [[null, null, null]], afterDbm: [[-60, -50, -40]],
  beforeSnrDb: [[null, null, null]], afterSnrDb: [[25, 35, 45]],
};
const ref = (band, id) => ({ jobId: id, settingsUsed: { band }, threshold: -67 });
const comparison = { ...ref("5", "five"), runs: { "2.4": ref("2.4", "low"), "5": ref("5", "five") } };

test("optimisation cells carry actual SNR separately from dBm and coverage", () => {
  const cells = optimizationCells(map, "after", { coverage: false, referenceDbm: -67 });
  assert.deepEqual(cells.map((c) => [c.dbm, c.snr, c.hasSnrMap]), [[-60, 25, true], [-50, 35, true]]);
  assert.equal(optimizationCells(map, "before", {})[0].snr, null);
  const legacy = { ...map, afterSnrDb: undefined };
  assert.equal(optimizationCells(legacy, "after", {})[0].hasSnrMap, false);
  const coverage = optimizationCells(map, "after", { coverage: true, referenceDbm: -70 });
  assert.equal(coverage[0].dbm, -63);
  assert.equal(coverage[0].rawDbm, -60);
  assert.equal(coverage[0].snr, 25);
  const snr = optimizationCells(map, "after", { metric: "snr", snrThreshold: 30 });
  assert.deepEqual(snr.map((c) => [c.dbm, c.rawDbm, c.covered]), [[25, -60, false], [35, -50, true]]);
  assert.deepEqual(optimizationCells(legacy, "after", { metric: "snr" }), []);
  assert.equal(optimizationCells(map, "before", { metric: "snr" })[0].covered, false);
});

test("reopening loads both band maps and restores the user's selected band", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json(url.includes("/maps/")
      ? { ...map, frequencyMHz: url.includes("/low/") ? 2437 : 5180 }
      : { status: "done", result: { maps: [{ floorId: "f", file: "maps/opt-f.json" }] } });
  });
  const restored = await loadOptimizationComparison(JSON.parse(JSON.stringify(comparison)));
  assert.equal(restored.partial, false);
  assert.equal(restored.selected.jobId, "five");
  assert.deepEqual(Object.keys(restored.runs).sort(), ["2.4", "5"]);
  assert.equal(restored.runs["2.4"].maps.f.frequencyMHz, 2437);
  assert.equal(restored.runs["5"].maps.f.frequencyMHz, 5180);
  assert.equal(calls.length, 4);
});

test("one missing band still restores the available band; legacy saves load", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/five")) return Response.json({ error: "unknown job" }, { status: 404 });
    return Response.json(url.includes("/maps/") ? map
      : { status: "done", result: { maps: [{ floorId: "f", file: "maps/opt-f.json" }] } });
  });
  const restored = await loadOptimizationComparison(comparison);
  assert.equal(restored.partial, true);
  assert.equal(restored.selected.jobId, "low");
  const legacy = await loadOptimizationComparison(ref("2.4", "low"));
  assert.equal(legacy.partial, false);
  assert.equal(legacy.selected.jobId, "low");
});

test("switching bands retains both jobs; a new comparison deletes only replaced jobs", (t) => {
  const deleted = [];
  t.mock.method(globalThis, "fetch", async (url) => { deleted.push(url); return Response.json({}); });
  let plan = { savedResults: { optimization: comparison } };
  const mutate = (fn) => { plan = fn(plan); };
  const switched = { ...comparison, ...comparison.runs["2.4"] };
  replaceSavedResult(mutate, "optimization", switched, comparison);
  assert.deepEqual(deleted, []);
  assert.deepEqual(savedJobIds(plan.savedResults.optimization).sort(), ["five", "low"]);
  const next = { ...ref("5", "next"), runs: { "5": ref("5", "next"), "2.4": ref("2.4", "low") } };
  replaceSavedResult(mutate, "optimization", next, switched);
  assert.deepEqual(deleted, ["/api/jobs/five"]);
});
