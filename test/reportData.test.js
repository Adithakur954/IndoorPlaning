import test from "node:test";
import assert from "node:assert/strict";
import {
  areaChecks,
  bandOfMHz,
  channelPairs,
  coverageAt,
  errorStats,
  groupByBand,
  overlapClasses,
  predictedAt,
  primarySecondaryGap,
  rankedCells,
  roomRows,
  weakClusters,
} from "../src/utils/reportData.js";

// 2 x 2 cells of 1 m; AP "a" is strong on the left, "b" on the right.
const raw = (freq = 5180) => ({
  frequencyMHz: freq,
  shape: [2, 2],
  cellSizeM: 1,
  xCentersM: [0.5, 1.5],
  zCentersM: [0.5, 1.5],
  accessPoints: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  perApDbm: [
    [[-50, -80], [-50, -80]],
    [[-75, -55], [-75, null]],
  ],
});
const room = { id: "r", name: "Room", shape: "rectangle", x: 0, z: 0, width: 2, depth: 2 };

test("bands follow the frequency", () => {
  assert.equal(bandOfMHz(2437), "2.4");
  assert.equal(bandOfMHz(5180), "5");
  assert.equal(bandOfMHz(6115), "6");
});

test("maps of one band are merged and the strongest AP wins", () => {
  const [band] = groupByBand([
    { floorId: "f", freqMHz: 5180, raw: { ...raw(), accessPoints: [{ id: "a", name: "A" }], perApDbm: [raw().perApDbm[0]] } },
    { floorId: "f", freqMHz: 5240, raw: { ...raw(5240), accessPoints: [{ id: "b", name: "B" }], perApDbm: [raw().perApDbm[1]] } },
  ]);
  assert.equal(band.band, "5");
  assert.deepEqual(band.aps.map((a) => a.name), ["A", "B"]);
  assert.deepEqual(band.floors[0].raw.bestDbm, [[-50, -55], [-50, -80]]);
});

test("ranking gives primary and secondary AP per cell", () => {
  const [band] = groupByBand([{ floorId: "f", freqMHz: 5180, raw: raw() }]);
  const cells = rankedCells(band.floors[0].raw, [room]);
  assert.equal(cells.length, 4);
  const left = cells.find((c) => c.x === 0.5 && c.z === 0.5);
  assert.deepEqual(left.top.map((t) => t.i), [0, 1]);
  assert.equal(left.best, -50);
  const gap = primarySecondaryGap(cells);
  assert.equal(gap.count, 3); // one cell hears only one AP
});

test("coverage and overlap classes use one threshold on one cell set", () => {
  const [band] = groupByBand([{ floorId: "f", freqMHz: 5180, raw: raw() }]);
  const cells = rankedCells(band.floors[0].raw, [room]);
  const [c67, c75] = coverageAt(cells, [-67, -75]);
  assert.equal(c67.totalM2, 4);
  assert.equal(c67.pct, 75); // -80 is below -67 in one cell; the rest reach it
  assert.ok(c75.pct >= c67.pct);
  const o = overlapClasses(cells, -75);
  const total = o.none.pct + o.one.pct + o.two.pct + o.threePlus.pct;
  assert.ok(Math.abs(total - 100) < 1e-9);
});

test("room rows report coverage and the AP names", () => {
  const [band] = groupByBand([{ floorId: "f", freqMHz: 5180, raw: raw() }]);
  const cells = rankedCells(band.floors[0].raw, [room]);
  const [row] = roomRows([room], cells, ["A", "B"], -85);
  assert.equal(row.areaM2, 4);
  assert.equal(row.coveragePct, 100);
  assert.equal(row.primary, "A");
});

test("weak patches are grouped and sized", () => {
  const cells = [];
  for (let x = 0; x < 4; x += 1)
    for (let z = 0; z < 4; z += 1)
      cells.push({ x: x + 0.5, z: z + 0.5, step: 1, best: x < 2 && z < 2 ? -90 : -50, top: [] });
  const [patch] = weakClusters(cells, -70);
  assert.equal(patch.areaM2, 4);
  assert.equal(patch.centroid.x, 1);
});

test("co-channel and overlapping channels are told apart", () => {
  const ap = (name, band, freq, width) => ({ kind: "wifi", name, band, freqMHz: freq, bandwidthMHz: width });
  const pairs = channelPairs([
    ap("1", "5", 5180, 20),
    ap("2", "5", 5180, 20),
    ap("3", "5", 5190, 40),
    ap("4", "2.4", 2437, 20),
  ]);
  assert.equal(pairs.find((p) => p.a.name === "1" && p.b.name === "2").kind, "co-channel");
  assert.equal(pairs.find((p) => p.a.name === "1" && p.b.name === "3").kind, "overlapping");
  assert.equal(pairs.some((p) => p.a.name === "4" || p.b.name === "4"), false);
});

test("prediction error statistics", () => {
  const s = errorStats([
    { predicted: -60, measured: -65 },
    { predicted: -70, measured: -65 },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.mae, 5);
  assert.equal(s.rmse, 5);
  assert.equal(s.bias, 0);
  assert.equal(errorStats([]), null);
});

test("predicted value is read from the nearest cell and outside is null", () => {
  const [band] = groupByBand([{ floorId: "f", freqMHz: 5180, raw: raw() }]);
  assert.equal(predictedAt(band.floors[0].raw, 0.6, 0.4), -50);
  assert.equal(predictedAt(band.floors[0].raw, 10, 10), null);
});

test("area check flags a mismatch between the prediction and the optimiser", () => {
  const { flags, rows } = areaChecks({ predictionM2: 882, optimisationM2: 896, geometryM2: 900 });
  assert.equal(rows.length, 3);
  assert.equal(flags.length, 1);
  assert.equal(areaChecks({ predictionM2: 100, optimisationM2: 100.5 }).flags.length, 0);
});
