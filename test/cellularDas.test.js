import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";
import { cableLengthM, cableLossAt, cableProblem, dasPowers, newCable, newDasPart } from "../src/infra/cellular/das.js";
import { buildCellularRequest } from "../src/infra/cellular/request.js";
import { BAND_PRESETS, presetCarrierFields } from "../src/infra/cellular/bands.js";
import { DEFAULT_CATALOGUE } from "../src/infra/cellular/engine/catalogue.js";
import { cableLossDb, splitterLossDb } from "../src/infra/cellular/engine/passive.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const band2300 = { id: "b2300", ...presetCarrierFields(BAND_PRESETS.find((p) => p.mhz === 2300)) };

// source (43 dBm) -> 10 m 1/2" -> 2-way splitter -> 5 m and 7 m 1/2" -> two omni antennas; a third antenna is not connected
function dasPlan() {
  let plan = {
    ...initialPlan(),
    projectType: "cellular",
    floors: [
      { id: "f0", name: "Ground", elevation: 0 },
      { id: "f1", name: "First", elevation: 4 },
    ],
    rooms: [{ id: "r0", floorId: "f0", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 30, depth: 20, height: 3.5, material: "concrete" }],
    sources: [
      { id: "a1", floorId: "f0", kind: "cellular", name: "A1", x: 15, z: 5, heightM: 3, antennaModelId: "frog-FR-AOF0740-25-NF-1C-IS", sectorId: "sector-1", inputPowerDbm: 15 },
      { id: "a2", floorId: "f0", kind: "cellular", name: "A2", x: 3, z: 17, heightM: 3, antennaModelId: "frog-FR-AOF0740-25-NF-1C-IS", sectorId: "sector-1", inputPowerDbm: 15 },
      { id: "a3", floorId: "f0", kind: "cellular", name: "A3", x: 25, z: 15, heightM: 3, antennaModelId: "frog-FR-AOF0740-25-NF-1C-IS", sectorId: "sector-1", inputPowerDbm: 12 },
      { id: "ap", floorId: "f0", kind: "wifi", name: "AP", x: 1, z: 1, heightM: 2.7, txPowerDbm: 20, freqMHz: 2400 },
    ],
    cellular: { carriers: [band2300] },
  };
  const add = (s) => (plan = { ...plan, sources: [...plan.sources, s] });
  add({ ...newDasPart(plan, "source", "f0", { x: 0, z: 10 }, "src"), powerDbm: { b2300: 43 } });
  add(newDasPart(plan, "splitter", "f0", { x: 10, z: 10 }, "sp"));
  const cable = (from, to, id) => {
    assert.equal(cableProblem(plan, from, to), null);
    plan = { ...plan, cellular: { ...plan.cellular, cables: [...(plan.cellular.cables || []), newCable(plan, from, to, id)] } };
  };
  cable("src", "sp", "c1"); // 10 m
  cable("sp", "a1", "c2"); // hypot(5, 5)
  cable("sp", "a2", "c3"); // hypot(7, 7)
  return plan;
}

test("a DAS part gets a name and default part, and the source a power per band", () => {
  const plan = initialPlan();
  const sp = newDasPart(plan, "splitter", "level-1", { x: 1, z: 2 }, "x");
  assert.deepEqual([sp.kind, sp.dasType, sp.name, sp.partId], ["das", "splitter", "SP1", "s2"]);
  assert.equal(newDasPart(plan, "coupler", "level-1", { x: 0, z: 0 }, "y").partId, "c10");
});

test("each connected antenna gets the source power less the cables, connectors and splitter", () => {
  const plan = dasPlan();
  const r = dasPowers(plan, band2300);
  assert.deepEqual(r.errors, []);
  const cable = DEFAULT_CATALOGUE.cables["1/2"];
  const conn = 2 * DEFAULT_CATALOGUE.connector.lossDb;
  const f = band2300.freqMHz;
  const expectA1 = 43 - cableLossDb(cable, 10, f) - conn - splitterLossDb(DEFAULT_CATALOGUE.splitters.s2) - cableLossDb(cable, Math.hypot(5, 5), f) - conn;
  near(r.antennas.a1.powerDbm, expectA1);
  assert.ok(r.antennas.a2.powerDbm < r.antennas.a1.powerDbm, "the longer cable loses more");
  assert.equal(r.antennas.a3, undefined, "an antenna without a cable keeps its typed power");
  assert.ok(r.antennas.a1.steps.some((s) => s.kind === "splitter"));
});

test("the prediction uses the calculated port power where the network feeds the antenna", () => {
  const plan = dasPlan();
  const { problems, request, notes } = buildCellularRequest(plan, "b2300");
  assert.deepEqual(problems, []);
  const power = Object.fromEntries(request.antennas.map((a) => [a.id, a.powerDbm]));
  near(power.a1, dasPowers(plan, band2300).antennas.a1.powerDbm, 1e-3);
  assert.equal(power.a3, 12);
  assert.ok(notes.some((n) => /2 of 3 antennas/.test(n)));
});

test("cables between floors add the floor height; extra length is added", () => {
  let plan = dasPlan();
  const riser = newDasPart(plan, "riser", "f1", { x: 0, z: 10 }, "r1");
  plan = { ...plan, sources: [...plan.sources, riser] };
  near(cableLengthM(plan, { from: "src", to: "r1", extraM: 2 }), 4 + 2);
  assert.ok(cableLossAt(plan, { from: "src", to: "r1", cableId: "7/8", connectors: 2 }, 3500).totalDb > 0);
});

test("a riser cable defaults to the 7/8 feeder; a combiner adds its datasheet loss", () => {
  let plan = dasPlan();
  const riser = newDasPart(plan, "riser", "f1", { x: 0, z: 10 }, "r1");
  const comb = newDasPart(plan, "combiner", "f0", { x: 2, z: 10 }, "cb");
  plan = { ...plan, sources: [...plan.sources, riser, comb] };
  assert.equal(newCable(plan, "src", "r1", "x").cableId, "7/8");
  assert.equal(newCable(plan, "sp", "a1", "y").cableId, "1/2");
  assert.equal(comb.partId, "cm21");
  assert.equal(DEFAULT_CATALOGUE.inline.cm21.lossDb, 3.8);
});

test("a cable that would break the tree is refused", () => {
  const plan = dasPlan();
  assert.match(cableProblem(plan, "a1", "sp"), /is an antenna/);
  assert.match(cableProblem(plan, "sp", "src"), /is a source/);
  assert.match(cableProblem(plan, "src", "a1"), /already fed/);
  assert.match(cableProblem(plan, "sp", "a3"), /2-way splitter/);
  const withCoupler = { ...plan, sources: [...plan.sources, newDasPart(plan, "coupler", "f0", { x: 20, z: 10 }, "cp")] };
  assert.equal(cableProblem(withCoupler, "cp", "a3"), null);
  assert.equal(newCable(withCoupler, "cp", "a3", "z").port, "through");
});

test("DAS parts are never in a Wi-Fi or cellular scene", async () => {
  const plan = dasPlan();
  const wifi = await buildSceneFiles(plan);
  assert.deepEqual(wifi.config.accessPoints.map((a) => a.id), ["ap"]);
  const cell = await buildSceneFiles(plan, { sources: "cellular" });
  assert.deepEqual(cell.config.accessPoints.map((a) => a.id).sort(), ["a1", "a2", "a3"]);
});
