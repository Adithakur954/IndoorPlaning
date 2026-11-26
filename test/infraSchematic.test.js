import test from "node:test";
import assert from "node:assert/strict";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { buildWifiSchematic } from "../src/infra/wifi/schematic.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";

const plan = (sources) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});
const ap = (id, x, z, name = id) => ({ id, kind: "wifi", name, floorId: "f1", x, z, heightM: 2.5 });
const racks = [{ id: "k1", name: "Rack 1", floorId: "f1", x: 0.75, z: 0.75 }];
const draw = (sources, opts = {}) => {
  const p = plan(sources);
  const design = designWifiCabling({ plan: p, racks });
  return { design, ...buildWifiSchematic({ design, plan: p, racks, catalogue: DEFAULT_WIFI_CATALOGUE, ...opts }) };
};

test("the schematic has one AP, one cable length and the PoE power per AP", () => {
  const { design, svg, nodes } = draw([ap("a1", 30.25, 3.25), ap("a2", 20.25, 6.75), ap("a3", 10.25, 8.25)]);
  assert.equal(nodes.filter((n) => n.type === "ap").length, 3);
  assert.equal(nodes.filter((n) => n.type === "rack").length, 1);
  assert.ok(nodes.some((n) => n.type === "core"));
  for (const run of design.runs) {
    assert.ok(svg.includes(`${run.permanentLinkM} m`), `length of ${run.apName}`);
    assert.ok(svg.includes(run.apName));
  }
  assert.match(svg, /30 W · Cat6A/);
  assert.match(svg, /1 × 24-port PoE\+ access switch/);
  assert.match(svg, /preliminary estimate/);
});

test("it is one well-formed SVG and escapes names", () => {
  const { svg } = draw([ap("a1", 30.25, 3.25, 'A&B <1> "x"')]);
  assert.equal((svg.match(/<svg /g) || []).length, 1);
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.ok(svg.includes("A&amp;B &lt;1&gt; &quot;x&quot;"));
  assert.ok(!/A&B/.test(svg));
  // every opened element is closed or self-closed
  const opens = (svg.match(/<(?!\/|\?|!)[a-zA-Z]+(?:\s[^>]*[^/])?>/g) || []).length;
  const closes = (svg.match(/<\/[a-zA-Z]+>/g) || []).length;
  assert.equal(opens, closes);
});

test("cables are coloured by their length check, and a suggested rack says so", () => {
  const far = plan([ap("far", 39.25, 9.25)]);
  const longHall = { ...far, rooms: [{ ...far.rooms[0], width: 200 }], sources: [ap("far", 150.25, 3.25)] };
  const design = designWifiCabling({ plan: longHall, racks });
  const { svg } = buildWifiSchematic({ design, plan: longHall, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.equal(design.runs[0].check, "too long");
  assert.ok(svg.includes("#c0392b"));
  const suggested = [{ ...racks[0], suggested: true }];
  const d2 = designWifiCabling({ plan: plan([ap("a", 5.25, 3.25)]), racks: suggested });
  const s2 = buildWifiSchematic({ design: d2, plan: plan([]), racks: suggested, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.match(s2.svg, /suggested, to confirm/);
});

test("many APs make the drawing wider; the drawing follows the design, not a template", () => {
  const few = draw([ap("a", 5.25, 3.25)]);
  const many = draw(Array.from({ length: 12 }, (_, i) => ap(`ap${i}`, 3.25 + i * 3, 3.25 + (i % 3) * 2)));
  assert.ok(many.width > few.width);
  assert.equal(many.nodes.filter((n) => n.type === "ap").length, 12);
});

test("with no runs it says what is missing instead of drawing an empty network", () => {
  const p = plan([]);
  const design = designWifiCabling({ plan: p, racks });
  const { svg, nodes } = buildWifiSchematic({ design, plan: p, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.match(svg, /No cable runs yet/);
  assert.equal(nodes.filter((n) => n.type === "ap").length, 0);
});

test("a rack already named 'suggested' is not labelled twice, and the core uplink does not cross its own box", () => {
  const named = [{ id: "k1", name: "Rack 1 (suggested)", floorId: "f1", x: 0.75, z: 0.75, suggested: true }];
  const p = plan([ap("a", 5.25, 3.25)]);
  const design = designWifiCabling({ plan: p, racks: named });
  const { svg } = buildWifiSchematic({ design, plan: p, racks: named, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.ok(!/\(suggested\) \(suggested/.test(svg));
  // the first uplink starts at the right edge of the core box (x = 250), at its mid height
  const coreBox = svg.match(/<rect x="30" y="(\d+)" width="220" height="70"/);
  assert.ok(coreBox);
  assert.match(svg, new RegExp(`<polyline points="250,${Number(coreBox[1]) + 35} `));
});

test("several racks hang off one trunk below the core box", () => {
  const two = [
    { id: "k1", name: "Rack 1", floorId: "f1", x: 0.75, z: 0.75 },
    { id: "k2", name: "Rack 2", floorId: "f1", x: 39.25, z: 9.25 },
  ];
  const p = plan([ap("a", 2.25, 3.25), ap("b", 37.25, 7.25)]);
  const design = designWifiCabling({ plan: p, racks: two });
  const { svg, nodes } = buildWifiSchematic({ design, plan: p, racks: two, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.equal(nodes.filter((n) => n.type === "rack").length, 2);
  assert.ok(svg.includes('points="140,'));
});
