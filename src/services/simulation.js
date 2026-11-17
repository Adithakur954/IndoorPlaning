// Client for the Rust simulation service (service/), proxied under /api/scenes
// and /api/simulations. Heavy work runs in the Sionna RT worker, not here.
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

export const uploadScene = async (blob) =>
  json(
    await call("/api/scenes", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: blob,
    }),
  );

export const submitSimulation = async (sceneId, settings, fresh = false) =>
  json(
    await call("/api/simulations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sceneId, settings, fresh }),
    }),
  );

export const getSimulation = async (id) =>
  json(await call(`/api/simulations/${id}`));

export const getMap = async (id, file) =>
  json(await call(`/api/simulations/${id}/maps/${encodeURIComponent(file)}`));

// Polls until the job is done or failed. `onStatus` receives each phase.
export async function waitForSimulation(
  id,
  { onStatus, intervalMs = 1500, signal } = {},
) {
  for (;;) {
    if (signal?.aborted) throw Error("Cancelled");
    const status = await getSimulation(id);
    onStatus?.(status.status);
    if (status.status === "done") return status;
    if (status.status === "failed")
      throw Error(status.error || "Simulation failed");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Converts a worker radio map into heatmap cells for the floor's rooms. Cells
// outside every room are dropped, so statistics describe the building only.
// `skip` lists rooms that are not receiver areas (storage, plant rooms): their
// cells are left out of the map and the statistics.
export function mapToCells(map, rooms, thresholdDbm, skip = []) {
  const cells = [];
  map.zCentersM.forEach((z, iy) =>
    map.xCentersM.forEach((x, ix) => {
      if (!rooms.some((room) => inside(x, z, room))) return;
      if (skip.some((room) => inside(x, z, room))) return;
      const value = map.bestDbm[iy][ix];
      const dbm = value === null ? -150 : value;
      // SNR (dB) of the same cell; null when the run predates the SNR map or
      // no signal reaches the cell
      const snr = map.bestSnrDb?.[iy]?.[ix];
      cells.push({
        x,
        z,
        step: map.cellSizeM,
        dbm,
        snr: Number.isFinite(snr) ? snr : null,
        hasSnrMap: Boolean(map.bestSnrDb),
        thresholdDbm,
        covered: dbm >= thresholdDbm,
        sourceName: map.accessPoints[map.bestApIndex[iy][ix]]?.name,
      });
    }),
  );
  return cells;
}
