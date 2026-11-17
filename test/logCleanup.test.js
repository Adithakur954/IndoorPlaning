import test from "node:test";
import assert from "node:assert/strict";
import {
  countLogs, hasNoPosition, isFromSource, isKpiOutOfRange, isOutsideBuilding,
  logSources, removeLogs, sessionSource, UNKNOWN_SOURCE,
} from "../src/utils/logCleanup.js";

const plan = () => ({
  rooms: [{ id: "r", floorId: "f", shape: "rectangle", x: 0, z: 0, width: 10, depth: 10 }],
  boundaries: [],
  alignment: null,
  sessionIds: ["s1", "s2"],
  logs: [
    { id: "1", floorId: "f", x: 2, z: 2, rsrp: -80, source: "a.csv" },
    { id: "2", floorId: "f", x: 50, z: 2, rsrp: -85, source: "a.csv" },
    { id: "3", floorId: "f", x: 3, z: 3, rsrp: -130, source: sessionSource("s1") },
    { id: "4", floorId: "f", x: null, z: null, lat: 1, lng: 1, rsrp: -90, source: sessionSource("s2") },
    { id: "5", floorId: "f", x: 4, z: 4, rsrp: -60 },
  ],
});

test("logs are grouped by the file or session they came from", () => {
  const rows = logSources(plan());
  assert.deepEqual(rows.map((r) => [r.source, r.count]), [
    ["a.csv", 2], [sessionSource("s1"), 1], [sessionSource("s2"), 1], [UNKNOWN_SOURCE, 1],
  ]);
});

test("each clean-up counts and removes the right points", () => {
  const p = plan();
  assert.equal(countLogs(p, isOutsideBuilding(p)), 1); // x = 50
  assert.equal(countLogs(p, hasNoPosition(p)), 1); // pending alignment
  assert.equal(countLogs(p, isKpiOutOfRange("rsrp", -120, null)), 1);
  assert.equal(countLogs(p, isKpiOutOfRange("rsrp", null, -70)), 1); // only -60 is above -70
  const without = removeLogs(p, isFromSource("a.csv"));
  assert.deepEqual(without.logs.map((l) => l.id), ["3", "4", "5"]);
});

test("removing every point of a session forgets the session id", () => {
  const p = plan();
  const next = removeLogs(p, isFromSource(sessionSource("s2")));
  assert.deepEqual(next.sessionIds, ["s1"]);
  assert.equal(removeLogs(p, isFromSource("a.csv")).sessionIds.length, 2);
});
