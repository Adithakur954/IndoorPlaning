import test from "node:test";
import assert from "node:assert/strict";
import {
  freeSpaceLossDb,
  perResourceElementDbm,
  referenceSignalAtPort,
  resourceBlocks,
  wattsToDbm,
} from "../src/infra/cellular/engine/rf.js";
import {
  cableLossDb,
  couplerIdealThroughLossDb,
  lossAtFrequency,
  splitterLossDb,
} from "../src/infra/cellular/engine/passive.js";
import {
  computeDownlink,
  computeUplink,
} from "../src/infra/cellular/engine/linkBudget.js";
import { DEFAULT_CATALOGUE } from "../src/infra/cellular/engine/catalogue.js";

const near = (actual, expected, tolerance = 0.001, label = "") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual}`,
  );

// Catalogue with round numbers so every expected value can be checked by hand.
const flat = (loss) => [
  { freqMHz: 700, loss },
  { freqMHz: 2700, loss },
];
const catalogue = {
  antennas: { omni: { id: "omni", gainDbi: 2 } },
  cables: {
    "7/8": { id: "7/8", lossDbPer100m: flat(3.9), maxPowerW: 500 },
    "1/2": { id: "1/2", lossDbPer100m: flat(6.9), maxPowerW: 250 },
  },
  couplers: {
    c10: { id: "c10", couplingDb: 10, excessLossDb: 0.3, maxPowerW: 200 },
    c7: { id: "c7", couplingDb: 7, excessLossDb: 0.3, maxPowerW: 200 },
  },
  splitters: {
    s2: { id: "s2", ways: 2, excessLossDb: 0.3, maxPowerW: 200 },
    s3: { id: "s3", ways: 3, excessLossDb: 0.3, maxPowerW: 200 },
  },
  inline: { combiner: { id: "combiner", lossDb: 0.5, maxPowerW: 200 } },
  connector: { id: "n", lossDb: 0.1 },
};

const edge = (from, to, cableId, lengthM, extra = {}) => ({
  from,
  to,
  cableId,
  lengthM,
  connectors: 0,
  ...extra,
});

// BTS -> 40 m of 7/8 cable -> coupler A (10 dB)
//   tap     : 10 m of 1/2 cable -> antenna A
//   through : 12 m of 7/8 cable -> coupler B (7 dB)
//       tap     : 8 m of 1/2 cable -> antenna B
//       through : 5 m of 1/2 cable -> antenna C
const chain = () => ({
  rootId: "bts",
  nodes: {
    bts: { type: "bts" },
    cA: { type: "coupler", partId: "c10" },
    cB: { type: "coupler", partId: "c7" },
    antA: { type: "antenna", partId: "omni" },
    antB: { type: "antenna", partId: "omni" },
    antC: { type: "antenna", partId: "omni" },
  },
  edges: [
    edge("bts", "cA", "7/8", 40),
    edge("cA", "antA", "1/2", 10, { port: "tap" }),
    edge("cA", "cB", "7/8", 12, { port: "through" }),
    edge("cB", "antB", "1/2", 8, { port: "tap" }),
    edge("cB", "antC", "1/2", 5, { port: "through" }),
  ],
});

const run = (network, btsPowerDbm = 33, freqMHz = 1800) =>
  computeDownlink({ network, catalogue, freqMHz, btsPowerDbm });

test("carrier power converts to power per resource element", () => {
  assert.equal(resourceBlocks(20), 100);
  assert.equal(resourceBlocks(10), 50);
  near(perResourceElementDbm(43, 20), 43 - 30.7918, 0.001);
  near(perResourceElementDbm(43, 10), 43 - 27.7815, 0.001);
  assert.throws(() => resourceBlocks(7), /Unsupported LTE bandwidth/);
});

test("a stated reference-signal power wins over the equal-power assumption", () => {
  const assumed = referenceSignalAtPort({
    carrierPowerDbm: 43,
    bandwidthMHz: 20,
  });
  assert.equal(assumed.source, "equal-power assumption");
  const stated = referenceSignalAtPort({
    carrierPowerDbm: 43,
    bandwidthMHz: 20,
    referenceSignalPowerDbm: 15.2,
  });
  assert.deepEqual(stated, { dbm: 15.2, source: "stated" });
});

test("free-space loss and watt conversion", () => {
  near(freeSpaceLossDb(20, 1800), 63.576, 0.001);
  near(wattsToDbm(2), 33.0103, 0.001);
});

test("coupler and splitter losses follow the power split", () => {
  near(couplerIdealThroughLossDb(5), 1.6509, 0.0005, "5 dB");
  near(couplerIdealThroughLossDb(7), 0.9665, 0.0005, "7 dB");
  near(couplerIdealThroughLossDb(10), 0.4576, 0.0005, "10 dB");
  near(couplerIdealThroughLossDb(15), 0.1396, 0.0005, "15 dB");
  near(splitterLossDb({ ways: 2 }), 3.0103, 0.0005);
  near(splitterLossDb({ ways: 3, excessLossDb: 0.3 }), 4.7712 + 0.3, 0.0005);
  assert.throws(() => couplerIdealThroughLossDb(0), /above 0 dB/);
});

test("datasheet losses are interpolated in log frequency and never extrapolated", () => {
  const table = [
    { freqMHz: 900, loss: 2.5 },
    { freqMHz: 1800, loss: 3.6 },
  ];
  near(lossAtFrequency(table, 900), 2.5);
  near(lossAtFrequency(table, 1800), 3.6);
  near(lossAtFrequency(table, Math.sqrt(900 * 1800)), 3.05, 0.0005);
  assert.throws(
    () => lossAtFrequency(table, 700),
    /no datasheet loss for 700 MHz/,
  );
  assert.throws(
    () => lossAtFrequency(table, 2600),
    /no datasheet loss for 2600 MHz/,
  );
  near(cableLossDb({ lossDbPer100m: flat(3.9) }, 40, 1800), 1.56);
});

test("power at each antenna: hand calculation of a three-antenna chain", () => {
  const result = run(chain());
  const throughA = 0.4575749 + 0.3;
  const throughB = 0.966529 + 0.3;
  const atCouplerA = 33 - 40 * 0.039; // 31.44
  const atCouplerB = atCouplerA - throughA - 12 * 0.039;
  near(
    result.antennas.antA.powerDbm,
    atCouplerA - (10 + 0.3) - 10 * 0.069,
    0.0001,
    "A",
  );
  near(
    result.antennas.antB.powerDbm,
    atCouplerB - (7 + 0.3) - 8 * 0.069,
    0.0001,
    "B",
  );
  near(
    result.antennas.antC.powerDbm,
    atCouplerB - throughB - 5 * 0.069,
    0.0001,
    "C",
  );
  near(
    result.antennas.antA.eirpDbm,
    result.antennas.antA.powerDbm + 2,
    1e-9,
  );
  near(
    result.antennas.antA.pathLossDb,
    33 - result.antennas.antA.powerDbm,
    1e-9,
  );
});

test("power never rises along any path", () => {
  const { antennas } = run(chain());
  for (const a of Object.values(antennas)) {
    let previous = 33;
    for (const step of a.steps) {
      assert.ok(step.powerAfterDbm <= previous + 1e-12);
      previous = step.powerAfterDbm;
    }
  }
});

test("connectors are counted on every cable run", () => {
  const network = chain();
  network.edges = network.edges.map((e) => ({ ...e, connectors: 2 }));
  const base = run(chain());
  const withConnectors = run(network);
  // antenna A sits behind two cable runs: 2 runs x 2 connectors x 0.1 dB
  near(
    base.antennas.antA.powerDbm - withConnectors.antennas.antA.powerDbm,
    0.4,
  );
});

test("a splitter divides the power and inline parts add a fixed loss", () => {
  const network = {
    rootId: "bts",
    nodes: {
      bts: { type: "bts" },
      comb: { type: "inline", partId: "combiner" },
      sp: { type: "splitter", partId: "s3" },
      a1: { type: "antenna", partId: "omni" },
      a2: { type: "antenna", partId: "omni" },
      a3: { type: "antenna", partId: "omni" },
    },
    edges: [
      edge("bts", "comb", "7/8", 0),
      edge("comb", "sp", "7/8", 0),
      edge("sp", "a1", "1/2", 0),
      edge("sp", "a2", "1/2", 0),
      edge("sp", "a3", "1/2", 0),
    ],
  };
  const r = run(network, 30);
  near(r.antennas.a1.powerDbm, 30 - 0.5 - (4.7712 + 0.3), 0.0005);
  assert.equal(r.antennas.a1.powerDbm, r.antennas.a3.powerDbm);
});

test("over-rated parts produce a warning", () => {
  // 60 dBm is 1 kW, far above the 200 W (53 dBm) coupler
  const r = run(chain(), 60);
  assert.ok(r.warnings.some((w) => /cA/.test(w) && /rating/.test(w)));
});

test("a broken network is refused instead of calculated", () => {
  const twoParents = chain();
  twoParents.edges.push(edge("cB", "antA", "1/2", 3, { port: "tap" }));
  assert.throws(() => run(twoParents), /two parents/);

  const unknownPart = chain();
  unknownPart.nodes.cA.partId = "c99";
  assert.throws(() => run(unknownPart), /not in the catalogue/);

  const noPort = chain();
  delete noPort.edges[1].port;
  assert.throws(() => run(noPort), /needs port/);

  const tooMany = {
    rootId: "bts",
    nodes: {
      bts: { type: "bts" },
      sp: { type: "splitter", partId: "s2" },
      a: { type: "antenna", partId: "omni" },
      b: { type: "antenna", partId: "omni" },
      c: { type: "antenna", partId: "omni" },
    },
    edges: [
      edge("bts", "sp", "7/8", 1),
      edge("sp", "a", "1/2", 1),
      edge("sp", "b", "1/2", 1),
      edge("sp", "c", "1/2", 1),
    ],
  };
  assert.throws(() => run(tooMany), /2-way/);

  const orphan = chain();
  orphan.nodes.lost = { type: "antenna", partId: "omni" };
  assert.throws(() => run(orphan), /not connected/);

  assert.throws(
    () => run(chain(), 33, 3500),
    /no datasheet loss for 3500/,
  );
});

test("uplink: reciprocal loss, noise funnelling grows with the antenna count", () => {
  const downlink = run(chain());
  const bts = { bandwidthMHz: 20, noiseFigureDb: 5, requiredSnrDb: -1 };
  const up = computeUplink({ downlink, mobileEirpDbm: 23, bts });
  near(up.btsNoiseDbm, -174 + 10 * Math.log10(20e6) + 5, 1e-9);
  near(up.sensitivityDbm, up.btsNoiseDbm - 1, 1e-9);
  const a = downlink.antennas.antA;
  near(
    up.antennas.antA.maxAirLossDb,
    23 + 2 - a.pathLossDb - up.sensitivityDbm,
    1e-9,
  );
  assert.ok(up.noiseRiseDb > 0);

  const one = { antennas: { antA: downlink.antennas.antA } };
  assert.ok(computeUplink({ downlink: one, bts }).noiseRiseDb < up.noiseRiseDb);
});

test("the default catalogue marks every value as illustrative", () => {
  for (const group of ["antennas", "cables", "couplers", "splitters", "inline"])
    for (const item of Object.values(DEFAULT_CATALOGUE[group]))
      assert.match(item.source, /illustrative/);
  // and the defaults work with the engine at a supported band
  assert.ok(cableLossDb(DEFAULT_CATALOGUE.cables["7/8"], 10, 1800) > 0);
});
