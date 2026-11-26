// Excel export of a cabling design (BoQ, runs, checks, assumptions).
const loadExcelJS = async () => {
  const module = await import("exceljs/dist/exceljs.min.js");
  return module.default || module;
};

function sheet(workbook, name, columns, rows) {
  const ws = workbook.addWorksheet(name);
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) ws.addRow(row);
  return ws;
}

// design: { boq, runs, violations, assumptions, status }
export async function designWorkbook(design, { title = "Cabling design" } = {}) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  workbook.title = title;

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 28 }, { width: 80 }];
  summary.addRow([title]).font = { bold: true, size: 14 };
  summary.addRow(["Status", design.status]);
  summary.addRow(["Runs", design.runs.length]);
  summary.addRow(["Errors", design.violations.filter((v) => v.severity === "error").length]);
  summary.addRow(["Warnings", design.violations.filter((v) => v.severity === "warning").length]);

  sheet(
    workbook,
    "BoQ",
    [["Group", "group", 22], ["Item", "name", 42], ["Unit", "unit", 8], ["Quantity", "qty", 12], ["How calculated", "basis", 70], ["Catalogue source", "source", 40]],
    design.boq,
  );
  sheet(
    workbook,
    "Runs",
    [
      ["AP", "apName", 22], ["Floor", "floorId", 14], ["Rack", "rackId", 14],
      ["Route (m)", "horizontalM", 12], ["Drops and loops (m)", "verticalM", 18],
      ["Slack (m)", "slackM", 10], ["Permanent link (m)", "permanentLinkM", 18],
      ["Channel (m)", "channelM", 12], ["Walls crossed", "crossings", 14], ["Check", "check", 12],
    ],
    design.runs,
  );
  sheet(
    workbook,
    "Checks",
    [["Severity", "severity", 10], ["Item", "item", 24], ["Message", "message", 100]],
    design.violations,
  );
  sheet(
    workbook,
    "Assumptions",
    [["Assumption", "text", 120]],
    design.assumptions.map((text) => ({ text })),
  );
  return workbook;
}

export async function designWorkbookBuffer(design, options) {
  return (await designWorkbook(design, options)).xlsx.writeBuffer();
}
