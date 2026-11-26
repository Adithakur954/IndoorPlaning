import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyInfrastructure,
  makeEquipmentRoom,
  makePathway,
  makeRestrictedArea,
  makeRiser,
} from "../src/infra/model/schema.js";
import { confidenceOf, validateInfrastructure } from "../src/infra/model/validate.js";
import { applyChanges, inverseChanges, undoRevision } from "../src/infra/model/revisions.js";
import { fromLegacyCabling, infrastructureOf } from "../src/infra/model/fromPlan.js";

const room = (id, name, floorId, x, z, w = 20, d = 10) => ({
  id, floorId, name, shape: "rectangle", x, z, width: w, depth: d, height: 3,
});
const plan = () => ({
  floors: [
    { id: "f1", name: "Level 1", elevation: 0 },
    { id: "f2", name: "Level 2", elevation: 3.2 },
  ],
  rooms: [room("a", "Hall 1", "f1", 0, 0), room("b", "Hall 2", "f2", 0, 0)],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources: [],
});
const fixed = () => "2026-11-18T10:00:00.000Z";
const meta = (summary = "") => ({ by: "tester", summary, now: fixed });

const mdf = makeEquipmentRoom({ id: "mdf1", name: "MDF", kind: "mdf", floorId: "f1", x: 2, z: 2 });
const idf = makeEquipmentRoom({ id: "idf2", name: "IDF 2", kind: "idf", floorId: "f2", x: 2, z: 2 });
const riser = makeRiser({ id: "r1", name: "Shaft A", x: 18, z: 8, floorIds: ["f1", "f2"], areaMm2: 90000 });
const tray = makePathway({ id: "t1", name: "Main tray", floorId: "f1", widthMm: 300, depthMm: 100, points: [{ x: 1, z: 5 }, { x: 19, z: 5 }] });

const build = () => {
  let m = emptyInfrastructure();
  m = applyChanges(m, [
    { op: "add", collection: "equipmentRooms", entity: mdf },
    { op: "add", collection: "equipmentRooms", entity: idf },
    { op: "add", collection: "risers", entity: riser },
    { op: "add", collection: "pathways", entity: tray },
  ], meta("initial"));
  return m;
};
const errors = (m) => validateInfrastructure(m, plan()).filter((p) => p.severity === "error");

test("a valid model has no problems", () => {
  assert.deepEqual(validateInfrastructure(build(), plan()), []);
});

test("changes return a new model and leave the old one untouched", () => {
  const before = emptyInfrastructure();
  const snapshot = JSON.stringify(before);
  const after = applyChanges(before, [{ op: "add", collection: "risers", entity: riser }], meta());
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(after.revision, 1);
  assert.equal(before.revision, 0);
});

test("every change set is recorded: who, when, what, before and after", () => {
  let m = build();
  m = applyChanges(m, [{ op: "update", collection: "equipmentRooms", id: "idf2", patch: { status: "confirmed", rackUnits: 24 } }], meta("confirm IDF"));
  assert.equal(m.revisions.length, 2);
  const entry = m.revisions[1];
  assert.equal(entry.revision, 2);
  assert.equal(entry.by, "tester");
  assert.equal(entry.at, fixed());
  assert.equal(entry.summary, "confirm IDF");
  assert.equal(entry.changes[0].before.status, "estimated");
  assert.equal(entry.changes[0].after.status, "confirmed");
  assert.equal(entry.changes[0].after.rackUnits, 24);
});

test("an id cannot be reused or changed, and unknown targets are refused", () => {
  const m = build();
  assert.throws(() => applyChanges(m, [{ op: "add", collection: "risers", entity: { ...riser, id: "mdf1" } }], meta()), /already exists/);
  assert.throws(() => applyChanges(m, [{ op: "update", collection: "risers", id: "r1", patch: { id: "x" } }], meta()), /cannot be changed/);
  assert.throws(() => applyChanges(m, [{ op: "remove", collection: "risers", id: "nope" }], meta()), /no risers entry/);
  assert.throws(() => applyChanges(m, [{ op: "add", collection: "rooms", entity: { id: "z" } }], meta()), /unknown collection/);
  assert.throws(() => applyChanges(m, [], meta()), /at least one change/);
  assert.throws(() => applyChanges(m, [{ op: "verify", key: "luck", value: true }], meta()), /unknown verification/);
});

test("a failed change set changes nothing (all or nothing)", () => {
  const m = build();
  const snapshot = JSON.stringify(m);
  assert.throws(() =>
    applyChanges(m, [
      { op: "remove", collection: "pathways", id: "t1" },
      { op: "remove", collection: "pathways", id: "missing" },
    ], meta()),
  );
  assert.equal(JSON.stringify(m), snapshot);
});

test("undo restores the exact earlier state as a new revision", () => {
  let m = build();
  const before = JSON.stringify({ ...m, revision: 0, revisions: [] });
  m = applyChanges(m, [
    { op: "update", collection: "risers", id: "r1", patch: { areaMm2: 1234, note: "added" } },
    { op: "remove", collection: "pathways", id: "t1" },
    { op: "verify", key: "dimensions", value: true },
  ], meta("edit"));
  const undone = undoRevision(m, 2, meta());
  assert.equal(undone.revision, 3);
  assert.match(undone.revisions[2].summary, /Undo revision 2: edit/);
  assert.equal(JSON.stringify({ ...undone, revision: 0, revisions: [] }), before);
  assert.equal(undone.revisions.length, 3); // the trail only grows
  assert.throws(() => undoRevision(m, 99, meta()), /no revision 99/);
  assert.equal(inverseChanges(m.revisions[1])[0].op, "verify");
});

test("validation: floors, positions, ids, kinds and statuses", () => {
  const bad = build();
  bad.equipmentRooms[0].floorId = "nowhere";
  bad.equipmentRooms[1].x = Number.NaN;
  bad.risers[0].floorIds = ["f1"];
  bad.pathways[0].points = [{ x: 1, z: 1 }];
  bad.pathways[0].widthMm = 0;
  const messages = errors(bad).map((p) => p.message).join(" | ");
  assert.match(messages, /floor "nowhere" does not exist/);
  assert.match(messages, /not a number/);
  assert.match(messages, /at least two floors/);
  assert.match(messages, /at least two points/);
  assert.match(messages, /widthMm and depthMm/);
});

test("validation: a duplicate id, bad status and a bad schema version are errors", () => {
  const dup = build();
  dup.risers[0].id = "mdf1";
  assert.match(errors(dup).map((p) => p.message).join(), /used twice/);
  const status = build();
  status.risers[0].status = "maybe";
  assert.match(errors(status).map((p) => p.message).join(), /status must be/);
  const schema = build();
  schema.schemaVersion = 99;
  assert.match(errors(schema).map((p) => p.message).join(), /unsupported schema version/);
  const trail = build();
  trail.revision = 7;
  assert.match(errors(trail).map((p) => p.message).join(), /does not match the audit trail/);
});

test("validation: equipment and shafts must be inside the building", () => {
  const out = build();
  out.equipmentRooms[0].x = 500;
  out.risers[0].x = -50;
  const messages = errors(out).map((p) => p.message).join(" | ");
  assert.match(messages, /position is outside the building/);
  assert.match(messages, /shaft is outside the building on floor/);
});

test("validation: floor rooms need a main room; capacity values must be sane", () => {
  const m = build();
  m.equipmentRooms = m.equipmentRooms.filter((r) => r.kind !== "mdf");
  assert.match(errors(m).map((p) => p.message).join(), /no main room \(MDF\)/);
  const u = build();
  u.equipmentRooms[0].rackUnits = 0;
  u.risers[0].areaMm2 = 0;
  u.pathways[0].fillLimit = 1.5;
  const messages = errors(u).map((p) => p.message).join(" | ");
  assert.match(messages, /rackUnits/);
  assert.match(messages, /areaMm2/);
  assert.match(messages, /fillLimit/);
});

test("validation: restricted areas need a real polygon; a pathway outside the outline only warns", () => {
  let m = build();
  m = applyChanges(m, [
    { op: "add", collection: "restrictedAreas", entity: makeRestrictedArea({ id: "ra", floorId: "f1", polygon: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }) },
  ], meta());
  assert.match(errors(m).map((p) => p.message).join(), /at least three points/);
  const warn = build();
  warn.pathways[0].points = [{ x: 1, z: 5 }, { x: 90, z: 5 }];
  const all = validateInfrastructure(warn, plan());
  assert.ok(all.some((p) => p.severity === "warning" && /outside the building outline/.test(p.message)));
  assert.deepEqual(all.filter((p) => p.severity === "error"), []);
});

test("confidence: preliminary until everything is confirmed and verified", () => {
  let m = build();
  assert.equal(confidenceOf(m).level, "preliminary");
  assert.match(confidenceOf(m).reasons.join(), /estimated/);
  for (const [collection, list] of [["equipmentRooms", m.equipmentRooms], ["risers", m.risers], ["pathways", m.pathways]])
    for (const e of list)
      m = applyChanges(m, [{ op: "update", collection, id: e.id, patch: { status: "confirmed" } }], meta());
  assert.equal(confidenceOf(m).level, "preliminary"); // checks not made yet
  m = applyChanges(m, [{ op: "verify", key: "dimensions", value: true }, { op: "verify", key: "pathways", value: true }], meta());
  assert.equal(confidenceOf(m).level, "validated");
  m = applyChanges(m, [{ op: "verify", key: "equipment", value: true }], meta());
  assert.equal(confidenceOf(m).level, "construction-ready");
  assert.deepEqual(confidenceOf(m).reasons, []);
  m = applyChanges(m, [{ op: "update", collection: "risers", id: "r1", patch: { status: "estimated" } }], meta());
  assert.equal(confidenceOf(m).level, "preliminary");
});

test("projects from the first cabling screen are converted without changing the plan", () => {
  const p = plan();
  p.cabling = {
    racks: [
      { id: "k1", name: "Rack 1", floorId: "f1", x: 2, z: 2 },
      { id: "k2", name: "Rack 2 (suggested)", floorId: "f2", x: 4, z: 4, suggested: true },
    ],
    risers: [{ id: "s1", name: "Shaft", x: 18, z: 8 }],
  };
  const snapshot = JSON.stringify(p);
  const model = infrastructureOf(p);
  assert.equal(JSON.stringify(p), snapshot);
  assert.deepEqual(model.equipmentRooms.map((r) => [r.id, r.kind, r.status, r.source]), [
    ["k1", "idf", "confirmed", "user"],
    ["k2", "idf", "estimated", "tool"],
  ]);
  assert.deepEqual(model.risers[0].floorIds, ["f1", "f2"]);
  // two racks and no main room: reported, not invented
  const found = validateInfrastructure(model, p).filter((x) => x.severity === "error").map((x) => x.message).join(" | ");
  assert.match(found, /no main room/);
  assert.match(found, /areaMm2/); // the old riser never recorded its size
  // a lone rack is the main room
  p.cabling.racks = [p.cabling.racks[0]];
  assert.equal(fromLegacyCabling(p).equipmentRooms[0].kind, "mdf");
});

test("a stored model wins over the legacy data", () => {
  const p = plan();
  p.cabling = { racks: [{ id: "old", floorId: "f1", x: 1, z: 1 }], risers: [] };
  p.infra = build();
  assert.equal(infrastructureOf(p), p.infra);
});
