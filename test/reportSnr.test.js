import test, { mock } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  groupByBand,
  hasSnr,
  noiseAssumptions,
  rankedCells,
  roomRows,
  snrBandShares,
  snrCoverage,
  snrStats,
} from "../src/utils/reportData.js";

const room = { id: "r", floorId: "f", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 4, depth: 2 };
// 4 x 2 cells; AP 0 strong on the left, AP 1 weaker on the right; 5 GHz 20 MHz and 40 MHz APs
const rawMap = (noise) => ({
  shape: [2, 4],
  cellSizeM: 1,
  xCentersM: [0.5, 1.5, 2.5, 3.5],
  zCentersM: [0.5, 1.5],
  accessPoints: [{ id: "a", name: "AP1" }, { id: "b", name: "AP2" }],
  perApDbm: [
    [[-50, -60, -80, -90], [-50, -60, -80, -90]],
    [[-90, -80, -60, -70], [-90, -80, -60, null]],
  ],
  ...(noise ? { snr: { noiseFloor20MHzDbm: -88, noiseFloorDbm: noise, bandwidthMHz: [20, 40], bandwidthAssumed: [false, true] } } : {}),
});

test("a cell's SNR is its best AP's signal minus that AP's own noise floor", () => {
  const cells = rankedCells(rawMap([-88, -85]), [room]);
  // cell (0.5, 0.5): best is AP1 at -50 dBm, floor -88 -> 38 dB
  assert.equal(cells[0].snr, 38);
  // cell (2.5, 0.5): best is AP2 at -60 dBm, floor -85 -> 25 dB
  assert.equal(cells[2].snr, 25);
  assert.equal(hasSnr(cells), true);
  // a run without SNR data has no SNR values
  assert.equal(hasSnr(rankedCells(rawMap(null), [room])), false);
});

test("SNR statistics, band shares and coverage at a target", () => {
  const cells = rankedCells(rawMap([-88, -85]), [room]);
  const stats = snrStats(cells);
  assert.equal(stats.min, Math.min(...cells.map((c) => c.snr)));
  assert.equal(stats.max, 38);
  const ranges = [
    { min: -Infinity, max: 10, color: "r" },
    { min: 10, max: 25, color: "o" },
    { min: 25, max: Infinity, color: "g" },
  ];
  const shares = snrBandShares(cells, ranges);
  assert.deepEqual(shares.map((s) => s.label), ["below 10 dB", "10 to 25 dB", "25 dB and above"]);
  assert.ok(Math.abs(shares.reduce((a, s) => a + s.pct, 0) - 100) < 1e-9);
  const cover = snrCoverage(cells, 25);
  assert.equal(cover.pct, (100 * cells.filter((c) => c.snr >= 25).length) / cells.length);
  assert.equal(roomRows([room], cells, ["AP1", "AP2"], -67)[0].snrMedian, stats.median);
});

test("maps of one band merge and keep each AP's noise floor", () => {
  const a = { ...rawMap([-88, -85]), accessPoints: [{ id: "a", name: "AP1" }], perApDbm: [rawMap().perApDbm[0]], snr: { noiseFloor20MHzDbm: -88, noiseFloorDbm: [-88], bandwidthMHz: [20], bandwidthAssumed: [false] } };
  const b = { ...rawMap([-88, -85]), accessPoints: [{ id: "b", name: "AP2" }], perApDbm: [rawMap().perApDbm[1]], snr: { noiseFloor20MHzDbm: -88, noiseFloorDbm: [-85], bandwidthMHz: [40], bandwidthAssumed: [true] } };
  const band = groupByBand([{ floorId: "f", freqMHz: 5180, raw: a }, { floorId: "f", freqMHz: 5200, raw: b }])[0];
  const raw = band.floors[0].raw;
  assert.deepEqual(raw.snr.noiseFloorDbm, [-88, -85]);
  const cells = rankedCells(raw, [room]);
  assert.equal(cells[2].snr, 25); // AP2 serves it, with its own 40 MHz floor
  const n = noiseAssumptions(raw);
  assert.deepEqual(n.aps.map((x) => [x.name, x.width, x.floor, x.assumed]), [["AP1", 20, -88, false], ["AP2", 40, -85, true]]);
});

// ---- the Word reports --------------------------------------------------------------------------------
const images = { snr: 0, drawn: [] };
mock.module("../src/utils/reportImages.js", {
  exports: {
    renderFloorImage: async (o) => ((o.legendTitle === "SNR (dB):" ? (images.snr += 1) : 0), images.drawn.push(o), { bytes: new Uint8Array([1]), width: 10, height: 10 }),
    renderCdfChart: async () => ({ bytes: new Uint8Array([1]), width: 10, height: 10 }),
    renderCoverageBuildChart: async () => null,
    renderCoverageCompareChart: async () => null,
  },
});
const { buildBandComparisonReport } = await import("../src/utils/reportCompare.js");
const { buildReport } = await import("../src/utils/reportBuilder.js");

const plan = {
  floors: [{ id: "f", name: "Level 1" }],
  rooms: [room],
  boundaries: [],
  doors: [],
  windows: [],
  interiorWalls: [],
  furniture: [],
  logs: [],
  thresholds: {},
  apProfiles: [],
  sources: [
    { id: "a", name: "AP1", kind: "wifi", floorId: "f", x: 1, z: 1, heightM: 2.5, band: "5", freqMHz: 5180, channel: 36, txPowerDbm: 20, antennaGainDbi: 4.5, bandwidthMHz: 20 },
    { id: "b", name: "AP2", kind: "wifi", floorId: "f", x: 3, z: 1, heightM: 2.5, band: "5", freqMHz: 5180, channel: 36, txPowerDbm: 20, antennaGainDbi: 4.5, bandwidthMHz: 40 },
  ],
};
const ranges = [{ min: -Infinity, max: -70, color: "#f00" }, { min: -70, max: Infinity, color: "#0f0" }];
const snrRanges = [
  { min: -Infinity, max: 10, color: "#d00" },
  { min: 10, max: 25, color: "#fa0" },
  { min: 25, max: Infinity, color: "#0a0" },
];
const docXml = async (blob) => (await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string"));

test("the comparison report has an SNR section with the SNR numbers of both bands", async () => {
  const maps = { j24: rawMap([-86, -83]), j5: rawMap([-88, -85]) };
  const run = (id, f) => ({ jobId: id, result: { floors: [{ floorId: "f", frequencyMHz: f, file: "maps/f.json" }] } });
  images.snr = 0;
  const xml = await docXml(
    await buildBandComparisonReport({
      plan, projectName: "Demo", runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) },
      ranges, snrRanges, designThr: -67, getMap: async (id) => maps[id],
    }),
  );
  for (const t of ["Signal-to-noise ratio (SNR) comparison", "Median SNR", "SNR distribution", "Noise floor used", "25 dB and above", "2.4 GHz noise floor", "40.0 MHz (assumed)"])
    assert.ok(xml.includes(t), `missing: ${t}`);
  assert.equal(images.snr, 2); // one SNR map per band
});

test("the comparison report says so when a run has no SNR map", async () => {
  const maps = { j24: rawMap(null), j5: rawMap(null) };
  const run = (id, f) => ({ jobId: id, result: { floors: [{ floorId: "f", frequencyMHz: f, file: "maps/f.json" }] } });
  const xml = await docXml(await buildBandComparisonReport({ plan, projectName: "Demo", runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) }, ranges, snrRanges, designThr: -67, getMap: async (id) => maps[id] }));
  assert.ok(xml.includes("has no SNR map"));
  assert.ok(!xml.includes("Median SNR"));
});

test("the main report has an SNR section, an SNR line in the summary and SNR in the room table", async () => {
  images.snr = 0;
  const xml = await docXml(
    await buildReport({
      plan, projectName: "Demo",
      rt: { jobId: "j5", finishedAt: "2026-11-04T10:00:00Z", result: { floors: [{ floorId: "f", frequencyMHz: 5180, file: "maps/f.json" }] } },
      opt: null, ranges, snrRanges, thresholdDbm: -67, getMap: async () => rawMap([-88, -85]),
    }),
  );
  for (const t of ["Signal-to-noise ratio (SNR)", "Predicted SNR (5 GHz)", "Noise floor used", "weakest", "SNR"])
    assert.ok(xml.includes(t), `missing: ${t}`);
  assert.equal(images.snr, 1);
});

test("RSSI maps use the signal-strength bands and SNR maps the SNR bands, never the other way round", async () => {
  const maps = { j24: rawMap([-86, -83]), j5: rawMap([-88, -85]) };
  const run = (id, f) => ({ jobId: id, result: { floors: [{ floorId: "f", frequencyMHz: f, file: "maps/f.json" }] } });
  images.drawn.length = 0;
  await buildBandComparisonReport({ plan, projectName: "Demo", runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) }, ranges, snrRanges, designThr: -67, getMap: async (id) => maps[id] });
  const rssiMaps = images.drawn.filter((o) => /RSSI/.test(o.title) && o.cells);
  const snrMaps = images.drawn.filter((o) => o.legendTitle === "SNR (dB):");
  assert.ok(rssiMaps.length >= 2 && snrMaps.length === 2);
  for (const o of rssiMaps) assert.equal(o.ranges, ranges);
  for (const o of snrMaps) assert.equal(o.ranges, snrRanges);
});
