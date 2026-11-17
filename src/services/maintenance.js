// Housekeeping calls to the simulation service: replaced results, the model
// version and the row cache.
const call = (url, init) =>
  fetch(url, init).catch(() => {
    throw Error(
      "Cannot reach the simulation service. Start it with `npm run sim:service` (port 3002) and try again.",
    );
  });

const json = async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw Error(body?.error || `Request failed (${response.status})`);
  return body ?? {};
};

export const deleteJob = async (id) =>
  json(await call(`/api/jobs/${id}`, { method: "DELETE" }));

// Version of the simulation code and engine a new run would use.
export const getModelVersion = async () =>
  (await json(await call("/api/model-version"))).modelVersion;

// Asks the service to remove results no project refers to any more.
export const cleanupResults = async () =>
  json(await call("/api/maintenance/cleanup", { method: "POST" }));

export const getCacheInfo = async () => json(await call("/api/cache"));

export const clearCache = async () =>
  json(await call("/api/cache/clear", { method: "POST" }));
