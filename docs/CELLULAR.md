# Cellular (IBS/DAS) module

A separately licensed module (license feature `cellular`). It shares the floor plan, walls and
materials with Wi-Fi and nothing else: its own antennas, carriers, prediction runs, results,
worker and model version. Wi-Fi APs, the Wi-Fi prediction, the optimiser and their cached
results are not affected by anything in it.

## Status

| Step | What | State |
|---|---|---|
| 1 | Wi-Fi and cellular separated (scene export by network, own route, own worker, license gate, Wi-Fi staleness ignores antennas) | done |
| 2 | Catalogue + carriers + antenna patterns → RSRP / SINR map | done |
| 3 | Several floors: floor heights and alignment | next |
| 4 | DAS network editor; link-budget power feeds each antenna | to do |
| 5 | BOQ from the network, rule tables, export templates | to do |
| 6 | Trunking diagram, cellular report | to do |
| 7 | Sionna SYS (MCS, throughput), several operators | to do |
| 8 | Automatic design (antenna placement, cable tree, coupler choice) | to do |

## Using it

1. Open the **Cellular** workspace (asked on start when the license has both Wi-Fi and cellular;
   with a cellular-only license the app opens there directly) and create or open a Cellular project.
   Each project is Wi-Fi or Cellular, never both.
   In the editor, press **Cellular**.
2. **Antenna models → Import catalogue…**: a vendor catalogue file (JSON, format below). A sample
   typed from the Frog datasheets is in `docs/catalogues/frog-ibs-antennas.json`. Measured
   pattern files (`.msi`) can be attached to a model; they win over the datasheet numbers
   within ±15 % of their frequency.
3. **Carriers**: one per operator and band (LTE or NR, 3GPP band, downlink frequency,
   bandwidth, NR subcarrier spacing, which sectors send it).
4. **Sectors**: each sector is its own cell on every carrier it sends.
5. **Place antenna**, then set its model, sector, power at its port, height, mounting,
   azimuth and downtilt. Until the DAS network exists (step 4) the port power is typed in.
6. Choose the carrier and **Run cellular prediction**. The map shows RSRP or SINR of the best
   cell; the panel gives the share of the floor at or above the target, median and range.
   Each carrier keeps its latest run, so switching carriers needs no new run.

## Where it runs

- Planner: `src/infra/cellular`, `src/hooks/useCellularPrediction.js`, `CellularPanel` (Editor → Cellular).
- Scene: the building only (`buildSceneZip(plan, { sources: "none" })`); Wi-Fi scenes leave antennas out.
- Service: `POST /api/cellular/predictions` (`service/src/cellular.rs`), license feature `cellular`
  checked by the service and, in the desktop app, by the Node proxy; status and maps as for
  `/api/simulations/{id}`. The job runs `python -m cellular_worker` with its own model version.

## How it is calculated

- Sionna RT traces every antenna with its own pattern, direction and port power, on all
  floors of the scene (slabs between floors), with the same materials as Wi-Fi.
- Pattern: the `.msi` file, else TR 38.901-shaped from the datasheet row of the carrier's band
  (gain, horizontal and vertical beamwidth, front-to-back ratio; omni when horizontal is 360°).
  A frequency no datasheet row covers is refused, not guessed.
- Antennas of one sector add up as one cell. RSRP = cell power − 10·log10(12 × resource
  blocks) (3GPP tables TS 36.101 / 38.101-1).
- SINR = best cell's RSRP over the other cells of the carrier (fully loaded) + thermal noise of
  one subcarrier + handset noise figure (default 7 dB). Outdoor interference is not included.

## Catalogue file

```json
{ "antennas": [
  { "id": "vendor-model", "name": "Shown name", "vendor": "…", "model": "…", "type": "omni|panel|other",
    "maxPowerW": 50, "source": "which datasheet",
    "bands": [ { "fromMHz": 1710, "toMHz": 2700, "gainDbi": 8, "hBeamwidthDeg": 65,
                 "vBeamwidthDeg": 60, "frontToBackDb": 15 } ] } ] }
```

A file with any wrong entry imports nothing and lists what is wrong.

## Code

- `src/infra/cellular/`: `bands.js` (3GPP bands, resource blocks), `antennaPattern.js`
  (datasheet and `.msi` patterns), `model.js` (plan.cellular), `request.js` (the job),
  `catalogueImport.js`, `mapCells.js`, `engine/` (link budget for step 4).
- `src/hooks/useCellularPrediction.js`, `src/components/planner/CellularPanel.jsx`,
  `CellularLegend.jsx`, `src/services/cellular.js`.
- Service: `POST /api/cellular/predictions` (feature check, own model version), the runner
  starts `cellular_worker` for `mode: "cellular"` jobs.
- Worker: `worker/cellular_worker/` (job checks, patterns in Sionna, RSRP/SINR maths).
- Tests: `test/cellularPrediction.test.js`, `worker/tests/test_cellular.py`, service unit tests.
