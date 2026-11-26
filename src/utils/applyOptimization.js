// Applying an optimisation result to a plan, and undoing it. Pure functions on
// the plan so they can be tested without the editor.
import { uid } from "../models/plan.js";

// A radio of another band within this distance of a new AP is the same physical (dual-band) AP: the new radio
// is put exactly at its position instead of a second AP a metre or two away.
export const DUAL_BAND_MERGE_M = 6;
const bandOf = (s) => String(s?.band ?? "");
const baseName = (name) => String(name || "").replace(/ ((?:2.4|5|6) GHz)$/, "");
const withBand = (name, band) => (band ? `${baseName(name)} (${band} GHz)` : baseName(name));

// result: the optimiser's result; fields: radio fields for new APs (fields.band = the band that was optimised).
//
// Applying is repeatable: the optimiser's APs of this band from an earlier Apply (on the floors of this run) are
// REPLACED by the new ones, never stacked on top of them, so pressing Apply twice changes nothing. A new radio
// within DUAL_BAND_MERGE_M of an optimised AP of another band joins it as one dual-band AP: same position, same
// device id, names "AP-opt-3 (2.4 GHz)" and "AP-opt-3 (5 GHz)".
export function applyOptimization(plan, result, fields) {
  const band = bandOf(fields);
  let sources = [...plan.sources];
  const removed = new Set(
    (result.existingActions || []).filter((a) => a.action === "remove").map((a) => a.id),
  );
  sources = sources.filter((s) => !removed.has(s.id));
  const floors = new Set([
    ...(result.settings?.floor_ids || []),
    ...(result.recommendations || []).map((r) => r.floorId),
  ]);
  const replaced = new Set(
    sources
      .filter((s) => s.origin === "optimized" && bandOf(s) === band && (!floors.size || floors.has(s.floorId)))
      .map((s) => s.id),
  );
  sources = sources.filter((s) => !replaced.has(s.id));

  // base names already taken by optimised APs that stay (another band, another floor)
  const takenBase = new Set(sources.filter((s) => s.origin === "optimized").map((s) => baseName(s.name)));
  let n = 0;
  const nextName = () => {
    do n += 1;
    while (takenBase.has(`AP-opt-${n}`));
    takenBase.add(`AP-opt-${n}`);
    return `AP-opt-${n}`;
  };
  const partnerUsed = new Set();
  for (const rec of result.recommendations || []) {
    if (rec.existingId && rec.action !== "new") {
      sources = sources.map((s) =>
        s.id === rec.existingId
          ? { ...s, x: rec.planX, z: rec.planZ, floorId: rec.floorId, heightM: rec.heightM }
          : s,
      );
      continue;
    }
    // the closest optimised radio of another band on this floor, not yet paired with a radio of this band
    let partner = null;
    for (const s of sources) {
      if (s.origin !== "optimized" || bandOf(s) === band || s.floorId !== rec.floorId || partnerUsed.has(s.id)) continue;
      if (sources.some((o) => o.origin === "optimized" && bandOf(o) === band && o.deviceId && o.deviceId === s.deviceId)) continue;
      const d = Math.hypot(s.x - rec.planX, s.z - rec.planZ);
      if (d <= DUAL_BAND_MERGE_M && (!partner || d < partner.d)) partner = { s, d };
    }
    if (partner) {
      const p = partner.s;
      partnerUsed.add(p.id);
      const deviceId = p.deviceId || p.id;
      sources = sources.map((s) =>
        s.id === p.id ? { ...s, deviceId, name: withBand(s.name, bandOf(s)) } : s,
      );
      sources.push({
        id: uid(),
        floorId: rec.floorId,
        kind: "wifi",
        name: withBand(p.name, band),
        origin: "optimized",
        deviceId,
        x: p.x,
        z: p.z,
        heightM: p.heightM,
        azimuthDeg: 0,
        beamwidthDeg: 120,
        sectors: [],
        mounting: p.mounting || rec.kind,
        notes: [`dual-band: the ${band} GHz radio of the AP the ${bandOf(p)} GHz run placed here (${partner.d.toFixed(1)} m from this run's spot)`],
        ...fields,
      });
    } else {
      const id = uid();
      sources.push({
        id,
        floorId: rec.floorId,
        kind: "wifi",
        name: nextName(),
        origin: "optimized",
        deviceId: id,
        x: rec.planX,
        z: rec.planZ,
        heightM: rec.heightM,
        azimuthDeg: 0,
        beamwidthDeg: 120,
        sectors: [],
        mounting: rec.kind,
        ...fields,
      });
    }
  }
  // what was there before, so Apply can be undone: the new APs to delete again
  // and the full original of every AP that was moved or removed (an earlier Apply's own APs are not "originals")
  const finalById = new Map(sources.map((s) => [s.id, s]));
  const previous = plan.optimizationBackup;
  const earlierAdded = new Set(previous?.addedIds || []);
  const changed = new Map((previous?.changed || []).map((s) => [s.id, s]));
  for (const old of plan.sources)
    if (finalById.get(old.id) !== old && !changed.has(old.id) && !earlierAdded.has(old.id)) changed.set(old.id, old);
  const oldIds = new Set(plan.sources.map((s) => s.id));
  return {
    ...plan,
    sources,
    optimizationBackup: {
      createdAt: new Date().toISOString(),
      addedIds: [
        ...(previous?.addedIds || []),
        ...sources.filter((s) => !oldIds.has(s.id)).map((s) => s.id),
      ],
      changed: [...changed.values()],
    },
  };
}

// New APs are deleted; moved or removed ones return with all their settings.
export function undoOptimization(plan) {
  const backup = plan.optimizationBackup;
  if (!backup) return plan;
  const added = new Set(backup.addedIds);
  const restored = new Map(backup.changed.map((s) => [s.id, s]));
  const sources = plan.sources.filter((s) => !added.has(s.id)).map((s) => restored.get(s.id) || s);
  const have = new Set(sources.map((s) => s.id));
  for (const s of backup.changed) if (!have.has(s.id)) sources.push(s);
  const { optimizationBackup, optimizationApplied, ...rest } = plan; // eslint-disable-line no-unused-vars
  return { ...rest, sources };
}
