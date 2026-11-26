# Indoor Planner

Indoor building and RF planning application for Windows. Draw or import a
building, place access points (APs), predict signal strength with physics-based
ray tracing, find the fewest APs that meet a coverage target, and export Word
reports.

> **Status:** predictions are planning estimates from ray tracing with standard
> ITU-R P.2040 materials. They are not calibrated measurements. Validate against
> a site survey before committing to a design.

## Features

| Area | What it does |
| --- | --- |
| Building editor | 2D and 3D views of one shared plan: rooms, polygons, interior walls, doors, windows, furniture, materials, multiple floors. Autosaves. |
| Floor-plan import | Excel building templates, and PNG / JPG / PDF floor plans converted to editable walls, openings and rooms (runs locally, no cloud). Scale is taken from a printed size or one known length, never guessed. |
| Ray-traced prediction | NVIDIA Sionna RT: line of sight, specular reflection and refraction, up to depth 5, per floor, per AP and best server. RSSI and SNR with a configurable noise floor. CPU or GPU. |
| AP optimisation | Fewest APs for a coverage target, or best coverage for an AP budget. Works with or without existing APs, keeps, moves or removes existing ones, and runs each selected band (2.4 / 5 / 6 GHz) separately with a comparison and a recommendation. Reports the result against your existing layout and warns when it is worse. |
| Measurements | Import drive-test or survey logs (`.csv`, `.xlsx`, ZIP), choose a KPI, edit threshold colours, overlay on the plan. Geographic alignment included. |
| Reports | Word (`.docx`) single-band design report and a 2.4 GHz vs 5 GHz comparison report with building measurements, coverage, SNR, rooms, weak zones and recommendations. |
| Wi-Fi cabling | Racks, cable routes, pathways (ceiling, walls, trays, no-go areas), switches and PoE, fibre uplinks, capacity planning, equipment list, compliance table, Excel and PowerPoint. See [docs/WIFI_CABLING.md](docs/WIFI_CABLING.md). |
| Licensing | Offline, machine-bound, signed licenses. No licensing server. A license can list the modules it unlocks. |

## Architecture

```text
Browser (React, Vite, Three.js)
   │  /api (projects, sessions, floor-plan import, licensing)
   ▼
Node.js API (Express)  ── SQLite project store (node:sqlite)
   │  scene zip upload, jobs
   ▼
Rust simulation service (service/)  ── validates, queues, caches by content hash
   │  subprocess
   ▼
Python worker (worker/)  ── Sionna RT on Dr.Jit / Mitsuba; optimiser; floor-plan reconstruction
```

Desktop builds package the same stack with Tauri (`src-tauri/`) into an NSIS
installer.

## Requirements

| Component | Version |
| --- | --- |
| Node.js | 24 or later (the API uses `node:sqlite`) |
| Rust toolchain | stable, for the simulation service |
| Python | 3.10+ with the packages in `worker/requirements.txt` |
| GPU | optional; CPU gives the same maps for the same seed, only slower |

## Getting started

```powershell
git clone https://github.com/Adithakur954/IndoorPlaning.git
cd IndoorPlaning
npm install

# Python worker
cd worker
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
cd ..

# Configuration (optional keys, see below)
copy .env.example .env

npm run dev            # frontend + API
npm run sim:service    # Rust simulation service (second terminal)
```

Open the **Local** URL that Vite prints. `npm run dev` starts the API on port
3001 when free, reuses it when it is already this application's API, and
otherwise picks a free port and configures the Vite proxy to match.

The floor-plan segmentation model is not stored in Git. Regenerate it with
`train/export_onnx.py` (see `worker/models/README.md`). Without it, the importer
falls back to its non-learned detection.

### Production build

```powershell
npm run build
npm start              # serves the build and the API on http://127.0.0.1:3001
```

The server binds to `127.0.0.1` and has no user accounts. Keep it local; add
authentication and network hardening before exposing it to other users.

### Windows installer

```powershell
npm run desktop:prepare
npm run desktop:build
```

See [docs/WINDOWS_INSTALLER.md](docs/WINDOWS_INSTALLER.md).

## Configuration

Copy `.env.example` to `.env`. **Never commit `.env`**; it is git-ignored.

| Variable | Purpose |
| --- | --- |
| `VITE_GOOGLE_MAPS_API_KEY` | Optional. Enables click-to-pick on the satellite map. Restart Vite after changing it. |
| `INDOOR_DATA_DIR` | Optional absolute directory for the database, imports and sessions. Set it for both the Node API and the Rust service. |
| `LICENSE_PUBLIC_KEY_FILE` | Public key used to verify licenses. |

## Using the application

1. Create a project and add floors.
2. **Editor:** draw rooms and walls, or import a floor plan; place APs and edit their frequency, power, gain and height.
3. **Network & RF:** set the receiver height, grid, noise floor and threshold, then run the prediction.
4. **Optimise AP placement:** choose the target signal and coverage, the bands, and how to treat existing APs. Compare the result with your current layout, then **Apply**. Apply can be undone.
5. **Reports:** use the header buttons to download the Word reports.

Detailed steps: [docs/USER_MANUAL.md](docs/USER_MANUAL.md).

## Data and security

- Projects live in SQLite in the data directory; back it up to keep projects. Licence activation is stored separately and expiry never deletes projects.
- Secrets are excluded by `.gitignore`: `.env*` (except `.env.example`), `*.pem`, `*.key`, `licensing-private/`, `*.license`, credentials files, client archives and generated outputs.
- The licence **private key** (`licensing-private/private.pem`) must stay on the publisher's machine and never ship with an installer. See [docs/LICENSING.md](docs/LICENSING.md).
- Report a security issue privately to the maintainer; do not open a public issue.

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | React app: routes, planner components, services, models, RF and report utilities. |
| `server/` | Express API: projects, sessions, floor-plan import, licensing, storage. |
| `service/` | Rust simulation service: scene validation, job queue, result cache. |
| `worker/` | Python worker: Sionna RT prediction, optimiser, floor-plan reconstruction. |
| `train/` | Floor-plan segmentation training and dataset tools. |
| `src-tauri/`, `license-generator/`, `licensing/` | Desktop shell, licence generator, licence protocol. |
| `scripts/` | Dev launcher, service launcher, checks and end-to-end scripts. |
| `test/` | Node tests for the frontend and API. |
| `docs/` | Technical documentation. |

## Testing

```powershell
npm test               # frontend and API tests
npm run build          # production build
node scripts/smoke.mjs # API smoke test (API must be running)
cd worker; python -m unittest discover tests   # worker tests
cd service; cargo test                         # service tests
```

## Documentation

| Document | Topic |
| --- | --- |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | Step-by-step product use |
| [docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md) | Code guide and data flow |
| [docs/RAY_TRACING.md](docs/RAY_TRACING.md) | Prediction, optimisation, model assumptions and limits |
| [docs/REPORT.md](docs/REPORT.md) | Word report contents |
| [docs/FLOORPLAN_RECONSTRUCTION.md](docs/FLOORPLAN_RECONSTRUCTION.md) | Image to building, scope and limits |
| [docs/WIFI_CABLING.md](docs/WIFI_CABLING.md) | Wi-Fi cabling design |
| [docs/WIFI_CABLING_ACCEPTANCE.md](docs/WIFI_CABLING_ACCEPTANCE.md) | Acceptance criteria and what is not yet proven |
| [docs/PROJECT_STORAGE.md](docs/PROJECT_STORAGE.md) | Database schema |
| [docs/LICENSING.md](docs/LICENSING.md) | Offline licensing |
| [docs/WINDOWS_INSTALLER.md](docs/WINDOWS_INSTALLER.md) | Installer build |

## Known limits

- Diffraction and diffuse scattering are off by default; very low frequencies and sharp corners will be less accurate.
- Floor-plan import recovers approximate geometry, not CAD-grade dimensions. Review the result against the underlay before using it for RF design.
- The optimiser's screening step uses coarse ray tracing to rank candidates; the reported coverage comes from the final full-resolution run.
- Cellular (IBS/DAS) planning is a separate add-on that is not part of the Wi-Fi feature set. Wi-Fi cabling is a planning estimate and is not validated on real buildings yet (see the acceptance criteria).
