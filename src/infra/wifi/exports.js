// Deliverables for a Wi-Fi cabling design: an Excel workbook in the layout of an
// equipment list plus a cable schedule, and a PowerPoint report (summary, floor
// plans, network schematic, BoQ, cable schedule, checks). Both are built from
// the design only. Images (floor plans, schematic) are passed in as PNG data
// URLs because rasterising needs a browser.
import { NOT_CHECKED, complianceRows } from "./compliance.js";

const loadExcelJS = async () => {
  const module = await import("exceljs/dist/exceljs.min.js");
  return module.default || module;
};
const loadPptx = async () => {
  const module = await import("pptxgenjs");
  return module.default || module;
};

const GROUP_ORDER = ["Active equipment", "Rack", "Cabling", "Outlets", "Patching", "Mounting", "Pathway", "Consumables"];

// Equipment list rows grouped like a client BoQ: group header rows, then
// Item | Quantity | Buffer | Total. spareFraction adds a buffer per line.
export function equipmentRows(boq, { spareFraction = 0 } = {}) {
  const groups = [...new Set(boq.map((l) => l.group))].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 100) % 100 - (GROUP_ORDER.indexOf(b) + 100) % 100,
  );
  const rows = [];
  for (const group of groups) {
    rows.push({ header: true, name: group });
    for (const l of boq.filter((x) => x.group === group)) {
      // metres are bought whole; every quantity is rounded up
      const qty = Math.ceil(l.qty - 1e-9);
      const buffer = Math.max(0, Math.ceil(qty * spareFraction - 1e-9));
      rows.push({ header: false, name: l.unit === "m" ? l.name.replace(/\s*\(metres\)/, " (metres)") : l.name, qty, buffer, total: qty + buffer, basis: l.basis, source: l.source });
    }
  }
  return rows;
}

export async function wifiWorkbook(design, { title = "Wi-Fi cabling design", projectName = "", date = "", schematic = null, spareFraction = 0, history = [], fieldTest = null } = {}) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.title = title;

  const info = wb.addWorksheet("Project");
  info.columns = [{ width: 26 }, { width: 90 }];
  info.addRow([title]).font = { bold: true, size: 14 };
  for (const [k, v] of [
    ["Project", projectName],
    ["Date", date],
    ["Status", design.status],
    ["Approval level", design.approval?.level ?? ""],
    ["Still to confirm", (design.approval?.missing || []).join("; ")],
    ["Routes (confirmed / stated / estimated)", design.approval ? `${design.approval.routes.confirmed} / ${design.approval.routes.stated} / ${design.approval.routes.estimated}` : ""],
    ["APs routed", design.runs.length],
    ["Racks", design.racks.length],
    ["Switches", design.racks.reduce((s, r) => s + r.switches, 0)],
    ["Errors", design.violations.filter((x) => x.severity === "error").length],
    ["Warnings", design.violations.filter((x) => x.severity === "warning").length],
  ])
    info.addRow([k, v]);

  const list = wb.addWorksheet("Equipment List");
  list.columns = [{ width: 52 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 70 }, { width: 38 }];
  const head = list.addRow(["Bill of Materials", "Quantity (Nos.)", "Buffer (Nos)", "Total", "How calculated", "Catalogue source"]);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
  });
  for (const r of equipmentRows(design.boq, { spareFraction })) {
    const row = r.header ? list.addRow([r.name]) : list.addRow([r.name, r.qty, r.buffer, r.total, r.basis, r.source]);
    if (r.header) row.font = { bold: true };
    row.eachCell({ includeEmpty: false }, (c) => {
      c.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
    });
  }

  // PoE budget, power, heat and network figures of every rack
  const sw = wb.addWorksheet("PoE and switches");
  sw.columns = [
    { header: "Room", key: "name", width: 24 }, { header: "Role", key: "role", width: 12 }, { header: "Switch model", key: "model", width: 30 },
    { header: "Switches", key: "switches", width: 10 }, { header: "APs", key: "aps", width: 8 }, { header: "PoE allocated (W)", key: "poeW", width: 18 },
    { header: "Usable PoE per switch (W)", key: "usable", width: 24 }, { header: "Power (W)", key: "powerW", width: 11 }, { header: "Heat (BTU/h)", key: "btu", width: 13 },
    { header: "Space used / usable (U)", key: "units", width: 22 }, { header: "Fibre strands", key: "strands", width: 14 }, { header: "Oversubscription", key: "over", width: 17 },
  ];
  sw.getRow(1).font = { bold: true };
  for (const n of design.network?.racks || []) {
    const s = design.racks.find((x) => x.rackId === n.rackId);
    sw.addRow({
      name: n.name, role: n.role === "mdf" ? "main room" : "floor room", model: s?.switchName ?? "", switches: s?.switches ?? 0, aps: s?.apCount ?? 0,
      poeW: s?.poeAllocatedW ?? 0, usable: s?.usableBudgetW ?? "", powerW: n.powerW, btu: n.heatBtuHr, units: `${n.unitsUsed} / ${n.unitsUsable}`,
      strands: n.fibreStrands || "", over: n.oversubscription ? `${n.oversubscription.ratio}:1` : "",
    });
  }
  const comp = wb.addWorksheet("Compliance");
  comp.columns = [
    { header: "Area", key: "area", width: 12 }, { header: "Requirement", key: "requirement", width: 44 }, { header: "Limit", key: "limit", width: 34 },
    { header: "Design reaches", key: "actual", width: 36 }, { header: "Status", key: "status", width: 10 }, { header: "Note", key: "note", width: 60 },
  ];
  comp.getRow(1).font = { bold: true };
  for (const row of complianceRows(design)) comp.addRow(row);
  comp.addRow({});
  comp.addRow({ area: "Not checked by this tool:" }).font = { bold: true };
  for (const text of NOT_CHECKED) comp.addRow({ area: text });

  const sched = wb.addWorksheet("Cable schedule");
  sched.columns = [
    { header: "AP", key: "apName", width: 20 }, { header: "Floor", key: "floorId", width: 12 },
    { header: "Rack", key: "rackId", width: 16 }, { header: "Riser", key: "riserId", width: 12 },
    { header: "Route (m)", key: "horizontalM", width: 11 }, { header: "Drops and loops (m)", key: "verticalM", width: 18 },
    { header: "Slack (m)", key: "slackM", width: 10 }, { header: "Permanent link (m)", key: "permanentLinkM", width: 18 },
    { header: "Channel (m)", key: "channelM", width: 12 }, { header: "PoE port power (W)", key: "portPowerW", width: 18 },
    { header: "AP receives (V)", key: "pdVoltageV", width: 16 }, { header: "PoE cable loss (W)", key: "poeCableLossW", width: 18 },
    { header: "Signal loss @100 MHz (dB)", key: "insertionLossDb", width: 24 },
    { header: "Cable", key: "cableName", width: 22 }, { header: "Conduit (m)", key: "conduitM", width: 12 }, { header: "Penetrations", key: "penetrations", width: 13 },
    { header: "Edited by hand", key: "edited", width: 14 },
    { header: "Unconfirmed wall crossings", key: "crossings", width: 24 },
    { header: "Permitted crossings", key: "permittedCrossings", width: 20 }, { header: "Pathway", key: "pathwayStatus", width: 12 },
    { header: "Check", key: "check", width: 12 },
  ];
  sched.getRow(1).font = { bold: true };
  sched.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of design.runs) sched.addRow({ ...r, conduitM: r.layers?.conduitM ?? 0, edited: r.edited ? "yes" : "" });

  const checks = wb.addWorksheet("Checks");
  checks.columns = [{ header: "Severity", key: "severity", width: 10 }, { header: "Item", key: "item", width: 24 }, { header: "Message", key: "message", width: 110 }];
  checks.getRow(1).font = { bold: true };
  for (const v of design.violations) checks.addRow(v);

  const notes = wb.addWorksheet("Assumptions");
  notes.columns = [{ header: "Assumption", key: "text", width: 130 }];
  notes.getRow(1).font = { bold: true };
  for (const text of design.assumptions) notes.addRow({ text });

  if (history.length) {
    const sheet = wb.addWorksheet("History");
    sheet.columns = [{ header: "When", key: "at", width: 26 }, { header: "By", key: "by", width: 12 }, { header: "What", key: "summary", width: 90 }];
    sheet.getRow(1).font = { bold: true };
    for (const h of history) sheet.addRow(h);
  }
  if (fieldTest?.rows?.length) {
    const sheet = wb.addWorksheet("Field test");
    sheet.columns = [
      { header: "AP", key: "ap", width: 22 }, { header: "Designed (m)", key: "designedM", width: 14 }, { header: "Measured (m)", key: "measuredM", width: 14 },
      { header: "Difference (m)", key: "deltaM", width: 15 }, { header: "Length differs", key: "differs", width: 15 }, { header: "Result", key: "pass", width: 10 },
      { header: "Insertion loss (dB)", key: "insertionLossDb", width: 18 }, { header: "Margin (dB)", key: "marginDb", width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of fieldTest.rows) sheet.addRow({ ...r, differs: r.differs ? "yes" : "", pass: r.pass == null ? "" : r.pass ? "pass" : "FAIL" });
    sheet.addRow({});
    sheet.addRow({ ap: `Not tested: ${fieldTest.notTested.join(", ") || "none"}` });
    sheet.addRow({ ap: `Not in the design: ${fieldTest.unknown.join(", ") || "none"}` });
  }

  // schematic: { dataUrl, width, height } (a PNG of the network drawing)
  if (schematic) {
    const sheet = wb.addWorksheet("Schematic");
    const id = wb.addImage({ base64: schematic.dataUrl, extension: "png" });
    sheet.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 1400, height: Math.round((1400 * schematic.height) / schematic.width) } });
  }
  return wb;
}

// images: { schematic: dataUrl, floors: [{ name, dataUrl, width, height }] }
export async function wifiPptx(design, { title = "Wi-Fi cabling design", projectName = "", date = "", images = {} } = {}) {
  const Pptx = await loadPptx();
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  const header = (slide, text) => {
    slide.addShape("rect", { x: 0, y: 0, w: 13.33, h: 0.7, fill: { color: "FDE047" }, line: { color: "334155" } });
    slide.addText(text, { x: 0.3, y: 0.08, w: 12.7, h: 0.55, fontSize: 22, bold: true, color: "111827" });
    slide.addText(`${projectName}${date ? ` · ${date}` : ""} · preliminary estimate`, { x: 0.3, y: 7.1, w: 12.7, h: 0.3, fontSize: 10, color: "7F1D1D" });
  };

  let s = pptx.addSlide();
  s.addShape("rect", { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: "FFFFFF" } });
  s.addText(title.toUpperCase(), { x: 0.6, y: 1.6, w: 12, h: 0.9, fontSize: 34, bold: true, color: "111827" });
  s.addText(projectName || "Project", { x: 0.6, y: 2.6, w: 12, h: 0.6, fontSize: 22, color: "334155" });
  s.addText(date, { x: 0.6, y: 3.2, w: 12, h: 0.4, fontSize: 14, color: "475569" });
  s.addText(design.status, { x: 0.6, y: 6.4, w: 12, h: 0.6, fontSize: 12, color: "7F1D1D" });

  s = pptx.addSlide();
  header(s, "Design summary");
  const errors = design.violations.filter((v) => v.severity === "error");
  const warnings = design.violations.filter((v) => v.severity === "warning");
  const facts = [
    ["APs routed", design.runs.length], ["Racks", design.racks.length],
    ["Switches", design.racks.reduce((n, r) => n + r.switches, 0)],
    ["Ethernet cable (m)", Math.round(design.runs.reduce((n, r) => n + r.permanentLinkM, 0))],
    ["Cable tray (m)", design.trayM], ["Errors", errors.length], ["Warnings", warnings.length],
  ];
  s.addTable(facts.map(([k, v]) => [{ text: k, options: { bold: true } }, { text: String(v) }]), { x: 0.6, y: 1.1, w: 5.2, fontSize: 14, border: { type: "solid", color: "CBD5E1", pt: 1 } });
  const issues = [...errors, ...warnings].slice(0, 12).map((v) => `${v.severity === "error" ? "✖" : "⚠"} ${v.item}: ${v.message}`);
  s.addText(issues.length ? issues.join("\n") : "No errors or warnings.", { x: 6.2, y: 1.1, w: 6.8, h: 5.6, fontSize: 12, valign: "top", color: errors.length ? "991B1B" : "166534" });

  if (design.approval) {
    s = pptx.addSlide();
    header(s, `Approval status: ${design.approval.level}`);
    const rows = design.approval.checks.map((c) => [{ text: c.ok ? "✓" : "○" }, { text: c.label }]);
    s.addTable(rows, { x: 0.6, y: 1.0, w: 8, colW: [0.6, 7.4], fontSize: 13, border: { type: "solid", color: "CBD5E1", pt: 1 } });
    const r = design.approval.routes;
    s.addText(`Routes: ${r.confirmed} confirmed, ${r.stated} stated, ${r.estimated} estimated.\nEstimated routes rest on an unconfirmed assumption (ceiling or wall access).`, { x: 9, y: 1.0, w: 3.8, h: 2.5, fontSize: 12, valign: "top" });
  }
  {
    const rows = complianceRows(design);
    const per = 12;
    for (let i = 0; i < rows.length; i += per) {
      s = pptx.addSlide();
      header(s, `Compliance${rows.length > per ? ` (${Math.floor(i / per) + 1}/${Math.ceil(rows.length / per)})` : ""}`);
      const table = [["Requirement", "Limit", "Design reaches", "Status"].map((t) => ({ text: t, options: { bold: true } }))];
      for (const r of rows.slice(i, i + per))
        table.push([r.requirement, r.limit, r.actual, { text: r.status, options: { bold: true, color: r.status === "pass" ? "166534" : "991B1B" } }]);
      s.addTable(table, { x: 0.6, y: 1.0, w: 12.1, colW: [4.3, 2.9, 3.7, 1.2], fontSize: 11, border: { type: "solid", color: "CBD5E1", pt: 1 } });
    }
    s = pptx.addSlide();
    header(s, "What this tool does not check");
    s.addText(NOT_CHECKED.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.6, y: 1.0, w: 12.1, h: 4, fontSize: 14, valign: "top" });
  }
  for (const [key, title] of [["topology", "MDF / IDF topology"], ["rack", "Rack elevation"]]) {
    if (!images[key]) continue;
    s = pptx.addSlide();
    header(s, title);
    const { dataUrl, width, height } = images[key];
    const ratio = width / height;
    const w = Math.min(12.6, 6.1 * ratio);
    s.addImage({ data: dataUrl, x: (13.33 - w) / 2, y: 0.85, w, h: w / ratio });
  }
  if (images.riser) {
    s = pptx.addSlide();
    header(s, "Riser diagram");
    const { dataUrl, width, height } = images.riser;
    const ratio = width / height;
    const w = Math.min(12.6, 6.1 * ratio);
    s.addImage({ data: dataUrl, x: (13.33 - w) / 2, y: 0.85, w, h: w / ratio });
  }

  for (const f of images.floors || []) {
    s = pptx.addSlide();
    header(s, `Floor plan: ${f.name}`);
    const maxW = 12.6;
    const maxH = 6.1;
    const ratio = f.width / f.height;
    const w = Math.min(maxW, maxH * ratio);
    s.addImage({ data: f.dataUrl, x: (13.33 - w) / 2, y: 0.85, w, h: w / ratio });
  }
  if (images.schematic) {
    s = pptx.addSlide();
    header(s, "Network schematic");
    const { dataUrl, width, height } = images.schematic;
    const ratio = width / height;
    const w = Math.min(12.6, 6.1 * ratio);
    s.addImage({ data: dataUrl, x: (13.33 - w) / 2, y: 0.85, w, h: w / ratio });
  }

  const rows = equipmentRows(design.boq);
  const per = 14;
  for (let i = 0; i < rows.length; i += per) {
    s = pptx.addSlide();
    header(s, `Bill of materials${rows.length > per ? ` (${Math.floor(i / per) + 1}/${Math.ceil(rows.length / per)})` : ""}`);
    const table = [[{ text: "Item", options: { bold: true } }, { text: "Quantity", options: { bold: true } }, { text: "Buffer", options: { bold: true } }, { text: "Total", options: { bold: true } }]];
    for (const r of rows.slice(i, i + per))
      table.push(r.header ? [{ text: r.name, options: { bold: true, fill: { color: "E2E8F0" }, colspan: 4 } }] : [r.name, String(r.qty), String(r.buffer), String(r.total)]);
    s.addTable(table, { x: 0.6, y: 1.0, w: 12.1, colW: [7.6, 1.5, 1.5, 1.5], fontSize: 12, border: { type: "solid", color: "CBD5E1", pt: 1 } });
  }

  const perRuns = 16;
  for (let i = 0; i < design.runs.length; i += perRuns) {
    s = pptx.addSlide();
    header(s, `Cable schedule${design.runs.length > perRuns ? ` (${Math.floor(i / perRuns) + 1}/${Math.ceil(design.runs.length / perRuns)})` : ""}`);
    const table = [["AP", "Floor", "Rack", "Route (m)", "Link (m)", "Channel (m)", "PoE (W)", "AP V", "Check"].map((t) => ({ text: t, options: { bold: true } }))];
    for (const r of design.runs.slice(i, i + perRuns))
      table.push([r.apName, r.floorId, r.rackId, String(r.horizontalM), String(r.permanentLinkM), String(r.channelM), String(r.portPowerW), String(r.pdVoltageV ?? "-"), r.check]);
    s.addTable(table, { x: 0.6, y: 1.0, w: 12.1, fontSize: 11, border: { type: "solid", color: "CBD5E1", pt: 1 } });
  }

  s = pptx.addSlide();
  header(s, "Assumptions");
  s.addText(design.assumptions.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.6, y: 1.0, w: 12.1, h: 5.9, fontSize: 12, valign: "top" });
  return pptx;
}
