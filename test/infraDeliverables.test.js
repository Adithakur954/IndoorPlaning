import test from "node:test";
import assert from "node:assert/strict";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { NOT_CHECKED, complianceRows } from "../src/infra/wifi/compliance.js";
import { buildRackElevationSvg, buildTopologySvg, rackDevices } from "../src/infra/wifi/rackSvg.js";

const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const building = (sources) => ({
  floors: [{ id: "f1", name: "Ground", elevation: 0 }, { id: "f2", name: "First", elevation: 3.2 }],
  rooms: ["f1", "f2"].map((f) => ({ id: `r-${f}`, floorId: f, name: f, shape: "rectangle", x: 0, z: 0, width: 30, depth: 10, height: 3 })),
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, floorId, x) => ({ id, kind: "wifi", name: id, floorId, x, z: 3.25, heightM: 2.5 });
const racks = [
  { id: "mdf", name: "Main room", floorId: "f1", x: 0.75, z: 4.75, role: "mdf" },
  { id: "idf", name: "First floor room", floorId: "f2", x: 0.75, z: 4.75, role: "idf" },
];
const shaft = [{ id: "s", name: "Shaft", x: 28.75, z: 8.75, areaMm2: 1000 }];
const make = (extra = {}) =>
  designWifiCabling({ plan: building([ap("g1", "f1", 10.25), ap("g2", "f1", 12.25), ap("u1", "f2", 10.25)]), racks, risers: shaft, pathway: OPEN, ...extra });

test("the rack elevation stacks the devices unit by unit and counts what is left", () => {
  const d = make();
  const out = buildRackElevationSvg({ design: d, racks });
  assert.equal(out.items.length, 2);
  const mdf = out.items.find((i) => i.rackId === "mdf");
  // fibre panel, switch, patch panel, then a manager after each pair and one after the last device
  assert.deepEqual(mdf.devices.map((x) => x.kind), ["fibre", "switch", "manager", "patch", "manager"]);
  assert.deepEqual(mdf.devices.map((x) => x.unit), [42, 41, 40, 39, 38]);
  assert.equal(mdf.unitsUsed, 5);
  assert.equal(mdf.spare, 37);
  assert.match(out.svg, /Rack elevation/);
  assert.match(out.svg, /Main room · main room/);
  assert.match(out.svg, /First floor room · floor room/);
  assert.match(out.svg, /37 U spare/);
  // the units used in the drawing match the engineering figure
  const eng = d.network.racks.find((r) => r.rackId === "mdf");
  assert.equal(mdf.unitsUsed, eng.unitsUsed);
});

test("a smaller rack is drawn at its own height; no rack with equipment means no drawing", () => {
  const d = make();
  const small = designWifiCabling({ plan: building([ap("g1", "f1", 10.25)]), racks: [{ ...racks[0], rackUnits: 12 }], pathway: OPEN });
  const out = buildRackElevationSvg({ design: small, racks });
  assert.match(out.svg, /height="264"/); // 12 units x 22
  const empty = designWifiCabling({ plan: building([]), racks: [racks[0]], pathway: OPEN });
  assert.equal(buildRackElevationSvg({ design: empty, racks }), null);
  assert.equal(rackDevices({ rackId: "none", fibrePanels: 0 }, d).length, 0);
});

test("the topology draws the main room, each floor room and its fibre", () => {
  const out = buildTopologySvg({ design: make() });
  assert.deepEqual(out.nodes.map((n) => [n.id, n.role]), [["mdf", "mdf"], ["idf", "idf"]]);
  const u = make().network.uplinks[0];
  assert.deepEqual(out.nodes[1].uplink, { strands: u.strands, lengthM: u.lengthM });
  assert.match(out.svg, new RegExp(`${u.strands}-strand · ${u.lengthM} m`));
  assert.match(out.svg, /Main room \(main room\)/);
  assert.match(out.svg, /Core \/ router \(not sized\)/);
});

test("the compliance table lists each requirement with its limit and what the design reaches", () => {
  const rows = complianceRows(make());
  const by = (re) => rows.find((r) => re.test(r.requirement));
  assert.equal(by(/Permanent link/).status, "pass");
  assert.match(by(/Permanent link/).limit, /<= 90 m/);
  assert.equal(by(/Channel length/).status, "pass");
  assert.equal(by(/Every AP receives enough voltage/).status, "pass");
  assert.ok(rows.some((r) => /Main room: space/.test(r.requirement)));
  assert.ok(rows.some((r) => /oversubscription/.test(r.requirement)));
  assert.ok(rows.some((r) => r.area === "Fibre"));
  assert.ok(rows.some((r) => /Tray fill/.test(r.requirement)));
  assert.ok(rows.some((r) => /Riser Shaft: fill/.test(r.requirement)));
  assert.equal(rows.every((r) => r.status === "pass"), true);
  assert.ok(NOT_CHECKED.length >= 3);
});

test("a failing design shows FAIL in the compliance table", () => {
  const long = designWifiCabling({
    plan: { ...building([ap("far", "f1", 160.25)]), rooms: [{ id: "h", floorId: "f1", name: "Long", shape: "rectangle", x: 0, z: 0, width: 200, depth: 10, height: 3 }] },
    racks: [racks[0]], pathway: OPEN,
  });
  const rows = complianceRows(long);
  assert.equal(rows.find((r) => /Permanent link/.test(r.requirement)).status, "FAIL");
  const unconfirmed = complianceRows(designWifiCabling({ plan: building([ap("g1", "f1", 10.25)]), racks: [racks[0]] }));
  assert.equal(unconfirmed.find((r) => /Every route is permitted/.test(r.requirement)).status, "pass"); // no wall crossed here
});
