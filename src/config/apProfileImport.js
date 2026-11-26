// New AP models for the Network & RF page: checked manual entries, and models
// read from a JSON or CSV file. Nothing here touches the plan; the caller gives
// each accepted model an id and stores it in plan.apProfiles.
import { BANDS } from "./apProfiles.js";

export const CHANNEL_WIDTHS = [20, 40, 80, 160, 320];
const CHANNEL_RANGE = { "2.4": [1, 14], 5: [32, 177], 6: [1, 233] };
const RADIO_FIELDS = ["txPowerDbm", "maxTxPowerDbm", "gainDbi", "channel", "widthMHz"];
export const CSV_COLUMNS = ["name", "model", "antenna", "note", "band", ...RADIO_FIELDS];

export const blankRadio = (band) => ({
  txPowerDbm: 20,
  maxTxPowerDbm: null,
  gainDbi: 4,
  channel: band === "2.4" ? 6 : band === "6" ? 5 : 36,
  widthMHz: band === "2.4" ? 20 : 40,
});

export const blankModel = () => ({
  name: "",
  model: "",
  antenna: "omni",
  note: "",
  bands: { "2.4": blankRadio("2.4"), 5: blankRadio("5") },
});

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";
const normBand = (b) => {
  const s = String(b ?? "").trim().toLowerCase().replace(/\s*ghz$/, "");
  if (s === "2.4" || s === "2" || s === "2.45") return "2.4";
  if (s === "5" || s === "5.0") return "5";
  if (s === "6" || s === "6e" || s === "6.0") return "6";
  return null;
};

// Problems with one model; an empty list means it can be added.
export function validateModel(m) {
  const errors = [];
  if (isBlank(m?.name)) errors.push("Name is required.");
  const bands = Object.keys(m?.bands || {});
  if (!bands.length) errors.push("Add at least one band (2.4, 5 or 6 GHz).");
  for (const band of bands) {
    const r = m.bands[band] || {},
      at = `${band} GHz`;
    if (!BANDS.includes(band)) {
      errors.push(`Unknown band "${band}". Use 2.4, 5 or 6.`);
      continue;
    }
    const tx = Number(r.txPowerDbm);
    if (isBlank(r.txPowerDbm) || !Number.isFinite(tx) || tx < -10 || tx > 36)
      errors.push(`${at}: transmit power must be a number from -10 to 36 dBm.`);
    if (!isBlank(r.maxTxPowerDbm) && !Number.isFinite(Number(r.maxTxPowerDbm)))
      errors.push(`${at}: max transmit power must be a number or empty.`);
    const gain = Number(r.gainDbi);
    if (isBlank(r.gainDbi) || !Number.isFinite(gain) || gain < -10 || gain > 30)
      errors.push(`${at}: antenna gain must be a number from -10 to 30 dBi.`);
    const ch = Number(r.channel),
      [lo, hi] = CHANNEL_RANGE[band];
    if (!Number.isInteger(ch) || ch < lo || ch > hi)
      errors.push(`${at}: channel must be a whole number from ${lo} to ${hi}.`);
    if (!CHANNEL_WIDTHS.includes(Number(r.widthMHz)))
      errors.push(`${at}: width must be one of ${CHANNEL_WIDTHS.join(", ")} MHz.`);
  }
  return errors;
}

// The stored shape: numbers as numbers, an empty max power as null.
export function normalizeModel(m) {
  const bands = {};
  for (const [band, r] of Object.entries(m.bands || {}))
    bands[band] = {
      txPowerDbm: Number(r.txPowerDbm),
      maxTxPowerDbm: isBlank(r.maxTxPowerDbm) ? null : Number(r.maxTxPowerDbm),
      gainDbi: Number(r.gainDbi),
      channel: Number(r.channel),
      widthMHz: Number(r.widthMHz),
    };
  return {
    name: String(m.name).trim(),
    model: isBlank(m.model) ? String(m.name).trim() : String(m.model).trim(),
    antenna: isBlank(m.antenna) ? "omni" : String(m.antenna).trim(),
    mounting: Array.isArray(m.mounting) ? m.mounting : ["ceiling"],
    ...(isBlank(m.note) ? {} : { note: String(m.note).trim() }),
    ...(Array.isArray(m.sizeMm) ? { sizeMm: m.sizeMm } : {}),
    bands,
  };
}

// one JSON object with the stored shape, an array of them, or { models: [...] }
function fromJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data?.apProfiles)
        ? data.apProfiles
        : [data];
  return list.map((m) => {
    const bands = {};
    for (const [b, r] of Object.entries(m?.bands || {})) bands[normBand(b) ?? b] = r;
    return { ...m, bands };
  });
}

// split one CSV line, with "quoted, values" and "" for a quote
function csvCells(line) {
  const out = [];
  let cur = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";" || c === "\t") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// one row per model and band; rows with the same name are one model
function fromCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw Error("The CSV needs a header row and at least one model row.");
  const head = csvCells(lines[0]).map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h.toLowerCase(), i]));
  for (const need of ["name", "band"])
    if (col[need] === undefined) throw Error(`The CSV header has no "${need}" column.`);
  const byName = new Map();
  lines.slice(1).forEach((line, k) => {
    const cells = csvCells(line);
    const get = (key) => cells[col[key.toLowerCase()]] ?? "";
    const name = get("name");
    const band = normBand(get("band"));
    const m = byName.get(name) || {
      name,
      model: get("model"),
      antenna: get("antenna"),
      note: get("note"),
      bands: {},
      row: k + 2,
    };
    const radio = Object.fromEntries(RADIO_FIELDS.map((f) => [f, get(f)]));
    m.bands[band ?? `${get("band")} (row ${k + 2})`] = radio;
    byName.set(name, m);
  });
  return [...byName.values()];
}

// Read a file's text as models. Every model comes back with its own errors, so
// the good ones can be added and the others fixed.
export function parseModelFile(text, fileName = "") {
  const looksJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text);
  let raw;
  try {
    raw = looksJson ? fromJson(text) : fromCsv(text);
  } catch (error) {
    return { format: looksJson ? "json" : "csv", models: [], error: error.message };
  }
  return {
    format: looksJson ? "json" : "csv",
    models: raw.map((m) => {
      const errors = validateModel(m);
      return { raw: m, errors, model: errors.length ? null : normalizeModel(m) };
    }),
  };
}

// Templates to download, filled with one example model.
const EXAMPLE = {
  name: "Example AP (Wi-Fi 6, 2x2)",
  model: "EX-AP6",
  antenna: "omni",
  note: "Values from the datasheet",
  bands: {
    "2.4": { txPowerDbm: 20, maxTxPowerDbm: 23, gainDbi: 4, channel: 6, widthMHz: 20 },
    5: { txPowerDbm: 20, maxTxPowerDbm: 26, gainDbi: 5, channel: 36, widthMHz: 80 },
  },
};
export const jsonTemplate = () => JSON.stringify([EXAMPLE], null, 2) + "\n";
export const csvTemplate = () =>
  [
    CSV_COLUMNS.join(","),
    ...Object.entries(EXAMPLE.bands).map(([band, r]) =>
      [
        `"${EXAMPLE.name}"`,
        EXAMPLE.model,
        EXAMPLE.antenna,
        `"${EXAMPLE.note}"`,
        band,
        ...RADIO_FIELDS.map((f) => r[f] ?? ""),
      ].join(","),
    ),
  ].join("\n") + "\n";
