import test from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon } from "../src/infra/core/pathway.js";
import { floorRoutingInput } from "../src/infra/core/planGeometry.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";

const near = (a, b, tol = 0.01, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

const hall = (width, depth, sources, extra = {}) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }, { id: "f2", name: "Level 2", elevation: 3.2 }],
  rooms: [
    { id: "h1", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 },
    { id: "h2", floorId: "f2", name: "Hall 2", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 },
  ],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources, ...extra,
});
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });
const rack = { id: "k1", floorId: "f1", x: 0.75, z: 4.75 };
const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const poly = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const run = (plan, pathway, rules = {}) => designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, ...pathway }, rules });

test("point in polygon", () => {
  const square = poly(0, 0, 4, 4);
  assert.equal(pointInPolygon(2, 2, square), true);
  assert.equal(pointInPolygon(5, 2, square), false);
  assert.equal(pointInPolygon(2, -1, square), false);
  const L = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 2 }, { x: 2, z: 2 }, { x: 2, z: 4 }, { x: 0, z: 4 }];
  assert.equal(pointInPolygon(3, 3, L), false);
  assert.equal(pointInPolygon(1, 3, L), true);
});

test("a no-go area takes its cells out of the routing floor", () => {
  const plan = hall(40, 10, []);
  const pathway = { noGo: [{ id: "n", floorId: "f1", polygon: poly(15, 0, 20, 7) }] };
  const input = floorRoutingInput(plan, "f1", pathway);
  assert.equal(input.footprint(17, 3), false); // inside the no-go area
  assert.equal(input.footprint(17, 8.5), true); // beside it
  assert.equal(input.footprint(30, 3), true);
  // another floor's no-go area does not apply
  const other = floorRoutingInput(plan, "f2", pathway);
  assert.equal(other.footprint(17, 3), true);
});

test("a cable goes around a no-go area, and the detour is counted in its length", () => {
  const plan = hall(40, 10, [ap("far", 38.25, 4.75)]);
  const straight = run(plan, {}).runs[0];
  near(straight.horizontalM, 37.5);
  // the no-go area blocks z 0..7 between x 15 and 20: the cable must pass through z 7..10
  const detour = run(plan, { noGo: [{ id: "n", floorId: "f1", polygon: poly(15, 0, 20, 7) }] }).runs[0];
  near(detour.horizontalM, 37.5 + 2.5 + 2.5);
});

test("a no-go area across the whole width leaves the AP unreachable, and says so", () => {
  const plan = hall(40, 10, [ap("far", 38.25, 4.75)]);
  const d = run(plan, { noGo: [{ id: "n", floorId: "f1", polygon: poly(15, -1, 20, 11) }] });
  assert.equal(d.runs.length, 0);
  assert.ok(d.violations.some((v) => v.severity === "error" && /no permitted cable route/.test(v.message)));
});

test("a drawn tray is the preferred pathway: the cable follows it, even if that is a little longer", () => {
  const plan = hall(40, 20, [ap("far", 38.25, 10.25)]);
  const tray = { id: "t", floorId: "f1", kind: "new", points: [{ x: 0.75, z: 7.25 }, { x: 38.25, z: 7.25 }] };
  const base = designWifiCabling({ plan, racks: [{ ...rack, z: 10.25 }], pathway: OPEN });
  const withTray = designWifiCabling({ plan, racks: [{ ...rack, z: 10.25 }], pathway: { ...OPEN, trays: [tray] } });
  near(base.runs[0].horizontalM, 37.5);
  assert.equal(base.runs[0].onTrayM, 0);
  // 3 m up to the tray, along it, 3 m back down
  near(withTray.runs[0].horizontalM, 37.5 + 6);
  assert.ok(withTray.runs[0].onTrayM >= 36, `on the tray: ${withTray.runs[0].onTrayM} m`);
});

test("turning the tray preference off (factor 1) gives the direct route again", () => {
  const plan = hall(40, 20, [ap("far", 38.25, 10.25)]);
  const tray = { id: "t", floorId: "f1", kind: "new", points: [{ x: 0.75, z: 7.25 }, { x: 38.25, z: 7.25 }] };
  const d = designWifiCabling({ plan, racks: [{ ...rack, z: 10.25 }], pathway: { ...OPEN, trays: [tray] }, rules: { trayFactor: 1 } });
  near(d.runs[0].horizontalM, 37.5);
});

test("an existing tray is not bought; a new one is", () => {
  const plan = hall(40, 20, [ap("a", 38.25, 7.25), ap("b", 36.25, 7.25)]);
  const points = [{ x: 0.75, z: 7.25 }, { x: 38.25, z: 7.25 }];
  const racks = [{ ...rack, z: 7.25 }];
  const newTray = designWifiCabling({ plan, racks, pathway: { ...OPEN, trays: [{ id: "t", floorId: "f1", kind: "new", points }] } });
  const existing = designWifiCabling({ plan, racks, pathway: { ...OPEN, trays: [{ id: "t", floorId: "f1", kind: "existing", points }] } });
  const trayLine = (d) => d.boq.find((l) => l.partId === "tray-3m");
  assert.equal(newTray.existingTrayM, 0);
  assert.ok(trayLine(newTray).qty >= 12, `new tray sections: ${trayLine(newTray).qty}`);
  assert.ok(existing.existingTrayM >= 36, `existing tray used: ${existing.existingTrayM} m`);
  assert.equal(trayLine(existing), undefined, "nothing to buy when the whole route is on the existing tray");
  // the cables themselves are the same either way
  assert.deepEqual(existing.runs.map((r) => r.permanentLinkM), newTray.runs.map((r) => r.permanentLinkM));
  // and the basis line says what was left out
  const mixed = designWifiCabling({ plan: hall(40, 20, [ap("c", 38.25, 12.25)]), racks, pathway: { ...OPEN, trays: [{ id: "t", floorId: "f1", kind: "existing", points }] } });
  assert.match(trayLine(mixed).basis, /on existing trays you drew and is not bought/);
});

test("a tray on another floor does not change this floor's routes", () => {
  const plan = hall(40, 20, [ap("far", 38.25, 10.25)]);
  const tray = { id: "t", floorId: "f2", kind: "new", points: [{ x: 0.75, z: 7.25 }, { x: 38.25, z: 7.25 }] };
  const d = designWifiCabling({ plan, racks: [{ ...rack, z: 10.25 }], pathway: { ...OPEN, trays: [tray] } });
  near(d.runs[0].horizontalM, 37.5);
});
