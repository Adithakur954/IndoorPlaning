// Loader for the Wi-Fi capacity engine (Rust, compiled to WebAssembly; source in
// capacity/, built with `npm run capacity:build`).
//
// The module loads once, asynchronously (`capacityReady`); after that every call
// is synchronous. Requests and results are JSON. Only the parts of the plan the
// engine reads are sent, and a ray-traced prediction is sent once and reused
// while the same object is passed.

const WASM_URL = new URL("./capacity_core.wasm", import.meta.url);

let instance = null;
let loadError = null;
let lastCells = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function wasmBytes() {
  if (WASM_URL.protocol === "file:") {
    // Node (tests, scripts): read the file; the name is built at run time so
    // browser bundlers leave it alone.
    const fs = "node:fs/promises";
    const { readFile } = await import(/* @vite-ignore */ fs);
    return readFile(WASM_URL);
  }
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`capacity engine: HTTP ${res.status} loading ${WASM_URL}`);
  return res.arrayBuffer();
}

// Long runs (the load test) report progress through an imported function.
let progressHandler = null;
const imports = {
  env: {
    cap_progress: (done, total) => {
      try {
        progressHandler?.(done, total);
      } catch {
        // a failing listener must not stop the engine
      }
    },
  },
};

/** Called with (done, total) while a load test runs; null to stop. */
export const setCapacityProgress = (fn) => {
  progressHandler = fn;
};

async function load() {
  try {
    const { instance: inst } = await WebAssembly.instantiate(await wasmBytes(), imports);
    instance = inst;
    lastCells = null;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

/** Resolves when the engine can be called. */
export let capacityReady = load();
capacityReady.catch(() => {}); // reported by isCapacityReady / call()

export const isCapacityReady = () => instance !== null;
export const capacityLoadError = () => loadError;

function call(request) {
  if (!instance) {
    throw new Error(loadError ? `The capacity engine did not load: ${loadError.message}` : "The capacity engine is still loading.");
  }
  const ex = instance.exports;
  const input = encoder.encode(JSON.stringify(request));
  const ptr = ex.cap_alloc(input.length);
  new Uint8Array(ex.memory.buffer, ptr, input.length).set(input);
  let len;
  try {
    len = ex.cap_call(ptr, input.length);
  } catch (err) {
    // A trap leaves the instance unusable: load a fresh one for the next call.
    instance = null;
    capacityReady = load();
    capacityReady.catch(() => {});
    throw new Error(`The capacity engine stopped: ${err.message}`);
  }
  ex.cap_free(ptr, input.length);
  const out = new Uint8Array(ex.memory.buffer, ex.cap_result_ptr(), len);
  const result = JSON.parse(decoder.decode(out));
  if (result && typeof result === "object" && !Array.isArray(result) && typeof result.error === "string") {
    throw new Error(`capacity engine: ${result.error}`);
  }
  return result;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// What the engine reads from a plan.
export function enginePlan(plan) {
  return {
    floors: (plan.floors || []).map((f) => pick(f, ["id", "name"])),
    rooms: plan.rooms || [],
    sources: (plan.sources || []).filter((s) => s.kind === "wifi").map((s) => pick(s, ["id", "kind", "name", "floorId", "x", "z", "proposed"])),
    boundaries: (plan.boundaries || []).map((b) => pick(b, ["id", "floorId", "name", "points"])),
    furniture: (plan.furniture || []).map((f) => pick(f, ["id", "floorId", "kind", "name", "x", "z", "width", "depth"])),
  };
}

function cellsArg(cells) {
  if (!cells) return null;
  if (cells !== lastCells) {
    call({ op: "setCells", cells });
    lastCells = cells;
  }
  return "cached";
}

const request = (op, { plan, settings = {}, cells = null }) => call({ op, plan: enginePlan(plan), settings: settings || {}, cells: cellsArg(cells) });

/** The deterministic capacity result (expected loads). */
export const planWifiCapacity = (args) => request("plan", args);

/** The deterministic result when the assumptions are wrong. */
export const capacitySensitivity = (args) => request("sensitivity", args);

/** Individual users over many seeded iterations. Can take a while: in the
 * planner, call it through runMonteCarlo (capacityWorkerClient.js). */
export const monteCarloCapacity = (args) => request("monteCarlo", args);

/** The same APs under a rising number of users: breaking point, KPIs per
 * step and capacity heat maps. Takes longer still: call it through
 * runLoadTest (capacityWorkerClient.js). */
export const loadTestCapacity = (args) => request("loadTest", args);

/** The load test's heat maps and checks at any number of users. */
export const loadTestHeatmap = ({ plan, settings = {}, cells = null, users }) =>
  call({ op: "loadTestHeatmap", plan: enginePlan(plan), settings: settings || {}, cells: cellsArg(cells), users });

/** Every AP on a floor as seen from one position (distance, RSSI, SNR, rate),
 * strongest first: the signal the simulation uses there. */
export const capacityLinks = ({ plan, settings = {}, cells = null, floorId, x, z }) =>
  call({ op: "links", plan: enginePlan(plan), settings: settings || {}, cells: cellsArg(cells), floorId, x, z });

export const capacityMeta = () => call({ op: "meta" });

export const phyRateMbps = ({ standard = "wifi6", widthMHz = 80, streams = 2, snrDb }) =>
  call({ op: "phyRate", standard, widthMHz, streams, snrDb: Number.isFinite(snrDb) ? snrDb : null });

export const channelsFor = (band, widthMHz) => call({ op: "channelsFor", band, widthMHz });
