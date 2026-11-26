import test from "node:test";
import assert from "node:assert/strict";
import { edgeMeasures, formatMetres } from "../src/utils/geometry.js";

const square = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
  { x: 4, z: 3 },
  { x: 0, z: 3 },
];

test("every edge of a closed shape gets its length and midpoint", () => {
  const m = edgeMeasures(square);
  assert.deepEqual(
    m.map((e) => e.length),
    [4, 3, 4, 3],
  );
  assert.deepEqual(m[0].mid, { x: 2, z: 0 });
});

test("the inward normal points into the shape whatever the winding", () => {
  for (const pts of [square, [...square].reverse()]) {
    for (const e of edgeMeasures(pts)) {
      const p = { x: e.mid.x + e.inward.x * 0.1, z: e.mid.z + e.inward.z * 0.1 };
      assert.ok(p.x > 0 && p.x < 4 && p.z > 0 && p.z < 3, JSON.stringify(e));
    }
  }
});

test("label angles never read upside down", () => {
  for (const e of edgeMeasures([...square].reverse()))
    assert.ok(e.angleDeg > -90 && e.angleDeg <= 90, String(e.angleDeg));
});

test("an open wall has one edge and zero-length edges are skipped", () => {
  assert.equal(
    edgeMeasures([
      { x: 0, z: 0 },
      { x: 0, z: 5 },
    ], false).length,
    1,
  );
  assert.equal(edgeMeasures([{ x: 1, z: 1 }, { x: 1, z: 1 }], false).length, 0);
});

test("lengths are formatted in metres", () => {
  assert.equal(formatMetres(4.5), "4.50 m");
  assert.equal(formatMetres(12.34), "12.3 m");
});
