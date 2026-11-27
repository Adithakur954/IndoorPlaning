// The cellular (IBS/DAS) part of a plan: plan.cellular. It is separate from
// everything Wi-Fi: Wi-Fi code never reads it, and the cellular code never
// changes Wi-Fi access points. The antennas themselves are plan.sources with
// kind "cellular" (so they are placed, moved and drawn like any source).
//
// plan.cellular = {
//   version: 1,
//   catalogue: { antennas: { id: entry } },   // models the project imported, besides the built-in ones
//   carriers: [{ id, name, operator, technology: "LTE"|"NR", band, freqMHz, bandwidthMHz, scsKHz, sectorIds }],
//   sectors:  [{ id, name }],
// A carrier is sent by every sector in sectorIds (null: all of them); each sector is its own cell on that
// carrier, so two sectors on one frequency interfere with each other where both reach.
//   settings: { ... see DEFAULT_SETTINGS },
//   prediction: { jobId, carrierId, at, settings } | undefined,
// }
// The antenna models are the built-in ones (builtInAntennas.js, from the supplied
// datasheets) plus any the project imported; carriers and targets are per project.

import { DEFAULT_CATALOGUE } from "./engine/catalogue.js";
import { BUILT_IN_ANTENNAS } from "./builtInAntennas.js";
import { bandCentreMHz, carrierProblems } from "./bands.js";
import { bandProblems } from "./antennaPattern.js";

export const DEFAULT_SETTINGS = {
  resolutionM: 1, // receiver grid step
  receiverHeightM: 1.5, // handset height above the floor
  maxDepth: 5,
  samplesPerTx: 1_000_000,
  diffraction: false,
  ueNoiseFigureDb: 7, // handset receiver noise figure, for SINR
  defaultAntennaPowerDbm: 15, // power at a new antenna's port until the DAS network sets it
  defaultAntennaModelId: null, // antenna model of a new antenna (null: the built-in omni)
  rsrpTargetDbm: -95,
  sinrTargetDb: 5,
  // colour bands of the maps: edges low to high, one colour per band (one more
  // than the edges, lowest first). RSRP follows the supplied design's legend.
  rsrpEdgesDbm: [-120, -114.78, -105.05, -99.78, -94.91, -84.78, -79.65, -74.52, -69.65, -60],
  rsrpColors: null, // null: RSRP_LEGEND.colors when the edges have its length
  sinrEdgesDb: [0, 5, 10, 20],
  sinrColors: null,
  // how the map is coloured: "smooth" blends the colours between the edges (as
  // the design tool's legend), "bands" gives one flat colour per band
  mapStyle: "smooth",
};

// RSRP colour scale of the supplied design (10 bands, dBm), lowest band first.
export const RSRP_LEGEND = {
  edges: DEFAULT_SETTINGS.rsrpEdgesDbm,
  colors: [
    "#2b2b2b", // < -120
    "#454545", // -120 .. -114.78
    "#3939c5",
    "#6187fa",
    "#50fffd",
    "#4dff4f",
    "#fffe54",
    "#fdd64e",
    "#fb8545",
    "#fa2f3f",
    "#fb34fb", // >= -60
  ],
};
// the simple 5-band scale (the first default)
export const SIMPLE_RSRP_EDGES = [-105, -95, -85, -75];

const HIGH_IS_GOOD = ["#dc2626", "#f97316", "#eab308", "#84cc16", "#16a34a"];

// n colours from bad to good: the 5-colour scale, interpolated when more bands are asked for
function scale(n) {
  if (n <= HIGH_IS_GOOD.length) return HIGH_IS_GOOD.slice(HIGH_IS_GOOD.length - n);
  const rgb = HIGH_IS_GOOD.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (rgb.length - 1);
    const a = Math.floor(t);
    const b = Math.min(a + 1, rgb.length - 1);
    const f = t - a;
    return `#${rgb[a].map((v, k) => Math.round(v + (rgb[b][k] - v) * f).toString(16).padStart(2, "0")).join("")}`;
  });
}

// Colour bands of a cellular map ("rsrp" or "sinr") from the project's edges.
export function mapRanges(plan, metric) {
  const s = cellularOf(plan).settings;
  const unit = metric === "sinr" ? "dB" : "dBm";
  const sinr = metric === "sinr";
  const edges = (sinr ? s.sinrEdgesDb : s.rsrpEdgesDbm).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const own = sinr ? s.sinrColors : s.rsrpColors;
  const colors =
    Array.isArray(own) && own.length === edges.length + 1
      ? own
      : !sinr && edges.length === RSRP_LEGEND.edges.length
        ? RSRP_LEGEND.colors
        : scale(edges.length + 1);
  return colors.map((color, i) => {
    const min = i === 0 ? -Infinity : edges[i - 1];
    const max = i === edges.length ? Infinity : edges[i];
    const label = i === 0 ? `< ${max} ${unit}` : i === edges.length ? `≥ ${min} ${unit}` : `${min} to ${max} ${unit}`;
    return { min, max, color, label, smooth: s.mapStyle !== "bands" };
  });
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// A project saved with the first default RSRP scale (never edited) gets the
// current default, so it shows the design legend too.
function upgradeSettings(s) {
  const old = Array.isArray(s.rsrpEdgesDbm) && s.rsrpEdgesDbm.join() === SIMPLE_RSRP_EDGES.join() && !s.rsrpColors;
  return old ? { ...s, rsrpEdgesDbm: DEFAULT_SETTINGS.rsrpEdgesDbm } : s;
}

export function cellularOf(plan) {
  const c = plan?.cellular || {};
  return {
    version: 1,
    catalogue: { antennas: { ...(c.catalogue?.antennas || {}) } },
    carriers: Array.isArray(c.carriers) ? c.carriers : [],
    sectors: Array.isArray(c.sectors) && c.sectors.length ? c.sectors : [{ id: "sector-1", name: "Sector 1" }],
    // DAS cables between parts (plan sources of kind "das") and antennas, see das.js
    cables: Array.isArray(c.cables) ? c.cables : [],
    settings: upgradeSettings({ ...DEFAULT_SETTINGS, ...(c.settings || {}) }),
    prediction: c.prediction,
  };
}

// The project's antenna models: the built-in ones and the project's imported
// ones (an import with the same id replaces the built-in entry). An old generic
// placeholder stays available only while an antenna still uses it.
export function antennaModels(plan) {
  const used = {};
  for (const s of plan?.sources || [])
    if (s.kind === "cellular" && DEFAULT_CATALOGUE.antennas[s.antennaModelId])
      used[s.antennaModelId] = DEFAULT_CATALOGUE.antennas[s.antennaModelId];
  return { ...BUILT_IN_ANTENNAS, ...used, ...cellularOf(plan).catalogue.antennas };
}

export const cellularAntennas = (plan, floorId) =>
  (plan?.sources || []).filter((s) => s.kind === "cellular" && (!floorId || s.floorId === floorId));

export function newCarrier(technology = "NR", band = "n78") {
  const nr = technology === "NR";
  return {
    id: uid(),
    name: "",
    operator: "",
    technology,
    band,
    freqMHz: bandCentreMHz(technology, band) ?? 3500,
    bandwidthMHz: 20,
    scsKHz: nr ? 30 : 15,
    sectorIds: null,
  };
}

export function newSector(existing) {
  const n = existing.length + 1;
  return { id: uid(), name: `Sector ${n}` };
}

// Fields a new cellular antenna starts with (it is a plan source of kind "cellular").
// The model a new antenna gets: the one chosen in Network & RF, else the first omni.
export function defaultAntennaModel(plan) {
  const models = antennaModels(plan);
  return (
    models[cellularOf(plan).settings.defaultAntennaModelId] ||
    Object.values(models).find((m) => m.type === "omni") ||
    Object.values(models)[0] ||
    null
  );
}

export function newAntennaFields(plan) {
  const c = cellularOf(plan);
  const model = defaultAntennaModel(plan);
  return {
    kind: "cellular",
    name: "Antenna",
    technology: null,
    antennaModelId: model?.id || null,
    sectorId: c.sectors[0]?.id || "sector-1",
    // a panel goes on a wall facing the room, an omni on the ceiling
    mount: model?.type === "panel" ? "wall" : "ceiling",
    azimuthDeg: 0,
    downtiltDeg: 0,
    inputPowerDbm: c.settings.defaultAntennaPowerDbm,
  };
}

// Everything that stops a cellular prediction of one carrier, in words.
export function predictionProblems(plan, carrierId) {
  const c = cellularOf(plan);
  const carrier = c.carriers.find((x) => x.id === carrierId);
  if (!carrier) return ["Add a band in Network & RF (e.g. 3500 MHz) and choose it."];
  const out = carrierProblems(carrier).map((m) => `Band: ${m}.`);
  const antennas = cellularAntennas(plan).filter((a) => plan.floors.some((f) => f.id === a.floorId));
  if (!antennas.length) out.push("Place at least one antenna on the plan.");
  const models = antennaModels(plan);
  for (const a of antennas) {
    for (const m of bandProblems(models[a.antennaModelId], carrier.freqMHz)) out.push(`${a.name}: ${m}.`);
    if (!Number.isFinite(Number(a.inputPowerDbm))) out.push(`${a.name}: enter the power at the antenna port.`);
  }
  return out;
}
