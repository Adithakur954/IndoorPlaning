import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseSwitch,
  oversubscription,
  packSwitches,
  rackEngineering,
  strandsFor,
  usableBudgetW,
} from "../src/infra/wifi/network.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { DEFAULT_WIFI_CATALOGUE, DEFAULT_WIFI_RULES } from "../src/infra/wifi/catalogue.js";

const near = (a, b, tol = 0.01, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);
const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const S = DEFAULT_WIFI_CATALOGUE.switches;

test("fibre comes in standard strand counts", () => {
  assert.equal(strandsFor(5), 6);
  assert.equal(strandsFor(6), 6);
  assert.equal(strandsFor(12), 12);
  assert.equal(strandsFor(13), 24);
  assert.equal(strandsFor(100), 144);
  assert.equal(strandsFor(200), 288);
});

test("usable PoE: the margin comes off the budget, and N+1 sizes for one failed power supply", () => {
  near(usableBudgetW(S.sw24, { poeMargin: 0 }), 370);
  near(usableBudgetW(S.sw24, { poeMargin: 0.2 }), 296);
  const twoPsu = { ...S.sw24, poeBudgetW: 740, poeBudgetRedundantW: 370 };
  near(usableBudgetW(twoPsu, { psuRedundancy: "N+1", poeMargin: 0 }), 370);
  near(usableBudgetW(twoPsu, { psuRedundancy: "none", poeMargin: 0 }), 740);
  // no figure for the failed-supply case: half the budget is assumed
  near(usableBudgetW({ poeBudgetW: 400 }, { psuRedundancy: "N+1", poeMargin: 0 }), 200);
});

test("switches are packed by ports and watts; the margin and redundancy add switches", () => {
  const items = Array.from({ length: 13 }, () => ({ watts: 30, portPowerW: 30 }));
  assert.equal(packSwitches(items, S.sw24, DEFAULT_WIFI_RULES).length, 2); // 12 + 1
  assert.equal(packSwitches(items, S.sw24, { ...DEFAULT_WIFI_RULES, poeMargin: 0.5 }).length, 3); // 6 per switch
  const lone = { ...S.sw24, poeBudgetW: 740, poeBudgetRedundantW: 370 };
  assert.equal(packSwitches(items, lone, { ...DEFAULT_WIFI_RULES, psuRedundancy: "N+1" }).length, 2);
  assert.equal(packSwitches(items, lone, DEFAULT_WIFI_RULES).length, 1);
});

test("automatic switch choice: the model with the fewest switches, and only models that can feed the AP", () => {
  const items = Array.from({ length: 30 }, () => ({ watts: 30, portPowerW: 30 }));
  const best = chooseSwitch(items, S, DEFAULT_WIFI_RULES);
  assert.equal(best.bins.length, 2);
  assert.equal(best.part.id, "sw24bt"); // 2 switches and the fewest ports
  const hungry = Array.from({ length: 4 }, () => ({ watts: 60, portPowerW: 60 }));
  assert.equal(chooseSwitch(hungry, S, DEFAULT_WIFI_RULES).part.id, "sw24bt");
  assert.equal(chooseSwitch([{ watts: 90, portPowerW: 90 }], S, DEFAULT_WIFI_RULES), null);
});

test("oversubscription is access capacity over uplink capacity", () => {
  const o = oversubscription({ apCount: 24, apPortGbps: 1, switches: 1, uplinksPerSwitch: 2, uplinkGbps: 10 });
  near(o.ratio, 1.2);
  assert.equal(oversubscription({ apCount: 5, apPortGbps: 1, switches: 1, uplinksPerSwitch: 0, uplinkGbps: 10 }).ratio, Infinity);
});

test("rack engineering: units, power and heat against what the room offers", () => {
  const base = { switches: 3, switchPart: S.sw24, patchPanels: 2, fibrePanels: 1, poeAllocatedW: 270, rules: DEFAULT_WIFI_RULES };
  const roomy = rackEngineering({ rack: {}, ...base });
  // 3 switches + 2 patch panels + 1 fibre panel + 3 managers (1 per 2 devices)
  assert.equal(roomy.unitsUsed, 3 + 2 + 1 + 3);
  assert.equal(roomy.unitsUsable, Math.floor(42 * 0.8));
  assert.equal(roomy.powerW, 3 * 60 + 270);
  near(roomy.heatW, 3 * 60 + 0.15 * 270, 1);
  near(roomy.heatBtuHr, roomy.heatW * 3.412, 3); // heat is rounded to whole watts first
  assert.deepEqual(roomy.issues, []);
  const tight = rackEngineering({ rack: { rackUnits: 10, powerW: 200, coolingW: 150 }, ...base });
  assert.equal(tight.issues.length, 3);
  assert.match(tight.issues[0], /needs 9 U but only 8 U of 10 U/);
});

// ---- in a design ------------------------------------------------------------------------------------

const building = (sources) => ({
  floors: [{ id: "f1", name: "Ground", elevation: 0 }, { id: "f2", name: "First", elevation: 3.2 }],
  rooms: ["f1", "f2"].map((f) => ({ id: `r-${f}`, floorId: f, name: f, shape: "rectangle", x: 0, z: 0, width: 30, depth: 10, height: 3 })),
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, floorId, x, z = 3.25) => ({ id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5 });
const mdf = { id: "mdf", name: "Main room", floorId: "f1", x: 0.75, z: 4.75, role: "mdf" };
const idf = { id: "idf", name: "First floor room", floorId: "f2", x: 0.75, z: 4.75, role: "idf" };
const shaft = { id: "s", name: "Shaft", x: 28.75, z: 8.75 };
const two = (extra = {}) => designWifiCabling({ plan: building([ap("g", "f1", 10.25), ap("u", "f2", 10.25)]), racks: [mdf, idf], risers: [shaft], pathway: OPEN, ...extra });

test("a floor room is joined to the main room by fibre: length, strands, and what to buy", () => {
  const d = two();
  assert.deepEqual(d.network.mdf, ["Main room"]);
  assert.equal(d.network.uplinks.length, 1);
  const u = d.network.uplinks[0];
  // 32 m to the shaft on each floor + 3.2 m between floors, 2 x 2 m drops, 2 x 2 m loops, 5 % slack
  near(u.lengthM, (32 + 32 + 3.2 + 4 + 4) * 1.05, 0.05);
  assert.equal(u.strands, 6); // 1 switch x 2 uplinks x 2 strands, +25 % spare -> 5 -> 6
  assert.equal(u.links, 2);
  assert.equal(u.riserId, "s");
  const line = (id) => d.boq.find((l) => l.partId === id);
  near(line("fibre-om4-6").qty, u.lengthM, 0.01);
  assert.equal(line("sfp-10g-sr").qty, 4);
  assert.equal(line("fibre-cord").qty, 4);
  assert.equal(line("fibre-panel-24").qty, 2); // one at each end
  assert.ok(line("cable-manager-1u").qty >= 2);
  assert.equal(d.violations.filter((v) => v.severity === "error").length, 0);
});

test("no riser between the floors: the uplink cannot be routed, and the design says so", () => {
  const d = designWifiCabling({ plan: building([ap("g", "f1", 10.25), ap("u", "f2", 10.25)]), racks: [mdf, { ...idf, floorId: "f2" }], risers: [], pathway: OPEN });
  assert.equal(d.network.uplinks.length, 0);
  assert.ok(d.violations.some((v) => v.severity === "error" && /no route for the fibre uplink/.test(v.message)));
});

test("a fibre run longer than the cable allows is an error", () => {
  const catalogue = structuredClone(DEFAULT_WIFI_CATALOGUE);
  catalogue.fibre.cable.maxLengthM = 50;
  const d = two({ catalogue });
  assert.ok(d.violations.some((v) => v.severity === "error" && /fibre uplink .* is longer than 50 m/.test(v.message)));
});

test("two racks with no main room marked: one is treated as the main room, with a warning", () => {
  const d = designWifiCabling({ plan: building([ap("g", "f1", 10.25), ap("u", "f2", 10.25)]), racks: [{ ...mdf, role: undefined }, { ...idf, role: undefined }], risers: [shaft], pathway: OPEN });
  assert.ok(d.violations.some((v) => v.severity === "warning" && /no rack is marked as the main room/.test(v.message)));
  assert.equal(d.network.racks.filter((r) => r.role === "mdf").length, 1);
  // one rack: nothing to warn about, no uplinks
  const solo = designWifiCabling({ plan: building([ap("g", "f1", 10.25)]), racks: [mdf], pathway: OPEN });
  assert.equal(solo.network.uplinks.length, 0);
  assert.ok(!solo.violations.some((v) => /main room/.test(v.message)));
});

test("a rack too small for its equipment, or short of power or cooling, is an error", () => {
  const small = { ...mdf, rackUnits: 3, powerW: 50, coolingW: 20 };
  const d = designWifiCabling({ plan: building([ap("g", "f1", 10.25)]), racks: [small], pathway: OPEN });
  const messages = d.violations.filter((v) => v.severity === "error").map((v) => v.message).join(" | ");
  assert.match(messages, /needs \d+ U but only/);
  assert.match(messages, /the room supplies 50 W/);
  assert.match(messages, /the cooling is 20 W/);
  const eng = d.network.racks[0];
  assert.ok(eng.unitsUsed > 0 && eng.powerW > 0 && eng.heatBtuHr > 0);
});

test("oversubscription above the limit is a warning", () => {
  const sources = Array.from({ length: 20 }, (_, i) => ap(`a${i}`, "f1", 4.25 + i, 2.25 + (i % 4)));
  const ok = designWifiCabling({ plan: building(sources), racks: [mdf], pathway: OPEN });
  assert.ok(!ok.violations.some((v) => /:1, above the/.test(v.message)));
  assert.ok(ok.network.racks[0].oversubscription.ratio < 20);
  const tight = designWifiCabling({ plan: building(sources), racks: [mdf], pathway: OPEN, rules: { maxOversubscription: 0.3 } });
  assert.ok(tight.violations.some((v) => v.severity === "warning" && /:1, above the 0.3:1 limit/.test(v.message)));
});

test("automatic switch choice in a design, plus PoE margin and redundancy", () => {
  const sources = Array.from({ length: 30 }, (_, i) => ap(`a${i}`, "f1", 4.25 + (i % 25), 2.25 + Math.floor(i / 25) * 2));
  const auto = designWifiCabling({ plan: building(sources), racks: [mdf], pathway: OPEN, rules: { switchPartId: "auto" } });
  assert.equal(auto.racks[0].switchPartId, "sw24bt");
  assert.equal(auto.racks[0].switches, 2);
  assert.equal(auto.boq.find((l) => l.partId === "sw24bt").qty, 2);
  const fixed = designWifiCabling({ plan: building(sources), racks: [mdf], pathway: OPEN });
  assert.equal(fixed.racks[0].switches, 3);
  const margin = designWifiCabling({ plan: building(sources.slice(0, 13)), racks: [mdf], pathway: OPEN, rules: { poeMargin: 0.5 } });
  assert.equal(margin.racks[0].switches, 3);
  assert.match(margin.boq.find((l) => l.partId === "sw24").basis, /50% margin/);
});
