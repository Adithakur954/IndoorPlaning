import test from "node:test";
import assert from "node:assert/strict";
import { addImportedParts, cableTemplateCsv, parseCsv, partTemplateCsv, partsFromRows } from "../src/infra/cellular/partImport.js";
import { dasCatalogue, outputPorts } from "../src/infra/cellular/das.js";
import { splitterLossDb } from "../src/infra/cellular/engine/passive.js";

test("the template imports as one part of each type", () => {
  const r = partsFromRows(parseCsv(partTemplateCsv()), "template.csv");
  assert.deepEqual(r.errors, []);
  assert.equal(r.count, 4); // splitter, coupler, combiner, riser
  const sp = Object.values(r.parts.splitters)[0];
  assert.equal(sp.ways, 2);
  assert.ok(Math.abs(splitterLossDb(sp) - 3.4) < 1e-9); // the datasheet loss per output
  assert.equal(Object.values(r.parts.couplers)[0].throughLossDb, 1.1);
  assert.deepEqual([Object.values(r.parts.inline)[0].inputs, Object.values(r.parts.inline)[0].outputs], [2, 1]);
});

test("semicolons, quotes and decimal commas are read; bad rows are named", () => {
  const csv = 'type;model;ways;insertion_loss_db;source\nsplitter;"X; 3W";3;"5,4";"rev ""B"""\nsplitter;BAD;3;2\ncoupler;;;\n';
  const r = partsFromRows(parseCsv(csv));
  assert.equal(r.count, 1);
  const sp = Object.values(r.parts.splitters)[0];
  assert.equal(sp.model, "X; 3W");
  assert.equal(sp.source, 'rev "B"');
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /Row 3 \(BAD\).*even split/);
  assert.match(r.errors[1], /Row 4.*model is missing/);
});

test("an imported splitter is used by the plan: its outputs and its loss", () => {
  const r = partsFromRows(parseCsv("type,model,ways,insertion_loss_db\nsplitter,MY-6W,6,8.5\n"));
  const plan = { floors: [], sources: [], cellular: addImportedParts({}, r.parts) };
  const id = Object.keys(r.parts.splitters)[0];
  assert.equal(dasCatalogue(plan).splitters[id].ways, 6);
  assert.ok(dasCatalogue(plan).splitters.s2); // the built-in ones stay
  const part = { id: "p", kind: "das", dasType: "splitter", partId: id };
  assert.equal(outputPorts({ ...plan, sources: [part] }, part).length, 6);
});

test("a cable file is recognised by its header and imported as cables", () => {
  const r = partsFromRows(parseCsv(cableTemplateCsv()), "cables.csv");
  assert.equal(r.format, "cables");
  assert.deepEqual(r.errors, []);
  assert.equal(Object.keys(r.parts.cables).length, 3);
  const jumper = Object.values(r.parts.cables).find((c) => c.model === "EXAMPLE-J1");
  assert.equal(jumper.fixedLengthM, 1);
  assert.equal(jumper.lossDbPer100m.length, 7);
  assert.equal(Object.keys(r.parts.splitters).length, 0);
});

test("a model already in the catalogue is updated, not added twice", () => {
  const plan = { floors: [], sources: [] };
  // FR-SP0740-NF-6C-2W is built in (id s2): importing it again keeps id s2
  const once = partsFromRows(
    parseCsv("type,model,ways,insertion_loss_db\nsplitter,FR-SP0740-NF-6C-2W,2,3.6\nsplitter,new-2w,2,3.5\n"),
    "a.csv",
    dasCatalogue(plan),
  );
  assert.deepEqual(Object.keys(once.parts.splitters).sort(), ["imp-sp-new-2w", "s2"]);
  assert.deepEqual([once.added, once.updated, once.unchanged], [1, 1, 0]);
  const plan2 = { ...plan, cellular: addImportedParts({}, once.parts) };
  assert.equal(Object.values(dasCatalogue(plan2).splitters).filter((p) => p.model === "FR-SP0740-NF-6C-2W").length, 1);
  // the same file again: nothing new
  const again = partsFromRows(
    parseCsv("type,model,ways,insertion_loss_db\nsplitter,FR-SP0740-NF-6C-2W,2,3.6\nsplitter,new-2w,2,3.5\n"),
    "a.csv",
    dasCatalogue(plan2),
  );
  assert.deepEqual([again.added, again.updated, again.unchanged], [0, 0, 2]);
  // the model in other letters is the same model: the same entry, no second one
  const caps = partsFromRows(parseCsv("type,model,ways,insertion_loss_db\nsplitter,NEW-2W,2,3.5\n"), "b.csv", dasCatalogue(plan2));
  assert.deepEqual(Object.keys(caps.parts.splitters), ["imp-sp-new-2w"]);
  assert.equal(caps.added, 0);
  // the same model twice in one file: one entry, and a note
  const twice = partsFromRows(parseCsv("type,model,ways,insertion_loss_db\nsplitter,X,2,3.4\nsplitter,x,2,3.5\n"));
  assert.equal(Object.keys(twice.parts.splitters).length, 1);
  assert.match(twice.errors[0], /also on row 2/);
});

test("an imported riser carries its loss; the built-in floor transition has none", () => {
  const r = partsFromRows(parseCsv("type,model,insertion_loss_db\nriser,FT-1,0.5\n"));
  const id = Object.keys(r.parts.risers)[0];
  const plan = { floors: [], sources: [], cellular: addImportedParts({}, r.parts) };
  assert.equal(dasCatalogue(plan).risers[id].lossDb, 0.5);
  assert.equal(dasCatalogue(plan).risers.riser.lossDb, 0);
});
