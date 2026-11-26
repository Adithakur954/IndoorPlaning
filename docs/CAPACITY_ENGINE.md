# Wi-Fi capacity engine

The capacity engine answers two questions for a plan: can the **internet plan** carry what
the active devices need, and can each **access point's radio** serve its devices? It has two
modes:

| Mode | What it does | When it runs |
|---|---|---|
| Deterministic | Spreads the expected number of people over the floor as fractions; one fixed answer per AP | On every edit (milliseconds) |
| Monte Carlo | Places every person as one user at an x, y position, with whole devices and their own traffic, and repeats that over many seeded runs | When you press **Run simulation** |

## Where the code is

```
capacity/                      Rust crate "capacity-core": the only engine
  src/model.rs                 occupancy, signal, association, airtime, verdicts (deterministic)
  src/montecarlo.rs            users, devices, traffic profiles, runs, statistics
  src/loadtest.rs              rising users on fixed APs: breaking point, KPIs, heat maps
  src/radio.rs                 MCS rate tables, channels, channel planning
  src/geometry.rs, js.rs       plan geometry; JavaScript number semantics
  src/wasm.rs                  WebAssembly exports (JSON in, JSON out)
src/infra/wifi/
  capacity_core.wasm           the built engine (commit it after a rebuild)
  capacityEngine.js            loads it; synchronous calls once loaded
  capacityWorker*.js           Monte Carlo in a Web Worker
  capacityDefaults.js          defaults the forms show before the engine loads
service/src/api.rs             POST /api/capacity: the same crate, natively
```

The planner runs the crate as WebAssembly in the browser and the desktop app. The Rust service
links the same crate for jobs too large for a browser. Python is not involved: it is only used
for ray tracing (Sionna) and floor-plan recognition.

## Build and test

```
npm run capacity:build   # needs once: rustup target add wasm32-unknown-unknown
npm run capacity:test    # Rust unit tests
npm test                 # includes test/capacityEngine.test.js
```

`test/fixtures/capacity-golden.json` holds the outputs of the original JavaScript engine for
40 random plans. The Rust engine reproduces all of them field for field. During the port it
also matched 1,400 further random plans. If you change the model on purpose, regenerate the
fixture and review the differences.

## Monte Carlo, step by step

Each run:

1. **Users.** Every person becomes one user. Positions are drawn with the same weights as the
   deterministic model: the whole floor, more near desks and seats if set, and exact headcounts
   for zones and rooms. Each position is then moved at random within its grid square. Users
   never land in excluded rooms, empty zones or outside the building.
2. **Devices.** Each user carries whole devices; 1.5 per person means some users have 1 and
   some have 2. Each device draws its traffic:
   - **Simple:** active with the "active at a time" share, at the typical, minimum and peak
     speeds.
   - **Profiles:** one profile drawn by its share (idle, browsing, video call, streaming,
     download, voice) and a speed within that profile's range.
3. **Signal.** Each AP's level at the device comes from the ray-traced cell it stands in. The
   other APs are scaled from it by distance. With no prediction, signal is estimated from
   distance. The prediction is never recomputed.
4. **Association, airtime, internet.** The deterministic engine's own functions decide
   association, airtime, channel sharing and the internet check.

Runs continue in batches until every AP's overload probability is known to within the target
(±3 points by default, 95% Wilson interval), up to the maximum number of runs. The same seed
always gives the same result.

### Results

- **Per AP:** devices and active devices at P50 with P5–P95, airtime, the share meeting the
  minimum speed, and the **overload probability** with its 95% range. The deterministic value
  is shown alongside.
- **Floor:** the share of runs in which every target is met, how often the internet plan is
  enough, and the most at-risk AP.
- **Users:** every user of a typical (median) run and of the worst run, with position, room
  or zone, devices, profile, chosen AP, distance, RSSI, SNR, rate, the speed it needs and gets,
  and a status. Click a user to see the distance and signal to every AP on the floor.
- **Problem areas:** how often active devices at each place missed their minimum speed, over
  all runs.

## Capacity simulation (Capacity → Capacity simulation)

The planner shows ONE simulation with one engine (the per-user model below) for two questions:

- **Run for a number of users** (default: the headcount on the Demand tab): op `loadTestHeatmap`.
  Summary tiles (simulated users, average Wi-Fi speed, % below the minimum, overloaded APs, after
  the internet plan), Pass / Warning / Fail per part, the four maps and an AP table.
- **Find capacity limit**: op `loadTest`, the same simulation at a rising number of users,
  narrowed down to the breaking point (described below).

Four maps, each with the simulated users as dots (click one: a line to its AP, its RSSI, SNR,
data rate, demand, airtime and Mbps):

| Map | What it shows |
|---|---|
| Throughput | what one active user standing there can achieve under that load: its data rate × its fair share of the AP's airtime, not capped at its demand (`achievable`; after the internet plan: `achievableNet`). Bands from the minimum and the demand: red below the minimum, orange, yellow, green |
| Signal | SNR (or RSSI) from the prediction; does not change with users |
| Congestion (airtime) | airtime the AP's channel needs over what it can use (`air`) |
| AP association | the AP a user standing there joins (`ap`) |

The Monte Carlo op (`monteCarlo`) and its per-AP model remain in the engine (deterministic and
Monte Carlo results, tests); the planner no longer shows a separate Simulation tab.

## Load test (Capacity → Capacity simulation → Find capacity limit)

The Simulation tab answers "can these APs carry my 200 people?". The load test answers "how
many users can these APs carry, when does performance start to degrade, when does it fail,
and what should change?". Code: `capacity/src/loadtest.rs`, op `loadTest`.

1. **Steps.** The APs, channels and ray-traced prediction stay fixed. The headcount goes from
   the start to the maximum in steps (default 50 → 500 by 50). People are spread the way
   the planner spreads them (zones, rooms, desks), scaled to each total. Every step is a
   Monte Carlo run (60 runs by default) with the same seeds, so steps differ only by the
   number of people.
2. **Pass, Warning, Fail.** In 95% of runs (setting), each step checks:
   - the busiest channel's airtime against the Wi-Fi tab's highest airtime use;
   - the share of active devices getting their minimum (95% must);
   - the worst 5% of device throughput against the minimum;
   - the devices on the busiest AP against the per-AP limit;
   - the internet plan at the minimum speed;
   - the share of devices with a usable signal.

   A value within 15% of a limit is a warning. Users getting less than their demand,
   but still their minimum, is also a warning. Latency and retries are shown, but decide
   only when switched on. The minimum-speed and per-user throughput checks are Wi-Fi only;
   the internet plan is its own check. Each step reports Wi-Fi, Internet and Coverage
   verdicts separately, as well as the overall one.
3. **Breaking point.** Between the last passing and the first failing step, the headcount
   is bisected down to 5 users. This is done for the network as a whole and for each KPI
   separately ("airtime fails at 146, devices per AP at 156").
4. **Per-user model** (`capacity/src/loadmodel.rs`, the load test only; the Simulation keeps its
   per-AP model). In every run, for every active device:
   - **Who shares airtime.** Same-channel APs that hear each other above the carrier-sense
     level (`ccaDbm`, default −82 dBm, from the prediction at the APs' positions) form one
     airtime domain. Optionally (`interference`, off by default) same-channel APs below that
     level and adjacent channels lower the signal quality instead; a pair is never counted
     both ways.
   - **Data rate from the SNR** where the device stands (as everywhere in the planner). Its
     upload share is sent at a lower rate (`uplinkLossDb`, default 5 dB weaker) and uses
     airtime too.
   - **Usable airtime** per domain = 1 − collision loss (Bianchi, from the contending stations).
   - **Fair sharing** (`fairness`): `airtime` (default, modern APs): equal airtime per active
     device, unused airtime goes to the others, so a device near the AP gets more Mbps than one
     at the edge; `throughput` (plain DCF): equal Mbps, so a slow device slows the whole cell.
   - Repeated with damping until it settles (tolerance, at most `convergenceIterations`); a run
     that does not settle is reported (`floor.convergedPct`).
   - **Internet plan after Wi-Fi**, max-min fair: throughput = min(Wi-Fi, internet share, demand).

   The step checks (minimum speed, worst 5%, airtime, AP status) use these per-device results.
5. **Heat maps.** The floor is cut into 1 m squares, at most about 6,000 per floor. The
   planner paints them into an image, one pixel per square, scales it with smoothing,
   clips it to the building and draws the rooms, walls and APs on top. The load test shows:
   - **estimated throughput**: what a user standing in that square would get under that
     load, averaged over the heat-map runs: min(its demand, its fair share of the airtime × its
     data rate there). Its full demand while the AP has airtime; less where the AP runs out
     (with airtime fairness, weak-signal spots first) or the signal is too weak. Every square
     has a value (no patchy map from where users happened to stand). Optionally after the
     internet plan;
   - the airtime the AP's domain needs, over what is usable;
   - the data rate at the SNR (does not change with load: rates follow the SNR alone);
   - how often devices there miss their minimum (problem areas);
   - SNR, once, as the baseline.

   Each step also carries **one representative run's users** (`userDots`: the run with the
   median share meeting the minimum), each with its AP, SNR, rate, airtime and Mbps per device.

6. **Proposed AP.** For a radio failure, the engine tries up to 16 spots spread over the
   overloaded AP's area. At each spot it adds an AP and checks the loads quickly
   (deterministic). It keeps a spot only if that lowers the busiest load. The planner then
   reruns the whole load test with the proposed AP (`proposed: true`) and shows before and
   after, so an improvement is measured, not assumed. A proposed AP has no ray-traced
   prediction, so its signal comes from distance, and is never capped by the prediction
   of the existing APs.

Estimates used:
- **Latency:** the access delay is the transmission time divided by the airtime left.
- **Retries:** the collision probability from Bianchi's 802.11 DCF model. The number of
  contending stations is the queue at that utilisation.

Both are labelled as estimates throughout.

Benchmark (3 floors, 72 APs, 28,800 ray-traced cells, 400 → 6,000 users): 12 steps,
including the bisection, plus 7 heat-map steps at 2,400 squares per floor take 2.3 s in
WebAssembly. The result is 2.1 MB.

### What it is and is not

User positions are **simulated**, not where real employees sit. Traffic is **modelled
demand**, not measured traffic. The rate table, the SNR needed for each rate and the MAC
efficiency are nominal figures. Check them against datasheets and site measurements.
