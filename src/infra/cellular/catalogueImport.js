// Importing antenna models into a project's cellular catalogue. A catalogue file
// is JSON: { "antennas": [entry, ...] } (or just the list). One entry per antenna
// model, with one row per datasheet band:
//   { id, name, vendor?, model?, itemCode?, type: "omni" | "panel" | "other",
//     maxPowerW?, polarization?, source?,
//     bands: [{ fromMHz, toMHz, gainDbi, hBeamwidthDeg, vBeamwidthDeg, frontToBackDb? }] }
// Every number comes from the vendor's datasheet; the file says where (source).
// Measured patterns (.msi) are attached to an entry afterwards (patternFiles).

import { parseMsi } from "./antennaPattern.js";

const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

export function validateAntenna(raw, index = 0) {
  const where = raw?.name || raw?.id || `entry ${index + 1}`;
  const errors = [];
  const id = String(raw?.id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) errors.push(`${where}: "id" must be 1-80 letters, digits, ".", "_" or "-"`);
  if (!String(raw?.name ?? "").trim()) errors.push(`${where}: "name" is required`);
  const type = raw?.type || "other";
  if (!["omni", "panel", "other"].includes(type)) errors.push(`${where}: "type" must be omni, panel or other`);
  const bands = Array.isArray(raw?.bands) ? raw.bands : [];
  if (!bands.length) errors.push(`${where}: at least one band row is required`);
  const rows = bands.map((b, i) => {
    const row = {
      fromMHz: num(b.fromMHz),
      toMHz: num(b.toMHz),
      gainDbi: num(b.gainDbi),
      hBeamwidthDeg: num(b.hBeamwidthDeg ?? (type === "omni" ? 360 : NaN)),
      vBeamwidthDeg: num(b.vBeamwidthDeg),
    };
    if (b.frontToBackDb !== undefined && b.frontToBackDb !== null && b.frontToBackDb !== "")
      row.frontToBackDb = num(b.frontToBackDb);
    const bad = (m) => errors.push(`${where}, band ${i + 1}: ${m}`);
    if (!(row.fromMHz > 0 && row.toMHz > row.fromMHz)) bad("fromMHz and toMHz must be a frequency range");
    if (!Number.isFinite(row.gainDbi) || row.gainDbi < -10 || row.gainDbi > 30) bad("gainDbi must be -10 to 30");
    if (!(row.hBeamwidthDeg > 0 && row.hBeamwidthDeg <= 360)) bad("hBeamwidthDeg must be 1 to 360");
    if (!(row.vBeamwidthDeg > 0 && row.vBeamwidthDeg <= 360)) bad("vBeamwidthDeg must be 1 to 360");
    if ("frontToBackDb" in row && !(row.frontToBackDb > 0 && row.frontToBackDb <= 60)) bad("frontToBackDb must be 1 to 60");
    return row;
  });
  const entry = {
    id,
    name: String(raw?.name ?? "").trim(),
    type,
    bands: rows,
    gainDbi: rows.length ? Math.max(...rows.map((r) => r.gainDbi)) : 0, // the link budget's single value (step 4 uses the band's)
    ...(raw?.vendor ? { vendor: String(raw.vendor) } : {}),
    ...(raw?.model ? { model: String(raw.model) } : {}),
    ...(raw?.itemCode ? { itemCode: String(raw.itemCode) } : {}),
    ...(raw?.polarization ? { polarization: String(raw.polarization) } : {}),
    ...(Number.isFinite(num(raw?.maxPowerW)) ? { maxPowerW: num(raw.maxPowerW) } : {}),
    source: String(raw?.source || "imported catalogue file"),
  };
  return { entry, errors };
}

// Parses a catalogue file. Returns { antennas: { id: entry }, errors }; nothing is
// imported when any entry is wrong, so a half-read file never ends up in a project.
export function parseCatalogue(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { antennas: {}, errors: [`The file is not JSON: ${e.message}`] };
  }
  const list = Array.isArray(data) ? data : data?.antennas;
  if (!Array.isArray(list) || !list.length) return { antennas: {}, errors: ['The file has no "antennas" list.'] };
  const antennas = {};
  const errors = [];
  list.forEach((raw, i) => {
    const { entry, errors: e } = validateAntenna(raw, i);
    errors.push(...e);
    if (antennas[entry.id]) errors.push(`"${entry.id}" is listed twice`);
    antennas[entry.id] = entry;
  });
  return errors.length ? { antennas: {}, errors } : { antennas, errors: [] };
}

// Adds (or replaces, by frequency) a measured pattern file on an antenna entry.
export function withPatternFile(entry, text, fileName) {
  const msi = parseMsi(text, fileName);
  const others = (entry.patternFiles || []).filter((p) => Math.abs(p.freqMHz - msi.freqMHz) > 0.5);
  return { ...entry, patternFiles: [...others, msi].sort((a, b) => a.freqMHz - b.freqMHz) };
}
