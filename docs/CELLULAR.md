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
| 4 | DAS network editor; link-budget power feeds each antenna | editor + calculated port powers done; vendor datasheets for cables / splitters / couplers pending (placeholders) |
| 5 | BOQ from the network, rule tables, export templates | to do |
| 6 | Trunking diagram, cellular report | to do |
| 7 | Sionna SYS (MCS, throughput), several operators | to do |
| 8 | Automatic design (antenna placement, cable tree, coupler choice) | to do |

## Using it

1. Open the **Cellular** workspace (asked on start when the license has both Wi-Fi and cellular;
   with a cellular-only license the app opens there directly) and create or open a Cellular project.
   Each project is Wi-Fi or Cellular, never both.
   In the editor, press **Prediction**.
2. **Network & RF → Bands**: click the bands the building needs (700, 900, 1800, 2100, 2300,
   2500, 3500 MHz), like Wi-Fi's 2.4 / 5 / 6 GHz. Each band can be 4G (LTE) or 5G (NR); the
   3GPP band (e.g. n78 for 5G 3500) is filled in. Set the operator (only shown when typed),
   bandwidth and frequency of the selected band.
3. **Network & RF → Antenna**: **Ceiling (omni)** or **Wall (panel)** for new antennas, with
   their port power and height. The two antennas are built in from the supplied datasheets
   (`src/infra/cellular/builtInAntennas.js`): one pattern each, with a row per band; the
   prediction uses the row of the band's frequency.
4. **Advanced** (collapsed): sectors (each is its own cell on every band it sends), the antenna
   datasheets, another vendor's catalogue (JSON, format below), measured pattern files (`.msi`,
   win within ±15 % of their frequency) and the prediction settings.
5. Editor → **Prediction** → **DAS network**: place a **Source** (BTS / repeater, output power per
   band) at the shaft, **Splitters** (2/3/4-way), **Couplers** (5/7/10/15 dB; first cable = through,
   second = tap) and **Risers** (where a cable changes floor). With **Cable**, click a part, then
   the part or antenna it feeds (also on another floor). Cable length = run on the plan + floor
   height + extra length; loss per frequency from the cable table, plus connectors. Every antenna
   a source feeds gets its port power from the network (its panel shows the loss chain); the
   others keep their typed power. Loss values are placeholders until the datasheets are entered.
6. Editor → **Prediction** → **Place antenna**; select one to change its model, sector, port power,
   height, mounting, azimuth and downtilt.
7. Press **Prediction**, choose the band and **Run prediction**. The map shows RSRP or SINR of the best
   cell; the panel gives the share of the floor at or above the target, median and range.
   Each band keeps its latest run, so switching bands needs no new run.

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
