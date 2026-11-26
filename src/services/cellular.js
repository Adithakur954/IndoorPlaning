// Client for the cellular (IBS/DAS) prediction of the simulation service. A
// separate route and worker from the Wi-Fi prediction; the run's status and maps
// are read the same way (simulation.js).
const json = async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 402) window.dispatchEvent(new Event("license-required"));
    throw Error(
      body?.error ||
        (response.status >= 500
          ? "Cannot reach the simulation service. Start it with `npm run sim:service` (port 3002) and try again."
          : `Request failed (${response.status})`),
    );
  }
  return body ?? {};
};

export const submitCellularPrediction = async (sceneId, request, fresh = false) =>
  json(
    await fetch("/api/cellular/predictions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sceneId, ...request, fresh }),
    }).catch(() => {
      throw Error("Cannot reach the simulation service. Start it with `npm run sim:service` (port 3002) and try again.");
    }),
  );

// Whether the license includes a separately sold module (development mode includes all).
export async function licensedFeatures() {
  try {
    const response = await fetch("/api/license/status", { cache: "no-store" });
    if (!response.ok) return [];
    const status = await response.json();
    return ["active", "development"].includes(status.status) && Array.isArray(status.features) ? status.features : [];
  } catch {
    return [];
  }
}
