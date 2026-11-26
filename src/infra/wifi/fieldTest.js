// Field-test results (from a cable certifier) compared with the design.
//
// The tool plans a cabling system; it cannot certify one. A certifier measures the
// installed links. This reads its results as CSV and sets them beside the design:
// measured length against designed length, and pass or fail from the tester.
const SYNONYMS = {
  name: ["ap", "apname", "ap name", "name", "link", "cable", "cable id", "id", "label", "port"],
  length: ["length", "length m", "length (m)", "len", "measured length", "length_m"],
  loss: ["insertion loss", "insertion loss db", "insertion loss (db)", "il", "attenuation"],
  margin: ["margin", "worst margin", "worst margin db", "worst margin (db)", "headroom"],
  result: ["result", "status", "pass fail", "pass/fail", "verdict"],
};

// One CSV row into cells, with quoted cells and commas or semicolons as separators.
function splitRow(line, sep) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { cells.push(cell.trim()); cell = ""; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const number = (text) => {
  const n = Number(String(text ?? "").replace(",", ".").replace(/[^0-9.+-]/g, ""));
  return String(text ?? "").trim() === "" || !Number.isFinite(n) ? null : n;
};

const passed = (text) => {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^(pass|passed|ok|true|yes|p)\b/.test(t)) return true;
  if (/^(fail|failed|false|no|f)\b/.test(t)) return false;
  return null;
};

export function parseFieldTestCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("the file needs a header row and at least one result");
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const header = splitRow(lines[0], sep).map((h) => h.toLowerCase().replace(/[_\s]+/g, " ").trim());
  const col = (key) => header.findIndex((h) => SYNONYMS[key].includes(h));
  const idx = Object.fromEntries(Object.keys(SYNONYMS).map((k) => [k, col(k)]));
  if (idx.name < 0) throw new Error('there is no column naming the cable or AP (try "AP" or "Link")');
  if (idx.length < 0 && idx.result < 0) throw new Error('the file needs a "Length" or a "Result" column');
  return lines.slice(1).map((line) => {
    const c = splitRow(line, sep);
    return {
      name: c[idx.name],
      lengthM: idx.length >= 0 ? number(c[idx.length]) : null,
      insertionLossDb: idx.loss >= 0 ? number(c[idx.loss]) : null,
      marginDb: idx.margin >= 0 ? number(c[idx.margin]) : null,
      pass: idx.result >= 0 ? passed(c[idx.result]) : null,
    };
  }).filter((r) => r.name);
}

// Set the results beside the design. A measured length more than `tolerance` (a
// fraction) or 3 m away from the design is flagged as different.
export function compareFieldTest(design, rows, { tolerance = 0.1 } = {}) {
  const byName = new Map(design.runs.map((r) => [String(r.apName).trim().toLowerCase(), r]));
  const seen = new Set();
  const compared = [];
  const unknown = [];
  for (const row of rows) {
    const run = byName.get(String(row.name).trim().toLowerCase());
    if (!run) { unknown.push(row.name); continue; }
    seen.add(run.apId);
    const deltaM = row.lengthM != null ? Math.round((row.lengthM - run.permanentLinkM) * 100) / 100 : null;
    const differs = deltaM != null && Math.abs(deltaM) > Math.max(3, tolerance * run.permanentLinkM);
    compared.push({ ap: run.apName, designedM: run.permanentLinkM, measuredM: row.lengthM, deltaM, differs, pass: row.pass, insertionLossDb: row.insertionLossDb, marginDb: row.marginDb });
  }
  const notTested = design.runs.filter((r) => !seen.has(r.apId)).map((r) => r.apName);
  return {
    rows: compared,
    unknown,
    notTested,
    summary: {
      tested: compared.length,
      failed: compared.filter((r) => r.pass === false).length,
      lengthDiffers: compared.filter((r) => r.differs).length,
      untested: notTested.length,
    },
  };
}
