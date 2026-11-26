import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoutingGrid,
  cellOf,
  pathTo,
  shortestFrom,
  trayLengthM,
} from "../src/infra/core/routing.js";
import { solidPieces } from "../src/infra/core/planGeometry.js";
import { Boq } from "../src/infra/core/boq.js";
import { designWorkbookBuffer } from "../src/infra/core/excel.js";

const near = (a, b, tol = 1e-9, label = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

// 10 m x 6 m building, a wall at x = 5 with a 1 m door at z 4..5.
const building = (doorGap = true) => {
  const walls = doorGap
    ? [
        { a: { x: 5, z: 0 }, b: { x: 5, z: 4 } },
        { a: { x: 5, z: 5 }, b: { x: 5, z: 6 } },
      ]
    : [{ a: { x: 5, z: 0 }, b: { x: 5, z: 6 } }];
  return buildRoutingGrid({
    walls,
    bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 6 },
    footprint: () => true,
    cellM: 0.5,
  });
};
const rack = { x: 0.75, z: 0.75 };
const ap = { x: 9.25, z: 0.75 };

test("without a wall the route is the straight Manhattan distance", () => {
  const grid = buildRoutingGrid({
    walls: [],
    bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 6 },
    footprint: () => true,
  });
  const tree = shortestFrom(grid, rack);
  const route = pathTo(grid, tree, rack, ap);
  near(route.horizontalM, 8.5);
  assert.equal(route.crossings, 0);
});

test("with a high wall-crossing cost the route goes through the door", () => {
  const grid = building();
  const route = pathTo(grid, shortestFrom(grid, rack, { crossPenaltyM: 50 }), rack, ap);
  // 3.5 m to the door row, 8.5 m across, 3.5 m back
  near(route.horizontalM, 15.5, 1e-9);
  assert.equal(route.crossings, 0);
});

test("with no door gap the route crosses the wall and counts the crossing", () => {
  const grid = building(false);
  const route = pathTo(grid, shortestFrom(grid, rack, { crossPenaltyM: 10 }), rack, ap);
  assert.equal(route.crossings, 1);
  // the penalty steers the route but is not added to the cable length
  near(route.horizontalM, 8.5);
});

test("a cheap crossing beats a long detour; an expensive one does not", () => {
  const grid = building();
  const cheap = pathTo(grid, shortestFrom(grid, rack, { crossPenaltyM: 2 }), rack, ap);
  assert.equal(cheap.crossings, 1);
  near(cheap.horizontalM, 8.5);
  const dear = pathTo(grid, shortestFrom(grid, rack, { crossPenaltyM: 50 }), rack, ap);
  assert.equal(dear.crossings, 0);
});

test("points outside the building snap to the nearest cell inside it", () => {
  const grid = buildRoutingGrid({
    walls: [],
    bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 6 },
    footprint: (x) => x < 5, // only the left half is inside
  });
  const cell = cellOf(grid, 7, 3);
  assert.ok(grid.centerX(cell % grid.nx) < 5);
});

test("a shared trunk is counted once in the tray length", () => {
  const grid = buildRoutingGrid({
    walls: [],
    bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 6 },
    footprint: () => true,
  });
  const tree = shortestFrom(grid, rack);
  const a = pathTo(grid, tree, rack, { x: 9.25, z: 0.75 });
  const b = pathTo(grid, tree, rack, { x: 9.25, z: 0.75 });
  near(trayLengthM(grid, [a, b]), a.gridM);
  const c = pathTo(grid, tree, rack, { x: 9.25, z: 2.75 });
  assert.ok(trayLengthM(grid, [a, c]) < a.gridM + c.gridM);
});

test("a door cuts a wall into solid pieces; windows stay solid", () => {
  const wall = {
    a: { x: 0, z: 0 },
    b: { x: 10, z: 0 },
    length: 10,
    openings: [
      { kind: "door", start: 4, end: 5 },
      { kind: "window", start: 7, end: 8 },
    ],
  };
  const pieces = solidPieces(wall);
  assert.equal(pieces.length, 2);
  near(pieces[0].b.x, 4);
  near(pieces[1].a.x, 5);
  near(pieces[1].b.x, 10);
});

test("the BoQ adds repeated parts, rounds counts up and keeps metres as measured", () => {
  const boq = new Boq();
  boq.add({ group: "g", partId: "a", name: "A", qty: 1.2, basis: "first" });
  boq.add({ group: "g", partId: "a", name: "A", qty: 0.2, basis: "second" });
  boq.add({ group: "g", partId: "m", name: "M", unit: "m", qty: 10.126, basis: "cable" });
  boq.add({ group: "g", partId: "zero", name: "Z", qty: 0 });
  const lines = boq.toLines();
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => l.partId === "a").qty, 2);
  assert.equal(lines.find((l) => l.partId === "a").basis, "first; second");
  assert.equal(lines.find((l) => l.partId === "m").qty, 10.13);
  assert.throws(() => boq.add({ group: "g", partId: "x", name: "X", qty: -1 }), /zero or more/);
});

test("the Excel export holds the BoQ, runs, checks and assumptions", async () => {
  const design = {
    status: "preliminary",
    runs: [{ apName: "AP1", floorId: "f", rackId: "r", horizontalM: 10, verticalM: 5, slackM: 1, permanentLinkM: 16, channelM: 18, crossings: 0, check: "ok" }],
    boq: [{ group: "Cabling", name: "Cat6A", unit: "m", qty: 16, basis: "1 run", source: "x" }],
    violations: [{ severity: "warning", item: "AP1", message: "near limit" }],
    assumptions: ["a"],
  };
  const buffer = await designWorkbookBuffer(design, { title: "T" });
  const ExcelJS = (await import("exceljs/dist/exceljs.min.js")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "BoQ", "Runs", "Checks", "Assumptions"]);
  assert.equal(wb.getWorksheet("BoQ").getRow(2).getCell(4).value, 16);
});

test("in open space the route is an L with one turn, and it is not longer than before", () => {
  const grid = buildRoutingGrid({
    walls: [],
    bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 6 },
    footprint: () => true,
  });
  const target = { x: 9.25, z: 4.75 };
  const plain = pathTo(grid, shortestFrom(grid, rack, { turnPenaltyM: 0 }), rack, target);
  const straight = pathTo(grid, shortestFrom(grid, rack, { turnPenaltyM: 0.25 }), rack, target);
  near(straight.horizontalM, 8.5 + 4);
  near(straight.horizontalM, plain.horizontalM); // the penalty only breaks ties
  assert.ok(straight.turns <= 1, `turns: ${straight.turns}`);
});

test("a cable follows an earlier cable's trunk when that is cheaper, without changing lengths", async () => {
  const { markRoute, newUsage } = await import("../src/infra/core/routing.js");
  const grid = buildRoutingGrid({
    walls: [],
    bounds: { minX: 0, maxX: 20, minZ: 0, maxZ: 10 },
    footprint: () => true,
  });
  const first = pathTo(grid, shortestFrom(grid, rack), rack, { x: 19.25, z: 0.75 });
  const usage = newUsage(grid);
  markRoute(grid, usage, first);
  const tree = shortestFrom(grid, rack, { used: usage, usedFactor: 0.3, turnPenaltyM: 0.25 });
  const second = pathTo(grid, tree, rack, { x: 19.25, z: 3.75 });
  const shared = second.edges.filter((e) => first.edges.includes(e)).length;
  assert.ok(shared >= 30, `shared edges: ${shared}`); // runs along the first cable for most of its way
  near(second.horizontalM, 18.5 + 3); // still the true length of the route
});
