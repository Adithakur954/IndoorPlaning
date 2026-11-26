import test from "node:test";
import assert from "node:assert/strict";
import { buildPathwayTree, leafCount } from "../src/infra/wifi/pathwayTree.js";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { buildWifiSchematic } from "../src/infra/wifi/schematic.js";
import { DEFAULT_WIFI_CATALOGUE } from "../src/infra/wifi/catalogue.js";

const pts = (floorId, list) => ({ floorId, points: list.map(([x, z]) => ({ x, z })) });
const run = (apId, paths, extra = {}) => ({ apId, apName: apId, riserId: null, permanentLinkM: 10, check: "ok", paths, ...extra });
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test("one AP: the rack goes straight to it, one branch with the route length", () => {
  const t = buildPathwayTree([run("a", [pts("f1", [[0, 0], [1, 0], [2, 0], [2, 1]])])]);
  assert.equal(t.leaves.length, 1);
  assert.equal(t.root.children.length, 1);
  assert.equal(t.root.children[0].node.run.apId, "a");
  near(t.root.children[0].lengthM, 3);
});

test("two APs that share a trunk: one shared branch, then a split", () => {
  // both run 0,0 -> 4,0; then one goes up to (4,2) and the other down to (4,-3)
  const a = run("up", [pts("f1", [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2]])]);
  const b = run("down", [pts("f1", [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, -1], [4, -2], [4, -3]])]);
  const t = buildPathwayTree([a, b]);
  assert.equal(t.leaves.length, 2);
  const trunk = t.root.children;
  assert.equal(trunk.length, 1, "one trunk out of the rack");
  near(trunk[0].lengthM, 4); // the shared part
  const split = trunk[0].node;
  assert.equal(split.children.length, 2);
  assert.deepEqual(split.children.map((c) => [c.node.run.apId, c.lengthM]).sort(), [["down", 3], ["up", 2]]);
  assert.equal(leafCount(t.root), 2);
});

test("an AP on another AP's path hangs off that point with a zero-length branch", () => {
  const far = run("far", [pts("f1", [[0, 0], [1, 0], [2, 0], [3, 0]])]);
  const mid = run("mid", [pts("f1", [[0, 0], [1, 0], [2, 0]])]);
  const t = buildPathwayTree([far, mid]);
  assert.equal(t.leaves.length, 2);
  const ids = [];
  const walk = (n) => { if (n.run) ids.push(n.run.apId); n.children.forEach((c) => walk(c.node)); };
  walk(t.root);
  assert.deepEqual(ids.sort(), ["far", "mid"]);
});

test("a run through a riser continues on the other floor", () => {
  const r = run("up", [pts("f2", [[5, 5], [6, 5]]), pts("f1", [[0, 0], [1, 0], [5, 5]])], { riserId: "shaft" });
  const t = buildPathwayTree([r]);
  assert.equal(t.leaves.length, 1);
  assert.equal(t.leaves[0].floorId, "f2");
  assert.ok(t.root.children[0].lengthM > 0);
});

const hall = (sources, width = 40, depth = 10) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width, depth, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [], sources,
});
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });
const racks = [{ id: "k1", name: "Rack 1", floorId: "f1", x: 0.75, z: 4.75 }];

test("a real design: every AP is a leaf, and APs that share a route share a branch", () => {
  const plan = hall([ap("n1", 30.25, 1.25), ap("n2", 33.25, 1.25), ap("s1", 30.25, 8.25), ap("s2", 33.25, 8.25)]);
  const design = designWifiCabling({ plan, racks });
  const { root, leaves } = buildPathwayTree(design.runs);
  assert.equal(leaves.length, 4);
  assert.equal(leafCount(root), 4);
  // the four APs sit far from the rack, so their cables leave on a common trunk first
  let node = root;
  let shared = 0;
  while (node.children.length === 1) { shared += node.children[0].lengthM; node = node.children[0].node; }
  assert.ok(shared > 10, `shared trunk ${shared} m`);
  assert.ok(node.children.length >= 2);
});

test("the schematic puts APs in floor order and shows the shared trunk once", () => {
  // names are in the wrong order on purpose: the drawing must follow the floor
  const plan = hall([ap("c-east", 36.25, 5.25), ap("a-west", 10.25, 5.25), ap("b-mid", 23.25, 5.25)]);
  const design = designWifiCabling({ plan, racks });
  const { svg, nodes } = buildWifiSchematic({ design, plan, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  const order = nodes.filter((n) => n.type === "ap").map((n) => n.id);
  assert.deepEqual(order, ["a-west", "b-mid", "c-east"]);
  for (const r of design.runs) assert.ok(svg.includes(`cable ${r.permanentLinkM} m`));
  assert.match(svg, /Branch lengths are the shared route sections/);
});

test("the schematic is not a straight bus: APs in different places make a branching tree", () => {
  const plan = hall([ap("n", 30.25, 1.25), ap("s", 30.25, 9.25), ap("w", 12.25, 5.25)], 40, 10);
  const design = designWifiCabling({ plan, racks });
  const { svg } = buildWifiSchematic({ design, plan, racks, catalogue: DEFAULT_WIFI_CATALOGUE });
  // a branch point is drawn as a dot
  assert.ok((svg.match(/r="4" fill="#334155"/g) || []).length >= 1);
});

test("APs north and south of the rack's line share one trunk, not two parallel ones", () => {
  const plan = hall([ap("n1", 30.25, 1.25), ap("n2", 33.25, 1.25), ap("s1", 30.25, 8.25), ap("s2", 33.25, 8.25)]);
  const design = designWifiCabling({ plan, racks });
  const { root } = buildPathwayTree(design.runs);
  // one branch leaves the rack, about 29.5 m long, and then the APs split off
  assert.equal(root.children.length, 1);
  near(root.children[0].lengthM, 29.5, 0.01);
  // tray: the trunk plus the short branches, not two 33 m runs
  assert.ok(design.trayM < 50, `tray ${design.trayM} m`);
  // every AP still has its own full-length cable
  for (const r of design.runs) assert.ok(r.permanentLinkM > 40);
});
