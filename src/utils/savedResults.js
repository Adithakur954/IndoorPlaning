// A project keeps the latest prediction and optimisation comparison (all bands):
// references in plan.savedResults, not the map data itself.
// The data stays in the simulation service's data folder; a new run replaces the
// reference and the service's files for the old one.
import { deleteJob } from "../services/maintenance.js";

// Everything about the plan that changes a simulation. A saved result whose
// fingerprint differs from the current plan is out of date.
export const planStamp = (plan) =>
  JSON.stringify([
    plan.floors,
    plan.rooms,
    plan.boundaries,
    plan.doors,
    plan.windows,
    plan.interiorWalls,
    plan.sources,
    plan.wallTypes,
    plan.wallThickness,
    plan.materialOverrides,
  ]);

// The building only (no access points): what every band's result depends on.
export const buildingStamp = (plan) =>
  JSON.stringify([
    plan.floors,
    plan.rooms,
    plan.boundaries,
    plan.doors,
    plan.windows,
    plan.interiorWalls,
    plan.wallTypes,
    plan.wallThickness,
    plan.materialOverrides,
  ]);

// What ONE band's optimisation depends on: the building and that band's own APs. Another band's APs do not
// change it (applying the 2.4 GHz result leaves the 5 GHz result valid), and neither do the APs an Apply of
// the optimiser added (origin "optimized"): applying a result does not make that result out of date.
export const bandStamp = (plan, band) =>
  JSON.stringify([
    buildingStamp(plan),
    (plan.sources || [])
      .filter((s) => s.kind === "wifi" && String(s.band ?? "") === String(band) && s.origin !== "optimized")
      .map((s) => [s.id, s.floorId, s.x, s.z, s.heightM, s.txPowerDbm, s.antennaGainDbi, s.freqMHz, s.channel, s.bandwidthMHz]),
  ]);

// Points the project at the new run and removes the old run's files.
export const savedJobIds = (reference) => [...new Set([
  ...(typeof reference === "string" ? [reference] : [reference?.jobId]),
  ...Object.values(reference?.runs || {}).map((run) => run.jobId),
].filter(Boolean))];

export function replaceSavedResult(mutate, slot, reference, previousReference) {
  mutate((p) => ({
    ...p,
    savedResults: { ...(p.savedResults || {}), [slot]: reference },
  }));
  const keep = new Set(savedJobIds(reference));
  for (const id of savedJobIds(previousReference))
    if (!keep.has(id)) deleteJob(id).catch(() => {});
}

// "The saved result is gone" (deleted, cleaned up) versus "the service is down".
export const isMissingResult = (error) =>
  /unknown|not found|no longer/i.test(error?.message || "");

export const timeLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};
