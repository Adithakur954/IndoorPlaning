import test from "node:test";
import assert from "node:assert/strict";
import { checkPositionsCabling, designWifiCabling } from "../src/infra/wifi/design.js";
import {
  DEFAULT_WIFI_CATALOGUE,
  DEFAULT_WIFI_RULES,
} from "../src/infra/wifi/catalogue.js";

const near = (a, b, tol = 0.01, label = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

// Two 5 x 6 m rooms side by side; the only door is on the shared wall at z 4..5.
const twoRooms = (sources) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [
    { id: "A", floorId: "f1", name: "A", shape: "rectangle", x: 0, z: 0, width: 5, depth: 6, height: 3 },
    { id: "B", floorId: "f1", name: "B", shape: "rectangle", x: 5, z: 0, width: 5, depth: 6, height: 3 },
  ],
  doors: [{ id: "d", floorId: "f1", roomId: "A", wallSide: "east", offset: 4, width: 1, height: 2.1 }],
  windows: [],
  interiorWalls: [],
  boundaries: [],
  sources,
});
const ap = (id, x, z, extra = {}) => ({
  id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5, ...extra,
});
const rack = { id: "rack1", floorId: "f1", x: 0.75, z: 0.75 };
const line = (design, partId) => design.boq.find((l) => l.partId === partId);

test("one AP: route through the door, lengths and every BoQ line by hand", () => {
  const design = designWifiCabling({
    plan: twoRooms([ap("ap1", 9.25, 0.75)]),
    racks: [rack],
  });
  assert.equal(design.runs.length, 1);
  const run = design.runs[0];
  near(run.horizontalM, 15.5, 1e-6, "route");
  assert.equal(run.crossings, 0);
  // AP drop (tray 2.7 m - AP 2.5 m) + rack drop 2 + loops 1 + 2
  near(run.verticalM, 0.2 + 2 + 1 + 2);
  near(run.slackM, (15.5 + 5.2) * 0.05);
  near(run.permanentLinkM, (15.5 + 5.2) * 1.05);
  near(run.channelM, run.permanentLinkM + 2);
  assert.equal(run.check, "ok");

  assert.equal(line(design, "ap-at").qty, 1);
  assert.equal(line(design, "sw24").qty, 1);
  near(line(design, "cat6a").qty, 21.74, 0.01);
  assert.equal(line(design, "cat6a-box").qty, 1);
  assert.equal(line(design, "patch-panel-24").qty, 1);
  assert.equal(line(design, "rj45-jack").qty, 1);
  assert.equal(line(design, "outlet-box").qty, 1);
  assert.equal(line(design, "patch-cord").qty, 2);
  assert.equal(line(design, "ap-mount").qty, 1);
  assert.equal(line(design, "label").qty, 2);
  assert.equal(line(design, "ties").qty, 1);
  assert.equal(line(design, "tray-3m").qty, Math.ceil(15.5 / 3));
  assert.deepEqual(design.violations, []);
  assert.match(design.status, /preliminary/);
});

test("every BoQ line says how it was calculated and where its value came from", () => {
  const design = designWifiCabling({ plan: twoRooms([ap("ap1", 9.25, 0.75)]), racks: [rack] });
  for (const l of design.boq) {
    assert.ok(l.basis.length > 0, `${l.partId} has no basis`);
    assert.match(l.source, /illustrative/);
  }
});

test("a floor with APs but no rack is an error, not a silent skip", () => {
  const design = designWifiCabling({ plan: twoRooms([ap("ap1", 9.25, 0.75)]), racks: [] });
  assert.equal(design.runs.length, 0);
  assert.equal(design.violations[0].severity, "error");
  assert.match(design.violations[0].message, /no rack/);
});

test("a run over the 90 m permanent-link limit is an error", () => {
  const plan = {
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
    rooms: [{ id: "L", floorId: "f1", name: "Long", shape: "rectangle", x: 0, z: 0, width: 120, depth: 6, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [],
    sources: [ap("far", 100.25, 0.75), ap("near", 20.25, 0.75), ap("edge", 77.25, 0.75)],
  };
  const design = designWifiCabling({ plan, racks: [rack] });
  const by = Object.fromEntries(design.runs.map((r) => [r.apId, r]));
  assert.equal(by.far.check, "too long");
  assert.equal(by.near.check, "ok");
  // 77 m route + 5.2 drops/loops + 5 % = 86.4 m: inside 90 m but above 90 % of it
  assert.equal(by.edge.check, "near limit");
  assert.ok(design.violations.some((v) => v.severity === "error" && v.item === "far" && /90 m/.test(v.message)));
  assert.ok(design.violations.some((v) => v.severity === "warning" && v.item === "edge"));
});

test("switches are packed by PoE budget as well as by port count", () => {
  const aps = Array.from({ length: 13 }, (_, i) => ap(`ap${i}`, 3.25 + i * 0.5, 4.75));
  const plan = {
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
    rooms: [{ id: "big", floorId: "f1", name: "Big", shape: "rectangle", x: 0, z: 0, width: 20, depth: 8, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [], sources: aps,
  };
  // 13 x 30 W = 390 W; a 370 W switch holds 12 of them, so 2 switches
  // (the 24 ports would have allowed all 13 in one)
  const design = designWifiCabling({ plan, racks: [rack] });
  assert.equal(design.racks[0].switches, 2);
  assert.equal(line(design, "sw24").qty, 2);
  near(design.racks[0].poeAllocatedW, 390, 1e-9);
  // 802.3af APs draw 15.4 W: 24 fit within the 370 W budget (369.6 W)
  const af = designWifiCabling({ plan, racks: [rack], rules: { apPartId: "ap-af" } });
  assert.equal(af.racks[0].switches, 1);
});

test("an AP that needs more power per port than the switch gives is an error", () => {
  const design = designWifiCabling({
    plan: twoRooms([ap("hungry", 9.25, 0.75, { apPartId: "ap-bt" })]),
    racks: [rack],
  });
  assert.ok(design.violations.some((v) => v.severity === "error" && /60 W/.test(v.message)));
});

test("each AP uses the nearest rack on its own floor", () => {
  const racks = [rack, { id: "rack2", floorId: "f1", x: 9.25, z: 5.25 }];
  const design = designWifiCabling({
    plan: twoRooms([ap("a", 1.25, 1.25), ap("b", 9.25, 4.75)]),
    racks,
  });
  const by = Object.fromEntries(design.runs.map((r) => [r.apId, r.rackId]));
  assert.equal(by.a, "rack1");
  assert.equal(by.b, "rack2");
  assert.equal(design.racks.length, 2);
});

test("a part that is not in the catalogue is refused", () => {
  assert.throws(
    () => designWifiCabling({ plan: twoRooms([ap("a", 1.25, 1.25, { apPartId: "nope" })]), racks: [rack] }),
    /"nope" is not in the catalogue/,
  );
  assert.throws(
    () => designWifiCabling({ plan: twoRooms([]), racks: [rack], rules: { switchPartId: "nope" } }),
    /switch part/,
  );
});

test("the same inputs give the same design", () => {
  const input = { plan: twoRooms([ap("ap1", 9.25, 0.75), ap("ap2", 7.25, 3.25)]), racks: [rack] };
  assert.deepEqual(designWifiCabling(input), designWifiCabling(input));
});

test("the defaults state the standard limits", () => {
  assert.equal(DEFAULT_WIFI_RULES.maxPermanentLinkM, 90);
  assert.equal(DEFAULT_WIFI_RULES.maxChannelM, 100);
  for (const part of Object.values(DEFAULT_WIFI_CATALOGUE.accessPoints))
    assert.match(part.source, /illustrative/);
});

// ---- risers, rack capacity, PoE allocation, candidate positions --------------

const twoFloors = (sources) => ({
  floors: [
    { id: "f1", name: "Level 1", elevation: 0 },
    { id: "f2", name: "Level 2", elevation: 3.2 },
  ],
  rooms: [
    { id: "r1", floorId: "f1", name: "Hall 1", shape: "rectangle", x: 0, z: 0, width: 10, depth: 6, height: 3 },
    { id: "r2", floorId: "f2", name: "Hall 2", shape: "rectangle", x: 0, z: 0, width: 10, depth: 6, height: 3 },
  ],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});

test("a floor without a rack is served through a riser to a rack on another floor", () => {
  const upstairs = ap("up", 9.25, 0.75, { floorId: "f2" });
  const riser = { id: "shaft", x: 0.75, z: 5.25 };
  const design = designWifiCabling({ plan: twoFloors([upstairs]), racks: [rack], risers: [riser] });
  assert.equal(design.runs.length, 1);
  const run = design.runs[0];
  assert.equal(run.riserId, "shaft");
  assert.equal(run.rackId, "rack1");
  // AP -> shaft on floor 2: 8.5 + 4.5; shaft -> rack on floor 1: 4.5
  near(run.horizontalM, 17.5, 1e-6, "horizontal");
  // AP drop 0.2 + 3.2 m between floors + rack drop 2 + loops 1 + 2
  near(run.verticalM, 0.2 + 3.2 + 5, 1e-6, "vertical");
  near(run.permanentLinkM, (17.5 + 0.2 + 3.2 + 5) * 1.05, 0.01);
  assert.deepEqual(run.paths.map((p) => p.floorId), ["f2", "f1"]);
  assert.deepEqual(design.violations, []);
});

test("without a riser the other floor is an error that says what to add", () => {
  const design = designWifiCabling({ plan: twoFloors([ap("up", 9.25, 0.75, { floorId: "f2" })]), racks: [rack] });
  assert.equal(design.runs.length, 0);
  assert.match(design.violations[0].message, /riser/);
});

test("a rack on the AP's own floor beats a rack reached through a riser", () => {
  const sources = [ap("up", 9.25, 0.75, { floorId: "f2" })];
  const racks = [rack, { id: "rack2", floorId: "f2", x: 9.25, z: 1.75 }];
  const design = designWifiCabling({ plan: twoFloors(sources), racks, risers: [{ id: "shaft", x: 0.75, z: 5.25 }] });
  assert.equal(design.runs[0].rackId, "rack2");
  assert.equal(design.runs[0].riserId, null);
});

test("rack capacity: the next-best rack takes the AP when the nearest is full", () => {
  const racks = [
    { ...rack, maxAps: 1 },
    { id: "rack2", floorId: "f1", x: 9.25, z: 0.75 },
  ];
  const design = designWifiCabling({
    plan: twoRooms([ap("a", 1.25, 1.25), ap("b", 1.75, 1.25)]),
    racks,
  });
  const used = design.runs.map((r) => r.rackId).sort();
  assert.deepEqual(used, ["rack1", "rack2"]);
  assert.deepEqual(design.violations.filter((v) => v.severity === "error"), []);
});

test("when every reachable rack is full the AP is reported, not dropped silently", () => {
  const racks = [
    { ...rack, maxAps: 1 },
    { id: "rack2", floorId: "f1", x: 9.25, z: 0.75, maxAps: 1 },
  ];
  const design = designWifiCabling({
    plan: twoRooms([ap("a", 1.25, 1.25), ap("b", 1.75, 1.25), ap("c", 2.25, 1.25)]),
    racks,
  });
  assert.equal(design.runs.length, 2);
  assert.ok(design.violations.some((v) => /full/.test(v.message)));
});

test("PoE allocation: worst-case class power needs more switches than typical draw", () => {
  const aps = Array.from({ length: 25 }, (_, i) => ap(`ap${i}`, 1.25 + (i % 5) * 0.5, 1.25 + Math.floor(i / 5) * 0.5));
  const plan = {
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
    rooms: [{ id: "big", floorId: "f1", name: "Big", shape: "rectangle", x: 0, z: 0, width: 20, depth: 8, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [], sources: aps,
  };
  // class: 25 x 30 W = 750 W, 12 per 370 W switch -> 3 switches
  assert.equal(designWifiCabling({ plan, racks: [rack] }).racks[0].switches, 3);
  // actual: 25 x 14 W = 350 W fits the budget, but 24 ports -> 2 switches
  const actual = designWifiCabling({ plan, racks: [rack], rules: { poeAllocation: "actual" } });
  assert.equal(actual.racks[0].switches, 2);
  near(actual.racks[0].poeAllocatedW, 350, 1e-9);
  // an AP can state its own draw
  const own = { ...plan, sources: aps.map((a) => ({ ...a, drawW: 30 })) };
  assert.equal(designWifiCabling({ plan: own, racks: [rack], rules: { poeAllocation: "actual" } }).racks[0].switches, 3);
});

test("recommended AP positions are checked against the cable limit without changing the plan", () => {
  const plan = {
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
    rooms: [{ id: "L", floorId: "f1", name: "Long", shape: "rectangle", x: 0, z: 0, width: 120, depth: 6, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [], sources: [],
  };
  const before = JSON.stringify(plan);
  const result = checkPositionsCabling({
    plan,
    racks: [rack],
    positions: [
      { id: "p1", floorId: "f1", x: 20.25, z: 0.75 },
      { id: "p2", floorId: "f1", x: 100.25, z: 0.75 },
    ],
  });
  assert.equal(JSON.stringify(plan), before);
  assert.equal(result[0].feasible, true);
  assert.equal(result[1].feasible, false);
  assert.ok(result[1].permanentLinkM > 90);
  const none = checkPositionsCabling({ plan, racks: [], positions: [{ id: "p", floorId: "f1", x: 5, z: 3 }] });
  assert.equal(none[0].routed, false);
  assert.equal(none[0].feasible, false);
});

test("cables share a trunk: tray is shorter, every cable keeps its own length", () => {
  const hall = (sources) => ({
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
    rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
  });
  const aps = [0.75, 2.75, 4.75, 6.75].map((z, i) => ap(`ap${i}`, 38.25, z));
  const alone = designWifiCabling({ plan: hall(aps), racks: [rack], rules: { trayShareFactor: 1 } });
  const shared = designWifiCabling({ plan: hall(aps), racks: [rack] });
  // turning late already makes the cables leave on one line, so sharing never makes the tray longer
  assert.ok(shared.trayM <= alone.trayM + 1e-9, `tray ${shared.trayM} vs ${alone.trayM}`);
  // and the tray is far shorter than laying every cable's route separately
  const separate = shared.runs.reduce((s, r) => s + r.horizontalM, 0);
  assert.ok(shared.trayM < separate * 0.6, `tray ${shared.trayM} vs separate routes ${separate}`);
  assert.equal(shared.runs.length, 4);
  for (const run of shared.runs) {
    const base = alone.runs.find((r) => r.apId === run.apId);
    assert.ok(run.horizontalM <= base.horizontalM * 1.15 + 1e-9, `${run.apId}: ${run.horizontalM} vs ${base.horizontalM}`);
  }
  // each AP still has its own cable: the cable total is the sum of the runs, not the tray
  const cable = shared.boq.find((l) => l.partId === "cat6a").qty;
  near(cable, shared.runs.reduce((s, r) => s + r.permanentLinkM, 0), 0.05);
  assert.ok(cable > shared.trayM * 2);
});
