import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPACITY_MODEL, capacityReady, channelsFor, maxWidthMHz, phyRateMbps, planWifiCapacity } from "../src/infra/wifi/capacityModel.js";

await capacityReady;

const near = (a, b, tol = 0.11) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const room = (id, x, z, w, d, floorId = "f1") => ({ id, floorId, name: id, shape: "rectangle", x, z, width: w, depth: d, height: 3 });
const ap = (id, x, z, floorId = "f1") => ({ id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5 });
const plan = (rooms, sources) => ({ floors: [{ id: "f1", name: "L1", elevation: 0 }], rooms, sources, doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [] });

test("data rate: from the signal, the standard, the width and the streams", () => {
  assert.equal(phyRateMbps({ standard: "wifi6", widthMHz: 20, streams: 1, snrDb: 2 }), 0); // too weak
  near(phyRateMbps({ standard: "wifi6", widthMHz: 20, streams: 1, snrDb: 6 }), 8.6); // lowest rate
  near(phyRateMbps({ standard: "wifi6", widthMHz: 20, streams: 1, snrDb: 60 }), 143.4); // highest rate
  near(phyRateMbps({ standard: "wifi6", widthMHz: 80, streams: 2, snrDb: 60 }), 143.4 * 4.2 * 2, 0.5);
  assert.ok(phyRateMbps({ standard: "wifi6", widthMHz: 80, streams: 2, snrDb: 30 }) < phyRateMbps({ standard: "wifi6", widthMHz: 80, streams: 2, snrDb: 40 }));
  assert.equal(maxWidthMHz("wifi6", "2.4"), 40);
  assert.equal(channelsFor("2.4", 20).length, 3);
});

test("the internet check does not depend on the number of APs", () => {
  const rooms = [room("a", 0, 0, 20, 10)];
  const s = { usersPerM2: 0.5, wanDownMbps: 300, minMbps: 5, wanHeadroomPct: 0 };
  const one = planWifiCapacity({ plan: plan(rooms, [ap("a1", 10, 5)]), settings: s });
  const four = planWifiCapacity({ plan: plan(rooms, [ap("a1", 3, 5), ap("a2", 8, 5), ap("a3", 13, 5), ap("a4", 18, 5)]), settings: s });
  // 200 m2 x 0.5 = 100 people x 1.5 x 0.6 = 90 active x 5 = 450 Mbps of a 300 Mbps plan
  near(one.wan.activeDevices, 90);
  near(one.wan.demandMinMbps, 450);
  assert.equal(one.wan.sufficientForMin, false);
  assert.equal(four.wan.sufficientForMin, false);
  near(four.wan.demandMinMbps, one.wan.demandMinMbps);
  assert.ok(one.bottleneck.internet);
  assert.match(one.recommendations[0], /Internet plan/);
  assert.match(one.recommendations[0], /More access points will not fix this/);
  near(one.wan.neededPlanMbps, 450);
});

test("headroom lowers the usable internet speed", () => {
  const out = planWifiCapacity({ plan: plan([room("a", 0, 0, 10, 10)], [ap("a1", 5, 5)]), settings: { wanDownMbps: 100, wanHeadroomPct: 20 } });
  near(out.wan.usableDownMbps, 80);
});

test("a plan that is big enough and a quiet room: no bottleneck", () => {
  const out = planWifiCapacity({ plan: plan([room("a", 0, 0, 10, 10)], [ap("a1", 5, 5)]), settings: { wanDownMbps: 1000 } });
  assert.deepEqual(out.bottleneck.verdict, []);
  assert.equal(out.aps[0].status, "ok");
  assert.equal(out.aps[0].meetsMinimumPct, 100);
  assert.match(out.recommendations[0], /No bottleneck/);
});

test("a crowded room on one AP is a radio problem, not an internet problem", () => {
  const out = planWifiCapacity({
    plan: plan([room("a", 0, 0, 20, 20)], [ap("a1", 10, 10)]),
    settings: { usersPerM2: 1, wanDownMbps: 100000, standard: "wifi5", widthMHz: 20, apStreams: 1, clientStreams: 1, maxClientsPerAp: 1000 },
  });
  assert.equal(out.wan.sufficientForMin, true);
  assert.ok(out.bottleneck.radio);
  assert.equal(out.bottleneck.internet, false);
  assert.ok(out.aps[0].airtimeMinPct > 100);
  assert.ok(out.aps[0].meetsMinimumPct < 100);
  assert.ok(out.aps[0].extraApsNeeded > 0);
});

test("a far corner has a weaker signal, so a lower rate and more airtime per device", () => {
  const near1 = planWifiCapacity({ plan: plan([room("a", 0, 0, 4, 4)], [ap("a1", 2, 2)]) }).aps[0];
  const far = planWifiCapacity({ plan: plan([room("a", 0, 0, 60, 60)], [ap("a1", 2, 2)]), settings: { usersPerM2: 4 / 3600 } }).aps[0];
  assert.ok(near1.avgRateMbps > far.avgRateMbps);
});

test("the ray-traced prediction is used when given, and the result says so", () => {
  const p = plan([room("a", 0, 0, 10, 10)], [ap("a1", 5, 5), ap("a2", 5, 5)]);
  const cells = { f1: [] };
  for (let x = 0.5; x < 10; x++) for (let z = 0.5; z < 10; z++) cells.f1.push({ x, z, step: 1, dbm: -50, snr: 40, sourceName: "a2" });
  const out = planWifiCapacity({ plan: p, cells });
  assert.equal(out.source, "ray-traced");
  assert.equal(out.aps.find((a) => a.id === "a2").devices > 0, true);
  assert.equal(out.aps.find((a) => a.id === "a1").devices, 0);
  assert.equal(planWifiCapacity({ plan: p }).source, "distance estimate");
});

test("load-aware association spreads devices between two APs; strongest sends them all to one", () => {
  const p = plan([room("a", 0, 0, 20, 10)], [ap("a1", 9, 5), ap("a2", 11, 5)]);
  const cells = { f1: [] };
  for (let x = 0.5; x < 20; x++) for (let z = 0.5; z < 10; z++) cells.f1.push({ x, z, step: 1, dbm: -55, snr: 35, sourceName: "a1" });
  const strongest = planWifiCapacity({ plan: p, cells, settings: { association: "strongest" } });
  const aware = planWifiCapacity({ plan: p, cells, settings: { association: "load-aware", roamMarginDb: 15 } });
  assert.equal(strongest.aps.find((a) => a.id === "a2").devices, 0);
  assert.ok(aware.aps.find((a) => a.id === "a2").devices > 0);
  assert.equal(aware.aps.reduce((s, a) => s + a.devices, 0), strongest.aps.reduce((s, a) => s + a.devices, 0));
});

test("a room with no AP on its floor is reported", () => {
  const p = plan([room("a", 0, 0, 10, 10, "f2")], [ap("a1", 5, 5)]);
  p.floors.push({ id: "f2", name: "L2", elevation: 3.2 });
  const out = planWifiCapacity({ plan: p });
  assert.equal(out.unserved.length, 1);
  assert.ok(out.bottleneck.coverage);
});

test("assumptions are listed and the defaults are what the panel shows", () => {
  const out = planWifiCapacity({ plan: plan([room("a", 0, 0, 10, 10)], [ap("a1", 5, 5)]) });
  assert.ok(out.assumptions.length >= 3);
  assert.equal(out.settings.wanDownMbps, DEFAULT_CAPACITY_MODEL.wanDownMbps);
});

test("the number of people is the main input: it is shared over the rooms by area and never lost", () => {
  const p = plan([room("a", 0, 0, 10, 10), room("b", 10, 0, 30, 10)], [ap("a1", 5, 5), ap("a2", 25, 5)]);
  const out = planWifiCapacity({ plan: p, settings: { totalPeople: 100, wanHeadroomPct: 15, wanDownMbps: 300 } });
  near(out.summary.totalUsers, 100);
  near(out.wan.totalDevices, 150, 0.6); // 1.5 devices each
  near(out.wan.activeDevices, 90, 0.6); // 60% active
  near(out.wan.demandMinMbps, 450, 3); // 90 x 5
  near(out.wan.usableDownMbps, 255);
  assert.equal(out.wan.sufficientForMin, false);
  assert.equal(out.rooms.find((r) => r.roomId === "b").users, 75); // 300 m2 of 400 m2
  // a number for one room is kept and the rest share what is left
  const fixed = planWifiCapacity({ plan: p, settings: { totalPeople: 100, roomUsers: { a: 40 } } });
  near(fixed.summary.totalUsers, 100);
  assert.equal(fixed.rooms.find((r) => r.roomId === "a").users, 40);
});

const bigFloor = (extra = {}) => ({
  ...plan([room("meet", 0, 0, 4, 3)], [ap("a1", 10, 10), ap("a2", 30, 10), ap("a3", 50, 10), ap("a4", 70, 10), ap("a5", 10, 30), ap("a6", 30, 30), ap("a7", 50, 30), ap("a8", 70, 30)]),
  boundaries: [{ id: "b", floorId: "f1", name: "Floor", points: [{ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 40 }, { x: 0, z: 40 }] }],
  ...extra,
});

test("people are spread over the whole floor, not only inside the few rooms", () => {
  const out = planWifiCapacity({ plan: bigFloor(), settings: { totalPeople: 400 } });
  near(out.summary.totalUsers, 400, 0.6);
  near(out.summary.floorAreaM2, 3200, 20); // the 80 x 40 m building, not the 12 m2 room
  // every one of the 8 APs carries some of them
  assert.equal(out.aps.filter((a) => a.devices > 0).length, 8);
  // each AP serves about a share of the floor: 400 people / 8 = 50 people = 75 devices
  for (const a of out.aps) assert.ok(a.devices > 40 && a.devices < 120, `${a.name}: ${a.devices}`);
  assert.ok(out.rooms.some((r) => r.roomId === null)); // open area is listed
});

test("a zone with its own headcount keeps it, and a zone with 0 people is empty", () => {
  const p = bigFloor();
  const zone = { id: "z1", floorId: "f1", name: "Call centre", x: 0, z: 0, width: 20, depth: 20, people: 100 };
  const out = planWifiCapacity({ plan: p, settings: { totalPeople: 300, zones: [zone] } });
  near(out.summary.totalUsers, 300, 0.6);
  const a1 = out.aps.find((a) => a.id === "a1");
  const a4 = out.aps.find((a) => a.id === "a4");
  assert.ok(a1.users > a4.users + 60, `${a1.users} vs ${a4.users}`); // the zone's 100 people are near a1
  const empty = planWifiCapacity({ plan: p, settings: { totalPeople: 300, zones: [{ ...zone, people: 0 }] } });
  near(empty.summary.totalUsers, 300, 0.6); // nobody is lost: the others share all 300
  assert.ok(empty.aps.find((a) => a.id === "a1").users < a1.users);
  assert.ok(empty.summary.floorAreaM2 < out.summary.floorAreaM2 + 1); // the zone area is not occupiable
});

test("desks and seats attract people when asked", () => {
  const p = bigFloor();
  p.furniture = [{ id: "d1", floorId: "f1", name: "Desk 1", kind: "desk", x: 60, z: 5, width: 4, depth: 2, height: 0.75 }];
  const even = planWifiCapacity({ plan: p, settings: { totalPeople: 400, distribution: "uniform" } });
  const seats = planWifiCapacity({ plan: p, settings: { totalPeople: 400, distribution: "furniture", seatWeight: 20 } });
  near(seats.summary.totalUsers, 400, 0.6);
  assert.ok(seats.aps.find((a) => a.id === "a4").users > even.aps.find((a) => a.id === "a4").users);
});

test("an excluded room holds nobody; an AP with nobody says so", () => {
  const p = bigFloor();
  p.rooms = [{ ...p.rooms[0], width: 30, depth: 40, receiverGrid: "excluded" }, room("big", 30, 0, 50, 40)];
  const out = planWifiCapacity({ plan: p, settings: { totalPeople: 200 } });
  assert.equal(out.aps.find((a) => a.id === "a1").devices, 0);
  assert.equal(out.aps.find((a) => a.id === "a1").status, "no devices");
  assert.ok(out.aps.find((a) => a.id === "a1").meetsMinimumPct === null);
});

test("every client position is returned for the map, with its AP", () => {
  const out = planWifiCapacity({ plan: bigFloor(), settings: { totalPeople: 100 } });
  assert.ok(out.clients.length > 1000);
  assert.ok(out.clients.every((c) => c.apId));
  const apIds = new Set(out.clients.map((c) => c.apId));
  assert.equal(apIds.size, 8);
});
