import test from "node:test";
import assert from "node:assert/strict";
import {
  interpolateHeatmap,
  rangesColorFn,
} from "../src/utils/heatmapImage.js";
import { getMetricColor, openEndedBands } from "../src/utils/logOverlay.js";
import { INDOOR_LOG_KPIS } from "../src/utils/indoorLogKpis.js";

const cell = (x, z, dbm) => ({ x, z, step: 1, dbm });
const rsrp = INDOOR_LOG_KPIS.find((k) => k.key === "rsrp").thresholds;
const hex = (rgb) =>
  "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

test("prediction colours are exactly the log threshold colours", () => {
  const colorAt = rangesColorFn(rsrp);
  for (const dbm of [-130, -80, -70, -65, -60, -55, -50, -45, -40, 0])
    assert.equal(hex(colorAt(dbm)), getMetricColor(dbm, rsrp), `${dbm} dBm`);
});

test("edited thresholds (null for open ends, as saved JSON) are honoured", () => {
  const edited = JSON.parse(
    JSON.stringify([
      { min: -Infinity, max: -45, color: "#dc2626" },
      { min: -45, max: Infinity, color: "#16a34a" },
    ]),
  );
  const colorAt = rangesColorFn(edited);
  assert.equal(hex(colorAt(-46)), "#dc2626");
  assert.equal(hex(colorAt(-45)), "#16a34a");
});

test("interpolated values change gradually across cells", () => {
  const img = interpolateHeatmap(
    [cell(0.5, 0.5, -80), cell(1.5, 0.5, -55), cell(2.5, 0.5, -30)],
    rangesColorFn(rsrp),
    10,
  );
  assert.equal(img.width, 30);
  assert.equal(img.height, 10);
  // red -> orange -> yellow/lime -> green along the row: more than the three
  // cell values' colours, with the boundaries between cell centres
  const colors = new Set();
  for (let px = 0; px < img.width; px++) {
    const o = (5 * img.width + px) * 4;
    colors.add(`${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`);
  }
  assert.ok(colors.size >= 4, `only ${colors.size} colours`);
});

test("sparse cells do not produce NaN colours", () => {
  const img = interpolateHeatmap(
    [cell(0.5, 0.5, -40), cell(2.5, 2.5, -40)],
    rangesColorFn(rsrp),
    4,
  );
  assert.ok(img.data.every(Number.isFinite));
  assert.equal(img.data[3], 255);
});


test("values above the top band or below the bottom band take the end colours", () => {
  const ranges = [
    { min: -95, max: -70, color: "#ff4000" },
    { min: -70, max: -50, color: "#fcff38" },
    { min: -50, max: -30, color: "#08c44d" },
  ];
  assert.equal(getMetricColor(-10, ranges), "#08c44d"); // next to the AP
  assert.equal(getMetricColor(-120, ranges), "#ff4000");
  assert.equal(getMetricColor(-60, ranges), "#fcff38");
  assert.equal(getMetricColor(null, ranges), "#808080"); // no data stays grey
  const open = openEndedBands(ranges);
  assert.equal(open[0].min, -Infinity);
  assert.equal(open[2].max, Infinity);
  assert.equal(ranges[2].max, -30); // the saved thresholds are not changed
  const colour = rangesColorFn(ranges);
  assert.deepEqual(colour(-5), [8, 196, 77]);
});
