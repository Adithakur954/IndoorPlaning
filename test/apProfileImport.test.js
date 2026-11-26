import test from "node:test";
import assert from "node:assert/strict";
import {
  blankModel,
  csvTemplate,
  jsonTemplate,
  normalizeModel,
  parseModelFile,
  validateModel,
} from "../src/config/apProfileImport.js";

test("a blank manual entry only needs a name", () => {
  const m = blankModel();
  assert.deepEqual(validateModel(m), ["Name is required."]);
  m.name = "My AP";
  assert.deepEqual(validateModel(m), []);
  const n = normalizeModel(m);
  assert.equal(n.model, "My AP");
  assert.equal(n.bands["2.4"].maxTxPowerDbm, null);
});

test("bad radio values are reported per band", () => {
  const m = blankModel();
  m.name = "X";
  m.bands["5"].channel = 7;
  m.bands["5"].widthMHz = 30;
  m.bands["2.4"].txPowerDbm = "";
  const errors = validateModel(m);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith("5 GHz: channel")));
  assert.ok(errors.some((e) => e.startsWith("2.4 GHz: transmit")));
});

test("both templates read back as one valid model", () => {
  for (const [text, name] of [
    [jsonTemplate(), "t.json"],
    [csvTemplate(), "t.csv"],
  ]) {
    const r = parseModelFile(text, name);
    assert.equal(r.error, undefined);
    assert.equal(r.models.length, 1, name);
    assert.deepEqual(r.models[0].errors, [], name);
    assert.deepEqual(Object.keys(r.models[0].model.bands).sort(), ["2.4", "5"]);
    assert.equal(r.models[0].model.bands["5"].widthMHz, 80);
  }
});

test("CSV rows group by name, accept 'GHz' bands and keep bad models apart", () => {
  const csv = [
    "name,band,txPowerDbm,gainDbi,channel,widthMHz",
    "A,2.4 GHz,18,3,1,20",
    "A,6GHz,18,5,37,160",
    "B,5,99,3,36,40",
  ].join("\n");
  const r = parseModelFile(csv, "m.csv");
  assert.equal(r.models.length, 2);
  assert.deepEqual(Object.keys(r.models[0].model.bands).sort(), ["2.4", "6"]);
  assert.equal(r.models[1].model, null);
  assert.ok(r.models[1].errors[0].includes("transmit power"));
});

test("broken files give one readable error", () => {
  assert.ok(parseModelFile("{ nope", "x.json").error);
  assert.match(parseModelFile("name\nA", "x.csv").error, /band/);
});
