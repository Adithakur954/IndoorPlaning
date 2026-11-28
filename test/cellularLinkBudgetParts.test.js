// The parts of the supplied 5G SISO design (iBwave Horizontal Link Budget Report,
// 17-11-2026) reproduce that report's downlink at 3.5 GHz: two of its antenna
// paths, typed from the report, give the same total loss as iBwave.
import test from "node:test";
import assert from "node:assert/strict";
import { computeDownlink } from "../src/infra/cellular/engine/linkBudget.js";
import { DEFAULT_CATALOGUE } from "../src/infra/cellular/engine/catalogue.js";

// a chain BTS -> parts... -> antenna; each step { type, partId, port?, cableId, lengthM }
// (the step's cable runs into that part). iBwave's report counts no connector loss.
function chainPower(steps) {
  const nodes = { bts: { type: "bts" } };
  const edges = [];
  let prev = "bts";
  let prevType = "bts";
  steps.forEach((s, i) => {
    const id = i === steps.length - 1 ? "ant" : `n${i}`;
    nodes[id] = s.type === "antenna" ? { type: "antenna", partId: "omni2" } : { type: s.type, partId: s.partId };
    edges.push({
      from: prev,
      to: id,
      cableId: s.cableId || "hfc12d",
      lengthM: s.lengthM || 0,
      connectors: 0,
      ...(prevType === "coupler" ? { port: s.fromPort } : {}),
    });
    prev = id;
    prevType = s.type;
  });
  const r = computeDownlink({ network: { rootId: "bts", nodes, edges }, catalogue: DEFAULT_CATALOGUE, freqMHz: 3500, btsPowerDbm: 43 });
  return r.antennas.ant.powerDbm;
}

const head = [
  { type: "inline", partId: "fps2405" },
  { type: "inline", partId: "cm0642-44" },
];

test("1F-A1: 2 x 5 dB through, 3 x 2-way, 92.96 m HFC 12D: total -36.10 dB", () => {
  const power = chainPower([
    ...head,
    { type: "coupler", partId: "cp0642-5" },
    { type: "coupler", partId: "cp0642-5", fromPort: "through" },
    { type: "splitter", partId: "sp0642-2w", fromPort: "through" },
    { type: "splitter", partId: "sp0642-2w" },
    { type: "splitter", partId: "sp0642-2w" },
    { type: "antenna", cableId: "hfc12d", lengthM: 92.96 },
  ]);
  assert.ok(Math.abs(power - (43 - 36.1)) < 0.05, `port power ${power}`);
});

test("1F-A13: 7 dB through, 3 x 5 dB tap, 2-way, 20.01 m HFC 12D + 77.34 m HFC 22D: total -37.15 dB", () => {
  const power = chainPower([
    ...head,
    { type: "coupler", partId: "cp0642-7", cableId: "hfc22d", lengthM: 77.34 },
    { type: "coupler", partId: "cp0642-5", fromPort: "through" },
    { type: "coupler", partId: "cp0642-5", fromPort: "tap" },
    { type: "coupler", partId: "cp0642-5", fromPort: "tap" },
    { type: "splitter", partId: "sp0642-2w", fromPort: "tap" },
    { type: "antenna", cableId: "hfc12d", lengthM: 20.01 },
  ]);
  assert.ok(Math.abs(power - (43 - 37.15)) < 0.05, `port power ${power}`);
});

test("the HFC cables refuse bands the report does not give, instead of guessing", () => {
  assert.throws(
    () =>
      computeDownlink({
        network: { rootId: "b", nodes: { b: { type: "bts" }, a: { type: "antenna", partId: "omni2" } }, edges: [{ from: "b", to: "a", cableId: "hfc12d", lengthM: 10, connectors: 0 }] },
        catalogue: DEFAULT_CATALOGUE,
        freqMHz: 2300,
        btsPowerDbm: 43,
      }),
    /no datasheet loss for 2300 MHz/,
  );
});
