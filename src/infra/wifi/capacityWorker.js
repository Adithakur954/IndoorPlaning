// Runs long capacity calculations (Monte Carlo, load test) off the page's main thread.
import { capacityReady, loadTestCapacity, loadTestHeatmap, monteCarloCapacity, setCapacityProgress } from "./capacityEngine.js";

const OPS = { monteCarlo: monteCarloCapacity, loadTest: loadTestCapacity, loadTestHeatmap };

self.onmessage = async (event) => {
  const { id, op = "monteCarlo", ...args } = event.data;
  try {
    await capacityReady;
    const run = OPS[op];
    if (!run) throw new Error(`unknown capacity job: ${op}`);
    setCapacityProgress((done, total) => self.postMessage({ id, progress: { done, total } }));
    const started = performance.now();
    const result = run(args);
    self.postMessage({ id, result, ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  } finally {
    setCapacityProgress(null);
  }
};
