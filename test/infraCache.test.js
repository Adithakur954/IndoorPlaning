import test from "node:test";
import assert from "node:assert/strict";
import { clearRoutingCache, designWifiCabling, routingCacheStats } from "../src/infra/wifi/design.js";
import { requestDesign } from "../src/infra/wifi/designClient.js";

const OPEN = { ceiling: { type: "false", voidAccess: "accessible", partitionToSlab: "no" } };
const plan = (sources) => ({
  floors: [{ id: "f1", name: "L1", elevation: 0 }, { id: "f2", name: "L2", elevation: 3.2 }],
  rooms: ["f1", "f2"].map((f) => ({ id: `r${f}`, floorId: f, name: f, shape: "rectangle", x: 0, z: 0, width: 40, depth: 20, height: 3 })),
  doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [], sources,
});
const ap = (id, x, z, floorId = "f1") => ({ id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5 });
const rack = { id: "k", floorId: "f1", x: 0.75, z: 10.25 };
const run = (sources, extra = {}) => designWifiCabling({ plan: plan(sources), racks: [rack], pathway: OPEN, ...extra });

test("moving an AP reuses the floor's routing grid, and gives the same answer as a fresh calculation", () => {
  clearRoutingCache();
  run([ap("a", 30.25, 5.25)]);
  assert.deepEqual([routingCacheStats().hits, routingCacheStats().misses], [0, 1]);
  const moved = run([ap("a", 35.25, 14.25)]);
  assert.equal(routingCacheStats().hits, 1);
  assert.equal(routingCacheStats().misses, 1);
  clearRoutingCache();
  const fresh = run([ap("a", 35.25, 14.25)]);
  assert.deepEqual(moved.runs, fresh.runs);
  assert.deepEqual(moved.boq, fresh.boq);
});

test("moving the rack reuses the grid but not the old rack's routes", () => {
  clearRoutingCache();
  const first = run([ap("a", 30.25, 10.25)]);
  const second = designWifiCabling({ plan: plan([ap("a", 30.25, 10.25)]), racks: [{ ...rack, x: 20.75 }], pathway: OPEN });
  assert.equal(routingCacheStats().hits, 1);
  assert.ok(second.runs[0].horizontalM < first.runs[0].horizontalM);
});

test("a change to the building or the pathway settings is not served from the cache", () => {
  clearRoutingCache();
  run([ap("a", 30.25, 5.25)]);
  designWifiCabling({ plan: plan([ap("a", 30.25, 5.25)]), racks: [rack], pathway: { ...OPEN, noGo: [{ id: "n", floorId: "f1", polygon: [{ x: 10, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 8 }, { x: 10, z: 8 }] }] } });
  assert.equal(routingCacheStats().misses, 2); // the no-go area is part of what the floor depends on
  const bigger = plan([ap("a", 30.25, 5.25)]);
  bigger.rooms[0].width = 50;
  designWifiCabling({ plan: bigger, racks: [rack], pathway: OPEN });
  assert.equal(routingCacheStats().misses, 3);
  // the same settings again are a hit
  designWifiCabling({ plan: bigger, racks: [rack], pathway: OPEN });
  assert.equal(routingCacheStats().hits, 1);
});

test("each floor has its own cache entry, and another floor's changes do not disturb it", () => {
  clearRoutingCache();
  const sources = [ap("a", 30.25, 5.25), ap("b", 30.25, 5.25, "f2")];
  designWifiCabling({ plan: plan(sources), racks: [rack, { id: "k2", floorId: "f2", x: 0.75, z: 10.25 }], pathway: OPEN });
  assert.equal(routingCacheStats().size, 2);
  const tray = [{ id: "t", floorId: "f2", kind: "new", points: [{ x: 1, z: 5 }, { x: 30, z: 5 }] }];
  designWifiCabling({ plan: plan(sources), racks: [rack, { id: "k2", floorId: "f2", x: 0.75, z: 10.25 }], pathway: { ...OPEN, trays: tray } });
  // floor 1 is unchanged (a hit), floor 2 changed (a miss)
  assert.equal(routingCacheStats().hits, 1);
  assert.equal(routingCacheStats().misses, 3);
});

test("the design client falls back to a direct calculation when there is no Web Worker", async () => {
  clearRoutingCache();
  const input = { plan: plan([ap("a", 30.25, 5.25)]), racks: [rack], pathway: OPEN };
  const out = await requestDesign(input);
  assert.equal(out.design.runs.length, 1);
  assert.deepEqual(out.design.runs, designWifiCabling(input).runs);
  // two requests in a row both answer (nothing is lost on the direct path)
  const [x, y] = await Promise.all([requestDesign(input), requestDesign(input)]);
  assert.ok((x.design || x.stale) && (y.design || y.stale));
});
