import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";
import {
  bandOfFrequency,
  carrierProblems,
  resourceBlocksFor,
  rsrpOffsetDb,
} from "../src/infra/cellular/bands.js";
import {
  bandEntry,
  msiPattern,
  parametricPattern,
  parseMsi,
  patternFor,
  patternGainDbi,
} from "../src/infra/cellular/antennaPattern.js";
import { buildCellularRequest, orientationDeg } from "../src/infra/cellular/request.js";
import { cellularOf, predictionProblems } from "../src/infra/cellular/model.js";

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

// a datasheet-style antenna entry (numbers chosen for the test, not a real product)
const omni = {
  id: "test-omni",
  name: "Test omni",
  type: "omni",
  bands: [
    { fromMHz: 698, toMHz: 960, gainDbi: 2.5, hBeamwidthDeg: 360, vBeamwidthDeg: 116 },
    { fromMHz: 1710, toMHz: 2170, gainDbi: 4, hBeamwidthDeg: 360, vBeamwidthDeg: 78 },
    { fromMHz: 2170, toMHz: 2700, gainDbi: 5, hBeamwidthDeg: 360, vBeamwidthDeg: 70 },
  ],
};
const panel = {
  id: "test-panel",
  name: "Test panel",
  type: "panel",
  bands: [{ fromMHz: 1710, toMHz: 2700, gainDbi: 8, hBeamwidthDeg: 65, vBeamwidthDeg: 60, frontToBackDb: 15 }],
};

test("resource blocks and the RSRP offset follow the 3GPP tables", () => {
  assert.equal(resourceBlocksFor({ technology: "LTE", bandwidthMHz: 20 }), 100);
  assert.equal(resourceBlocksFor({ technology: "LTE", bandwidthMHz: 10 }), 50);
  assert.equal(resourceBlocksFor({ technology: "NR", bandwidthMHz: 100, scsKHz: 30 }), 273);
  assert.equal(resourceBlocksFor({ technology: "NR", bandwidthMHz: 20, scsKHz: 15 }), 106);
  near(rsrpOffsetDb({ technology: "LTE", bandwidthMHz: 20 }), 10 * Math.log10(1200));
  assert.throws(() => resourceBlocksFor({ technology: "LTE", bandwidthMHz: 40 }), /LTE has no 40 MHz/);
  assert.throws(() => resourceBlocksFor({ technology: "NR", bandwidthMHz: 5, scsKHz: 60 }), /NR at 60 kHz/);
});

test("bands are found from the frequency and a carrier outside its band is reported", () => {
  assert.equal(bandOfFrequency("LTE", 2350), "B40");
  assert.equal(bandOfFrequency("NR", 3500), "n77"); // n77 and n78 overlap; the first listed match
  assert.deepEqual(carrierProblems({ technology: "LTE", band: "B40", freqMHz: 2350, bandwidthMHz: 20 }), []);
  assert.match(carrierProblems({ technology: "LTE", band: "B3", freqMHz: 2350, bandwidthMHz: 20 })[0], /outside B3/);
});

test("the datasheet row of the carrier's band is used, the narrower one when rows overlap", () => {
  assert.equal(bandEntry(omni, 800).gainDbi, 2.5);
  assert.equal(bandEntry(omni, 2170).gainDbi, 4); // both rows contain 2170: same width, first stays
  assert.equal(bandEntry(omni, 2300).gainDbi, 5);
  assert.equal(bandEntry(omni, 1500), null);
  assert.throws(() => patternFor(omni, 1500), /no datasheet values at 1500 MHz/);
});

test("an omni pattern is round and drops by 3 dB at half the vertical beamwidth", () => {
  const p = parametricPattern(omni.bands[2]);
  near(patternGainDbi(p, 90, 0), 5);
  near(patternGainDbi(p, 90, 137), 5); // the same all the way round
  near(patternGainDbi(p, 90 + 35, 0), 5 - 3); // 70/2 below the horizon
  near(patternGainDbi(p, 90 - 35, 200), 5 - 3);
  near(patternGainDbi(p, 180, 0), 5 - 12 * (90 / 70) ** 2); // straight down
  near(patternGainDbi(parametricPattern({ gainDbi: 3, vBeamwidthDeg: 30 }), 0, 0), 3 - 30); // capped at the side-lobe level
});

test("a panel pattern drops 3 dB at half its beamwidths and keeps its front-to-back ratio", () => {
  const p = patternFor(panel, 2350);
  near(patternGainDbi(p, 90, 0), 8);
  near(patternGainDbi(p, 90, 32.5), 8 - 3, 0.1); // 1-degree table
  near(patternGainDbi(p, 90, 360 - 32.5), 8 - 3, 0.1);
  near(patternGainDbi(p, 120, 0), 8 - 3);
  near(patternGainDbi(p, 90, 180), 8 - 15); // behind the panel: the front-to-back ratio
});

test("a .msi pattern file is read and turned the same way as the datasheet pattern", () => {
  const h = Array.from({ length: 360 }, (_, a) => `${a} ${a === 90 ? 10 : a === 270 ? 4 : 0}`).join("\n");
  const v = Array.from({ length: 360 }, (_, a) => `${a} ${a === 30 ? 6 : a === 330 ? 9 : 0}`).join("\n");
  const text = `NAME TEST\nFREQUENCY 2350\nGAIN 5.85 dBd\nHORIZONTAL 360\n${h}\nVERTICAL 360\n${v}\n`;
  const msi = parseMsi(text, "test.msi");
  near(msi.gainDbi, 8);
  const p = msiPattern(msi);
  // clockwise 90 in the file is azimuth 270 (counter-clockwise) in the pattern
  near(p.h[270], 10);
  near(p.h[90], 4);
  // 30 deg below the horizon is zenith 120; 30 deg above (330) is zenith 60
  near(p.v[120], 6);
  near(p.v[60], 9);
  const withFile = { ...panel, patternFiles: [msi] };
  assert.match(patternFor(withFile, 2400).source, /pattern file test\.msi/); // within 15 %
  assert.match(patternFor(withFile, 1800).source, /datasheet/); // too far: the datasheet row
  assert.throws(() => parseMsi("NAME X\nGAIN 3\n"), /FREQUENCY/);
});

test("antenna direction: omni keeps its axis, a wall panel faces its azimuth, a ceiling panel faces down", () => {
  assert.deepEqual(orientationDeg({ downtiltDeg: 0 }, omni), [0, 0, 0]);
  assert.deepEqual(orientationDeg({ mount: "wall", azimuthDeg: 90, downtiltDeg: 6 }, panel), [-90, 6, 0]);
  assert.deepEqual(orientationDeg({ mount: "ceiling", azimuthDeg: 0 }, panel), [-0, 90, 0]);
});

const cellPlan = (over = {}) => ({
  ...initialPlan(),
  floors: [
    { id: "f0", name: "Ground", elevation: 0 },
    { id: "f1", name: "First", elevation: 4 },
  ],
  rooms: [
    { id: "r0", floorId: "f0", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 20, depth: 10, height: 3.5, material: "concrete" },
    { id: "r1", floorId: "f1", name: "Office", shape: "rectangle", x: 0, z: 0, width: 20, depth: 10, height: 3, material: "concrete" },
  ],
  sources: [
    { id: "ap1", floorId: "f0", kind: "wifi", name: "AP-1", x: 5, z: 5, heightM: 2.7, txPowerDbm: 20, freqMHz: 2400 },
    { id: "a1", floorId: "f0", kind: "cellular", name: "GF-A1", x: 4, z: 5, heightM: 3.4, antennaModelId: "test-omni", sectorId: "s2", inputPowerDbm: 12, downtiltDeg: 0 },
    { id: "a2", floorId: "f1", kind: "cellular", name: "1F-A1", x: 16, z: 5, heightM: 3.5, antennaModelId: "test-panel", sectorId: "s1", mount: "wall", azimuthDeg: 180, downtiltDeg: 0, inputPowerDbm: 10 },
  ],
  cellular: {
    catalogue: { antennas: { "test-omni": omni, "test-panel": panel } },
    sectors: [{ id: "s1", name: "Sector 1" }, { id: "s2", name: "Sector 2" }],
    carriers: [{ id: "c1", operator: "Op", technology: "LTE", band: "B40", freqMHz: 2350, bandwidthMHz: 20, sectorIds: null }],
  },
  ...over,
});

test("the cellular job has every antenna with its pattern, power, sector and position", () => {
  const { problems, request, notes } = buildCellularRequest(cellPlan(), "c1");
  assert.deepEqual(problems, []);
  assert.equal(request.carrier.resourceBlocks, 100);
  near(request.carrier.rsrpOffsetDb, 30.792, 0.001);
  assert.deepEqual(request.sectors.map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(request.antennas.map((a) => a.id), ["a1", "a2"]); // the Wi-Fi AP is not in it
  const [a1, a2] = request.antennas;
  assert.deepEqual(a1.position, [4, -5, 3.4]);
  // 3.5 m wanted in a 3 m room on a floor at 4 m: 5 cm under the ceiling
  assert.deepEqual(a2.position, [16, -5, 6.95]);
  assert.equal(notes.length, 0); // placed under the ceiling without a note per antenna
  assert.deepEqual(a2.orientationDeg, [-180, 0, 0]);
  assert.equal(a1.powerDbm, 12);
  assert.equal(request.patterns["test-omni@2350"].gainDbi, 5);
  assert.equal(request.patterns["test-panel@2350"].gainDbi, 8);
  assert.equal(request.patterns["test-omni@2350"].h.length, 360);
  assert.equal(request.patterns["test-omni@2350"].v.length, 181);
});

test("a carrier sent by one sector only leaves the other sector's antennas out", () => {
  const plan = cellPlan();
  plan.cellular.carriers[0].sectorIds = ["s1"];
  const { request } = buildCellularRequest(plan, "c1");
  assert.deepEqual(request.antennas.map((a) => a.id), ["a2"]);
  assert.deepEqual(request.sectors.map((s) => s.id), ["s1"]);
});

test("problems are reported in words instead of running a wrong prediction", () => {
  const plan = cellPlan();
  plan.cellular.carriers[0].freqMHz = 1500; // no datasheet row covers it
  plan.cellular.carriers[0].band = null;
  const problems = predictionProblems(plan, "c1");
  assert.ok(problems.some((p) => /GF-A1: Test omni has no datasheet values at 1500 MHz/.test(p)));
  assert.match(predictionProblems(plan, "nope")[0], /Add a band/);
  assert.deepEqual(buildCellularRequest(plan, "c1").request, undefined);
});

test("a plan without cellular data gets one default sector and the default settings", () => {
  const c = cellularOf(initialPlan());
  assert.equal(c.sectors.length, 1);
  assert.equal(c.carriers.length, 0);
  assert.equal(c.settings.receiverHeightM, 1.5);
});

test("Wi-Fi scenes leave cellular antennas out, cellular-only and geometry-only scenes are separate", async () => {
  const plan = cellPlan();
  const wifi = await buildSceneFiles(plan);
  assert.deepEqual(wifi.config.accessPoints.map((a) => a.id), ["ap1"]);
  const cell = await buildSceneFiles(plan, { sources: "cellular" });
  assert.deepEqual(cell.config.accessPoints.map((a) => a.id), ["a1", "a2"]);
  const none = await buildSceneFiles(plan, { sources: "none" });
  assert.deepEqual(none.config.accessPoints, []);
  assert.ok(!none.warnings.some((w) => /No access points/.test(w)));
  // moving a cellular antenna changes neither the Wi-Fi scene nor the geometry-only scene
  const moved = cellPlan();
  moved.sources[1] = { ...moved.sources[1], x: 9 };
  assert.equal((await buildSceneFiles(moved)).config.contentSha256, wifi.config.contentSha256);
  assert.equal((await buildSceneFiles(moved, { sources: "none" })).config.contentSha256, none.config.contentSha256);
});

import { parseCatalogue, withPatternFile } from "../src/infra/cellular/catalogueImport.js";
import { antennaModels, mapRanges } from "../src/infra/cellular/model.js";
import { BUILT_IN_ANTENNA_LIST, BUILT_IN_ANTENNAS } from "../src/infra/cellular/builtInAntennas.js";
import { cellStats, cellularCells } from "../src/infra/cellular/mapCells.js";

test("the built-in antennas are checked, every project has them, and a wrong catalogue file imports nothing", () => {
  const text = JSON.stringify({ antennas: BUILT_IN_ANTENNA_LIST });
  assert.deepEqual(Object.keys(antennaModels(initialPlan())).sort(), Object.keys(BUILT_IN_ANTENNAS).sort());
  assert.equal(BUILT_IN_ANTENNAS["frog-FR-AOF0740-25-NF-1C-IS"].name, "Omni SISO");
  const { antennas, errors } = parseCatalogue(text);
  assert.deepEqual(errors, []);
  const omniEntry = antennas["frog-FR-AOF0740-25-NF-1C-IS"];
  assert.equal(omniEntry.type, "omni");
  assert.equal(patternFor(omniEntry, 2350).gainDbi, 5);
  assert.equal(patternFor(omniEntry, 3500).gainDbi, 4);
  assert.equal(patternFor(antennas["frog-FR-AP0740-58-NF-1C-IS"], 1800).maxAttDb, 15);
  const bad = parseCatalogue(JSON.stringify({ antennas: [{ id: "x", name: "X", bands: [{ fromMHz: 900, toMHz: 800, gainDbi: 3, vBeamwidthDeg: 60 }] }] }));
  assert.deepEqual(bad.antennas, {});
  assert.ok(bad.errors.some((e) => /frequency range/.test(e)));
  assert.match(parseCatalogue("{oops").errors[0], /not JSON/);
});

test("a pattern file is attached to an antenna model and replaces one of the same frequency", () => {
  const h = Array.from({ length: 360 }, (_, a) => `${a} 0`).join("\n");
  const file = (f, g) => `NAME T\nFREQUENCY ${f}\nGAIN ${g} dBi\nHORIZONTAL 360\n${h}\nVERTICAL 360\n${h}\n`;
  let entry = withPatternFile(panel, file(2350, 7), "a.msi");
  entry = withPatternFile(entry, file(3500, 6), "b.msi");
  entry = withPatternFile(entry, file(2350, 7.5), "c.msi");
  assert.deepEqual(entry.patternFiles.map((p) => [p.freqMHz, p.gainDbi]), [[2350, 7.5], [3500, 6]]);
  assert.equal(patternFor(entry, 2350).gainDbi, 7.5);
});

test("map colour bands follow the project's edges", () => {
  const r = mapRanges(initialPlan(), "rsrp");
  assert.equal(r.length, 11);
  assert.equal(r[0].max, -120);
  assert.equal(r[10].min, -60);
  assert.equal(r[10].color, "#fb34fb");
  assert.equal(r[9].min, -69.65);
  // a project saved with the first 5-band default shows the design legend
  const old = { ...initialPlan(), cellular: { settings: { rsrpEdgesDbm: [-105, -95, -85, -75] } } };
  assert.equal(mapRanges(old, "rsrp").length, 11);
  // more bands than the 5 colours: interpolated, one colour per band
  const many = { ...initialPlan(), cellular: { settings: { rsrpEdgesDbm: [-110, -100, -95, -90, -85, -80, -70] } } };
  assert.equal(new Set(mapRanges(many, "rsrp").map((b) => b.color)).size, 8);
  const plan = { ...initialPlan(), cellular: { settings: { rsrpEdgesDbm: [-100, -90] } } };
  assert.deepEqual(mapRanges(plan, "rsrp").map((b) => [b.min, b.max]), [[-Infinity, -100], [-100, -90], [-90, Infinity]]);
  assert.equal(mapRanges(initialPlan(), "sinr")[1].label, "0 to 5 dB");
});

test("a cellular map becomes cells of the rooms only, with the serving sector and the target", () => {
  const map = {
    cellSizeM: 1,
    xCentersM: [0.5, 1.5, 25],
    zCentersM: [0.5],
    bestDbm: [[-80, null, -60]],
    bestSinrDb: [[12, null, 30]],
    bestApIndex: [[1, 0, 0]],
    sectors: [{ id: "s1", name: "Sector 1" }, { id: "s2", name: "Sector 2" }],
  };
  const room = { id: "r", shape: "rectangle", x: 0, z: 0, width: 10, depth: 10 };
  const cells = cellularCells(map, [room], [], { metric: "rsrp", threshold: -95 });
  assert.equal(cells.length, 2); // x = 25 is outside the room
  assert.deepEqual(cells.map((c) => [c.dbm, c.covered, c.sourceName]), [[-80, true, "Sector 2"], [-150, false, "Sector 1"]]);
  const sinr = cellularCells(map, [room], [], { metric: "sinr", threshold: 5 });
  assert.deepEqual(sinr.map((c) => c.dbm), [12, -20]);
  assert.equal(cellStats(cells).coveredPct, 50);
});
