import assert from "node:assert/strict";
import test from "node:test";
import { floorImageTiles, registerFloorDrawing } from "../src/utils/floorRegistration.js";
import { floorSourceLabels } from "../src/infra/cellular/floorLabels.js";

test("registration preserves the shared outline and matches the raster, floor geometry and equipment", () => {
  const fixed = { id: "outline", floorId: "2", points: [{ x: 1, z: 1 }, { x: 9, z: 1 }, { x: 9, z: 11 }] };
  const room = { id: "room", floorId: "2", x: 1, z: 1, width: 8, depth: 8 };
  const lower = { ...room, id: "lower", floorId: "1" };
  const antenna = { id: "ant", floorId: "2", x: 5, z: 9 };
  const cable = { from: antenna.id, to: "riser", specifiedLengthM: 14, points: [{ x: 5, z: 9 }] };
  const plan = {
    floors: [{ id: "1" }, { id: "2" }],
    images: { "2": { offsetX: 1, offsetZ: 1, widthM: 8, heightM: 8 } },
    boundaries: [fixed],
    rooms: [room, lower],
    doors: [{ id: "door", floorId: "2", roomId: "room", wallSide: "east", offset: 4, width: 2 }],
    sources: [antenna],
    cellular: { cables: [cable] },
  };
  const x = [[1, 1], [9, 9]];
  const aligned = registerFloorDrawing(plan, "2", { x, z: [[1, 1], [5, 5], [9, 11]], fixedIds: [fixed.id] });
  assert.equal(aligned.boundaries[0], fixed);
  assert.equal(aligned.rooms[1], lower);
  assert.equal(aligned.rooms[0].depth, 10);
  assert.equal(aligned.doors[0].offset, 4);
  assert.equal(aligned.doors[0].width, 3);
  assert.deepEqual(aligned.sources[0], { ...antenna, z: 11 });
  assert.deepEqual(aligned.cellular.cables[0], { ...cable, points: [{ x: 5, z: 11 }] });
  assert.deepEqual(floorImageTiles(aligned.images["2"]), [
    { x: 1, z: 1, width: 8, height: 4, viewBox: "0 0 1 0.5" },
    { x: 1, z: 5, width: 8, height: 6, viewBox: "0 0.5 1 0.5" },
  ]);
  const restored = registerFloorDrawing(aligned, "2", { x, z: [[1, 1], [5, 5], [11, 9]] });
  assert.deepEqual(restored.images["2"].registration.z, [[0, 0], [0.5, 0.5], [1, 1]]);
  assert.deepEqual(restored.rooms, plan.rooms);
  assert.throws(() => registerFloorDrawing(plan, "2", { x, z: [[1, 11], [9, 1]] }), /preserve the order/);
});

test("floor labels are short, unique and stable when the source array is reordered", () => {
  const sources = [
    { id: "a", kind: "cellular", name: "2F-A22" },
    { id: "s", kind: "das", name: "2F-SP19" },
    { id: "coupler", kind: "das", name: "2F-CP105" },
    { id: "r", kind: "das", dasType: "riser", name: "2F S1 Shaft R · 4" },
    { id: "manual", kind: "das", name: "SP1" },
  ];
  const labels = new Map([["a", "A22"], ["s", "SP2"], ["coupler", "CP1"], ["r", "Shaft R"], ["manual", "SP1"]]);
  assert.deepEqual(floorSourceLabels(sources), labels);
  assert.deepEqual(floorSourceLabels(sources.toReversed()), labels);
  assert.equal(sources[0].name, "2F-A22");
});
