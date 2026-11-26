// The cellular (IBS/DAS) part of a plan: plan.cellular. It is separate from
// everything Wi-Fi: Wi-Fi code never reads it, and the cellular code never
// changes Wi-Fi access points. The antennas themselves are plan.sources with
// kind "cellular" (so they are placed, moved and drawn like any source).
//
// plan.cellular = {
//   version: 1,
//   catalogue: { antennas: { id: entry } },   // the project's parts (imported or typed), over the defaults
//   carriers: [{ id, name, operator, technology: "LTE"|"NR", band, freqMHz, bandwidthMHz, scsKHz, sectorIds }],
//   sectors:  [{ id, name }],
// A carrier is sent by every sector in sectorIds (null: all of them); each sector is its own cell on that
// carrier, so two sectors on one frequency interfere with each other where both reach.
//   settings: { ... see DEFAULT_SETTINGS },
//   prediction: { jobId, carrierId, at, settings } | undefined,
// }
// No value here belongs to one client: every number is entered or imported per project.

import { DEFAULT_CATALOGUE } from "./engine/catalogue.js";
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
  rsrpTargetDbm: -95,
  sinrTargetDb: 5,
  // colour band edges of the maps (low to high); editable per project
  rsrpEdgesDbm: [-105, -95, -85, -75],
  sinrEdgesDb: [0, 5, 10, 20],
};

const HIGH_IS_GOOD = ["#dc2626", "#f97316", "#eab308", "#84cc16", "#16a34a"];

// Colour bands of a cellular map ("rsrp" or "sinr") from the project's edges.
export function mapRanges(plan, metric) {
  const s = cellularOf(plan).settings;
  const unit = metric === "sinr" ? "dB" : "dBm";
  const edges = (metric === "sinr" ? s.sinrEdgesDb : s.rsrpEdgesDbm).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const colors = HIGH_IS_GOOD.slice(HIGH_IS_GOOD.length - edges.length - 1);
  return colors.map((color, i) => {
    const min = i === 0 ? -Infinity : edges[i - 1];
    const max = i === edges.length ? Infinity : edges[i];
    const label = i === 0 ? `< ${max} ${unit}` : i === edges.length ? `≥ ${min} ${unit}` : `${min} to ${max} ${unit}`;
    return { min, max, color, label };
  });
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function cellularOf(plan) {
  const c = plan?.cellular || {};
  return {
    version: 1,
    catalogue: { antennas: { ...(c.catalogue?.antennas || {}) } },
    carriers: Array.isArray(c.carriers) ? c.carriers : [],
    sectors: Array.isArray(c.sectors) && c.sectors.length ? c.sectors : [{ id: "sector-1", name: "Sector 1" }],
    settings: { ...DEFAULT_SETTINGS, ...(c.settings || {}) },
    prediction: c.prediction,
  };
}

// The project's antenna models: its own entries over the built-in generic ones.
export function antennaModels(plan) {
  return { ...DEFAULT_CATALOGUE.antennas, ...cellularOf(plan).catalogue.antennas };
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
export function newAntennaFields(plan) {
  const c = cellularOf(plan);
  const models = antennaModels(plan);
  const first = Object.values(models).find((m) => m.type === "omni") || Object.values(models)[0];
  return {
    kind: "cellular",
    name: "Antenna",
    technology: null,
    antennaModelId: first?.id || null,
    sectorId: c.sectors[0]?.id || "sector-1",
    mount: "ceiling",
    azimuthDeg: 0,
    downtiltDeg: 0,
    inputPowerDbm: c.settings.defaultAntennaPowerDbm,
  };
}

// Everything that stops a cellular prediction of one carrier, in words.
export function predictionProblems(plan, carrierId) {
  const c = cellularOf(plan);
  const carrier = c.carriers.find((x) => x.id === carrierId);
  if (!carrier) return ["Add a carrier (operator, band, frequency and bandwidth) and choose it."];
  const out = carrierProblems(carrier).map((m) => `Carrier: ${m}.`);
  const antennas = cellularAntennas(plan).filter((a) => plan.floors.some((f) => f.id === a.floorId));
  if (!antennas.length) out.push("Place at least one antenna on the plan.");
  const models = antennaModels(plan);
  for (const a of antennas) {
    for (const m of bandProblems(models[a.antennaModelId], carrier.freqMHz)) out.push(`${a.name}: ${m}.`);
    if (!Number.isFinite(Number(a.inputPowerDbm))) out.push(`${a.name}: enter the power at the antenna port.`);
  }
  return out;
}
