import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultKpiFor,
  kpisForKind,
  networkKindOf,
} from "../src/utils/indoorLogKpis.js";

const keys = (kind) => kpisForKind(kind).map((k) => k.key);

test("Wi-Fi shows RSSI, SNR and throughput only; RSSI is the default", () => {
  assert.deepEqual(keys("wifi"), ["rssi", "snr", "dl_thpt", "ul_thpt"]);
  assert.equal(defaultKpiFor("wifi"), "rssi");
});

test("cellular shows the other KPIs, not RSSI", () => {
  assert.ok(keys("cellular").includes("rsrp"));
  assert.ok(keys("cellular").includes("sinr"));
  assert.ok(!keys("cellular").includes("rssi"));
  assert.ok(!keys("cellular").includes("snr")); // cellular keeps SINR
  assert.equal(defaultKpiFor("cellular"), "rsrp");
});

test("the network kind follows the selected AP, else the floor's APs", () => {
  const wifi = { kind: "wifi" };
  const cell = { kind: "cellular" };
  assert.equal(networkKindOf([], null), "wifi");
  assert.equal(networkKindOf([cell], null), "cellular");
  assert.equal(networkKindOf([wifi, cell], null), "all");
  assert.equal(networkKindOf([wifi, cell], cell), "cellular");
  assert.equal(keys("all").length, kpisForKind("all").length);
});

test("SNR has dB colour bands and reads measured SNR columns", async () => {
  const { INDOOR_LOG_KPIS, readLogKpi, normalizeLogColumn } = await import("../src/utils/indoorLogKpis.js");
  const snr = INDOOR_LOG_KPIS.find((k) => k.key === "snr");
  assert.equal(snr.unit, "dB");
  assert.equal(snr.thresholds.length, 5);
  assert.equal(readLogKpi({ [normalizeLogColumn("Wi-Fi SNR")]: "27" }, snr), 27);
});

test("a cell's SNR comes from the worker map; older maps give null", async () => {
  const { mapToCells } = await import("../src/services/simulation.js");
  const room = { id: "r", shape: "rectangle", x: 0, z: 0, width: 2, depth: 1 };
  const base = { cellSizeM: 1, xCentersM: [0.5, 1.5], zCentersM: [0.5], bestDbm: [[-50, null]], bestApIndex: [[0, 0]], accessPoints: [{ name: "AP1" }] };
  const withSnr = mapToCells({ ...base, bestSnrDb: [[44.2, null]] }, [room], -67);
  assert.deepEqual(withSnr.map((c) => c.snr), [44.2, null]);
  assert.equal(withSnr[0].hasSnrMap, true);
  const old = mapToCells(base, [room], -67);
  assert.deepEqual(old.map((c) => [c.snr, c.hasSnrMap]), [[null, false], [null, false]]);
});
