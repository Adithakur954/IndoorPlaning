import test from "node:test";
import assert from "node:assert/strict";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { floorRoutingInput } from "../src/infra/core/planGeometry.js";
import { approvalSummary } from "../src/infra/wifi/approval.js";

const near = (a, b, tol = 0.01, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);
const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const SOLID = { ceiling: { type: "solid", voidAccess: "none", partitionToSlab: "yes" } };

const hall = (width, depth, sources, extra = {}) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }, { id: "f2", name: "Level 2", elevation: 3.2 }],
  rooms: [
    { id: "h1", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 },
    { id: "h2", floorId: "f2", name: "Hall 2", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 },
  ],
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources, ...extra,
});
const ap = (id, x, z, floorId = "f1") => ({ id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5 });
const rack = { id: "k1", floorId: "f1", x: 0.75, z: 10.25 };
const go = (plan, pathway = {}, extra = {}) => designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, ...pathway }, ...extra });

// ---- A1: a person edits a route ------------------------------------------------------------------

test("a route with a waypoint passes it, and its length is the length of that route", () => {
  const plan = hall(40, 20, [ap("far", 38.25, 10.25)]);
  const plain = go(plan).runs[0];
  near(plain.horizontalM, 37.5);
  const edited = go(plan, { routeEdits: { far: { waypoints: [{ x: 20.25, z: 2.25 }] } } }).runs[0];
  // rack -> waypoint: 19.5 + 8; waypoint -> AP: 18 + 8
  near(edited.horizontalM, 27.5 + 26);
  assert.equal(edited.edited, true);
  assert.ok(edited.paths[0].points.some((p) => Math.abs(p.x - 20.25) < 0.3 && Math.abs(p.z - 2.25) < 0.3), "the path goes through the waypoint");
  assert.equal(edited.pathwayStatus, "stated"); // edited but not yet approved: it rests on the stated ceiling
});

test("confirming a route makes its status 'confirmed'; an unedited route cannot be confirmed by accident", () => {
  const plan = hall(40, 20, [ap("a", 38.25, 10.25), ap("b", 30.25, 4.25)]);
  const d = go(plan, { routeEdits: { a: { waypoints: [{ x: 20.25, z: 2.25 }], confirmed: true } } });
  assert.equal(d.runs.find((r) => r.apId === "a").pathwayStatus, "confirmed");
  assert.equal(d.runs.find((r) => r.apId === "b").pathwayStatus, "stated");
});

test("the shared-trunk step leaves an edited route as drawn", () => {
  const plan = hall(40, 20, [ap("a", 38.25, 10.25), ap("b", 36.25, 10.25)]);
  const d = go(plan, { routeEdits: { a: { waypoints: [{ x: 20.25, z: 2.25 }] } } });
  near(d.runs.find((r) => r.apId === "a").horizontalM, 27.5 + 26);
});

// ---- A2: what a route is made of -----------------------------------------------------------------

const twoRooms = (sources) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [
    { id: "A", floorId: "f1", name: "A", shape: "rectangle", x: 0, z: 0, width: 10, depth: 6, height: 3 },
    { id: "B", floorId: "f1", name: "B", shape: "rectangle", x: 10, z: 0, width: 10, depth: 6, height: 3 },
  ],
  doors: [{ id: "d", floorId: "f1", roomId: "A", wallSide: "east", offset: 4, width: 1, height: 2.1 }],
  windows: [], interiorWalls: [], boundaries: [], furniture: [],
  sources: sources || [ap("ap", 19.25, 0.75)],
});
const rackA = { id: "k1", floorId: "f1", x: 0.75, z: 0.75 };
const goTwo = (pathway, rules) => designWifiCabling({ plan: twoRooms(), racks: [rackA], pathway, rules });

test("a crossing is classified: estimate, over the partition (ceiling), or through a sleeve (penetration)", () => {
  const unknown = goTwo({}, { crossPenaltyM: 3 }).runs[0];
  assert.deepEqual(unknown.crossingPoints.map((c) => c.kind), ["estimated"]);
  const over = goTwo(OPEN).runs[0];
  assert.deepEqual(over.crossingPoints.map((c) => c.kind), ["ceiling"]);
  near(over.crossingPoints[0].x, 10, 0.3);
  const wall = floorRoutingInput(twoRooms(), "f1", SOLID).walls.find((w) => Math.abs(w.a.x - 10) < 1e-6 && Math.abs(w.b.x - 10) < 1e-6);
  const sleeve = goTwo({ ...SOLID, wallOverrides: { [wall.key]: "sleeve" } }).runs[0];
  assert.deepEqual(sleeve.crossingPoints.map((c) => c.kind), ["penetration"]);
  assert.equal(sleeve.layers.penetrations, 1);
  assert.equal(sleeve.layers.ceilingCrossings, 0);
});

test("rooms without a usable ceiling void need surface conduit, and it is in the BoQ", () => {
  const solid = goTwo(SOLID);
  const run = solid.runs[0];
  assert.ok(run.layers.conduitM > 20, `conduit ${run.layers.conduitM} m`);
  const line = solid.boq.find((l) => l.partId === "conduit-3m");
  assert.ok(line && line.qty >= 6, "conduit line in the BoQ");
  assert.match(line.basis, /without a usable ceiling void/);
  const open = goTwo(OPEN);
  assert.equal(open.runs[0].layers.conduitM, 0);
  assert.equal(open.boq.find((l) => l.partId === "conduit-3m"), undefined);
  // unknown ceiling: no claim either way
  assert.equal(goTwo({}).boq.find((l) => l.partId === "conduit-3m"), undefined);
});

test("a room that alone has no ceiling access needs conduit only there", () => {
  const d = goTwo({ ...OPEN, roomOverrides: { B: { voidAccess: "none" } } });
  const run = d.runs[0];
  assert.ok(run.layers.conduitM > 4 && run.layers.conduitM < 20, `conduit ${run.layers.conduitM} m`);
});

// ---- A3: risers -------------------------------------------------------------------------------------

test("riser capacity: cables against the shaft's area at its fill limit", () => {
  const plan = hall(40, 20, [ap("u1", 10.25, 3.25, "f2"), ap("u2", 12.25, 3.25, "f2"), ap("u3", 14.25, 3.25, "f2")]);
  const cableArea = Math.PI * (7.5 / 2) ** 2; // Cat6A, 7.5 mm
  const small = designWifiCabling({ plan, racks: [rack], risers: [{ id: "s", name: "Shaft", x: 39.25, z: 19.25, areaMm2: 100 }], pathway: OPEN });
  assert.equal(small.riserUse[0].cables, 3);
  near(small.riserUse[0].usedMm2, Math.round(3 * cableArea), 1);
  assert.equal(small.riserUse[0].capacityMm2, 40); // 100 mm2 x 40 %
  assert.ok(small.violations.some((v) => v.severity === "error" && /riser holds 40 mm2/.test(v.message)));
  const big = designWifiCabling({ plan, racks: [rack], risers: [{ id: "s", name: "Shaft", x: 39.25, z: 19.25, areaMm2: 2000 }], pathway: OPEN });
  assert.ok(big.riserUse[0].fillPct < 100);
  assert.ok(!big.violations.some((v) => /riser holds/.test(v.message)));
  // a riser with no size recorded reports the cable count but makes no capacity claim
  const unsized = designWifiCabling({ plan, racks: [rack], risers: [{ id: "s", name: "Shaft", x: 39.25, z: 19.25 }], pathway: OPEN });
  assert.equal(unsized.riserUse[0].capacityMm2, null);
});

// ---- A4: columns -------------------------------------------------------------------------------------

test("a column stops a cable run: the route goes around it, unless columns are switched off", () => {
  const column = { id: "c", floorId: "f1", kind: "column", name: "Column 1", x: 4.6, z: 0, width: 0.8, depth: 9, height: 3 };
  const plan = hall(10, 10, [ap("far", 9.25, 4.75)], { furniture: [column] });
  const r = { ...rack, z: 4.75 };
  const blocked = designWifiCabling({ plan, racks: [r], pathway: OPEN });
  near(blocked.runs[0].horizontalM, 8.5 + 9, 0.05); // up to the gap at the top and back
  const off = designWifiCabling({ plan, racks: [r], pathway: { ...OPEN, columnsBlock: false } });
  near(off.runs[0].horizontalM, 8.5);
  // a column on another floor does not matter
  const other = designWifiCabling({ plan: hall(10, 10, [ap("far", 9.25, 4.75)], { furniture: [{ ...column, floorId: "f2" }] }), racks: [r], pathway: OPEN });
  near(other.runs[0].horizontalM, 8.5);
});

// ---- A5: approval ---------------------------------------------------------------------------------------

test("approval: preliminary until the facts are stated, then validated, then construction-ready", () => {
  const plan = hall(40, 20, [ap("a", 38.25, 10.25)]);
  const rk = { ...rack };
  const base = designWifiCabling({ plan, racks: [rk] });
  assert.equal(base.approval.level, "preliminary");
  assert.match(base.status, /preliminary estimate/);
  assert.ok(base.approval.missing.includes("Ceiling and wall access stated"));
  assert.equal(base.approval.routes.estimated, 1);

  const verified = { ...OPEN, verification: { dimensions: true, pathways: true, equipment: false } };
  const validated = designWifiCabling({ plan, racks: [rk], pathway: verified });
  assert.equal(validated.approval.level, "validated");
  assert.match(validated.status, /validated design/);

  const ready = designWifiCabling({
    plan, racks: [rk],
    pathway: { ...OPEN, verification: { dimensions: true, pathways: true, equipment: true }, routeEdits: { a: { waypoints: [], confirmed: true } } },
  });
  // an empty waypoint list still confirms the automatic route
  assert.equal(ready.runs[0].pathwayStatus, "confirmed");
  assert.equal(ready.approval.level, "construction-ready");
  assert.match(ready.status, /does not certify an installation/);
});

test("approval: an unconfirmed tray or a suggested rack keeps the design preliminary", () => {
  const plan = hall(40, 20, [ap("a", 38.25, 10.25)]);
  const verified = { verification: { dimensions: true, pathways: true, equipment: true } };
  const tray = { id: "t", floorId: "f1", kind: "new", status: "estimated", points: [{ x: 0.75, z: 7.25 }, { x: 38.25, z: 7.25 }] };
  assert.equal(designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, ...verified, trays: [tray] } }).approval.level, "preliminary");
  assert.equal(designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, ...verified, trays: [{ ...tray, status: "confirmed" }] } }).approval.level, "validated");
  assert.equal(designWifiCabling({ plan, racks: [{ ...rack, suggested: true }], pathway: { ...OPEN, ...verified } }).approval.level, "preliminary");
});

test("approval summary on its own: nothing to approve is never 'validated'", () => {
  assert.equal(approvalSummary({ runs: [], racks: [], pathway: { ...OPEN, verification: { dimensions: true, pathways: true, equipment: true } } }).level, "preliminary");
});
