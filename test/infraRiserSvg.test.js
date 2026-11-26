import test from "node:test";
import assert from "node:assert/strict";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { buildRiserSvg } from "../src/infra/wifi/riserSvg.js";

const plan = (sources) => ({
  floors: [
    { id: "f1", name: "Ground", elevation: 0 },
    { id: "f2", name: "First", elevation: 3.2 },
    { id: "f3", name: "Second", elevation: 6.4 },
  ],
  rooms: ["f1", "f2", "f3"].map((f) => ({ id: `r${f}`, floorId: f, name: f, shape: "rectangle", x: 0, z: 0, width: 30, depth: 10, height: 3 })),
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, floorId, x) => ({ id, kind: "wifi", name: id, floorId, x, z: 3.25, heightM: 2.5 });
const racks = [{ id: "k1", name: "Main rack", floorId: "f1", x: 0.75, z: 4.75 }];
const risers = [{ id: "s", name: "Shaft A", x: 28.75, z: 8.75, areaMm2: 600 }];

test("the riser diagram stacks floors by height and shows cables and fill per shaft", () => {
  const p = plan([ap("g", "f1", 10.25), ap("a1", "f2", 10.25), ap("a2", "f2", 12.25), ap("b1", "f3", 10.25)]);
  const design = designWifiCabling({ plan: p, racks, risers });
  const out = buildRiserSvg({ design, plan: p, risers, racks });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].cables, 3);
  assert.ok(out.items[0].fillPct > 0);
  // highest floor first, lowest last
  const order = [...out.svg.matchAll(/font-weight="700">(Second|First|Ground)</g)].map((m) => m[1]);
  assert.deepEqual(order, ["Second", "First", "Ground"]);
  assert.match(out.svg, /Main rack/);
  assert.match(out.svg, /2 APs/);
  assert.match(out.svg, /3 cable\(s\)/);
});

test("no riser use means no diagram; an over-full shaft is marked", () => {
  const p = plan([ap("g", "f1", 10.25)]);
  assert.equal(buildRiserSvg({ design: designWifiCabling({ plan: p, racks, risers }), plan: p, risers, racks }), null);
  const many = plan(Array.from({ length: 8 }, (_, i) => ap(`u${i}`, "f2", 5.25 + i)));
  const tiny = [{ ...risers[0], areaMm2: 100 }];
  const out = buildRiserSvg({ design: designWifiCabling({ plan: many, racks, risers: tiny }), plan: many, risers: tiny, racks });
  assert.equal(out.items[0].over, true);
  assert.match(out.svg, /#b91c1c/);
});
