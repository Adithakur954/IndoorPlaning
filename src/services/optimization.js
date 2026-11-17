// Client for the AP placement optimisation endpoints of the Rust service.
import { inside } from "../utils/geometry.js";

// A dev-proxy 500/502/504 with no JSON body means the service itself is down.
const SERVICE_DOWN =
  "Cannot reach the simulation service. Start it with `npm run sim:service` (port 3002) and try again.";
const call = (url, init) =>
  fetch(url, init).catch(() => {
    throw Error(SERVICE_DOWN);
  });
const json = async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 402) window.dispatchEvent(new Event("license-required"));
    if (body?.error) throw Error(body.error);
    throw Error(
      response.status >= 500
        ? SERVICE_DOWN
        : `Request failed (${response.status})`,
    );
  }
  return body ?? {};
};

export const submitOptimization = async (
  sceneId,
  settings,
  profile,
  candidates,
  fresh = false,
) =>
  json(
    await call("/api/optimizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sceneId, settings, profile, candidates, fresh }),
    }),
  );

export const getOptimization = async (id) =>
  json(await call(`/api/optimizations/${id}`));

export const cancelJob = async (id) =>
  json(await call(`/api/jobs/${id}/cancel`, { method: "POST" }));

export const getOptimizationMap = async (id, file) =>
  json(await call(`/api/optimizations/${id}/maps/${encodeURIComponent(file)}`));

// Restore every band independently so one missing result does not hide the rest.
export async function loadOptimizationComparison(saved) {
  const refs = saved.runs || { [saved.settingsUsed.band]: saved };
  const loaded = await Promise.allSettled(Object.entries(refs).map(async ([band, ref]) => {
    const status = await getOptimization(ref.jobId);
    if (status.status !== "done") throw Error("no longer available");
    const maps = Object.fromEntries(await Promise.all(status.result.maps.map(async (m) => [
      m.floorId, await getOptimizationMap(ref.jobId, m.file.split("/").pop()),
    ])));
    return [band, { ...ref, result: status.result, maps, cached: true }];
  }));
  const runs = Object.fromEntries(loaded.filter((r) => r.status === "fulfilled").map((r) => r.value));
  const selected = Object.values(runs).find((r) => r.jobId === saved.jobId) || Object.values(runs)[0];
  if (!selected) throw loaded.find((r) => r.status === "rejected")?.reason || Error("no longer available");
  return { runs, selected, partial: loaded.some((r) => r.status === "rejected") };
}

// Polls until the job ends. `onProgress` gets { stage, fraction, message }.
export async function waitForOptimization(
  id,
  { onProgress, signal, intervalMs = 700 } = {},
) {
  for (;;) {
    if (signal?.aborted) throw Error("Cancelled");
    const status = await getOptimization(id);
    if (status.progress) onProgress?.(status.progress, status.status);
    if (status.status === "done") return status;
    if (status.status === "cancelled") throw Error("Cancelled");
    if (status.status === "failed")
      throw Error(status.error || "Optimisation failed");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Heatmap cells ("before" or "after") of one floor from a worker map. With
// `coverage`, each cell is shifted by its own threshold so one red/green split
// at `referenceDbm` shows coverage even when rooms have different targets.
export function optimizationCells(map, which, { coverage, referenceDbm, metric, snrThreshold = 10 }) {
  const grid = which === "before" ? map.beforeDbm : map.afterDbm;
  const snrGrid = which === "before" ? map.beforeSnrDb : map.afterSnrDb;
  const showSnr = metric === "snr" && !coverage;
  if (showSnr && !snrGrid) return []; // Legacy results must never display dBm as SNR.
  const cells = [];
  map.zCentersM.forEach((z, iy) =>
    map.xCentersM.forEach((x, ix) => {
      if (!map.inTarget[iy][ix]) return;
      const value = grid[iy][ix];
      const dbm = value === null ? -150 : value;
      const snr = snrGrid?.[iy]?.[ix] ?? null;
      const threshold = map.thresholdDbm[iy][ix];
      cells.push({
        x,
        z,
        step: map.cellSizeM,
        dbm: coverage ? dbm - threshold + referenceDbm : showSnr ? (snr ?? -20) : dbm,
        rawDbm: dbm,
        snr,
        hasSnrMap: Boolean(snrGrid),
        thresholdDbm: showSnr ? snrThreshold : referenceDbm,
        covered: showSnr ? snr != null && snr >= snrThreshold : dbm >= threshold,
      });
    }),
  );
  return cells;
}

// Is this plan point inside the building (rooms or boundary)? Used to place
// markers; exported for tests.
export const insideAny = (x, z, areas) => areas.some((a) => inside(x, z, a));
