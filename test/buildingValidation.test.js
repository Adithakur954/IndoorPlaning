import test from "node:test";
import assert from "node:assert/strict";
import { validateBuilding } from "../src/utils/buildingValidation.js";

const room = (o) => ({
  id: "a", floorId: "f", name: "A", shape: "rectangle", x: 0, z: 0, width: 5, depth: 4, height: 3, ...o,
});
const plan = (extra) => ({ rooms: [room({})], doors: [], windows: [], interiorWalls: [], images: {}, ...extra });

test("a clean room passes", () => {
  assert.deepEqual(validateBuilding(plan({}), "f"), { errors: [], warnings: [] });
});

test("finds crossing outlines, duplicates, bad openings and drawn-twice walls", () => {
  const bow = room({ id: "b", name: "Bow", shape: "polygon", polygonPoints: [{ x: 0, z: 0 }, { x: 4, z: 4 }, { x: 4, z: 0 }, { x: 0, z: 4 }] });
  const issues = validateBuilding(
    plan({
      rooms: [room({}), room({ id: "c", name: "Copy" }), bow],
      doors: [
        { id: "d1", floorId: "f", roomId: "a", wallSide: "north", offset: 4.5, width: 1, height: 2 },
        { id: "d2", floorId: "f", roomId: "a", wallSide: "south", offset: 1, width: 1, height: 2 },
        { id: "d3", floorId: "f", roomId: "a", wallSide: "south", offset: 1.5, width: 1, height: 2 },
        { id: "d4", floorId: "f", roomId: "gone", wallSide: "south", offset: 1, width: 1, height: 2 },
      ],
      interiorWalls: [
        { id: "w1", floorId: "f", name: "W1", x1: 0, z1: 0, x2: 3, z2: 0 },
        { id: "w2", floorId: "f", name: "W2", x1: 3, z1: 0, x2: 0, z2: 0 },
      ],
    }),
    "f",
  ).errors.join(" | ");
  assert.match(issues, /Bow: its outline crosses itself/);
  assert.match(issues, /same room drawn twice/);
  assert.match(issues, /runs past the end of its wall/);
  assert.match(issues, /Two openings overlap/);
  assert.match(issues, /no longer exists/);
  assert.match(issues, /drawn twice/);
});

test("rooms far outside the floor image are flagged as misaligned", () => {
  const { warnings } = validateBuilding(
    plan({ rooms: [room({ x: 60 })], images: { f: { widthM: 20, heightM: 10 } } }),
    "f",
  );
  assert.match(warnings.join(" "), /outside the floor image/);
});
