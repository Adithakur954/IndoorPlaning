import assert from "node:assert/strict";
import test from "node:test";
import { pointsFromPrinted, twoLengthScale } from "../src/utils/scaleCalibration.js";

test("two lengths give the scale across and up-down of a stretched picture", () => {
  // a 100 m x 50 m building drawn at 10 px/m across but only 8 px/m up-down
  const s = twoLengthScale([0, 0], [1000, 0], 100, [0, 0], [0, 400], 50);
  assert.ok(Math.abs(s.xPxPerM - 10) < 1e-9);
  assert.ok(Math.abs(s.yPxPerM - 8) < 1e-9);
  assert.ok(Math.abs(s.stretchPct - 25) < 1e-9);
});

test("a slanted known length still works with a vertical one", () => {
  const s = twoLengthScale([0, 0], [600, 320], Math.hypot(60, 40), [0, 0], [0, 400], 50);
  assert.ok(Math.abs(s.xPxPerM - 10) < 1e-9);
  assert.ok(Math.abs(s.yPxPerM - 8) < 1e-9);
});

test("an unstretched picture has the same scale both ways", () => {
  const k = 1180 / 190;
  const s = twoLengthScale([10, 10], [1190, 10], 190, [5, 100], [5, 100 + 80 * k], 80);
  assert.ok(Math.abs(s.xPxPerM - k) < 1e-9);
  assert.ok(Math.abs(s.yPxPerM - k) < 1e-9);
  assert.ok(s.stretchPct < 0.1);
});

test("two lengths in the same direction, or missing input, give no answer", () => {
  assert.equal(twoLengthScale([0, 0], [1000, 0], 100, [0, 50], [800, 60], 80), null);
  assert.equal(twoLengthScale([0, 0], [1000, 0], 100, null, [0, 400], 50), null);
  assert.equal(twoLengthScale([0, 0], [1000, 0], 100, [0, 0], [0, 400], 0), null);
});

test("printed sizes become A-B (across) and C-D (up-down)", () => {
  const p = pointsFromPrinted([
    { text: "190.00 m", metres: 190, horizontal: true, a: [174, 761], b: [1357, 761] },
    { text: "80.00 m", metres: 80, horizontal: false, a: [35, 229], b: [35, 678] },
  ]);
  assert.deepEqual(p.ab, { a: [174, 761], b: [1357, 761], metres: 190, text: "190.00 m" });
  assert.equal(p.cd.metres, 80);
  assert.deepEqual(pointsFromPrinted([]), { ab: null, cd: null });
});
