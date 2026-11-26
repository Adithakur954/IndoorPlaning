// Long capacity calculations from the planner (Monte Carlo, load test): each
// kind runs in its own Web Worker so the page stays responsive and one kind
// never cancels the other. A new run replaces a run of the same kind that is
// still going. Where workers are not available (Node), it runs in place.
import { capacityReady, enginePlan, loadTestCapacity, loadTestHeatmap, monteCarloCapacity, setCapacityProgress } from "./capacityEngine.js";

const IN_PLACE = { monteCarlo: monteCarloCapacity, loadTest: loadTestCapacity, loadTestHeatmap };
const slots = {}; // op -> { worker, pending }
let nextId = 1;

function stop(op) {
  const slot = slots[op];
  slot?.worker?.terminate();
  delete slots[op];
}

function runJob(op, { plan, settings = {}, cells = null, ...extra }, onProgress) {
  const message = { ...extra, op, plan: enginePlan(plan), settings: settings || {}, cells: cells || null };
  if (typeof Worker === "undefined") {
    return capacityReady.then(() => {
      setCapacityProgress(onProgress || null);
      try {
        const started = performance.now();
        const result = IN_PLACE[op](message);
        return { result, ms: Math.round(performance.now() - started) };
      } finally {
        setCapacityProgress(null);
      }
    });
  }
  if (slots[op]?.pending) {
    // the engine cannot be interrupted mid-run: drop that worker
    slots[op].pending.reject(new DOMException("Replaced by a newer run", "AbortError"));
    stop(op);
  }
  const slot = (slots[op] ??= { worker: new Worker(new URL("./capacityWorker.js", import.meta.url), { type: "module" }), pending: null });
  const id = nextId++;
  return new Promise((resolve, reject) => {
    slot.pending = { id, reject };
    slot.worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.progress) {
        onProgress?.(data.progress.done, data.progress.total);
        return;
      }
      slot.pending = null;
      if (data.error) reject(new Error(data.error));
      else resolve({ result: data.result, ms: data.ms });
    };
    slot.worker.onerror = (e) => {
      slot.pending = null;
      stop(op);
      reject(new Error(e.message || "The capacity worker failed."));
    };
    slot.worker.postMessage({ id, ...message });
  });
}

function cancel(op) {
  const slot = slots[op];
  if (!slot?.pending) return;
  slot.pending.reject(new DOMException("Cancelled", "AbortError"));
  stop(op);
}

/**
 * @returns {Promise<{ result: object, ms: number }>} rejects with an AbortError
 * when a newer run replaces it.
 */
export const runMonteCarlo = (args) => runJob("monteCarlo", args);
export const cancelMonteCarlo = () => cancel("monteCarlo");

/** The load test, with `onProgress(done, total)` while it runs. */
export const runLoadTest = (args, onProgress) => runJob("loadTest", args, onProgress);
export const cancelLoadTest = () => cancel("loadTest");

/** Heat maps and checks at any number of users: `{ plan, settings, cells, users }`. */
export const runLoadTestHeatmap = (args) => runJob("loadTestHeatmap", args);
