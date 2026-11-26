import test from "node:test";
import assert from "node:assert/strict";
import { resolveWallPolicy, wallKey, pathwayStated, roomCeiling } from "../src/infra/core/pathway.js";
import { floorRoutingInput } from "../src/infra/core/planGeometry.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { suggestRacks } from "../src/infra/wifi/racks.js";

const near = (a, b, tol = 1e-6, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

// Rooms A and B side by side; the wall between them at x = 10 has a door at z 4..5.
const twoRooms = ({ door = true, sources } = {}) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [
    { id: "A", floorId: "f1", name: "A", shape: "rectangle", x: 0, z: 0, width: 10, depth: 6, height: 3 },
    { id: "B", floorId: "f1", name: "B", shape: "rectangle", x: 10, z: 0, width: 10, depth: 6, height: 3 },
  ],
  doors: door ? [{ id: "d", floorId: "f1", roomId: "A", wallSide: "east", offset: 4, width: 1, height: 2.1 }] : [],
  windows: [], interiorWalls: [], boundaries: [],
  sources: sources || [{ id: "ap", kind: "wifi", name: "AP", floorId: "f1", x: 19.25, z: 0.75, heightM: 2.5 }],
});
const rack = { id: "k1", floorId: "f1", x: 0.75, z: 0.75 };
const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const SOLID = { ceiling: { type: "solid", voidAccess: "none", partitionToSlab: "yes" } };
const run = (plan, pathway, rules = {}) => designWifiCabling({ plan, racks: [rack], pathway, rules });

test("the wall rule: unknown facts mean an estimate, stated facts decide", () => {
  const piece = { key: "k", owners: ["A", "B"] };
  assert.equal(resolveWallPolicy(piece, {}).policy, "penalty");
  assert.equal(resolveWallPolicy(piece, OPEN).policy, "permitted");
  assert.equal(resolveWallPolicy(piece, SOLID).policy, "blocked");
  // an accessible void is not enough if the partition reaches the slab
  assert.equal(resolveWallPolicy(piece, { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "yes" } }).policy, "blocked");
  // an open ceiling with restricted access is not usable
  assert.equal(resolveWallPolicy(piece, { ceiling: { type: "open", voidAccess: "restricted", partitionToSlab: "no" } }).policy, "blocked");
  // the partition height is unknown: still an estimate
  assert.equal(resolveWallPolicy(piece, { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "unknown" } }).policy, "penalty");
});

test("marks on a wall win over the ceiling settings", () => {
  const piece = { key: "f1|a|b", owners: ["A", "B"] };
  const marks = (m) => ({ ...SOLID, wallOverrides: { [piece.key]: m } });
  assert.equal(resolveWallPolicy(piece, marks("opening")).policy, "penetration");
  assert.equal(resolveWallPolicy(piece, marks("sleeve")).policy, "penetration");
  for (const m of ["not-permitted", "fire-rated", "structural"])
    assert.equal(resolveWallPolicy(piece, { ...OPEN, wallOverrides: { [piece.key]: m } }).policy, "blocked", m);
});

test("room settings override the project; the wall follows its strictest room", () => {
  const piece = { key: "k", owners: ["A", "B"] };
  const noAccessInB = { ...OPEN, roomOverrides: { B: { voidAccess: "none" } } };
  assert.equal(resolveWallPolicy(piece, noAccessInB).policy, "blocked");
  assert.equal(roomCeiling(noAccessInB, "B").voidAccess, "none");
  assert.equal(roomCeiling(noAccessInB, "A").voidAccess, "accessible");
  const unknownInA = { ...OPEN, roomOverrides: { A: { type: "unknown" } } };
  assert.equal(resolveWallPolicy(piece, unknownInA).policy, "penalty");
  // an interior wall with no room uses the project default
  assert.equal(resolveWallPolicy({ key: "x", owners: [] }, SOLID).policy, "blocked");
  assert.equal(resolveWallPolicy({ key: "x", owners: [] }, OPEN).policy, "permitted");
});

test("stated means the ceiling type and access were given", () => {
  assert.equal(pathwayStated({}), false);
  assert.equal(pathwayStated({ ceiling: { type: "false" } }), false);
  assert.equal(pathwayStated(OPEN), true);
});

test("wall keys do not depend on which end is listed first", () => {
  assert.equal(wallKey("f1", { x: 1, z: 2 }, { x: 3, z: 4 }), wallKey("f1", { x: 3, z: 4 }, { x: 1, z: 2 }));
});

test("the routing input marks each wall piece with its policy and key", () => {
  const input = floorRoutingInput(twoRooms(), "f1", SOLID);
  assert.ok(input.walls.length > 0);
  assert.ok(input.walls.every((w) => w.policy === "blocked" && w.key.startsWith("f1|")));
  assert.equal(floorRoutingInput(twoRooms(), "f1", OPEN).walls.every((w) => w.policy === "permitted"), true);
  assert.equal(floorRoutingInput(twoRooms(), "f1").walls.every((w) => w.policy === "penalty"), true);
});

test("ceiling unknown: the cable goes over the wall as an ESTIMATE and is flagged", () => {
  const d = run(twoRooms(), {}, { crossPenaltyM: 3 });
  const r = d.runs[0];
  assert.equal(r.crossings, 1);
  assert.equal(r.pathwayStatus, "estimated");
  near(r.horizontalM, 18.5);
  assert.ok(d.violations.some((v) => v.severity === "warning" && /Ceiling access is not confirmed/.test(v.message)));
  assert.ok(d.assumptions.some((a) => /Ceiling access is unknown/.test(a)));
});

test("accessible ceiling void over low partitions: the cable crosses, and the route is 'stated'", () => {
  const d = run(twoRooms(), OPEN);
  const r = d.runs[0];
  near(r.horizontalM, 18.5); // straight over the partition
  assert.equal(r.permittedCrossings, 1);
  assert.equal(r.crossings, 0);
  assert.equal(r.pathwayStatus, "stated");
  assert.ok(!d.violations.some((v) => /Ceiling access is not confirmed/.test(v.message)));
  assert.ok(d.assumptions.some((a) => /Ceiling and wall settings were given/.test(a)));
});

test("a solid ceiling, or partitions to the slab: the cable must use the door", () => {
  for (const pathway of [SOLID, { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "yes" } }]) {
    const r = run(twoRooms(), pathway).runs[0];
    near(r.horizontalM, 18.5 + 7); // 3.5 m to the door row, across, 3.5 m back
    assert.equal(r.permittedCrossings, 0);
    assert.equal(r.crossings, 0);
    assert.equal(r.pathwayStatus, "stated");
  }
});

test("no door and no way over the wall: the AP is reported as unreachable, with what to change", () => {
  const d = run(twoRooms({ door: false }), SOLID);
  assert.equal(d.runs.length, 0);
  const error = d.violations.find((v) => v.severity === "error");
  assert.ok(error);
  assert.match(error.message, /no permitted cable route/);
  assert.match(error.message, /opening or approved sleeve/);
});

test("marking one wall piece as an opening makes the crossing possible there", () => {
  const plan = twoRooms({ door: false });
  const walls = floorRoutingInput(plan, "f1", SOLID).walls;
  const middle = walls.find((w) => Math.abs(w.a.x - 10) < 1e-6 && Math.abs(w.b.x - 10) < 1e-6);
  assert.ok(middle, "the shared wall piece exists");
  const marked = { ...SOLID, wallOverrides: { [middle.key]: "sleeve" } };
  const r = run(plan, marked).runs[0];
  near(r.horizontalM, 18.5);
  assert.equal(r.penetrations, 1); // through the sleeve, not over the partition
  assert.equal(r.permittedCrossings, 0);
  // a fire-rated mark closes it again, even with an accessible ceiling
  const closed = { ...OPEN, wallOverrides: { [middle.key]: "fire-rated" } };
  assert.equal(run(plan, closed).runs.length, 0);
});

test("a room with no ceiling access closes its partitions, even when the project says accessible", () => {
  const pathway = { ...OPEN, roomOverrides: { B: { voidAccess: "none" } } };
  const r = run(twoRooms(), pathway).runs[0];
  near(r.horizontalM, 18.5 + 7);
});

test("the rack suggestion respects the same rules", () => {
  const plan = twoRooms({
    door: false,
    sources: [
      { id: "a", kind: "wifi", name: "a", floorId: "f1", x: 4.25, z: 3.25, heightM: 2.5 },
      { id: "b", kind: "wifi", name: "b", floorId: "f1", x: 15.25, z: 3.25, heightM: 2.5 },
    ],
  });
  // sealed rooms: no single rack reaches both
  const sealed = suggestRacks({ plan, pathway: SOLID });
  assert.ok(sealed.racks.length >= 2 || sealed.uncovered.length > 0);
  // with an accessible ceiling one rack reaches both
  const open = suggestRacks({ plan, pathway: OPEN });
  assert.equal(open.racks.length, 1);
  assert.deepEqual(open.uncovered, []);
});
