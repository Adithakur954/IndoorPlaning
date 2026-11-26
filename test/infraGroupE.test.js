import test from "node:test";
import assert from "node:assert/strict";
import {
  USER_SOURCE, addPart, catalogueToJson, mergeCatalogue, parseCatalogueJson,
  resetPart, setPartField, sourceSummary, validateCatalogue,
} from "../src/infra/wifi/catalogueEdit.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";
import { auditEntry, describeChange, emptyHistory, pushHistory, recordChange, redo, undo } from "../src/infra/wifi/history.js";
import { compareFieldTest, parseFieldTestCsv } from "../src/infra/wifi/fieldTest.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";

// ---- catalogue ------------------------------------------------------------------------------------

test("changing a part's value overrides the default and marks the part as entered by the user", () => {
  const o = setPartField({}, "switches", "sw24", "poeBudgetW", 480);
  const merged = mergeCatalogue(o);
  assert.equal(merged.switches.sw24.poeBudgetW, 480);
  assert.equal(merged.switches.sw24.poePorts, 24); // untouched values stay
  assert.equal(merged.switches.sw24.source, USER_SOURCE);
  assert.equal(DEFAULT_WIFI_CATALOGUE.switches.sw24.poeBudgetW, 370); // the defaults are never changed
  assert.match(DEFAULT_WIFI_CATALOGUE.switches.sw24.source, /illustrative/);
});

test("the design uses the project's catalogue", () => {
  const plan = {
    floors: [{ id: "f1", name: "L1", elevation: 0 }],
    rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 30, depth: 10, height: 3 }],
    doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [],
    sources: Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, kind: "wifi", name: `a${i}`, floorId: "f1", x: 5.25 + i, z: 3.25, heightM: 2.5 })),
  };
  const racks = [{ id: "k", floorId: "f1", x: 0.75, z: 4.75 }];
  const base = designWifiCabling({ plan, racks });
  assert.equal(base.racks[0].switches, 2); // 12 per 370 W switch
  const bigger = mergeCatalogue(setPartField({}, "switches", "sw24", "poeBudgetW", 480));
  const better = designWifiCabling({ plan, racks, catalogue: bigger });
  assert.equal(better.racks[0].switches, 1); // 13 x 30 W = 390 W fits in 480 W
  assert.equal(sourceSummary(better.boq).real >= 1, true); // the switch line now rests on the user's data
});

test("a new part can be added by copying one, and a part can be put back to its default", () => {
  let o = addPart({}, "accessPoints", "ap-at", "my-ap");
  const merged = mergeCatalogue(o);
  assert.equal(merged.accessPoints["my-ap"].id, "my-ap");
  assert.equal(merged.accessPoints["my-ap"].portPowerW, 30);
  assert.throws(() => addPart(o, "accessPoints", "ap-at", "my-ap"), /already exists/);
  assert.throws(() => addPart(o, "accessPoints", "nope", "x"), /there is no/);
  o = setPartField(o, "accessPoints", "my-ap", "portPowerW", 45);
  assert.equal(mergeCatalogue(o).accessPoints["my-ap"].portPowerW, 45);
  o = resetPart(setPartField({}, "switches", "sw24", "poeBudgetW", 1), "switches", "sw24");
  assert.deepEqual(o, {});
  assert.equal(mergeCatalogue(o).switches.sw24.poeBudgetW, 370);
});

test("a catalogue that would not work is reported", () => {
  assert.deepEqual(validateCatalogue(DEFAULT_WIFI_CATALOGUE), []);
  const broken = mergeCatalogue({ switches: { sw24: { poeBudgetW: Number.NaN } }, accessPoints: { x: { id: "x", name: "X" } } });
  const problems = validateCatalogue(broken).join(" | ");
  assert.match(problems, /sw24: "poeBudgetW" is not a number/);
  assert.match(problems, /accessPoints\/x: "portPowerW" is missing/);
});

test("importing JSON: known groups only, a readable message when it is wrong", () => {
  const ok = parseCatalogueJson(JSON.stringify({ switches: { sw24: { poeBudgetW: 500 } }, ignored: { a: {} } }));
  assert.equal(mergeCatalogue(ok).switches.sw24.poeBudgetW, 500);
  assert.equal(mergeCatalogue(ok).switches.sw24.source, USER_SOURCE);
  assert.throws(() => parseCatalogueJson("not json"), /not valid JSON/);
  assert.throws(() => parseCatalogueJson(JSON.stringify({ other: {} })), /has no access points/);
  assert.throws(() => parseCatalogueJson(JSON.stringify({ switches: { sw24: { poeBudgetW: Number.NaN } } })), /would not work|is not valid JSON/);
  assert.throws(() => parseCatalogueJson(JSON.stringify({ switches: { sw24: "x" } })), /must be an object/);
  // export then import gives back the same catalogue
  const again = mergeCatalogue(parseCatalogueJson(catalogueToJson(setPartField({}, "switches", "sw24", "poeBudgetW", 480))));
  assert.equal(again.switches.sw24.poeBudgetW, 480);
});

test("the summary says how much of a BoQ rests on illustrative defaults", () => {
  const s = sourceSummary([{ source: "illustrative default" }, { source: USER_SOURCE }, { source: "Datasheet 2026" }]);
  assert.deepEqual(s, { lines: 3, illustrative: 1, real: 2 });
});

// ---- undo, redo, audit trail ----------------------------------------------------------------------

const fixed = () => "2026-11-18T10:00:00.000Z";

test("a change is described and recorded; no change records nothing", () => {
  const a = { racks: [], risers: [], rules: {}, pathway: { trays: [] } };
  const b = { ...a, racks: [{ id: "k" }], pathway: { trays: [{ id: "t" }], ceiling: { type: "false" } } };
  assert.deepEqual(describeChange(a, b), ["racks", "pathway.trays", "pathway.ceiling"]);
  const entry = auditEntry(a, b, { now: fixed });
  assert.equal(entry.at, fixed());
  assert.match(entry.summary, /Changed racks, pathway.trays, pathway.ceiling/);
  assert.equal(auditEntry(a, { ...a }, { now: fixed }), null);
  assert.equal(recordChange(a, { ...a }), a);
  assert.equal(recordChange(a, b, { now: fixed, summary: "Added a rack" }).auditLog[0].summary, "Added a rack");
});

test("undo and redo restore earlier states; the audit trail only grows", () => {
  const s0 = { racks: [], pathway: {}, auditLog: [] };
  const s1 = recordChange(s0, { ...s0, racks: [{ id: "a" }] }, { now: fixed });
  let h = pushHistory(emptyHistory(), s0);
  const s2 = recordChange(s1, { ...s1, racks: [{ id: "a" }, { id: "b" }] }, { now: fixed });
  h = pushHistory(h, s1);
  assert.equal(s2.racks.length, 2);
  const u1 = undo(h, s2, { now: fixed });
  assert.deepEqual(u1.state.racks, [{ id: "a" }]);
  assert.equal(u1.state.auditLog.length, s2.auditLog.length + 1);
  assert.equal(u1.state.auditLog.at(-1).summary, "Undo");
  const u2 = undo(u1.history, u1.state, { now: fixed });
  assert.deepEqual(u2.state.racks, []);
  assert.equal(undo(u2.history, u2.state), null); // nothing left to undo
  const r1 = redo(u2.history, u2.state, { now: fixed });
  assert.deepEqual(r1.state.racks, [{ id: "a" }]);
  assert.equal(r1.state.auditLog.at(-1).summary, "Redo");
  // a new change after an undo clears what could have been redone
  assert.equal(pushHistory(u1.history, u1.state).future.length, 0);
  // the history is bounded
  let big = emptyHistory();
  for (let i = 0; i < 80; i++) big = pushHistory(big, { racks: [i] });
  assert.equal(big.past.length, 50);
});

// ---- field test --------------------------------------------------------------------------------------

const plan = () => ({
  floors: [{ id: "f1", name: "L1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [],
  sources: [10.25, 20.25, 30.25].map((x, i) => ({ id: `a${i}`, kind: "wifi", name: `AP${i + 1}`, floorId: "f1", x, z: 4.75, heightM: 2.5 })),
});
const design = () => designWifiCabling({ plan: plan(), racks: [{ id: "k", floorId: "f1", x: 0.75, z: 4.75 }] });

test("a certifier's CSV is read, whatever the separator and column names", () => {
  const rows = parseFieldTestCsv('AP;Length (m);Insertion Loss (dB);Result\nAP1;21,5;7.4;PASS\n"AP2";33.0;11.2;Fail\n');
  assert.deepEqual(rows.map((r) => [r.name, r.lengthM, r.insertionLossDb, r.pass]), [["AP1", 21.5, 7.4, true], ["AP2", 33, 11.2, false]]);
  assert.equal(parseFieldTestCsv("link,length_m\nX1,10").length, 1);
  assert.throws(() => parseFieldTestCsv("only a header"), /header row and at least one/);
  assert.throws(() => parseFieldTestCsv("foo,bar\n1,2"), /no column naming the cable/);
  assert.throws(() => parseFieldTestCsv("AP,colour\nA,red"), /"Length" or a "Result"/);
});

test("measured results are set beside the design: length differences, failures, and what was not tested", () => {
  const d = design();
  const designed = Object.fromEntries(d.runs.map((r) => [r.apName, r.permanentLinkM]));
  const csv = `AP,Length,Result\nAP1,${designed.AP1 + 1},Pass\nap2,${designed.AP2 + 8},Fail\nGHOST,10,Pass`;
  const out = compareFieldTest(d, parseFieldTestCsv(csv));
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].differs, false); // 1 m off: within tolerance
  assert.equal(out.rows[1].differs, true); // 8 m off
  assert.equal(out.rows[1].pass, false);
  assert.deepEqual(out.unknown, ["GHOST"]);
  assert.deepEqual(out.notTested, ["AP3"]);
  assert.deepEqual(out.summary, { tested: 2, failed: 1, lengthDiffers: 1, untested: 1 });
});
