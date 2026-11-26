import test from "node:test";
import assert from "node:assert/strict";
import { POE_TYPES, loopResistanceOhm, poeLink } from "../src/infra/wifi/ethernet.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";

const near = (a, b, tol = 1e-6, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

test("loop resistance: a 2-pair link uses one pair each way, a 4-pair link uses two", () => {
  // 100 m of 9.38 ohm per 100 m conductors
  near(loopResistanceOhm({ channelM: 100, resistancePer100m: 9.38, pairs: 2 }), 9.38);
  near(loopResistanceOhm({ channelM: 100, resistancePer100m: 9.38, pairs: 4 }), 4.69);
  near(loopResistanceOhm({ channelM: 50, resistancePer100m: 9.38, pairs: 2 }), 4.69);
  // copper resistance rises about 0.393 % per degree C
  near(loopResistanceOhm({ channelM: 100, resistancePer100m: 9.38, pairs: 2, tempC: 60 }), 9.38 * (1 + 0.00393 * 40), 1e-9);
});

test("PoE: current, AP voltage and cable loss follow V_pse = V_pd + I R with P_pd = V_pd I", () => {
  const t = POE_TYPES.at;
  const R = 9.38;
  const out = poeLink({ pdPowerW: t.pdPowerW, pseVoltageV: t.pseVoltageV, psePowerW: t.psePowerW, pdMinVoltageV: t.pdMinVoltageV, loopOhm: R });
  // hand calculation
  const I = (50 - Math.sqrt(2500 - 4 * R * 25.5)) / (2 * R);
  near(out.currentA, I, 1e-9);
  near(out.cableLossW, I * I * R, 1e-9);
  near(out.pdVoltageV, 25.5 / I, 1e-9);
  near(out.pdVoltageV + I * R, 50, 1e-9, "voltages add up"); // 50 V at the port
  near(out.psePowerNeededW, 25.5 + I * I * R, 1e-9);
  assert.equal(out.ok, true);
  assert.ok(out.cableLossW > 2.9 && out.cableLossW < 3.2);
});

test("PoE fails clearly when the cable cannot deliver, and when the port is too small", () => {
  const t = POE_TYPES.at;
  const dead = poeLink({ pdPowerW: 25.5, pseVoltageV: 50, psePowerW: 30, pdMinVoltageV: 42.5, loopOhm: 30 });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /too high/);
  const low = poeLink({ pdPowerW: 25.5, pseVoltageV: 50, psePowerW: 30, pdMinVoltageV: 48, loopOhm: 9.38 });
  assert.match(low.reason, /below its 48 V minimum/);
  const small = poeLink({ pdPowerW: 25.5, pseVoltageV: 50, psePowerW: 28, pdMinVoltageV: 42.5, loopOhm: 9.38 });
  assert.match(small.reason, /above the 28 W it supplies/);
  assert.equal(t.pairs, 2);
});

const hall = (sources, width = 40) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth: 10, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});
const ap = (id, x, z, extra = {}) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5, ...extra });
const rack = { id: "k1", floorId: "f1", x: 0.75, z: 0.75 };

test("each run reports the voltage the AP receives and the power lost in the cable", () => {
  const d = designWifiCabling({ plan: hall([ap("a", 30.25, 3.25)]), racks: [rack] });
  const run = d.runs[0];
  assert.ok(run.pdVoltageV >= 42.5 && run.pdVoltageV < 50);
  assert.ok(run.poeCableLossW > 0);
  assert.deepEqual(d.violations.filter((v) => v.severity === "error"), []);
});

test("a longer cable loses more power and delivers a lower voltage", () => {
  const d = designWifiCabling({ plan: hall([ap("near", 10.25, 3.25), ap("far", 38.25, 9.25)]), racks: [rack] });
  const [near_, far] = ["near", "far"].map((id) => d.runs.find((r) => r.apId === id));
  assert.ok(far.poeCableLossW > near_.poeCableLossW);
  assert.ok(far.pdVoltageV < near_.pdVoltageV);
});

test("a hot or high-resistance cable makes the PoE check fail with an error on that AP", () => {
  const catalogue = structuredClone(DEFAULT_WIFI_CATALOGUE);
  catalogue.cables.cat6a.dcResistanceOhmPer100m = 40; // a thin, poor cable
  const d = designWifiCabling({ plan: hall([ap("a", 30.25, 3.25)]), racks: [rack], catalogue });
  assert.equal(d.runs[0].check, "PoE");
  assert.ok(d.violations.some((v) => v.severity === "error" && v.item === "a" && /PoE over/.test(v.message)));
  // and temperature alone is accounted for
  const cold = designWifiCabling({ plan: hall([ap("a", 30.25, 3.25)]), racks: [rack] });
  const hot = designWifiCabling({ plan: hall([ap("a", 30.25, 3.25)]), racks: [rack], rules: { cableTempC: 60 } });
  assert.ok(hot.runs[0].poeCableLossW > cold.runs[0].poeCableLossW);
});

test("an over-long run keeps its 'too long' label even if PoE also fails", () => {
  const catalogue = structuredClone(DEFAULT_WIFI_CATALOGUE);
  catalogue.cables.cat6a.dcResistanceOhmPer100m = 40;
  const d = designWifiCabling({ plan: hall([ap("far", 150.25, 3.25)], 200), racks: [rack], catalogue });
  assert.equal(d.runs[0].check, "too long");
});

test("many cables in one tray section raise a bundle warning", () => {
  const aps = Array.from({ length: 30 }, (_, i) => ap(`ap${i}`, 30.25 + (i % 5) * 0.5, 1.25 + Math.floor(i / 5) * 1.25));
  const d = designWifiCabling({ plan: hall(aps), racks: [rack], rules: { bundleWarnCount: 5, trayShareFactor: 0.3 } });
  assert.ok(d.maxCablesPerSection > 5);
  assert.ok(d.violations.some((v) => /share one tray section/.test(v.message) && /TSB-184/.test(v.message)));
  const quiet = designWifiCabling({ plan: hall(aps.slice(0, 2)), racks: [rack] });
  assert.ok(!quiet.violations.some((v) => /share one tray section/.test(v.message)));
});
