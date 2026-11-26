import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_CAPACITY_MODEL,
  DEFAULT_LOAD_TEST,
  DEFAULT_MONTE_CARLO,
  MIN_SNR_DB,
  STANDARDS,
  capacityLinks,
  capacityMeta,
  capacityReady,
  capacitySensitivity,
  loadTestCapacity,
  loadTestHeatmap,
  maxWidthMHz,
  monteCarloCapacity,
  planWifiCapacity,
} from "../src/infra/wifi/capacityModel.js";
import { inside } from "../src/utils/geometry.js";

await capacityReady;

// ---------------------------------------------------------------- the port

// numbers equal to 1e-9 relative; JSON turns NaN into null
function diff(a, b, path = "$") {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = diff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const golden = JSON.parse(readFileSync(new URL("./fixtures/capacity-golden.json", import.meta.url), "utf8"));

test("the Rust engine reproduces the JavaScript engine it replaced, field for field", () => {
  assert.ok(golden.cases.length >= 40);
  for (const c of golden.cases) {
    const out = planWifiCapacity({ plan: c.plan, settings: c.settings, cells: c.cells });
    assert.equal(diff(c.expected, out), null, c.name);
    if (c.sensitivity) assert.equal(diff(c.sensitivity, capacitySensitivity({ plan: c.plan, settings: c.settings, cells: c.cells })), null, `${c.name} sensitivity`);
  }
});

test("the planner's copy of the defaults and limits matches the engine", () => {
  const meta = capacityMeta();
  assert.deepEqual(meta.defaults, DEFAULT_CAPACITY_MODEL);
  assert.deepEqual(meta.monteCarloDefaults, DEFAULT_MONTE_CARLO);
  assert.deepEqual(meta.loadTestDefaults, DEFAULT_LOAD_TEST);
  assert.deepEqual(meta.standards, STANDARDS);
  assert.deepEqual(meta.minSnrDb, MIN_SNR_DB);
  for (const [standard, bands] of Object.entries(meta.maxWidthMHz))
    for (const [band, width] of Object.entries(bands)) assert.equal(maxWidthMHz(standard, band), width, `${standard} ${band}`);
});

// ---------------------------------------------------------------- Monte Carlo

const room = (id, x, z, w, d, extra = {}) => ({ id, floorId: "f1", name: id, shape: "rectangle", x, z, width: w, depth: d, height: 3, ...extra });
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });
const office = (extra = {}) => ({
  floors: [{ id: "f1", name: "L1", elevation: 0 }],
  rooms: [room("open", 0, 0, 40, 20), room("plant", 34, 14, 6, 6, { receiverGrid: "excluded" })],
  sources: [ap("a1", 8, 10), ap("a2", 20, 10), ap("a3", 32, 10)],
  boundaries: [],
  furniture: [],
  doors: [],
  windows: [],
  interiorWalls: [],
  ...extra,
});
const mc = (settings = {}, plan = office(), cells = null) => monteCarloCapacity({ plan, settings, cells });

test("every person becomes one user with an x, z position on the floor, never in an excluded room", () => {
  const out = mc({ totalPeople: 50, monteCarlo: { iterations: 20, maxIterations: 20 } });
  const users = out.samples.median.users;
  assert.equal(users.length, 50);
  assert.equal(out.floor.users.min, 50);
  assert.equal(out.floor.users.max, 50);
  const plan = office();
  const [open, plant] = plan.rooms;
  for (const u of users) {
    assert.ok(Number.isFinite(u.x) && Number.isFinite(u.z), u.id);
    assert.ok(inside(u.x, u.z, open), `${u.id} at ${u.x}, ${u.z} is off the floor`);
    assert.ok(!inside(u.x, u.z, plant), `${u.id} is in the excluded room`);
  }
  assert.match(users[0].id, /^U\d{3}$/);
});

test("from each user's spot: distance, RSSI and SNR to every AP; devices join the strongest", () => {
  const plan = office();
  const settings = { totalPeople: 30, monteCarlo: { iterations: 5, maxIterations: 5 } };
  const out = mc(settings, plan);
  let devices = 0;
  for (const u of out.samples.median.users) {
    const links = capacityLinks({ plan, settings, floorId: u.floorId, x: u.x, z: u.z });
    assert.equal(links.length, 3);
    for (const a of links) {
      const src = plan.sources.find((s) => s.id === a.apId);
      const dist = Math.max(1, Math.hypot(src.x - u.x, src.z - u.z));
      assert.ok(Math.abs(a.distanceM - dist) < 0.01, `${u.id}: ${a.distanceM} vs ${dist}`);
    }
    for (let i = 1; i < links.length; i++) assert.ok(links[i - 1].rssiDbm >= links[i].rssiDbm, "strongest first");
    for (const d of u.devices) {
      devices++;
      assert.ok(["ok", "idle", "weak signal", "AP congested", "internet limited"].includes(d.status), d.status);
      // positions are reported to the centimetre, so allow that much
      const tie = links[0].rssiDbm - links[1].rssiDbm < 0.2;
      if (!tie) assert.equal(d.apId, links[0].apId, `${d.id} joins the strongest AP`);
      const link = links.find((a) => a.apId === d.apId);
      assert.ok(Math.abs(link.distanceM - d.distanceM) < 0.02 && Math.abs(link.snrDb - d.snrDb) <= 0.15, d.id);
    }
  }
  assert.ok(devices > 0);
});

test("the same seed gives the same result; another seed gives other positions", () => {
  const s = { totalPeople: 40, monteCarlo: { iterations: 30, maxIterations: 30, seed: 7 } };
  const a = mc(s);
  const b = mc(s);
  assert.deepEqual(a, b);
  const c = mc({ ...s, monteCarlo: { ...s.monteCarlo, seed: 8 } });
  assert.notDeepEqual(a.samples.median.users.map((u) => [u.x, u.z]), c.samples.median.users.map((u) => [u.x, u.z]));
});

test("on average, the simulation agrees with the deterministic model", () => {
  const settings = { totalPeople: 120, monteCarlo: { iterations: 400, maxIterations: 400 } };
  const det = planWifiCapacity({ plan: office(), settings });
  const out = mc(settings);
  for (const a of out.aps) {
    const d = det.aps.find((x) => x.id === a.id);
    assert.ok(Math.abs(a.devices.mean - d.devices) <= Math.max(3, d.devices * 0.1), `${a.id}: ${a.devices.mean} vs ${d.devices}`);
    assert.ok(Math.abs(a.activeDevices.mean - d.activeDevices) <= Math.max(2, d.activeDevices * 0.1), `${a.id} active`);
    assert.equal(a.deterministic.devices, d.devices);
  }
  assert.ok(Math.abs(out.floor.devices.mean - det.wan.totalDevices) < det.wan.totalDevices * 0.05);
  // the spread is real: P95 is above P50 somewhere
  assert.ok(out.aps.some((a) => a.devices.p95 > a.devices.p50));
});

test("zones keep their headcount and empty zones hold nobody", () => {
  const plan = office();
  const zones = [
    { id: "z1", floorId: "f1", name: "Call centre", x: 0, z: 0, width: 10, depth: 10, people: 25 },
    { id: "z2", floorId: "f1", name: "Void", x: 20, z: 0, width: 10, depth: 20, people: 0 },
  ];
  const out = mc({ totalPeople: 60, zones, monteCarlo: { iterations: 10, maxIterations: 10 } }, plan);
  const users = out.samples.median.users;
  assert.equal(users.length, 60);
  assert.equal(users.filter((u) => u.zone === "Call centre").length, 25);
  for (const u of users) {
    if (u.zone === "Call centre") assert.ok(u.x <= 10 && u.z <= 10);
    assert.ok(!(u.x > 20 && u.x < 30), `${u.id} is in the empty zone`);
  }
});

test("a crowded floor is likely to overload; a quiet one is not", () => {
  const quiet = mc({ totalPeople: 10, wanDownMbps: 10000, monteCarlo: { iterations: 50, maxIterations: 50 } });
  const crowded = mc({ totalPeople: 600, wanDownMbps: 10000, monteCarlo: { iterations: 50, maxIterations: 50 } });
  assert.equal(quiet.floor.allTargetsMet.pct, 100);
  assert.ok(quiet.aps.every((a) => a.overload.pct === 0));
  assert.ok(crowded.aps.some((a) => a.overload.pct > 50));
  assert.ok(crowded.floor.allTargetsMet.pct < 50);
  assert.ok(crowded.worstAp && crowded.worstAp.overload.pct > 50);
  assert.ok(crowded.bins.length > 0 && crowded.bins.some((b) => b.failPct > 0));
});

test("traffic profiles: each device gets a profile and a speed in its range", () => {
  const out = mc({ totalPeople: 100, monteCarlo: { traffic: "profiles", iterations: 20, maxIterations: 20 } });
  const devices = out.samples.median.users.flatMap((u) => u.devices);
  const names = new Set(devices.map((d) => d.profile));
  assert.ok(names.size >= 3, [...names].join(", "));
  for (const d of devices) {
    const p = DEFAULT_MONTE_CARLO.profiles.find((x) => x.name === d.profile);
    assert.ok(p, d.profile);
    assert.equal(d.active, p.active);
    if (d.active) assert.ok(d.demandMbps >= p.lowMbps - 0.01 && d.demandMbps <= p.highMbps + 0.01, `${d.profile} ${d.demandMbps}`);
  }
});

test("runs continue until the overload probabilities are within the target interval", () => {
  const out = mc({ totalPeople: 220, monteCarlo: { iterations: 50, maxIterations: 1500, targetCiPct: 4 } });
  assert.ok(out.iterations >= 50);
  if (out.convergence.converged) assert.ok(out.convergence.maxCiHalfWidthPct <= 4);
  else assert.equal(out.iterations, 1500);
});

test("the ray-traced prediction is used at each user's position", () => {
  const plan = office();
  const cells = { f1: [] };
  for (let x = 0.5; x < 40; x++) for (let z = 0.5; z < 20; z++) cells.f1.push({ x, z, step: 1, dbm: -50, snr: 40, sourceName: "a3" });
  const out = mc({ totalPeople: 30, monteCarlo: { iterations: 5, maxIterations: 5 } }, plan, cells);
  const devices = out.samples.median.users.flatMap((u) => u.devices);
  assert.ok(devices.every((d) => d.apId === "a3" && d.snrDb === 40));
  assert.equal(out.deterministic.source, "ray-traced");
});

// ---------------------------------------------------------------- load test

const lt = (loadTest = {}, extra = {}, plan = office(), cells = null) =>
  loadTestCapacity({ plan, settings: { totalPeople: 100, wanDownMbps: 10000, ...extra, loadTest: { runsPerStep: 30, heatmapRuns: 4, ...loadTest } }, cells });

test("load test: the same APs under more users find a breaking point, narrowed to the resolution", () => {
  const out = lt({ startUsers: 50, maxUsers: 400, stepUsers: 50, refineUsers: 5 });
  const r = out.result;
  assert.ok(r.firstFailUsers > 50 && r.firstFailUsers <= 400, `fails at ${r.firstFailUsers}`);
  assert.ok(r.firstFailUsers - r.maxSupportedUsers <= 5, `${r.maxSupportedUsers} .. ${r.firstFailUsers}`);
  const at = (u) => out.steps.find((s) => s.users === u);
  assert.notEqual(at(r.maxSupportedUsers).status, "fail");
  assert.equal(at(r.firstFailUsers).status, "fail");
  assert.deepEqual(r.bottleneck, ["radio"]);
  assert.ok(r.firstOverloadedAp && r.firstOverloadedAp.users <= r.firstFailUsers + 5);
  // every step keeps the 3 APs; airtime rises and throughput falls with users
  const coarse = out.steps.filter((s) => !s.refined);
  for (const s of out.steps) assert.equal(s.aps.length, 3);
  for (let i = 1; i < coarse.length; i++) {
    assert.ok(coarse[i].floor.airtimeMaxHighPct >= coarse[i - 1].floor.airtimeMaxHighPct - 1, `airtime at ${coarse[i].users}`);
    assert.ok(coarse[i].floor.spareAvgMbps <= coarse[i - 1].floor.spareAvgMbps + 1, `throughput at ${coarse[i].users}`);
  }
  // each KPI's first failure is a tested step that fails that KPI
  for (const [k, u] of Object.entries(out.kpiFirstFail)) if (u != null) assert.equal(at(u).kpis[k].status, "fail", k);
});

test("load test: a small internet plan is the bottleneck, and more APs are not recommended for it", () => {
  const out = lt({ startUsers: 20, maxUsers: 300, stepUsers: 40 }, { wanDownMbps: 200 });
  assert.ok(out.result.bottleneck.includes("internet"));
  assert.ok(out.result.internetNeededMbps > 200);
  assert.ok(out.recommendations.some((t) => /internet plan/.test(t)));
});

test("load test: heat maps per number of users; RSSI and SNR stay the baseline", () => {
  const out = lt({ startUsers: 50, maxUsers: 250, stepUsers: 100 });
  const hm = out.heatmaps;
  assert.ok(hm.steps.length >= 3);
  const grid = hm.floors[0];
  assert.ok(grid.x.length > 50 && grid.x.length === grid.rssi.length && grid.x.length === grid.snr.length);
  for (const s of hm.steps) for (const key of ["delivered", "deliveredNet", "avail", "air", "rate", "latency", "retry", "fail"]) assert.equal(s.floors[0][key].length, grid.x.length, key);
  // more users: less throughput and more airtime at the same places
  const mean = (a) => a.filter(Number.isFinite).reduce((x, y) => x + y, 0) / a.filter(Number.isFinite).length;
  const [first, lastStep] = [hm.steps[0].floors[0], hm.steps[hm.steps.length - 1].floors[0]];
  assert.ok(mean(lastStep.avail) < mean(first.avail));
  assert.ok(mean(lastStep.air) > mean(first.air));
  // squares lie on the floor
  for (let i = 0; i < grid.x.length; i++) assert.ok(grid.x[i] >= 0 && grid.x[i] <= 40 && grid.z[i] >= 0 && grid.z[i] <= 20);
});

test("load test: the proposed AP is tested, not assumed, and it raises capacity here", () => {
  const before = lt({ startUsers: 50, maxUsers: 400, stepUsers: 50 });
  const p = before.proposal;
  assert.ok(p && p.reason === "radio" && p.floorId === "f1");
  assert.ok(p.busiestLoadAfterPct < p.busiestLoadBeforePct);
  const plan = office();
  plan.sources.push({ id: "proposed-ap", kind: "wifi", name: "Proposed AP", floorId: "f1", x: p.x, z: p.z, proposed: true });
  const after = lt({ startUsers: 50, maxUsers: 400, stepUsers: 50 }, {}, plan);
  assert.equal(after.aps.length, 4);
  assert.ok(after.aps.find((a) => a.id === "proposed-ap").proposed);
  assert.ok(after.result.maxSupportedUsers > before.result.maxSupportedUsers, `${before.result.maxSupportedUsers} -> ${after.result.maxSupportedUsers}`);
});

test("a proposed AP keeps its distance estimate where the prediction names another AP", () => {
  const plan = office();
  plan.sources.push({ id: "p", kind: "wifi", name: "p", floorId: "f1", x: 20, z: 4, proposed: true });
  const cells = { f1: [] };
  for (let x = 0.5; x < 40; x++) for (let z = 0.5; z < 20; z++) cells.f1.push({ x, z, step: 1, dbm: -70, snr: 25, sourceName: "a2" });
  const links = capacityLinks({ plan, settings: {}, cells, floorId: "f1", x: 20, z: 4.5 });
  assert.equal(links[0].apId, "p", "right under it, the proposed AP is the strongest");
  assert.ok(links.find((a) => a.apId === "a2").rssiDbm === -70);
});

test("load test: the same seed gives the same result", () => {
  const a = lt({ startUsers: 40, maxUsers: 160, stepUsers: 60 });
  const b = lt({ startUsers: 40, maxUsers: 160, stepUsers: 60 });
  assert.deepEqual(a, b);
});

test("the Monte Carlo result carries capacity heat maps for its own headcount", () => {
  const out = mc({ totalPeople: 80, monteCarlo: { iterations: 20, maxIterations: 20 } });
  assert.ok(out.heatmap && out.heatmap.floors.length === 1);
  assert.equal(out.heatmap.step.users, 80);
  assert.equal(out.heatmap.step.floors[0].avail.length, out.heatmap.floors[0].x.length);
});
test("load test: heat maps on demand for any number of users match the test's own steps", () => {
  const plan = office();
  const settings = { totalPeople: 100, wanDownMbps: 10000, loadTest: { startUsers: 50, maxUsers: 250, stepUsers: 100, runsPerStep: 30, heatmapRuns: 4 } };
  const full = loadTestCapacity({ plan, settings });
  const same = loadTestHeatmap({ plan, settings, users: 150 });
  const own = full.steps.find((s) => s.users === 150);
  const { custom, refined, ...a } = same.step; // eslint-disable-line no-unused-vars
  const { refined: r2, ...b } = own; // eslint-disable-line no-unused-vars
  assert.deepEqual(a, b);
  assert.deepEqual(same.heat, full.heatmaps.steps.find((s) => s.users === 150));
  // any other count: same grid, figures in between its neighbours
  const at70 = loadTestHeatmap({ plan, settings, users: 70 });
  assert.equal(at70.users, 70);
  assert.equal(at70.heat.floors[0].avail.length, full.heatmaps.floors[0].x.length);
  assert.ok(at70.step.floor.airtimeMaxPct >= full.steps.find((s) => s.users === 50).floor.airtimeMaxPct - 1);
  assert.ok(at70.step.floor.airtimeMaxPct <= own.floor.airtimeMaxPct + 1);
});
test("load test: Wi-Fi and internet are judged apart; per-user throughput holds at demand, then drops", () => {
  // like the user's plan: 1.5 devices, 70% active, 5 Mbps, a 200 Mbps plan (170 usable)
  const out = lt({ startUsers: 20, maxUsers: 400, stepUsers: 40, stopAfterFailSteps: 0 }, { wanDownMbps: 200, activeFraction: 0.7 });
  const first = out.steps[0];
  const fifty = out.steps.find((s) => s.users === 60);
  // 60 users: 63 active x 5 Mbps = 315 Mbps > 170 usable: the internet fails, the Wi-Fi does not
  assert.equal(fifty.internetStatus, "fail");
  assert.notEqual(fifty.wifiStatus, "fail");
  assert.equal(fifty.status, "fail");
  assert.ok(fifty.failing.includes("internet") && !fifty.failing.includes("minSpeed"));
  // over Wi-Fi every user gets the 5 Mbps demand; with the internet plan they get less
  assert.ok(Math.abs(first.floor.wifiAvgMbps - 5) < 0.01, `${first.floor.wifiAvgMbps}`);
  assert.ok(fifty.floor.netAvgMbps < fifty.floor.wifiAvgMbps);
  assert.ok(Math.abs(fifty.floor.netAvgMbps - 170 / fifty.floor.activeDevices) < 0.6, `${fifty.floor.netAvgMbps}`);
  // with many users the APs run out of airtime: Wi-Fi per-user throughput drops below the demand
  const last = out.steps[out.steps.length - 1];
  assert.ok(last.floor.wifiLowMbps < 5, `${last.floor.wifiLowMbps}`);
  assert.equal(last.wifiStatus, "fail");
  // the heat map is what a device there gets (its fair share of airtime at its own rate): not one flat value,
  // less with more users, and never more after the internet plan
  const hm = out.heatmaps;
  const fin = (a) => a.filter(Number.isFinite);
  const mean = (a) => fin(a).reduce((x, y) => x + y, 0) / fin(a).length;
  const d0 = hm.steps[0].floors[0].delivered;
  assert.ok(Math.max(...fin(d0)) > 2 * Math.min(...fin(d0)), "throughput differs by position");
  assert.ok(mean(hm.steps[hm.steps.length - 1].floors[0].delivered) < mean(d0));
  const net0 = hm.steps[0].floors[0].deliveredNet;
  assert.ok(d0.every((v, i) => !Number.isFinite(v) || net0[i] <= v + 1e-9));
});

// ---------------------------------------------------------------- load test: per-user model (loadmodel.rs)

const ltPlan = (sources) => ({ ...office(), sources });

test("load test acceptance: 50 -> 100 -> 150 -> 200 users, each user by position, AP and airtime", () => {
  const out = lt({ startUsers: 50, maxUsers: 200, stepUsers: 50, stopAfterFailSteps: 0 });
  // the heat maps also hold the refined breaking point: take the four counts by name
  const steps = [50, 100, 150, 200].map((u) => out.heatmaps.steps.find((s) => s.users === u));
  assert.ok(steps.every(Boolean), "a heat map for 50, 100, 150 and 200 users");
  const fin = (a) => a.filter(Number.isFinite);
  const mean = (a) => fin(a).reduce((x, y) => x + y, 0) / fin(a).length;
  // the throughput map falls step by step, and the airtime load rises
  for (let i = 1; i < 4; i++) {
    assert.ok(mean(steps[i].floors[0].delivered) < mean(steps[i - 1].floors[0].delivered), `throughput at ${steps[i].users}`);
    assert.ok(mean(steps[i].floors[0].air) > mean(steps[i - 1].floors[0].air), `airtime at ${steps[i].users}`);
  }
  // near an AP more than far from it: the square under AP a1 (8, 10) against the weakest square
  const grid = out.heatmaps.floors[0];
  const at = (x, z) => grid.x.reduce((b, gx, i) => (Math.hypot(gx - x, grid.z[i] - z) < Math.hypot(grid.x[b] - x, grid.z[b] - z) ? i : b), 0);
  const d = steps[0].floors[0].delivered;
  const far = grid.x.map((_, i) => i).filter((i) => Number.isFinite(d[i])).reduce((b, i) => (d[i] < d[b] ? i : b));
  assert.ok(d[at(8, 10)] > d[far], `${d[at(8, 10)]} near vs ${d[far]} far`);
  // the users of a representative run, each with its AP and its own result
  for (const s of steps.slice(0, 4)) {
    const dots = s.userDots;
    assert.ok(Array.isArray(dots) && Math.abs(dots.length - s.users) <= s.users * 0.2, `${dots?.length} dots for ${s.users}`);
    for (const u of dots) {
      assert.ok(u.x >= 0 && u.x <= 40 && u.z >= 0 && u.z <= 20);
      assert.ok(["ok", "below demand", "below minimum", "no signal", "idle"].includes(u.status));
      for (const dv of u.devices.filter((x) => x.active && x.wifiMbps != null)) {
        assert.ok(dv.netMbps <= dv.wifiMbps + 1e-9 && dv.wifiMbps <= dv.demandMbps + 1e-9);
      }
    }
  }
  // actual user throughput: what a user standing there gets, never more than its demand;
  // the full demand while the APs have airtime, less once they run out
  for (const s of steps) {
    const a = s.floors[0].actual;
    assert.equal(a.length, grid.x.length);
    assert.ok(fin(a).every((v) => v <= 5 + 1e-6), `at most the 5 Mbps demand at ${s.users}`);
    assert.ok(fin(s.floors[0].actualNet).every((v, i) => true) && s.floors[0].actualNet.every((v, i) => v == null || v <= a[i] + 1e-6));
  }
  assert.ok(Math.abs(mean(steps[0].floors[0].actual) - 5) < 0.05, `${mean(steps[0].floors[0].actual)} at 50 users`);
  // this office's APs run out of airtime just past 200 users: at 300 the users really get less
  const at300 = loadTestHeatmap({ plan: office(), settings: { totalPeople: 100, wanDownMbps: 10000, loadTest: { runsPerStep: 30, heatmapRuns: 4 } }, users: 300 });
  assert.ok(mean(at300.heat.floors[0].actual) < 4.5, `${mean(at300.heat.floors[0].actual)} at 300 users`);
  assert.ok(Math.min(...fin(at300.heat.floors[0].actual)) < 2, "some places well below the demand");
  assert.ok(steps[0].floors[0].actual.every((v) => v != null), "every square with a usable AP has a value");
  // a user's details name its AP and its signal
  const someone = steps[0].userDots.find((u) => u.devices.some((d) => d.active && d.wifiMbps != null));
  assert.ok(someone.apId && someone.devices.find((d) => d.active).rssiDbm < 0);
  // the load model settles
  for (const s of out.steps) assert.equal(s.floor.convergedPct, 100);
});

test("load test: same-channel APs that hear each other share airtime; far apart they do not", () => {
  const settings = (x2) => ({
    plan: ltPlan([
      { id: "a", kind: "wifi", name: "a", floorId: "f1", x: 10, z: 10 },
      { id: "b", kind: "wifi", name: "b", floorId: "f1", x: x2, z: 10 },
    ]),
    settings: { totalPeople: 120, wanDownMbps: 10000, channels: [36], loadTest: { startUsers: 120, maxUsers: 120, stepUsers: 10, runsPerStep: 20, heatmapRuns: 2 } },
  });
  // 4 m apart: well above the carrier-sense level, one airtime domain; with a weak AP far away (-82 dBm not
  // reached) each keeps its own airtime. Same users, same channel, so the shared case is busier.
  const shared = loadTestCapacity(settings(14)).steps[0];
  const apart = loadTestCapacity({ ...settings(14), settings: { ...settings(14).settings, loadTest: { ...settings(14).settings.loadTest, ccaDbm: -40 } } }).steps[0];
  assert.ok(shared.floor.airtimeMaxPct > apart.floor.airtimeMaxPct, `${shared.floor.airtimeMaxPct} vs ${apart.floor.airtimeMaxPct}`);
});

test("load test: the Simulation's heat maps keep their own model (no user dots there)", () => {
  const out = mc({ totalPeople: 80, monteCarlo: { iterations: 20, maxIterations: 20 } });
  assert.equal(out.heatmap.step.userDots, undefined);
});
test("capacity simulation: one number of users carries its own grid, throughput by position and its users", () => {
  const plan = office();
  const settings = { totalPeople: 100, wanDownMbps: 10000, loadTest: { runsPerStep: 30, heatmapRuns: 4 } };
  const fin = (a) => a.filter(Number.isFinite);
  const mean = (a) => fin(a).reduce((x, y) => x + y, 0) / fin(a).length;
  const a = loadTestHeatmap({ plan, settings, users: 50 });
  const b = loadTestHeatmap({ plan, settings, users: 300 });
  const grid = a.floors[0];
  const t50 = a.heat.floors[0].achievable;
  assert.equal(t50.length, grid.x.length);
  assert.ok(Math.max(...fin(t50)) > 1.5 * Math.min(...fin(t50)), "throughput differs by position");
  assert.ok(mean(b.heat.floors[0].achievable) < mean(t50), "less with more users");
  assert.ok(b.heat.floors[0].achievableNet.every((v, i) => v == null || v <= b.heat.floors[0].achievable[i] + 1e-6));
  assert.ok(Math.abs(a.heat.userDots.length - 50) <= 10);
  assert.ok(a.heat.floors[0].ap.every((id) => id == null || ["a1", "a2", "a3"].includes(id)), "every square names its AP");
});
