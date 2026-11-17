// Usage: node scripts/export-scene.mjs <outDir> [projectId|sample]
// Writes the ray-tracing scene (scene.xml, meshes/, scene_config.json).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { initialPlan } from "../src/models/plan.js";
import { buildSceneFiles } from "../src/utils/sceneExport.js";
import { generateAllCandidates } from "../src/utils/apCandidates.js";
import { ION4I_PROFILE, channelCenterMHz } from "../src/config/apProfiles.js";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [outDir, source = "sample"] = args;
if (!outDir) {
  console.error(
    "Usage: node scripts/export-scene.mjs <outDir> [projectId|sample]",
  );
  process.exit(2);
}

const room = (
  id,
  floorId,
  name,
  x,
  z,
  width,
  depth,
  material = "concrete",
) => ({
  id,
  floorId,
  name,
  shape: "rectangle",
  x,
  z,
  width,
  depth,
  height: 3,
  material,
});
const samplePlan = () => ({
  ...initialPlan(),
  floors: [
    { id: "f1", name: "Level 1", elevation: 0 },
    { id: "f2", name: "Level 2", elevation: 3.2 },
  ],
  rooms: [
    room("a1", "f1", "Hall", 0, 0, 12, 8),
    room("b1", "f1", "Office", 12, 0, 8, 8, "brick"),
    room("a2", "f2", "Open space", 0, 0, 20, 8),
  ],
  doors: [
    {
      id: "d1",
      floorId: "f1",
      roomId: "a1",
      wallSide: "east",
      offset: 3,
      width: 1,
      height: 2,
    },
  ],
  windows: [
    {
      id: "w1",
      floorId: "f1",
      roomId: "a1",
      wallSide: "north",
      offset: 2,
      width: 3,
      height: 1.2,
      sillHeight: 1,
    },
  ],
  sources: [
    {
      id: "ap1",
      floorId: "f1",
      kind: "wifi",
      name: "AP-L1",
      x: 4,
      z: 4,
      heightM: 2.7,
      txPowerDbm: 20,
      freqMHz: 5000,
      bandwidthMHz: 20,
    },
    {
      id: "ap2",
      floorId: "f2",
      kind: "wifi",
      name: "AP-L2",
      x: 10,
      z: 4,
      heightM: 2.7,
      txPowerDbm: 20,
      freqMHz: 5000,
      bandwidthMHz: 20,
    },
  ],
});

// Representative benchmark: 4 floors of 40 x 24 m, a 5 x 3 grid of rooms per
// floor with doors and windows, 3 Wi-Fi APs per floor.
const benchmarkPlan = () => {
  const plan = {
    ...initialPlan(),
    floors: [],
    rooms: [],
    doors: [],
    windows: [],
    sources: [],
  };
  for (let f = 0; f < 4; f++) {
    const floorId = `f${f + 1}`;
    plan.floors.push({
      id: floorId,
      name: `Level ${f + 1}`,
      elevation: f * 3.2,
    });
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 3; j++) {
        const id = `${floorId}-r${i}${j}`;
        plan.rooms.push(
          room(
            id,
            floorId,
            id,
            i * 8,
            j * 8,
            8,
            8,
            (i + j) % 2 ? "brick" : "drywall",
          ),
        );
        plan.doors.push({
          id: `${id}-d`,
          floorId,
          roomId: id,
          wallSide: "south",
          offset: 3.5,
          width: 1,
          height: 2,
        });
        plan.windows.push({
          id: `${id}-w`,
          floorId,
          roomId: id,
          wallSide: "north",
          offset: 2,
          width: 3,
          height: 1.2,
          sillHeight: 1,
        });
      }
    for (const x of [8, 20, 32])
      plan.sources.push({
        id: `ap-${floorId}-${x}`,
        floorId,
        kind: "wifi",
        name: `AP-${floorId}-${x}`,
        x,
        z: 12,
        heightM: 2.7,
        txPowerDbm: 20,
        freqMHz: 5000,
        bandwidthMHz: 20,
      });
  }
  return plan;
};

let plan;
if (source === "sample") plan = samplePlan();
else if (source === "benchmark") plan = benchmarkPlan();
else {
  const { projectStore } = await import("../server/repositories/projectRepository.js");
  const store = projectStore();
  const project = store.get(source);
  store.close();
  if (!project) throw new Error(`Project ${source} not found`);
  plan = { ...initialPlan(), ...(project.plan ?? project) };
}

const { files, config, warnings } = await buildSceneFiles(plan);
for (const [name, data] of Object.entries(files)) {
  const path = join(outDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
console.log(
  `wrote ${Object.keys(files).length} files to ${outDir}; sha256 ${config.contentSha256}`,
);
for (const w of warnings) console.log("warning:", w);

// --job: also write an AP placement optimisation job (candidates on walls, plus
// ceilings with --ceiling) for the Python worker: node ... <dir> benchmark --job
if (flags.has("--job")) {
  const floorIds = plan.floors.map((f) => f.id);
  const mounting = flags.has("--ceiling") ? ["wall", "ceiling"] : ["wall"];
  const { valid, stats } = generateAllCandidates(plan, floorIds, { mounting });
  const band = "5";
  const radio = ION4I_PROFILE.bands[band];
  const job = {
    mode: "optimize",
    scene_dir: resolve(outDir),
    output_dir: resolve(outDir, "opt-out"),
    cache_dir: resolve(outDir, "opt-cache"),
    candidates: valid,
    band,
    profile: {
      txPowerDbm: radio.txPowerDbm,
      gainDbi: radio.gainDbi,
      freqMHz: channelCenterMHz(band, radio.channel),
    },
    threshold_dbm: -67,
    target_coverage_pct: 95,
    existing_handling: "ignore",
    resolution_m: 1.0,
  };
  await writeFile(join(outDir, "optimize-job.json"), JSON.stringify(job));
  console.log(`job: ${valid.length} candidates (${stats.rejected} rejected)`, stats.byReason);
}
