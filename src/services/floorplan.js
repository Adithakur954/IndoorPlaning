import { api } from "./api.js";

// Floor-plan image -> building geometry, done by the local worker (no cloud).

async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function uploadFloorplan(file) {
  return api("/floorplan/uploads", {
    method: "POST",
    body: JSON.stringify({ name: file.name, dataBase64: await toBase64(file) }),
  });
}

export const runReconstruction = (id, { scale, options }) =>
  api(`/floorplan/jobs/${id}/run`, {
    method: "POST",
    body: JSON.stringify({ scale, options }),
  });

export const fileUrl = (id, name) => `/api/floorplan/jobs/${id}/files/${name}`;

export async function waitForReconstruction(id, { onStatus, timeoutMs = 600_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const status = await api(`/floorplan/jobs/${id}`);
    onStatus?.(status);
    if (status.status === "done") return status.result;
    if (status.status === "failed")
      throw new Error(status.error || "Reconstruction failed");
    if (Date.now() - start > timeoutMs)
      throw new Error("Reconstruction is taking too long; it keeps running in the background.");
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

// The deskewed drawing as a data URL, so it can be saved with the plan.
export async function fetchDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the processed drawing.");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error("Could not read the processed drawing."));
    reader.readAsDataURL(blob);
  });
}

export const removeReconstruction = (id) =>
  api(`/floorplan/jobs/${id}`, { method: "DELETE" }).catch(() => null);
