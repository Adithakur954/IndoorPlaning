# Ray-traced Wi-Fi prediction (Sionna RT)

Physics-based received-power prediction for the planner's building, using
NVIDIA Sionna RT (Apache-2.0). No drive-test data, calibration or training is
required. Results are **estimates**, not measurements and not guaranteed accurate.

```text
Browser (React)                    Rust service (service/)            Python worker (worker/)
  Network & RF panel                 POST /api/scenes                   python -m sionna_worker job.json
  src/utils/sceneExport.js  --zip--> validate + unpack, cache by hash   Sionna RT 2.x on Dr.Jit
  src/services/simulation.js <-poll- POST /api/simulations -> queue --> radio maps (GPU or CPU)
  2D/3D heatmap, floor by floor      GET  /api/simulations/{id}[/maps/{file}]
```

* **Scene export** (`src/utils/sceneExport.js`) builds the walls, door/window
  openings, slabs and ceiling from the same code the 3D view uses
  (`src/utils/wallPieces.js`), PLY meshes, a Mitsuba `scene.xml` with ITU-R
  materials, and `scene_config.json` (APs, floors, receiver planes, assumptions,
  content hash). `node scripts/export-scene.mjs <dir> [projectId|sample|benchmark]`
  writes the same files from the command line.
* **Rust service** validates the upload (size, zip-slip, structure), queues jobs
  (one at a time by default), runs the worker as a subprocess with a timeout, and
  caches finished maps by `sha256(scene) + numerical settings`. CPU and GPU give
  the same maps for the same seed, so the device is not part of the cache key.
* **Python worker** loads the scene, applies per-object material thickness, groups
  APs by frequency (APs on different frequencies do not combine), and writes
  per-AP, best-server and total maps per floor plus `result.json`.

## In the editor

* **Run prediction** (header) opens the right sidebar with the settings (device,
  resolution, ray depth, samples per AP) and the run button. The same panel is on
  Network & RF.
* **Legend** (top-right of the workspace) lists the prediction bands and the
  building-structure symbols. The bands are the measurement logs' threshold bands
  (RSSI when RSSI is the selected KPI, otherwise RSRP), so predictions and log
  dots use the same colours; "weak" is the top of the first (red) band.
* **Boundary** tool: click the outline of the building on a floor, then Finish
  boundary. It becomes the exterior wall (material and height editable by
  selecting it), the slab and ceiling then cover the whole footprint (halls and
  corridors that are not rooms), and the heatmap covers it. A room wall lying on
  the boundary is merged into it, with its doors and windows. Without a boundary
  the building is just the rooms, as before.

## Saved results: only the latest run is kept

* A project keeps **one** saved prediction and **one** saved optimisation
  (`plan.savedResults`). It stores a reference (job id, time, plan fingerprint,
  settings), not the data; the maps stay in the service's data folder.
* When a project is opened, the saved results are loaded again; nothing has to be
  re-run. A result is marked **outdated** if the plan changed after the run (rooms,
  walls, doors, windows, boundaries, APs, wall materials or thickness), and when
  the simulation model changed since the run.
* A new run **replaces** the previous one: the reference changes only after the new
  run succeeded, and the old run's files are then deleted. A failed run keeps the
  last good result.
* Results no project refers to (a deleted project, a replaced run) are removed when
  the service starts and right after a project is deleted. Runs younger than two
  minutes are kept because their project may not have saved the reference yet.
* **Model version** (`worker/sionna_worker/version.py`): a hash of the worker's
  code plus the Sionna RT, Mitsuba and Dr.Jit versions. It is part of every job id
  and every cached row, so after any change to the simulation code or engine the
  same inputs are simulated again, and cached rows of older versions are deleted.
  `GET /api/model-version` shows the current one; each result records its own.
* **Recompute everything** (checkbox next to the Run buttons) ignores the saved
  result and the row cache for that run.
* The row cache (per-AP signal rows that make reruns fast) is capped by
  `CACHE_MAX_MB` (default 500 MB, oldest deleted first), shown in the Optimise APs
  panel with a **Clear cache** button. Saved results do not depend on it.

## Walls, rooms and materials

* **One wall per stretch of line.** Rooms side by side, a room inside a building
  shell and a room against the boundary share walls. `src/utils/wallGraph.js`
  merges every wall segment that lies on the same line (within 3 cm) into one
  wall, with the doors and windows of all the rooms it serves, so a shared wall is
  counted once in the 3D view and in the ray-tracing export. The boundary's
  material wins on a wall it shares with a room; if two rooms disagree about the
  material of a shared wall the export warns and uses the first.
* **Overlap warnings** are only for rooms that really overlap (partly or
  identical). Rooms that touch, or that sit completely inside another room, are
  not overlaps; nested rooms are listed as "Rooms inside rooms" and the inner room
  gets no second floor slab. If the outer room is really the building outline,
  use **Use as building boundary** in its properties.
* **Wall thickness** (Property > Wall materials, or Floor properties) changes the
  3D walls, the 2D line weight and the thickness given to the simulator. A
  material can have its own thickness.
* **Manual wall losses** (Property > Wall materials). Each of the six materials
  keeps its ITU-R P.2040 default until you enter a value:
  * *Loss (dB)*: the loss of one wall of that material at right angles, for its
    thickness, at the simulated frequency. The worker converts it into the
    conductivity that gives exactly that loss (`worker/sionna_worker/materials.py`,
    exact single-slab formula, checked against the planner's copy of it in tests)
    and reports the loss it achieved. Values below the loss of a lossless slab of
    that thickness cannot be reached and are flagged.
  * *Permittivity and conductivity*: used as given (replace the loss value).
  * Walls only lose signal; there is no wall "gain". AP antenna gain is part of
    the AP profile. The quick estimate also uses the loss value for that material.
  Default losses through a 0.2 m wall at 5 GHz: drywall 8.5 dB, wood 6.6, glass
  6.4, brick 6.2, concrete 25.3 (metal blocks the signal).

## AP placement optimisation

**Optimise APs** (editor header) finds how many APs a threshold needs and where to
mount them. **Mode A** (Run prediction) shows your existing APs and never changes
them. **Mode B** (Optimise APs) keeps its result separate until you press
**Apply to plan** (new APs are tagged `optimized`; a moved existing AP is
moved instead of duplicated; "Remove applied APs" undoes it).

How it works (all numbers come from simulation, nothing is hard-coded):

1. **Candidates** (`src/utils/apCandidates.js`): wall positions along room walls,
   the building boundary and interior walls (on the room side, offset from the
   wall) and a grid on ceilings. Positions are rejected, with a reason shown on the
   plan, near corners, doors and windows, on walls lower than the mounting height,
   in excluded rooms ("AP mounting" in the room properties), on walls marked not
   mountable, and next to furniture. Spacing, height and clearances are settings.
2. **Receiver grid** (`worker/sionna_worker/grid.py`): per floor at the device
   height, only inside rooms or the boundary, each cell weighted by its area (and
   an optional room weight). Rooms and floors can be excluded and rooms can have
   their own threshold.
3. **Screening**: when there are more candidates than the shortlist (120 by
   default), all candidates are ranked with a *coarse* Sionna RT run (2 m grid,
   100 000 rays, depth 3). This is approximate and only chooses which candidates
   get the full simulation; every room keeps its best few candidates.
4. **Full simulation**: the shortlist is ray traced at the chosen resolution into a
   candidate-coverage matrix, in GPU-friendly batches. Each candidate's row is
   cached on disk (key: scene hash, position, EIRP, frequency, grid and ray
   settings, seed; oldest files are evicted above `CACHE_MAX_MB`), so changing the
   threshold, target, budget or existing-AP handling does not re-simulate.
5. **Optimiser** (`optimizer.py`, pure NumPy): a cell is covered when at least *k*
   distinct APs reach its threshold; powers of different APs are never added.
   Greedy weighted set cover, then swap refinement, then removal of APs the target
   does not need; fixed existing APs count as already placed; a minimum distance
   between new APs is enforced. It reports each AP's marginal gain, per-floor and
   per-room coverage, the largest uncovered zones and the best coverage achievable
   with the available positions. If the target is unreachable it says so and does
   not claim 100 %. The result is a good heuristic answer, not a proven minimum.

AP profile and threshold are chosen per run in the sidebar. The ion4i entry is a
template filled from the HFCL datasheet and every value is editable. The profile's
gain is applied as EIRP (the simulated antenna is isotropic) and the plan's
receiver gain is added to the result.

Service endpoints (in addition to the prediction ones): `POST /api/optimizations`
`{sceneId, settings, profile, candidates}`, `GET /api/optimizations/{id}` (status,
progress while running, result when done), `GET /api/optimizations/{id}/maps/{file}`,
`POST /api/jobs/{id}/cancel`. The queue is bounded (`MAX_QUEUED_JOBS`, default 8).
Command line: `node scripts/export-scene.mjs <dir> benchmark --job` then
`python -m sionna_worker <dir>/optimize-job.json` from `worker/`.

### Optimisation benchmark (measured here, 2026-10-27)

Same machine as above. Scene: 4 floors of 40x24 m, 15 rooms per floor, 620 valid
wall candidates (220 rejected next to doors/windows), existing APs ignored,
5 GHz, -67 dBm, target 95 %. `python benchmark_optimize.py samples/benchmark-4floor`
reproduces it.

| Case | Wall time | Screening | Full ray tracing | Optimiser | Peak RAM | Peak VRAM (above idle) | Result |
|---|---|---|---|---|---|---|---|
| GPU, 1 m grid, 1 M rays | 4.2 s | 1.9 s | 0.9 s | 0.01 s | 451 MB | ~0.4 GB | 7 APs, 97.8 % |
| GPU, same job again (rows cached) | 3.4 s | 1.7 s | 0.3 s | 0.01 s | 392 MB | ~0.4 GB | same |
| GPU, 0.5 m grid, 4 M rays | 7.6 s | 1.9 s | 4.4 s | 0.01 s | 492 MB | ~0.4 GB | 7 APs, 97.7 % |
| CPU, 4 threads, 1 m grid, 1 M rays | 117 s | 35 s | 80 s | 0.01 s | 331 MB | n/a | 7 APs, 97.8 % |

The very first GPU run after installation took about 14 s while GPU kernels were
compiled. The CPU row limits threads only; it is not a real 4 vCPU / 6 GB host, so
benchmark there before promising anything. Larger buildings, more candidates and
finer grids cost more; the service rejects more than 5 000 candidates and the
worker caps the matrix size (`shortlist_max` shrinks automatically).

### Limits of the optimiser

* Results are estimates under the model's assumptions: ITU-R materials, assumed
  thicknesses, a 20 cm concrete slab between floors (this strongly affects how
  many floors one AP reaches), isotropic antennas, no interference or channel
  reuse, no people or unmodelled furniture.
* Monte-Carlo ray tracing is noisy near the threshold: cells within 1-2 dB of it
  can change with the seed or ray count. Use the "accurate" preset for final plans.
* Ceiling mounting uses the same omni model; a ceiling AP's real pattern differs.
* Candidates are screened with coarse ray tracing; a good position that screening
  ranks poorly can be missed. Raise `shortlist_max` when in doubt.

## Install

Requirements: Python 3.10+, Rust 1.80+, Node 20.19+. A CUDA GPU is optional.

```powershell
# Worker
cd worker
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # Linux: .venv/bin/python

# CPU backend only: Dr.Jit needs the LLVM shared library.
#   Windows: conda create -p worker/.llvm -c conda-forge llvmdev   (found automatically)
#            or set DRJIT_LIBLLVM_PATH to LLVM-C.dll
#   Linux:   apt install llvm   (or set DRJIT_LIBLLVM_PATH to libLLVM.so)
# GPU: an NVIDIA driver recent enough for your GPU (CUDA/OptiX come from the driver).

# App, API and simulation service
cd ..
npm run dev
```

Service environment: `SIM_PORT` (3002), `SIM_DATA_DIR` (`../data/simulations`),
`WORKER_DIR` (`../worker`), `WORKER_PYTHON`, `SIM_CONCURRENCY` (1),
`JOB_TIMEOUT_SECS` (1800), `MAX_UPLOAD_MB` (50).

Worker settings (`resolutionM` 0.1-10, `maxDepth` 0-20, `samplesPerTx`,
`weakThresholdDbm`, `device` auto|gpu|cpu, `seed`, `cpuThreads`) are validated by
both the service and the worker. `device: auto` uses the GPU when a real CUDA
kernel runs, otherwise the CPU.

## Tests

```powershell
npm test                                          # scene export (3 older Excel tests fail independently)
cd service; cargo test                            # API validation, zip safety, cache key
cd worker; .venv\Scripts\python -m unittest discover -s tests -t .   # incl. physics checks
node scripts/e2e-prediction.mjs                   # client -> service -> worker (service must run)
```

## Benchmark (measured here, 2026-10-27)

Machine: RTX 5070 Ti 16 GB, 24 threads, Windows 11; sionna-rt 2.2.0, mitsuba 3.9.1,
drjit 1.5.0. Scene: `node scripts/export-scene.mjs <dir> benchmark` - 4 floors of
40x24 m, 15 rooms/floor with doors and windows, 3 APs/floor at 5 GHz.
`python benchmark.py samples/benchmark-4floor` reproduces the table.

| Device | Resolution | Depth | Samples/AP | Solve (4 floors) | Process RSS* |
|---|---|---|---|---|---|
| GPU | 1.0 m | 3 | 1 M | 1.6 s | ~430 MB (+~0.5 GB VRAM) |
| GPU | 0.5 m | 5 | 1 M | 1.6 s | ~430 MB |
| GPU | 0.5 m | 5 | 4 M | 1.7 s | ~420 MB |
| CPU, 4 threads | 1.0 m | 3 | 1 M | 6.8 s | ~290 MB |
| CPU, 4 threads | 1.0 m | 5 | 1 M | 9.2 s | ~290 MB |
| CPU, 4 threads | 0.5 m | 5 | 1 M | 9.2 s | ~290 MB |
| CPU, 4 threads | 0.5 m | 5 | 4 M | 31.7 s | ~290 MB |

\* Sampled before and after each solve, so it can understate a transient peak.
"CPU, 4 threads" limits threads only. It was **not** run on a real 4 vCPU / 6 GB
host, so treat it as an indication, and benchmark on the target server before
promising performance. Larger buildings, finer grids, more APs and more samples
will cost more; the service rejects maps above 1 M cells.

## Assumptions and limitations

* Output is predicted **received power (dBm)** at 1.5 m (default) from each AP's
  transmit power, not a vendor RSSI. Bandwidth affects only noise/SINR, which is
  not reported. Channel and bandwidth are not stored on APs yet.
* Isotropic vertically polarised antennas (the planner's directional patterns are
  not applied). No fading, people or unmodelled furniture (furniture is optional,
  as wooden boxes). Doors are modelled closed.
* ITU-R P.2040 materials with assumed thicknesses (`scene_config.json`), not
  calibrated. Walls are single surfaces carrying a thickness. Specular
  reflection, refraction and LOS are on; diffuse reflection and diffraction are
  off by default.
* Rooms that overlap produce coincident surfaces and a warning. Cells outside all
  rooms are dropped in the UI; worker statistics cover the full bounding box.
* Calibration against drive-test logs is possible later and is not implemented.
