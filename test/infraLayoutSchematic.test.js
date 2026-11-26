import test from "node:test";
import assert from "node:assert/strict";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { buildWifiLayoutSchematic } from "../src/infra/wifi/layoutSchematic.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";

const hall = (sources, width = 40, depth = 10) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});
const ap = (id, x, z, name = id) => ({ id, kind: "wifi", name, floorId: "f1", x, z, heightM: 2.5 });
const racks = [{ id: "k1", name: "Rack 1", floorId: "f1", x: 38.75, z: 4.75 }];
const draw = (sources, opts = {}) => {
  const plan = hall(sources);
  const catalogue = opts.catalogue || DEFAULT_WIFI_CATALOGUE;
  const design = designWifiCabling({ plan, racks, catalogue });
  return { design, plan, ...buildWifiLayoutSchematic({ design, plan, racks, catalogue, ...opts }) };
};
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test("APs are drawn where they are: same relative positions as on the floor, same scale both ways", () => {
  const { nodes } = draw([ap("far", 5.25, 1.25), ap("low", 14.25, 8.25), ap("mid", 25.25, 4.75)]);
  const by = Object.fromEntries(nodes.filter((n) => n.type === "ap").map((n) => [n.id, n]));
  // order along x and z follows the floor
  assert.ok(by.far.x < by.low.x && by.low.x < by.mid.x);
  assert.ok(by.far.y < by.mid.y && by.mid.y < by.low.y);
  // one scale for both directions: metres map to pixels in the same ratio
  const sx = (by.low.x - by.far.x) / (14.25 - 5.25);
  const sz = (by.low.y - by.far.y) / (8.25 - 1.25);
  near(sx, sz, 1e-6);
  // the rack stands east of the APs, as on the floor
  const rack = nodes.find((n) => n.type === "rack");
  assert.ok(rack.x > by.mid.x);
});

test("it is not a row: APs at different depths are drawn at different heights", () => {
  const { nodes } = draw([ap("a", 10.25, 1.25), ap("b", 20.25, 4.75), ap("c", 30.25, 8.25)]);
  const ys = new Set(nodes.filter((n) => n.type === "ap").map((n) => Math.round(n.y)));
  assert.equal(ys.size, 3);
});

test("each AP shows its cable length, PoE voltage at the AP and the power lost in the cable", () => {
  const { design, svg } = draw([ap("a", 10.25, 1.25), ap("b", 20.25, 8.25)]);
  for (const r of design.runs) {
    assert.ok(svg.includes(`cable ${r.permanentLinkM} m`));
    assert.ok(svg.includes(`PoE: ${r.pdVoltageV} V at the AP · ${r.poeCableLossW} W lost`));
  }
  assert.ok(!/signal loss \d/.test(svg), "no signal loss without a datasheet value");
  assert.match(svg, /PoE loss = voltage and power lost in the copper/);
});

test("signal loss appears only when the cable's datasheet value is in the catalogue", () => {
  const catalogue = structuredClone(DEFAULT_WIFI_CATALOGUE);
  catalogue.cables.cat6a.insertionLossDbPer100m100MHz = 20;
  const { design, svg } = draw([ap("a", 10.25, 1.25)], { catalogue });
  const run = design.runs[0];
  near(run.insertionLossDb, Math.round(((20 * run.channelM) / 100) * 10) / 10, 1e-9);
  assert.ok(svg.includes(`signal loss ${run.insertionLossDb} dB @100 MHz`));
});

test("route sections carry their lengths, and the shared trunk is one line", () => {
  const { svg } = draw([ap("n1", 8.25, 1.25), ap("n2", 5.25, 1.25), ap("s1", 8.25, 8.25), ap("s2", 5.25, 8.25)]);
  // the rack is at x = 38.75; the trunk to x = 8.25 is 30.5 m before the APs split off
  assert.match(svg, />30\.5 m</);
  assert.ok((svg.match(/r="4\.5" fill="#334155"/g) || []).length >= 1);
});

test("the rack is a box where it stands, with the uplink marked as not sized", () => {
  const { svg } = draw([ap("a", 10.25, 1.25)]);
  assert.match(svg, /uplink to core \(not sized\)/);
  assert.match(svg, /stroke="#2563eb" stroke-width="3.5"/);
});

test("APs on other floors reach the rack through a riser and are listed, not dropped", () => {
  const plan = {
    floors: [{ id: "f1", name: "Level 1", elevation: 0 }, { id: "f2", name: "Level 2", elevation: 3.2 }],
    rooms: [
      { id: "h1", floorId: "f1", name: "Hall 1", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 },
      { id: "h2", floorId: "f2", name: "Hall 2", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 },
    ],
    doors: [], windows: [], interiorWalls: [], boundaries: [],
    sources: [{ ...ap("down", 10.25, 3.25), floorId: "f1" }, { ...ap("up", 20.25, 3.25, "Upstairs AP"), floorId: "f2" }],
  };
  const risers = [{ id: "shaft", x: 38.75, z: 8.75 }];
  const design = designWifiCabling({ plan, racks, risers });
  const { svg, nodes } = buildWifiLayoutSchematic({ design, plan, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.equal(nodes.filter((n) => n.type === "ap").length, 1);
  assert.match(svg, /Via riser from other floors: Upstairs AP/);
});

test("names are escaped and the SVG is well formed", () => {
  const { svg } = draw([ap("a", 10.25, 1.25, 'A&B <1> "x"')]);
  assert.ok(svg.includes("A&amp;B &lt;1&gt; &quot;x&quot;"));
  assert.equal((svg.match(/<svg /g) || []).length, 1);
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  const opens = (svg.match(/<(?!\/|\?|!)[a-zA-Z]+(?:\s[^>]*[^/])?>/g) || []).length;
  const closes = (svg.match(/<\/[a-zA-Z]+>/g) || []).length;
  assert.equal(opens, closes);
});

test("with nothing to draw it says so", () => {
  const plan = hall([]);
  const design = designWifiCabling({ plan, racks });
  const { svg } = buildWifiLayoutSchematic({ design, plan, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.match(svg, /No cable runs yet/);
});

test("everything is drawn inside its own panel and inside the image (also with two racks)", () => {
  const two = [
    { id: "k1", name: "Rack 1", floorId: "f1", x: 38.75, z: 4.75 },
    { id: "k2", name: "Rack 2", floorId: "f1", x: 0.75, z: 4.75 },
  ];
  const plan = hall([ap("e1", 30.25, 1.25), ap("e2", 33.25, 8.25), ap("w1", 6.25, 2.25), ap("w2", 9.25, 7.25)]);
  const design = designWifiCabling({ plan, racks: two });
  const { svg, nodes, width, height } = buildWifiLayoutSchematic({ design, plan, racks: two, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.equal(nodes.filter((n) => n.type === "rack").length, 2);
  // panel frames in the order they are drawn
  const frames = [...svg.matchAll(/<rect x="20" y="([\d.]+)" width="1400" height="([\d.]+)"/g)].map((m) => ({ top: Number(m[1]), bottom: Number(m[1]) + Number(m[2]) }));
  assert.equal(frames.length, 2);
  assert.ok(frames[1].top >= frames[0].bottom, "panels do not overlap");
  for (const n of nodes) {
    assert.ok(n.x > 0 && n.x < width && n.y > 0 && n.y < height, `${n.id} is inside the image`);
    assert.ok(frames.some((f) => n.y > f.top && n.y < f.bottom), `${n.id} (${Math.round(n.y)}) is inside a panel`);
  }
  // the second rack's APs are in the second panel
  const second = nodes.filter((n) => n.type === "ap" && design.runs.find((r) => r.apId === n.id).rackId === "k2");
  for (const n of second) assert.ok(n.y > frames[1].top && n.y < frames[1].bottom);
  // the legend is below the last panel, not on top of it
  const legend = svg.match(/<text x="30" y="([\d.]+)" font-size="12" font-weight="700">Cable colour/);
  assert.ok(Number(legend[1]) > frames[1].bottom);
});

test("the uplink stub leaves the rack on a side where no cable leaves", () => {
  // all cables leave the rack to the west, so the uplink goes east
  const { nodes, svg } = draw([ap("a", 10.25, 4.75), ap("b", 20.25, 4.75)]);
  const rack = nodes.find((n) => n.type === "rack");
  assert.equal(rack.uplink, "right");
  assert.ok(svg.includes(`<line x1="${rack.x + 50}" y1="${rack.y}" x2="${rack.x + 92}"`));
  // a cable also leaves to the east: the uplink moves to another side
  const east = [{ id: "k1", name: "Rack 1", floorId: "f1", x: 20.75, z: 4.75 }];
  const plan = hall([ap("w", 5.25, 4.75), ap("e", 35.25, 4.75)]);
  const design = designWifiCabling({ plan, racks: east });
  const out = buildWifiLayoutSchematic({ design, plan, racks: east, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.notEqual(out.nodes.find((n) => n.type === "rack").uplink, "right");
  assert.notEqual(out.nodes.find((n) => n.type === "rack").uplink, "left");
});




// ---- labels never overlap -------------------------------------------------------

const hit = (a, b, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
function overlaps({ labels, shapes }) {
  const bad = [];
  labels.forEach((a, i) => {
    labels.slice(i + 1).forEach((b) => hit(a.box, b.box) && bad.push(`label ${a.id || a.text} / ${b.id || b.text}`));
    shapes.symbols.forEach((s) => hit(a.box, s) && bad.push(`label ${a.id || a.text} / symbol`));
    // an AP label must also keep off every cable; a length label sits beside its own cable
    if (a.kind === "ap") shapes.lines.forEach((l) => hit(a.box, l) && bad.push(`label ${a.id} / cable`));
  });
  return bad;
}
function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const scatter = (n, seed, w = 60, d = 30) => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ap(`AP${i + 1}`, 1.25 + Math.floor(r() * (w - 3)) + 0.25, 1.25 + Math.floor(r() * (d - 3)) + 0.25));
};
const drawBig = (sources, w = 60, d = 30, rack = { x: w - 1.25, z: d / 2 - 0.25 }) => {
  const plan = hall(sources, w, d);
  const rk = [{ id: "k1", name: "Rack 1", floorId: "f1", ...rack }];
  const design = designWifiCabling({ plan, racks: rk });
  return { design, ...buildWifiLayoutSchematic({ design, plan, racks: rk, catalogue: DEFAULT_WIFI_CATALOGUE }) };
};

test("no label touches another label, a symbol, or (for APs) any cable: random floors of different density", () => {
  for (const [n, seed] of [[8, 1], [15, 2], [25, 3], [25, 4], [40, 5]]) {
    const out = drawBig(scatter(n, seed));
    assert.deepEqual(overlaps(out), [], `${n} APs, seed ${seed}`);
  }
});

test("every AP is either labelled, labelled with a leader line, or numbered and listed in the table", () => {
  const out = drawBig(scatter(40, 9, 30, 15));
  const aps = out.nodes.filter((n) => n.type === "ap");
  assert.equal(aps.length, 40);
  for (const n of aps) assert.ok(["full", "compact", "tag", "leader", "table"].includes(n.labelLevel), n.labelLevel);
  assert.deepEqual(overlaps(out), []);
  // the table holds every AP with all its values
  for (const r of out.design.runs) {
    assert.ok(out.svg.includes(`>${r.apName}</text>`));
    assert.ok(out.svg.includes(`>${r.permanentLinkM}</text>`));
  }
  // a numbered AP shows its number in the circle
  for (const n of aps.filter((x) => x.labelLevel === "table")) assert.ok(out.svg.includes(`>${n.index}</text>`));
});

test("a crowded floor gets more room before any label is shortened", () => {
  // the same 12 APs: spread over a big hall (room to spare) and packed into a small area
  const spread = drawBig(scatter(12, 21, 60, 30));
  const packed = drawBig(scatter(12, 21, 14, 8), 14, 8, { x: 12.75, z: 3.75 });
  assert.deepEqual(overlaps(spread), []);
  assert.deepEqual(overlaps(packed), []);
  const full = (o) => o.nodes.filter((n) => n.type === "ap" && n.labelLevel === "full").length;
  assert.ok(full(spread) >= 10, `spread: ${full(spread)} of 12 in full`);
  // packed APs cannot all keep a full label at the base size, so the drawing is made larger first
  assert.ok(packed.width > 1440 || packed.height > spread.height || full(packed) >= 8);
});

test("the AP table lists every AP: cable, voltage, watts lost and check", () => {
  const out = drawBig(scatter(6, 5));
  assert.match(out.svg, /AP details \(all values for every AP\)/);
  for (const r of out.design.runs) {
    assert.ok(out.svg.includes(`>${r.pdVoltageV}</text>`));
    assert.ok(out.svg.includes(`>${r.poeCableLossW}</text>`));
  }
});

test("a dense real-looking layout (8 APs, 3 on one trunk) has no overlapping text", () => {
  const out = drawBig([
    ap("A1", 12.25, 3.25), ap("A2", 20.25, 6.25), ap("A3", 21.25, 8.75), ap("A4", 26.25, 11.25),
    ap("A5", 31.25, 11.25), ap("A6", 36.25, 13.25), ap("A7", 36.25, 21.25), ap("A8", 44.25, 14.25),
  ]);
  assert.deepEqual(overlaps(out), []);
});

test("a floor room's uplink is drawn as the real fibre run; the main room's stays 'not sized'", () => {
  const plan2 = {
    floors: [{ id: "f1", name: "Ground", elevation: 0 }, { id: "f2", name: "First", elevation: 3.2 }],
    rooms: ["f1", "f2"].map((f) => ({ id: `r-${f}`, floorId: f, name: f, shape: "rectangle", x: 0, z: 0, width: 30, depth: 10, height: 3 })),
    doors: [], windows: [], interiorWalls: [], boundaries: [],
    sources: [ap("g", 10.25, 3.25), { ...ap("u", 10.25, 3.25), floorId: "f2" }],
  };
  const rks = [
    { id: "mdf", name: "Main room", floorId: "f1", x: 0.75, z: 4.75, role: "mdf" },
    { id: "idf", name: "First floor room", floorId: "f2", x: 0.75, z: 4.75, role: "idf" },
  ];
  const design = designWifiCabling({ plan: plan2, racks: rks, risers: [{ id: "s", name: "Shaft", x: 28.75, z: 8.75 }], pathway: { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } } });
  const { svg } = buildWifiLayoutSchematic({ design, plan: plan2, racks: rks, catalogue: DEFAULT_WIFI_CATALOGUE });
  assert.match(svg, /uplink to core \(not sized\)/);
  assert.match(svg, /fibre uplink to Main room · 6-strand · [0-9.]+ m/);
});
