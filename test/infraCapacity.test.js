import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPACITY, planCapacity, planChannels } from "../src/infra/wifi/capacity.js";

const near = (a, b, tol = 0.11) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const room = (id, name, x, z, w, d, floorId = "f1") => ({ id, floorId, name, shape: "rectangle", x, z, width: w, depth: d, height: 3 });
const ap = (id, x, z, floorId = "f1") => ({ id, kind: "wifi", name: id, floorId, x, z, heightM: 2.5 });
const plan = (rooms, sources, floors = [{ id: "f1", name: "L1", elevation: 0 }]) => ({ floors, rooms, sources, doors: [], windows: [], interiorWalls: [], boundaries: [], furniture: [] });

test("people per room come from the area, or from a number you give; one AP carries them all", () => {
  const p = plan([room("a", "Open office", 0, 0, 20, 10)], [ap("ap", 10, 5)]);
  const out = planCapacity({ plan: p });
  // 200 m2 x 0.2 = 40 people; 1.5 devices each = 60; 60% active = 36; 5 Mbit/s each = 180 Mbit/s of 400
  const r = out.aps[0];
  near(r.users, 40);
  assert.equal(r.clients, 60);
  near(r.activeClients, 36);
  near(r.demandMbps, 180);
  near(r.utilisationPct, 45);
  assert.equal(r.overloadedBy, null);
  near(r.perClientMbps, (400 * 0.5) / 36);
  // a number for the room overrides the density
  const crowded = planCapacity({ plan: p, settings: { roomUsers: { a: 120 } } }).aps[0];
  near(crowded.users, 120);
  assert.equal(crowded.overloadedBy, "clients"); // 180 devices on one AP (more than 100)
});

test("people go to the nearest AP: a room between two APs is split between them", () => {
  const p = plan([room("a", "Hall", 0, 0, 40, 10)], [ap("west", 10, 5), ap("east", 30, 5)]);
  const out = planCapacity({ plan: p });
  near(out.aps[0].users, 40, 0.5); // 400 m2 x 0.2 = 80 people, half each
  near(out.aps[1].users, 40, 0.5);
  // an AP placed nearer one end carries more of the room
  const lop = planCapacity({ plan: plan([room("a", "Hall", 0, 0, 40, 10)], [ap("west", 5, 5), ap("east", 20, 5)]) });
  assert.ok(lop.aps.find((a) => a.id === "east").users > lop.aps.find((a) => a.id === "west").users);
});

test("an overloaded AP says why, and how many more APs the area needs", () => {
  const p = plan([room("a", "Auditorium", 0, 0, 30, 30)], [ap("only", 15, 15)]);
  const out = planCapacity({ plan: p });
  const r = out.aps[0];
  // 900 m2 -> 180 people -> 270 devices -> 162 active -> 810 Mbit/s: over the clients limit and the airtime limit
  assert.equal(r.overloadedBy, "clients");
  assert.equal(out.summary.overloaded, 1);
  // by devices: 270 / 100 -> 3 APs; by airtime: 810 / 400 = 2.03 of a 0.5 target -> 4.05 -> 5 APs. The larger need counts.
  assert.equal(r.extraApsNeeded, 4);
  assert.equal(out.summary.extraApsNeeded, 4);
});

test("a room with no AP on its floor is reported, with its people counted", () => {
  const p = plan(
    [room("a", "Room 1", 0, 0, 10, 10, "f1"), room("b", "Room 2", 0, 0, 10, 10, "f2")],
    [ap("ap", 5, 5, "f1")],
    [{ id: "f1", name: "L1", elevation: 0 }, { id: "f2", name: "L2", elevation: 3.2 }],
  );
  const out = planCapacity({ plan: p });
  assert.equal(out.unserved.length, 1);
  assert.equal(out.unserved[0].name, "Room 2");
  near(out.summary.unservedUsers, 20);
  assert.equal(out.summary.extraApsNeeded, 1);
});

test("a big room around smaller rooms is not counted twice", () => {
  const p = plan([room("floor", "Floor", 0, 0, 20, 10), room("meet", "Meeting", 2, 2, 5, 5)], [ap("ap", 10, 5)]);
  const out = planCapacity({ plan: p });
  assert.deepEqual(out.rooms.map((r) => r.name), ["Meeting"]);
});

test("the RF best-server map decides who serves a spot, when it is available", () => {
  const p = plan([room("a", "Hall", 0, 0, 40, 10)], [ap("west", 10, 5), ap("east", 30, 5)]);
  const out = planCapacity({ plan: p, bestServer: () => "east" });
  near(out.aps.find((a) => a.id === "east").users, 80, 0.5);
  assert.equal(out.aps.find((a) => a.id === "west").users, 0);
});

test("channels: neighbours get different channels, and a shortage of channels is reported", () => {
  const line = [ap("a", 0, 0), ap("b", 10, 0), ap("c", 20, 0)];
  const out = planChannels(line, DEFAULT_CAPACITY);
  assert.notEqual(out.assignment.get("a"), out.assignment.get("b"));
  assert.notEqual(out.assignment.get("b"), out.assignment.get("c"));
  assert.deepEqual(out.conflicts, []);
  // 5 APs all within range of each other and only 2 channels: some pairs must share
  const dense = Array.from({ length: 5 }, (_, i) => ap(`d${i}`, i * 3, 0));
  const tight = planChannels(dense, { ...DEFAULT_CAPACITY, channels: [36, 40] });
  assert.ok(tight.conflicts.length > 0);
  // APs far apart may reuse a channel without conflict
  const far = planChannels([ap("x", 0, 0), ap("y", 200, 0)], { ...DEFAULT_CAPACITY, channels: [36] });
  assert.deepEqual(far.conflicts, []);
  // another floor right above counts as a neighbour; a floor far to the side does not
  const stacked = planChannels([ap("l1", 5, 5, "f1"), ap("l2", 5, 5, "f2")], { ...DEFAULT_CAPACITY, channels: [36, 40] });
  assert.notEqual(stacked.assignment.get("l1"), stacked.assignment.get("l2"));
});

test("the results carry each AP's channel and the settings used", () => {
  const p = plan([room("a", "Hall", 0, 0, 40, 10)], [ap("west", 10, 5), ap("east", 30, 5)]);
  const out = planCapacity({ plan: p, settings: { channels: [36, 40] } });
  assert.deepEqual(out.aps.map((a) => a.channel).sort(), [36, 40]);
  assert.equal(out.settings.apCapacityMbps, DEFAULT_CAPACITY.apCapacityMbps);
  assert.equal(out.summary.coChannelPairs, 0);
});
