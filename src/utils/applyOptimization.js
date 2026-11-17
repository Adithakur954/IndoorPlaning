// Applying an optimisation result to a plan, and undoing it. Pure functions on
// the plan so they can be tested without the editor.
import { uid } from "../models/plan.js";

// result: the optimiser's result; fields: radio fields for new APs.
export function applyOptimization(plan, result, fields) {
  let sources = [...plan.sources];
  const removed = new Set(
    (result.existingActions || []).filter((a) => a.action === "remove").map((a) => a.id),
  );
  sources = sources.filter((s) => !removed.has(s.id));
  let n = sources.filter((s) => s.origin === "optimized").length;
  for (const rec of result.recommendations) {
    if (rec.existingId && rec.action !== "new") {
      sources = sources.map((s) =>
        s.id === rec.existingId
          ? { ...s, x: rec.planX, z: rec.planZ, floorId: rec.floorId, heightM: rec.heightM }
          : s,
      );
    } else {
      n += 1;
      sources.push({
        id: uid(),
        floorId: rec.floorId,
        kind: "wifi",
        name: `AP-opt-${n}`,
        origin: "optimized",
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
  // and the full original of every AP that was moved or removed
  const finalById = new Map(sources.map((s) => [s.id, s]));
  const previous = plan.optimizationBackup;
  const changed = new Map((previous?.changed || []).map((s) => [s.id, s]));
  for (const old of plan.sources)
    if (finalById.get(old.id) !== old && !changed.has(old.id)) changed.set(old.id, old);
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
  const { optimizationBackup, ...rest } = plan; // eslint-disable-line no-unused-vars
  return { ...rest, sources };
}
