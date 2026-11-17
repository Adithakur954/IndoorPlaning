import test, { mock } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

// Drawing needs a browser canvas; the images are replaced by empty ones here.
const calls = { floor: 0, cdf: 0 };
mock.module("../src/utils/reportImages.js", {
  exports: {
    renderFloorImage: async () => (calls.floor += 1, { bytes: new Uint8Array([1]), width: 10, height: 10 }),
    renderCdfChart: async () => (calls.cdf += 1, { bytes: new Uint8Array([1]), width: 10, height: 10 }),
    renderCoverageBuildChart: async () => null,
    renderCoverageCompareChart: async (o) => (calls.compare = o, { bytes: new Uint8Array([1]), width: 10, height: 10 }),
  },
});
const { buildBandComparisonReport } = await import("../src/utils/reportCompare.js");

const room = { id: "r", floorId: "f", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 6, depth: 4 };
const plan = {
  floors: [{ id: "f", name: "Level 1" }],
  rooms: [room],
  boundaries: [],
  apProfiles: [],
  sources: [
    { id: "a", name: "AP1", kind: "wifi", floorId: "f", x: 1, z: 1, heightM: 2.5 },
    { id: "b", name: "AP2", kind: "wifi", floorId: "f", x: 5, z: 3, heightM: 2.5 },
  ],
};
// 6 x 4 m at 1 m cells; a band's level is its base minus the distance to each AP
const map = (freq, base) => {
  const xs = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
    zs = [0.5, 1.5, 2.5, 3.5];
  const grid = (ax, az) => zs.map((z) => xs.map((x) => base - 6 * Math.hypot(x - ax, z - az)));
  return {
    shape: [4, 6],
    cellSizeM: 1,
    xCentersM: xs,
    zCentersM: zs,
    frequencyMHz: freq,
    accessPoints: [{ id: "a", name: "AP1" }, { id: "b", name: "AP2" }],
    perApDbm: [grid(1, 1), grid(5, 3)],
  };
};
const maps = { "j24": map(2437, -30), "j5": map(5180, -38) };
const run = (id, freq) => ({ jobId: id, result: { floors: [{ floorId: "f", frequencyMHz: freq, file: "maps/f.json" }] } });

test("the comparison report is a Word file that holds both bands", async () => {
  const lines = [];
  const blob = await buildBandComparisonReport({
    plan,
    projectName: "Demo",
    includeAppendices: true,
    runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) },
    ranges: [{ min: -Infinity, max: -70, color: "#f00" }, { min: -70, max: Infinity, color: "#0f0" }],
    designThr: -67,
    getMap: async (jobId) => maps[jobId],
    onProgress: (t) => lines.push(t),
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  for (const text of ["2.4 GHz vs 5 GHz Wi-Fi Comparison Prediction Report", "Executive summary", "Wi-Fi infrastructure", "Coverage comparison", "Room-level comparison", "Weak zones and problem areas", "Engineering recommendations", "Hall", "Appendix A. Individual AP predictions", "Appendix B. Adding access points one by one", "AP1 (2.4 GHz)", "AP2 (5 GHz)", "2.4 GHz band", "5 GHz band"])
    assert.ok(xml.includes(text), `missing: ${text}`);
  assert.ok(calls.floor >= 4 && calls.cdf >= 1, `images ${JSON.stringify(calls)}`);
  // 2.4 GHz is stronger in the model above, so it must cover at least as much
  assert.match(xml, /Coverage at ≥ -67 dBm/);
});

test("the company logo and the tool icon go into the page header", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const blob = await buildBandComparisonReport({
    plan,
    projectName: "Demo",
    runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) },
    ranges: [],
    designThr: -67,
    getMap: async (jobId) => maps[jobId],
    logos: { left: { bytes: png, widthPx: 560, heightPx: 300 }, right: { bytes: png, widthPx: 410, heightPx: 620 } },
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const header = await zip.file("word/header1.xml").async("string");
  assert.match(header, /rIdHdrImg1/);
  assert.match(header, /rIdHdrImg2/);
  const rels = await zip.file("word/_rels/header1.xml.rels").async("string");
  assert.match(rels, /media\/logo1\.png/);
  assert.ok(zip.file("word/media/logo1.png") && zip.file("word/media/logo2.png"));
  // a report without logos still has its header text and no image relations
  const plain = await JSZip.loadAsync(
    await (await buildBandComparisonReport({ plan, projectName: "Demo", runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) }, ranges: [], designThr: -67, getMap: async (j) => maps[j] })).arrayBuffer(),
  );
  assert.equal(plain.file("word/_rels/header1.xml.rels"), null);
});

test("the combined report has the coverage-vs-APs-added chart with one line per band", async () => {
  await buildBandComparisonReport({
    plan,
    projectName: "Demo",
    includeAppendices: true,
    runs: { "2.4": run("j24", 2437), 5: run("j5", 5180) },
    ranges: [],
    designThr: -67,
    getMap: async (jobId) => maps[jobId],
  });
  const { series, thresholdDbm } = calls.compare;
  assert.equal(thresholdDbm, -67);
  assert.deepEqual(series.map((s) => s.label), ["2.4 GHz", "5 GHz"]);
  for (const s of series) {
    assert.equal(s.points.length, 2); // two APs: AP 1, then AP 1 + 2
    assert.ok(s.points[1].pct >= s.points[0].pct); // adding an AP never lowers coverage
  }
});
