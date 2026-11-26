import test from "node:test";
import assert from "node:assert/strict";
import { resolveWallPolicy, WALL_MARK_LABELS } from "../src/infra/core/pathway.js";
import { floorRoutingInput } from "../src/infra/core/planGeometry.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";

const near = (a, b, tol = 0.01, label = "") => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);
const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const SOLID = { ceiling: { type: "solid", voidAccess: "none", partitionToSlab: "yes" } };

const hall = (sources, width = 40, depth = 10) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });
const rack = { id: "k1", floorId: "f1", x: 0.75, z: 4.75 };

// ---- tray fill ------------------------------------------------------------------------------

test("tray fill: the busiest section against the tray's cross-section", () => {
  const sources = Array.from({ length: 30 }, (_, i) => ap(`a${i}`, 36.25 + (i % 3) * 0.5, 0.75 + Math.floor(i / 3) * 0.9));
  const small = structuredClone(DEFAULT_WIFI_CATALOGUE);
  small.passive.tray.widthMm = 50;
  small.passive.tray.depthMm = 50;
  const d = designWifiCabling({ plan: hall(sources), racks: [rack], pathway: OPEN, catalogue: small });
  const cableMm2 = Math.PI * (7.5 / 2) ** 2;
  assert.ok(d.trayFill.maxCables >= 20, `cables in the busiest section: ${d.trayFill.maxCables}`);
  near(d.trayFill.fillPct, ((d.trayFill.maxCables * cableMm2) / 2500) * 100, 0.1);
  assert.ok(d.trayFill.fillPct > 40);
  const error = d.violations.find((v) => v.severity === "error" && v.item === "Cable tray");
  assert.ok(error, "over the fill limit is an error");
  assert.match(error.message, /Use a tray at least \d+ mm wide/);
  // the width asked for is enough
  assert.ok((d.trayFill.maxCables * cableMm2) / (d.trayFill.requiredWidthMm * 50) <= 0.4 + 1e-9);
  // a normal 300 x 100 tray carries the same cables easily
  const fine = designWifiCabling({ plan: hall(sources), racks: [rack], pathway: OPEN });
  assert.ok(fine.trayFill.fillPct < 15);
  assert.ok(!fine.violations.some((v) => v.item === "Cable tray"));
});

// ---- power and data -----------------------------------------------------------------------------

test("data cable that runs close to power cabling is flagged, with the length", () => {
  const plan = hall([ap("far", 38.25, 4.75)]);
  const along = designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, powerRoutes: [{ id: "p", floorId: "f1", points: [{ x: 0, z: 4.75 }, { x: 40, z: 4.75 }] }] } });
  assert.ok(along.powerSeparationM > 30, `close run: ${along.powerSeparationM} m`);
  assert.ok(along.violations.some((v) => v.severity === "warning" && /within 300 mm of power cabling/.test(v.message)));
  const away = designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, powerRoutes: [{ id: "p", floorId: "f1", points: [{ x: 0, z: 9.5 }, { x: 40, z: 9.5 }] }] } });
  assert.equal(away.powerSeparationM, 0);
  assert.ok(!away.violations.some((v) => /power cabling/.test(v.message)));
  // a larger separation catches the nearer power cable
  const wide = designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, powerRoutes: [{ id: "p", floorId: "f1", points: [{ x: 0, z: 5.75 }, { x: 40, z: 5.75 }] }] }, rules: { powerSeparationM: 1.2 } });
  assert.ok(wide.powerSeparationM > 30);
  const narrow = designWifiCabling({ plan, racks: [rack], pathway: { ...OPEN, powerRoutes: [{ id: "p", floorId: "f1", points: [{ x: 0, z: 5.75 }, { x: 40, z: 5.75 }] }] } });
  assert.equal(narrow.powerSeparationM, 0);
});

// ---- fire-stopped sleeves ---------------------------------------------------------------------------

const twoRooms = () => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [
    { id: "A", floorId: "f1", name: "A", shape: "rectangle", x: 0, z: 0, width: 10, depth: 6, height: 3 },
    { id: "B", floorId: "f1", name: "B", shape: "rectangle", x: 10, z: 0, width: 10, depth: 6, height: 3 },
  ],
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [],
  sources: [ap("x", 19.25, 0.75), ap("y", 17.25, 0.75), ap("z", 15.25, 0.75)],
});

test("a fire-rated wall crossed through an approved fire-stopped sleeve needs a fire-stop kit", () => {
  const plan = twoRooms();
  const wall = floorRoutingInput(plan, "f1", SOLID).walls.find((w) => Math.abs(w.a.x - 10) < 1e-6 && Math.abs(w.b.x - 10) < 1e-6);
  const r = { id: "k1", floorId: "f1", x: 0.75, z: 0.75 };
  const stopped = designWifiCabling({ plan, racks: [r], pathway: { ...SOLID, wallOverrides: { [wall.key]: "fire-stopped" } } });
  assert.equal(stopped.runs.length, 3);
  assert.ok(stopped.runs.every((run) => run.penetrations === 1));
  assert.equal(stopped.fireStopKits, 1); // 3 cables, one kit takes up to 12
  const line = stopped.boq.find((l) => l.partId === "fire-stop-kit");
  assert.ok(line && line.qty === 1);
  // a plain sleeve has no fire-stop
  const plain = designWifiCabling({ plan, racks: [r], pathway: { ...SOLID, wallOverrides: { [wall.key]: "sleeve" } } });
  assert.equal(plain.fireStopKits, 0);
  assert.equal(plain.boq.find((l) => l.partId === "fire-stop-kit"), undefined);
});

test("the fire-stopped mark is a permitted penetration with its own label", () => {
  assert.match(WALL_MARK_LABELS["fire-stopped"], /fire-stopped sleeve/);
  const piece = { key: "k", owners: ["A", "B"] };
  assert.equal(resolveWallPolicy(piece, { ...SOLID, wallOverrides: { k: "fire-stopped" } }).policy, "penetration");
  assert.equal(resolveWallPolicy(piece, { ...OPEN, wallOverrides: { k: "fire-rated" } }).policy, "blocked");
});

test("the design records the bend-radius and bundle-heating assumptions it does not calculate", () => {
  const d = designWifiCabling({ plan: hall([ap("a", 20.25, 4.75)]), racks: [rack], pathway: OPEN });
  assert.ok(d.assumptions.some((a) => /Bend radius: keep every bend at least 30 mm/.test(a)));
  assert.ok(d.assumptions.some((a) => /bundle heating is not calculated/.test(a)));
});
