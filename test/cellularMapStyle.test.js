import test from "node:test";
import assert from "node:assert/strict";
import { mapRanges } from "../src/infra/cellular/model.js";
import { rangesColorFn } from "../src/utils/heatmapImage.js";

test("the cellular RSRP map is smooth by default: colours blend between the band edges", () => {
  const colour = rangesColorFn(mapRanges({ cellular: {} }, "rsrp"));
  assert.deepEqual(colour(-60), [251, 52, 251]); // magenta at the top edge
  assert.deepEqual(colour(-69.65), [250, 47, 63]); // red at its edge
  const mid = colour(-65); // half way: a mix of the two
  assert.ok(mid[2] > 63 && mid[2] < 251);
});

test("the Bands style gives one flat colour per band, as before", () => {
  const colour = rangesColorFn(mapRanges({ cellular: { settings: { mapStyle: "bands" } } }, "rsrp"));
  assert.deepEqual(colour(-65), colour(-69));
  assert.deepEqual(colour(-65), [250, 47, 63]);
});

test("Wi-Fi ranges (no smooth flag) keep flat bands", () => {
  const colour = rangesColorFn([
    { min: -70, max: Infinity, color: "#00ff00" },
    { min: -Infinity, max: -70, color: "#ff0000" },
  ]);
  assert.deepEqual(colour(-50), [0, 255, 0]);
  assert.deepEqual(colour(-69), [0, 255, 0]);
});
