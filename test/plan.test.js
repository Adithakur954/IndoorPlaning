import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import {
  areaOf,
  overlapWarnings,
  resizePolygonPoints,
} from "../src/utils/geometry.js";
import { predict } from "../src/utils/prediction.js";
import {
  localToGeographic,
  geographicToLocal,
} from "../src/utils/geographicAlignment.js";
import { createStoryBuildingTemplateWorkbook } from "../src/templates/buildingTemplate.js";
import {
  parseBuildingWorkbook,
  parseLogsCsv,
  createReviewedDetectedWorkbook,
} from "../src/utils/excelPlan.js";
import { parseIndoorLogZip } from "../src/utils/indoorZip.js";
import JSZip from "jszip";
import { detectRegionsFromPixels } from "../src/utils/imageDetection.js";

test("geometry, overlap and RF coverage react to wall loss", () => {
  const room = {
    id: "a",
    floorId: "level-1",
    name: "A",
    shape: "rectangle",
    x: 0,
    z: 0,
    width: 10,
    depth: 10,
    height: 3,
  };
  assert.equal(areaOf(room), 100);
  assert.ok(
    Math.abs(
      areaOf({ ...room, shape: "circle", width: 4, depth: 4, radius: 2 }) -
        Math.PI * 4,
    ) < 0.05,
  );
  assert.equal(
    overlapWarnings([room, { ...room, id: "b", name: "B", x: 8 }]).length,
    1,
  );
  const plan = initialPlan();
  plan.rooms = [room];
  plan.sources = [
    {
      id: "s",
      floorId: "level-1",
      name: "AP",
      kind: "wifi",
      x: 2,
      z: 2,
      heightM: 2.5,
      txPowerDbm: 20,
      freqMHz: 2400,
      antennaGainDbi: 0,
      antennaPattern: "omni",
    },
  ];
  const points = predict(plan, "level-1");
  assert.ok(points.length > 50);
  assert.ok(points.every((p) => Number.isFinite(p.dbm)));
  const clear = points.find((p) => p.x === 2.5 && p.z === 2.5);
  assert.ok(clear.dbm > -70);
  plan.interiorWalls = [
    {
      id: "wall",
      floorId: "level-1",
      x1: 5,
      z1: 0,
      x2: 5,
      z2: 10,
      material: "metal",
    },
  ];
  const blocked = predict(plan, "level-1").find(
    (p) => p.x === 7.5 && p.z === 4.5,
  );
  const unblocked = points.find((p) => p.x === 7.5 && p.z === 4.5);
  assert.ok(blocked.dbm < unblocked.dbm - 20);
});

test("custom polygons can be resized to any supported vertex count", () => {
  const hexagon = resizePolygonPoints(
    [
      { x: 0, z: 0 },
      { x: 8, z: 0 },
      { x: 8, z: 6 },
      { x: 0, z: 6 },
    ],
    6,
  );
  assert.equal(hexagon.length, 6);
  assert.ok(
    hexagon.every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.z),
    ),
  );
  assert.equal(resizePolygonPoints(hexagon, 100).length, 64);
});

test("geographic alignment round trips local coordinates", () => {
  const a = { lat: 28.6, lng: 77.2, x: 3, z: 5, rotationDeg: 25, unit: "m" };
  const geo = localToGeographic({ x: 10, z: 14 }, a),
    back = geographicToLocal(geo, a);
  assert.ok(Math.abs(back.x - 10) < 1e-6);
  assert.ok(Math.abs(back.z - 14) < 1e-6);
});

test("existing building template imports with floor and shape data", async () => {
  const workbook = await createStoryBuildingTemplateWorkbook(3);
  const parsed = await parseBuildingWorkbook(await workbook.xlsx.writeBuffer());
  assert.equal(parsed.error, undefined);
  assert.equal(new Set(parsed.rooms.map((r) => r.floorId)).size, 3);
  assert.ok(parsed.rooms.some((r) => r.shape === "circle"));
  assert.ok(parsed.rooms.some((r) => r.shape === "polygon"));
  assert.ok(parsed.doors.length > 0);
});

test("local and geographic CSV samples load with KPI values", () => {
  const data = "x,z,RSRP,latitude,longitude\n2,3,-85,,\n,, -95,28.6,77.2";
  const result = parseLogsCsv(data, null, "level-1", null);
  assert.equal(result.logs.length, 2);
  assert.equal(result.pendingAlignment, 1);
  assert.equal(result.logs[0].rsrp, -85);
});

test("reviewed image rooms download and reimport in metres", async () => {
  const room = {
    id: "detected",
    floorId: "level-1",
    name: "Detected office",
    shape: "rectangle",
    x: 2,
    z: 3,
    width: 6,
    depth: 4,
    height: 3,
  };
  const workbook = await createReviewedDetectedWorkbook(
    { rooms: [room], siteName: "Test", wallThickness: 0.2 },
    { id: "level-1", name: "Level 1" },
  );
  const parsed = await parseBuildingWorkbook(await workbook.xlsx.writeBuffer());
  assert.equal(parsed.rooms[0].width, 6);
  assert.equal(parsed.rooms[0].x, 2);
});

test("building workbook round trips walls and furniture for image plotting", async () => {
  const workbook = await createReviewedDetectedWorkbook(
    {
      siteName: "Office trace",
      wallThickness: 0.2,
      rooms: [
        {
          id: "R1",
          floorId: "level-1",
          name: "Office",
          x: 1,
          z: 2,
          width: 3,
          depth: 4,
          height: 3,
        },
      ],
      interiorWalls: [
        {
          id: "IW1",
          floorId: "level-1",
          x1: 0,
          z1: 5,
          x2: 8,
          z2: 5,
          material: "drywall",
        },
      ],
      furniture: [
        {
          id: "F1",
          floorId: "level-1",
          name: "Desk cluster",
          x: 4,
          z: 6,
          width: 2,
          depth: 1,
          height: 0.8,
        },
      ],
    },
    { id: "level-1", name: "Level 1" },
  );
  const parsed = await parseBuildingWorkbook(await workbook.xlsx.writeBuffer());
  assert.equal(parsed.rooms.length, 1);
  assert.deepEqual(
    [parsed.interiorWalls[0].x1, parsed.interiorWalls[0].z2],
    [0, 5],
  );
  assert.deepEqual([parsed.furniture[0].x, parsed.furniture[0].depth], [4, 1]);
});

test("standard network log ZIP loads samples and color ranges", async () => {
  const zip = new JSZip();
  zip.file("NetworkLog_sample.csv", "x,z,RSRP\n2,3,-85");
  zip.file(
    "ColorSettings_sample.csv",
    "metric,type,min,max,color,label\nrsrp,RANGE,-100,-80,#16a34a,Good",
  );
  const parsed = await parseIndoorLogZip(
    await zip.generateAsync({ type: "uint8array" }),
    "level-1",
    null,
  );
  assert.equal(parsed.logs.length, 1);
  assert.equal(parsed.logs[0].rsrp, -85);
  assert.equal(parsed.zipThresholds.rsrp[0].color, "#16a34a");
});

test("floor image detector finds an enclosed room for review", () => {
  const width = 100,
    height = 100,
    pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const black =
        (x >= 20 && x <= 70 && (y === 20 || y === 70)) ||
        (y >= 20 && y <= 70 && (x === 20 || x === 70));
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = black ? 0 : 255;
      pixels[i + 3] = 255;
    }
  const rooms = detectRegionsFromPixels(pixels, width, height, 20);
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0].width > 9 && rooms[0].width < 10);
});

test("floor image quick scan ignores chair-sized enclosed details", () => {
  const width = 650,
    height = 650;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const edge =
        x >= 100 &&
        x <= 118 &&
        y >= 100 &&
        y <= 118 &&
        (x === 100 || x === 118 || y === 100 || y === 118);
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = edge ? 0 : 255;
      pixels[i + 3] = 255;
    }
  assert.equal(detectRegionsFromPixels(pixels, width, height, 20).length, 0);
});
