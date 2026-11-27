// Importing DAS equipment from a datasheet table: a CSV file, or an Excel sheet
// read into rows. There are two table formats:
//   parts:  splitters, couplers, combiners and risers in one table; the `type`
//           column says which each row is.
//   cables: one row per cable, with its loss per 100 m at several frequencies
//           (columns loss_<MHz>, e.g. loss_900, loss_1800).
// The header row tells which format a file is, so a file can be imported from
// any part window and each row still lands in its own list. A model that is
// already in the catalogue (built in or imported before) is updated, never
// added a second time.

export const PART_COLUMNS = [
  // [column, needed for, what it holds]
  ["type", "all", "splitter, coupler, combiner or riser"],
  ["model", "all", "the manufacturer's model number"],
  ["manufacturer", "optional", "company name"],
  ["name", "optional", "a short description (made from the values when empty)"],
  ["ways", "splitter", "number of outputs, 2 to 16"],
  ["insertion_loss_db", "splitter, combiner, riser", "datasheet insertion loss in dB; for a splitter the loss of each output, the even split included (e.g. 3.4 for a 2-way); a riser with no part of its own: 0"],
  ["coupling_db", "coupler", "coupling in dB: the loss to the tap output (e.g. 10)"],
  ["through_loss_db", "coupler", "loss to the through output in dB (e.g. 1.1)"],
  ["inputs", "combiner", "number of inputs (default 2)"],
  ["outputs", "combiner", "number of outputs (default 1)"],
  ["max_power_w", "optional", "maximum average power in W"],
  ["freq_min_mhz", "optional", "lowest frequency of the datasheet in MHz"],
  ["freq_max_mhz", "optional", "highest frequency of the datasheet in MHz"],
  ["connector", "optional", "connector type, e.g. N female"],
  ["source", "optional", "where the values come from, e.g. the datasheet name and revision"],
];

const CABLE_FREQS = [450, 700, 900, 1800, 2100, 2600, 3500];
export const CABLE_COLUMNS = [
  ["model", "all", "the manufacturer's model number"],
  ["manufacturer", "optional", "company name"],
  ["name", "optional", 'a short description, e.g. 1/2" superflex feeder'],
  ["fixed_length_m", "optional", "for a jumper of fixed length, e.g. 1; empty for cable measured along the plan"],
  ["max_power_w", "optional", "maximum average power in W"],
  ["source", "optional", "where the values come from"],
  ["loss_<MHz>", "at least 2", "attenuation in dB per 100 m at that frequency: one column per frequency, e.g. loss_900, loss_1800 (empty where the datasheet gives none)"],
];

const quote = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (rows) => rows.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";

// Templates: the header and example rows (Excel opens them as they are).
export const partTemplateCsv = () =>
  csv([
    PART_COLUMNS.map(([c]) => c),
    ["splitter", "EXAMPLE-SP-2W", "Example Ltd", "2-way splitter", "2", "3.4", "", "", "", "", "300", "698", "3800", "N female", "Example datasheet rev 1 (replace this row)"],
    ["coupler", "EXAMPLE-CP-10dB", "Example Ltd", "10 dB coupler", "", "", "10", "1.1", "", "", "300", "698", "3800", "N female", "Example datasheet rev 1 (replace this row)"],
    ["combiner", "EXAMPLE-CM-21", "Example Ltd", "Combiner 2x1", "", "3.8", "", "", "2", "1", "100", "698", "3800", "4.3-10 female", "Example datasheet rev 1 (replace this row)"],
    ["riser", "EXAMPLE-FT-01", "Example Ltd", "Floor feed-through", "", "0.2", "", "", "", "", "300", "698", "3800", "N female", "Example datasheet rev 1 (replace this row)"],
  ]);
export const cableTemplateCsv = () =>
  csv([
    ["model", "manufacturer", "name", "fixed_length_m", "max_power_w", "source", ...CABLE_FREQS.map((f) => `loss_${f}`)],
    ["EXAMPLE-12", "Example Ltd", '1/2" superflex feeder', "", "", "Example datasheet rev 1 (replace this row)", "7.6", "9.3", "10.8", "16.0", "17.6", "19.8", "23.5"],
    ["EXAMPLE-78", "Example Ltd", '7/8" low-loss feeder', "", "1700", "Example datasheet rev 1 (replace this row)", "2.6", "3.3", "3.7", "5.5", "6.0", "6.7", "8.0"],
    ["EXAMPLE-J1", "Example Ltd", "Jumper 1 m", "1", "", "Example datasheet rev 1 (replace this row)", "7.6", "9.3", "10.8", "16.0", "17.6", "19.8", "23.5"],
  ]);

// CSV text to rows (quoted fields, "" inside quotes, commas or semicolons).
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const columnName = (h) => slug(h).replace(/-/g, "_");
const sameModel = (a, b) => slug(a) === slug(b);
export const GROUP_OF = { splitter: "splitters", coupler: "couplers", combiner: "inline", riser: "risers", cable: "cables" };
const EMPTY = () => ({ splitters: {}, couplers: {}, inline: {}, risers: {}, cables: {} });
const LOSS_COLUMN = /^loss_(\d{2,5})(_mhz)?$/;

// Which format a header row is: "parts", "cables" or null.
export function formatOf(header) {
  const cols = header.map(columnName);
  if (cols.includes("type") && cols.includes("model")) return "parts";
  if (cols.includes("model") && cols.filter((c) => LOSS_COLUMN.test(c)).length) return "cables";
  return null;
}

// the values that matter when comparing an entry with the one it replaces
const comparable = ({ id, imported, source, ...rest }) => JSON.stringify(rest); // eslint-disable-line no-unused-vars

// Rows (the header first) to catalogue entries. `existing`: the catalogue the
// project has now ({ splitters, couplers, inline, risers, cables }), so a model
// already there keeps its id and is updated instead of added again.
// returns { format, parts, added, updated, unchanged, count, errors: [text] }
export function partsFromRows(rows, sourceName = "imported file", existing = {}) {
  const parts = EMPTY();
  const errors = [];
  const out = { format: null, parts, added: 0, updated: 0, unchanged: 0, count: 0, errors };
  if (!rows.length) return { ...out, errors: ["The file is empty."] };
  const format = formatOf(rows[0]);
  if (!format)
    return {
      ...out,
      errors: [
        "The first row must be the column names of a template: the parts template (type, model, …) or the cable template (model, loss_900, loss_1800, …).",
      ],
    };
  out.format = format;
  const head = rows[0].map(columnName);
  const seen = new Map(); // group|model -> row it was first given on

  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (col) => String(cells[head.indexOf(col)] ?? "").trim();
    const numberOf = (col) => {
      const raw = get(col).replace(",", ".");
      return raw === "" ? null : Number(raw);
    };
    const type = format === "cables" ? "cable" : get("type").toLowerCase();
    const model = get("model");
    if (!model && (format === "cables" || !type)) return; // an empty row
    if (format === "parts" && (!GROUP_OF[type] || type === "cable"))
      return errors.push(`Row ${line}: type "${get("type")}" is not splitter, coupler, combiner or riser.`);
    if (!model) return errors.push(`Row ${line}: the model is missing.`);
    const bad = (col, why) => errors.push(`Row ${line} (${model}): ${col} ${why}.`);
    const group = GROUP_OF[type];
    const common = {
      model,
      ...(get("manufacturer") ? { manufacturer: get("manufacturer") } : {}),
      ...(get("connector") ? { connector: get("connector") } : {}),
      source: get("source") || `Imported from ${sourceName}`,
      imported: true,
    };
    for (const col of ["max_power_w", "freq_min_mhz", "freq_max_mhz", "fixed_length_m"]) {
      const v = numberOf(col);
      if (v !== null && !(v > 0)) return bad(col, "must be a number above 0");
    }
    const maxPowerW = numberOf("max_power_w");
    if (maxPowerW) common.maxPowerW = maxPowerW;
    let entry;
    if (type === "cable") {
      const table = head
        .map((c, k) => [LOSS_COLUMN.exec(c), k])
        .filter(([m]) => m)
        .map(([m, k]) => ({ freqMHz: Number(m[1]), raw: String(cells[k] ?? "").trim().replace(",", ".") }))
        .filter((x) => x.raw !== "")
        .map((x) => ({ freqMHz: x.freqMHz, loss: Number(x.raw) }))
        .sort((a, b) => a.freqMHz - b.freqMHz);
      if (table.some((x) => !(x.loss > 0))) return bad("loss columns", "must be numbers above 0 (dB per 100 m)");
      if (table.length < 2) return bad("loss columns", "need values at 2 or more frequencies");
      const fixed = numberOf("fixed_length_m");
      entry = { name: get("name") || model, lossDbPer100m: table, ...(fixed ? { fixedLengthM: fixed } : {}) };
    } else {
      const fMin = numberOf("freq_min_mhz"),
        fMax = numberOf("freq_max_mhz");
      if (fMin && fMax && fMin >= fMax) return bad("freq_min_mhz", "must be below freq_max_mhz");
      if (fMin) common.freqMinMHz = fMin;
      if (fMax) common.freqMaxMHz = fMax;
      if (type === "splitter") {
        const ways = numberOf("ways"),
          il = numberOf("insertion_loss_db");
        if (!(Number.isInteger(ways) && ways >= 2 && ways <= 16)) return bad("ways", "must be a whole number from 2 to 16");
        const even = 10 * Math.log10(ways);
        if (!(il >= even - 0.05)) return bad("insertion_loss_db", `must be at least the even split, ${even.toFixed(1)} dB for ${ways} outputs`);
        entry = { name: get("name") || `${ways}-way splitter`, ways, datasheetInsertionLossDb: il, excessLossDb: Math.max(0, il - even) };
      } else if (type === "coupler") {
        const c = numberOf("coupling_db"),
          t = numberOf("through_loss_db");
        if (!(c > 0 && c <= 40)) return bad("coupling_db", "must be a number from 0 to 40");
        if (!(t >= 0 && t < c)) return bad("through_loss_db", "must be 0 or more and below the coupling");
        entry = { name: get("name") || `${c} dB coupler`, couplingDb: c, tapLossDb: c, throughLossDb: t };
      } else if (type === "combiner") {
        const il = numberOf("insertion_loss_db"),
          ins = numberOf("inputs") ?? 2,
          outs = numberOf("outputs") ?? 1;
        if (!(il >= 0)) return bad("insertion_loss_db", "must be 0 or more");
        if (!(Number.isInteger(ins) && ins >= 1 && ins <= 8)) return bad("inputs", "must be a whole number from 1 to 8");
        if (!(Number.isInteger(outs) && outs >= 1 && outs <= 8)) return bad("outputs", "must be a whole number from 1 to 8");
        entry = { name: get("name") || `Combiner ${ins}x${outs}`, lossDb: il, inputs: ins, outputs: outs };
      } else {
        const il = numberOf("insertion_loss_db") ?? 0;
        if (!(il >= 0)) return bad("insertion_loss_db", "must be 0 or more");
        entry = { name: get("name") || "Riser", lossDb: il };
      }
    }
    // no second copy: the same model in the file, or already in the catalogue, keeps one entry
    const key = `${group}|${slug(model)}`;
    if (seen.has(key)) errors.push(`Row ${line}: ${model} is also on row ${seen.get(key)}; row ${line} is used.`);
    seen.set(key, line);
    const before = Object.values(existing[group] || {}).find((p) => sameModel(p.model || "", model));
    const id = before?.id || `imp-${type.slice(0, 2)}-${slug(model)}`;
    const next = { id, ...entry, ...common };
    parts[group][id] = next;
  });
  for (const group of Object.keys(parts))
    for (const [id, next] of Object.entries(parts[group])) {
      const before = existing[group]?.[id];
      if (!before) out.added++;
      else if (comparable(before) === comparable(next)) out.unchanged++;
      else out.updated++;
      out.count++;
    }
  return out;
}

// The project's cellular data with these parts added (same id: replaced).
export function addImportedParts(cellular, parts) {
  const cat = cellular.catalogue || {};
  const merged = { ...cat };
  for (const group of Object.keys(EMPTY())) merged[group] = { ...(cat[group] || {}), ...(parts[group] || {}) };
  return { ...cellular, catalogue: merged };
}
