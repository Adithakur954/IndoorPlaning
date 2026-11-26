// Asks for a design without freezing the page. Only the newest request matters: an
// older answer that arrives late is discarded. Without Web Workers (or if one cannot
// start) the design is calculated directly, so it always works.
import { designWifiCabling } from "./design.js";

let worker = null;
let failed = false;
let counter = 0;
const waiting = new Map();

function start() {
  if (worker || failed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./designWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const { id, design, error } = event.data;
      const job = waiting.get(id);
      if (!job) return;
      waiting.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(design);
    };
    worker.onerror = () => {
      // the worker could not run: finish what is waiting directly and stop using it
      failed = true;
      worker = null;
      for (const [, job] of waiting) job.fallback();
      waiting.clear();
    };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

// Resolves to { design } or { stale: true } when a newer request replaced this one.
export function requestDesign(input) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const direct = () => {
      try {
        resolve({ design: designWifiCabling(input) });
      } catch (e) {
        reject(e);
      }
    };
    const w = start();
    if (!w) return direct();
    // every older request is now out of date
    for (const [oldId, job] of waiting) {
      if (oldId < id) {
        waiting.delete(oldId);
        job.resolve({ stale: true });
      }
    }
    waiting.set(id, {
      resolve: (design) => resolve({ design }),
      reject,
      fallback: direct,
    });
    try {
      w.postMessage({ id, input });
    } catch {
      waiting.delete(id);
      direct();
    }
  }).then((r) => (r.stale || r.design ? r : r));
}
