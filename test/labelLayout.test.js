import test from "node:test";
import assert from "node:assert/strict";
import { labelSize, layoutLabels } from "../src/utils/labelLayout.js";

const box = (spot, text, fontSize) => {
  const { w, h } = labelSize(text, fontSize);
  return {
    x0: spot.x - w / 2,
    y0: spot.y - h / 2,
    x1: spot.x + w / 2,
    y1: spot.y + h / 2,
  };
};
const hit = (a, b) =>
  Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) &&
  Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

test("an AP name and a column name on the same spot do not overlap", () => {
  const column = { x0: 4.8, y0: 5.8, x1: 5.2, y1: 6.2 };
  const ap = { x0: 4.56, y0: 5.56, x1: 5.44, y1: 6.44 };
  const labels = [
    { id: "f", text: "Column 10", fontSize: 0.4, priority: 1, preferred: { x: 5, y: 6 }, anchor: column },
    { id: "a", text: "AP4", fontSize: 0.4, priority: 2, preferred: null, anchor: ap },
  ];
  const spots = layoutLabels(labels, [
    { ...column, owner: "f" },
    { ...ap, owner: "a" },
  ]);
  const f = box(spots.f, "Column 10", 0.4),
    a = box(spots.a, "AP4", 0.4);
  assert.equal(hit(f, a), false);
  assert.equal(hit(a, column), false, "AP name stays off the column");
  assert.equal(hit(a, ap), false, "AP name stays off its own marker");
});

test("two APs next to each other get separate names", () => {
  const rect = (x, z) => ({ x0: x - 0.44, y0: z - 0.44, x1: x + 0.44, y1: z + 0.44 });
  const labels = ["AP-1", "AP-2"].map((id, i) => ({
    id,
    text: id,
    fontSize: 0.55,
    priority: 2,
    preferred: null,
    anchor: rect(i * 0.5, 0),
  }));
  const spots = layoutLabels(labels, []);
  assert.equal(hit(box(spots["AP-1"], "AP-1", 0.55), box(spots["AP-2"], "AP-2", 0.55)), false);
});
