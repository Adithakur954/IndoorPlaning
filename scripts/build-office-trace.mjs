import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReviewedDetectedWorkbook,
  parseBuildingWorkbook,
} from "../src/utils/excelPlan.js";

// Manually reviewed against the 1600 x 1396 raster plan. The project's image
// underlay is calibrated to 20 x 17.45 metres, so 80 pixels represent 1 metre.
const pxPerMetre = 80;
const floorId = "level-1";
const box = ([name, x0, y0, x1, y1], index, kind) => ({
  id: `${kind}-${String(index + 1).padStart(2, "0")}`,
  floorId,
  name,
  x: +(x0 / pxPerMetre).toFixed(2),
  z: +(y0 / pxPerMetre).toFixed(2),
  width: +((x1 - x0) / pxPerMetre).toFixed(2),
  depth: +((y1 - y0) / pxPerMetre).toFixed(2),
  height: kind === "ROOM" ? 3 : 0.8,
  ...(kind === "ROOM" ? { shape: "rectangle" } : {}),
});

const roomPixels = [
  ["Northwest enclosed area 1", 88, 105, 195, 209],
  ["Northwest enclosed area 2", 88, 218, 195, 328],
  ["North office 1", 588, 31, 697, 110],
  ["North storage 1", 700, 75, 779, 110],
  ["North office 2", 851, 31, 955, 110],
  ["North storage 2", 959, 75, 1040, 110],
  ["North meeting pod 1", 1055, 31, 1171, 110],
  ["North meeting pod 2", 1179, 31, 1297, 110],
  ["North meeting pod 3", 1305, 31, 1427, 110],
  ["Phone pod north 1", 1141, 178, 1188, 229],
  ["Phone pod north 2", 1190, 178, 1237, 229],
  ["Phone pod west", 199, 480, 248, 535],
  ["Phone pod east", 1311, 615, 1375, 675],
  ["South pod 1", 171, 1209, 256, 1334],
  ["South pod 2", 258, 1209, 345, 1334],
  ["South pod 3", 349, 1209, 435, 1334],
  ["South pod 4", 583, 1209, 677, 1334],
  ["South pod 5", 679, 1209, 769, 1334],
  ["South pod 6", 931, 1209, 1024, 1334],
  ["South pod 7", 1027, 1209, 1115, 1334],
];

const furniturePixels = [
  ["Communal table north-west", 304, 181, 506, 238],
  ["Communal table north-centre", 560, 181, 752, 238],
  ["Communal table north-east", 827, 176, 1142, 240],
  ["Workstation island upper 1", 315, 282, 564, 381],
  ["Workstation island upper 2", 614, 282, 978, 381],
  ["Workstation island upper 3", 1032, 282, 1280, 381],
  ["Perimeter desk run 1", 263, 418, 405, 471],
  ["Perimeter desk run 2", 450, 418, 559, 471],
  ["Perimeter desk run 3", 576, 418, 724, 471],
  ["Perimeter desk run 4", 738, 418, 1011, 471],
  ["Perimeter desk run 5", 1085, 418, 1361, 471],
  ["Shared table west", 280, 505, 505, 568],
  ["Shared table centre", 610, 493, 846, 571],
  ["Shared table east", 880, 493, 1022, 571],
  ["Small meeting table", 1100, 478, 1215, 580],
  ["Private desk bank 1", 92, 614, 207, 735],
  ["Private desk bank 2", 246, 614, 356, 735],
  ["Private desk bank 3", 380, 614, 492, 735],
  ["Private desk bank 4", 518, 614, 707, 735],
  ["Private desk bank 5", 796, 614, 886, 735],
  ["Private desk bank 6", 901, 614, 996, 735],
  ["Private desk bank 7", 1013, 614, 1120, 735],
  ["Private desk bank 8", 1137, 614, 1240, 735],
];

const privateDeskX = [
  [91, 232],
  [252, 394],
  [408, 550],
  [565, 708],
  [735, 871],
  [885, 1022],
  [1037, 1178],
  [1195, 1362],
];
for (const [row, y0, y1] of [
  ["north", 781, 843],
  ["south", 848, 923],
])
  for (const [index, [x0, x1]] of privateDeskX.entries())
    furniturePixels.push([`Private desk ${row} ${index + 1}`, x0, y0, x1, y1]);

const lowerDeskX = [
  [165, 242],
  [317, 396],
  [468, 548],
  [620, 701],
  [773, 852],
  [925, 1004],
  [1074, 1155],
  [1226, 1308],
  [1378, 1463],
];
for (const [index, [x0, x1]] of lowerDeskX.entries())
  furniturePixels.push([`Workstation bench ${index + 1}`, x0, 973, x1, 1158]);
furniturePixels.push(
  ["South open desk group 1", 439, 1211, 563, 1333],
  ["South open desk group 2", 774, 1211, 929, 1333],
  ["South communal table", 1149, 1218, 1465, 1306],
);

const wallPixels = [
  [80, 30, 1493, 30],
  [80, 30, 80, 1344],
  [1493, 30, 1493, 1344],
  [80, 1344, 1493, 1344],
  [80, 472, 1372, 472],
  [80, 843, 1373, 843],
  [1375, 175, 1375, 580],
];

const rooms = roomPixels.map((item, index) => box(item, index, "ROOM"));
const furniture = furniturePixels.map((item, index) =>
  box(item, index, "FURN"),
);
const interiorWalls = wallPixels.map(([x1, z1, x2, z2], index) => ({
  id: `WALL-${String(index + 1).padStart(2, "0")}`,
  floorId,
  name: index < 4 ? "Outer boundary" : "Visible partition or beam",
  x1: +(x1 / pxPerMetre).toFixed(2),
  z1: +(z1 / pxPerMetre).toFixed(2),
  x2: +(x2 / pxPerMetre).toFixed(2),
  z2: +(z2 / pxPerMetre).toFixed(2),
  material: "drywall",
}));

const workbook = await createReviewedDetectedWorkbook(
  {
    siteName: "Coworking floor - image trace",
    wallThickness: 0.2,
    rooms,
    interiorWalls,
    furniture,
  },
  { id: floorId, name: "Level 1" },
);
for (const name of ["Doors", "Windows"])
  workbook.removeWorksheet(workbook.getWorksheet(name).id);

const meta = workbook.getWorksheet("FloorMeta");
meta.getCell("I1").value = "image_width_m";
meta.getCell("I2").value = 20;
meta.getCell("J1").value = "image_height_m";
meta.getCell("J2").value = 17.45;
meta.getCell("K1").value = "trace_note";
meta.getCell("K2").value =
  "Approximate manual trace from the uploaded raster image; check dimensions before RF planning.";

const colors = {
  FloorMeta: "184E77",
  Rooms: "0F766E",
  InteriorWalls: "6D28D9",
  Furniture: "9A6700",
};
for (const sheet of workbook.worksheets) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.properties.tabColor = { argb: colors[sheet.name] };
  sheet.getRow(1).height = 29;
  sheet.getRow(1).font = {
    name: "Aptos",
    size: 11,
    bold: true,
    color: { argb: "FFFFFF" },
  };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: colors[sheet.name] },
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.height = 22;
    row.font = { name: "Aptos", size: 10, color: { argb: "24313F" } };
    if (rowNumber % 2 === 0)
      row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "F3F7F8" },
      };
    row.eachCell((cell, col) => {
      if (typeof cell.value === "number") cell.numFmt = "0.00";
      cell.alignment = { vertical: "middle", wrapText: false };
    });
  });
  sheet.columns.forEach((column) => {
    column.width = /name|note/i.test(column.header || "") ? 34 : 17;
  });
  if (sheet.name === "FloorMeta") sheet.getColumn("K").width = 85;
  sheet.autoFilter = {
    from: "A1",
    to: sheet.getCell(1, sheet.columnCount).address,
  };
  sheet.showGridLines = false;
}

const outputDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../outputs/office-plan-trace-20261016",
);
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "coworking_floor_plan_trace.xlsx");
const buffer = await workbook.xlsx.writeBuffer();
const parsed = await parseBuildingWorkbook(buffer);
if (
  parsed.error ||
  parsed.rooms.length !== rooms.length ||
  parsed.interiorWalls.length !== interiorWalls.length ||
  parsed.furniture.length !== furniture.length
)
  throw Error(
    `Workbook import check failed: ${parsed.error || "object counts differ"}`,
  );
await fs.writeFile(outputPath, Buffer.from(buffer));
const sourceImagePath = path.join(outputDir, "floor_plan_reference.webp");
const sourceImage = await fs.readFile(sourceImagePath).catch(() => null);
if (sourceImage) {
  const rectangles = (items, color) =>
    items
      .map(
        ([, x0, y0, x1, y1]) =>
          `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="3"/>`,
      )
      .join("");
  const lines = wallPixels
    .map(
      ([x1, y1, x2, y2]) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6D28D9" stroke-width="4"/>`,
    )
    .join("");
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1396" viewBox="0 0 1600 1396"><image href="data:image/webp;base64,${sourceImage.toString("base64")}" width="1600" height="1396"/><g>${rectangles(roomPixels, "#0F766E")}${rectangles(furniturePixels, "#B45309")}${lines}</g></svg>`;
  await fs.writeFile(path.join(outputDir, "trace_review.svg"), preview);
}
console.log(
  JSON.stringify({
    outputPath,
    rooms: rooms.length,
    walls: interiorWalls.length,
    furniture: furniture.length,
  }),
);
