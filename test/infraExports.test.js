import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { buildFloorSvg } from "../src/infra/wifi/floorSvg.js";
import { equipmentRows, wifiPptx, wifiWorkbook } from "../src/infra/wifi/exports.js";

// 1 x 1 pixel PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ap = (id, x, z) => ({ id, kind: "wifi", name: id, floorId: "f1", x, z, heightM: 2.5 });
const plan = (n) => ({
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }],
  rooms: [{ id: "h", floorId: "f1", name: "Hall", shape: "rectangle", x: 0, z: 0, width: 40, depth: 10, height: 3 }],
  doors: [], windows: [], interiorWalls: [], boundaries: [],
  sources: Array.from({ length: n }, (_, i) => ap(`AP${i + 1}`, 5.25 + i * 2, 3.25 + (i % 3) * 2)),
});
const racks = [{ id: "k1", name: "Rack 1", floorId: "f1", x: 0.75, z: 0.75 }];
const design = (n = 5) => designWifiCabling({ plan: plan(n), racks });

test("equipment list: group headers, then quantity, buffer and total per line", () => {
  const rows = equipmentRows(design().boq, { spareFraction: 0.1 });
  assert.equal(rows[0].header, true);
  assert.equal(rows[0].name, "Active equipment");
  const cable = rows.find((r) => /Cat6A U\/UTP cable \(metres\)/.test(r.name));
  assert.equal(cable.qty, Math.ceil(cable.qty));
  assert.equal(cable.total, cable.qty + cable.buffer);
  assert.equal(cable.buffer, Math.ceil(cable.qty * 0.1));
  const ap = rows.find((r) => /Wi-Fi AP/.test(r.name));
  assert.equal(ap.qty, 5);
  assert.equal(ap.buffer, 1); // 10 % of 5, rounded up
  assert.equal(equipmentRows(design().boq).find((r) => /Wi-Fi AP/.test(r.name)).buffer, 0);
});

test("the Excel workbook has the project sheet, equipment list, cable schedule, checks and assumptions", async () => {
  const d = design();
  const wb = await wifiWorkbook(d, { projectName: "Demo", date: "2026-11-18", schematic: { dataUrl: PNG, width: 1, height: 1 } });
  const buffer = await wb.xlsx.writeBuffer();
  const ExcelJS = (await import("exceljs/dist/exceljs.min.js")).default;
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer);
  assert.deepEqual(back.worksheets.map((w) => w.name), ["Project", "Equipment List", "PoE and switches", "Compliance", "Cable schedule", "Checks", "Assumptions", "Schematic"]);
  const list = back.getWorksheet("Equipment List");
  assert.deepEqual(list.getRow(1).values.slice(1, 5), ["Bill of Materials", "Quantity (Nos.)", "Buffer (Nos)", "Total"]);
  const names = [];
  list.eachRow((r) => names.push(String(r.getCell(1).value)));
  assert.ok(names.includes("Cabling") && names.some((n) => /Wi-Fi AP/.test(n)));
  assert.equal(back.getWorksheet("Cable schedule").rowCount, d.runs.length + 1);
  assert.equal(back.getWorksheet("Project").getRow(2).getCell(2).value, "Demo");
  const projectRows = [];
  back.getWorksheet("Project").eachRow((r) => projectRows.push(String(r.getCell(1).value)));
  assert.ok(projectRows.includes("Approval level") && projectRows.includes("Still to confirm"));
  assert.equal(back.getWorksheet("Cable schedule").getRow(1).values.includes("Conduit (m)"), true);
});

test("the PowerPoint report has the expected slides, text and images", async () => {
  const d = design(20); // 20 runs: the cable schedule spans two slides
  const floor = buildFloorSvg({ plan: plan(20), floorId: "f1", design: d, racks, title: "Level 1" });
  const pptx = await wifiPptx(d, {
    projectName: "Demo", date: "2026-11-18",
    images: {
      schematic: { dataUrl: PNG, width: 1400, height: 800 },
      floors: [{ name: "Level 1", dataUrl: PNG, width: floor.width, height: floor.height }],
    },
  });
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  // title, summary, 1 floor, schematic, BoQ (1+), cable schedule (2), assumptions
  assert.ok(slides.length >= 8, `slides: ${slides.length}`);
  const text = (await Promise.all(slides.map((n) => zip.file(n).async("string")))).join(" ");
  for (const needle of ["WI-FI CABLING DESIGN", "Design summary", "Floor plan: Level 1", "Network schematic", "Bill of materials", "Cable schedule", "Assumptions", "Demo", "preliminary estimate"])
    assert.ok(text.includes(needle), `missing: ${needle}`);
  assert.ok(Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/")).length >= 2);
});

test("the floor drawing shows walls, APs, racks and each cable's length", () => {
  const d = design(3);
  const out = buildFloorSvg({ plan: plan(3), floorId: "f1", design: d, racks, title: "Level 1 <&>" });
  assert.match(out.svg, /<svg /);
  assert.ok(out.svg.includes("Level 1 &lt;&amp;&gt;"));
  for (const r of d.runs) assert.ok(out.svg.includes(`${r.permanentLinkM} m`));
  assert.ok(out.svg.includes("Rack 1"));
  assert.equal(buildFloorSvg({ plan: { floors: plan(0).floors, rooms: [], doors: [], windows: [], interiorWalls: [], boundaries: [], sources: [] }, floorId: "f1", design: d }), null);
});
