// End-to-end check of the frontend client against the running Rust service:
//   node scripts/e2e-prediction.mjs [http://127.0.0.1:3002]
// Builds the sample plan's scene, runs a simulation and prints a summary.
import JSZip from "jszip";
import { initialPlan } from "../src/models/plan.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";
import {
  getMap,
  mapToCells,
  submitSimulation,
  uploadScene,
  waitForSimulation,
} from "../src/services/simulation.js";

const base = process.argv[2] || "http://127.0.0.1:3002";
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? base + url : url, init);

const room = (id, floorId, name, x, z, width, depth) => ({
  id, floorId, name, shape: "rectangle", x, z, width, depth, height: 3, material: "concrete",
});
const plan = {
  ...initialPlan(),
  floors: [{ id: "f1", name: "Level 1", elevation: 0 }, { id: "f2", name: "Level 2", elevation: 3.2 }],
  rooms: [room("a", "f1", "Hall", 0, 0, 12, 8), room("b", "f1", "Office", 12, 0, 8, 8), room("c", "f2", "Open", 0, 0, 20, 8)],
  sources: [
    { id: "ap1", floorId: "f1", kind: "wifi", name: "AP-L1", x: 4, z: 4, heightM: 2.7, txPowerDbm: 20, freqMHz: 5000 },
    { id: "ap2", floorId: "f2", kind: "wifi", name: "AP-L2", x: 10, z: 4, heightM: 2.7, txPowerDbm: 20, freqMHz: 5000 },
  ],
};

const { files } = await buildSceneFiles(plan);
const zip = new JSZip();
for (const [name, data] of Object.entries(files)) zip.file(name, data);
const bytes = await zip.generateAsync({ type: "uint8array" });

const { sceneId } = await uploadScene(bytes);
const settings = { device: "auto", resolutionM: 1, maxDepth: 5, samplesPerTx: 1000000, weakThresholdDbm: -75 };
const job = await submitSimulation(sceneId, settings);
console.log("job", job);
const status = await waitForSimulation(job.id, { onStatus: (s) => console.log(" status:", s) });
for (const floor of status.result.floors) {
  const map = await getMap(job.id, floor.file.split("/").pop());
  const cells = mapToCells(map, plan.rooms.filter((r) => r.floorId === floor.floorId), -75);
  const weak = cells.filter((c) => !c.covered).length;
  console.log(floor.floorId, `${cells.length} cells in rooms, ${weak} weak`, `device=${status.result.backend.device}`);
}
