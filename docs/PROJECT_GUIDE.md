# Project guide

This guide describes how Indoor Planner starts, how a project moves through the app, and where to make changes. The project is a local React application backed by a Node/Express API. Project plans and preferences are saved as JSON in `data/projects.json`.

## Runtime flow

```text
Browser
  └─ src/main.jsx → src/App.jsx (React Router)
       ├─ / → src/routes/ProjectsPage.jsx
       └─ /projects/:projectId/:section → src/routes/PlannerPage.jsx
            ├─ sidebar selects Editor, Network, Imports, or Geo alignment
            ├─ panel components render the selected workflow
            └─ planner state → src/services/projects.js → /api/projects
                                      ↓
                         server/routes/projects.js
                                      ↓
                         projectService.js → projectRepository.js
                                      ↓
                             data/projects.json
```

`npm run dev` starts the Vite frontend and the local API. The development launcher chooses available ports and configures the Vite API proxy. In production, `server/app.js` serves the Vite `dist` files when present and falls back to `index.html` for client routes.

## Project lifecycle and state

1. `ProjectsPage.jsx` lists projects and creates or deletes them through `src/services/projects.js`.
2. `PlannerPage.jsx` loads a project, merges its saved plan with defaults from `src/models/plan.js`, and owns the current editor state.
3. Editing actions call `mutate` or update view state. Changes are marked unsaved and saved after a short debounce through `saveProject`.
4. The API validates the basic project shape, updates the project record, and serializes writes through a promise queue. The repository writes a temporary file and renames it to `data/projects.json` so a partial write does not replace the saved file.
5. View preferences such as 2D/3D mode, grid snapping, room labels, furniture labels, and Wi-Fi antenna labels are stored under `plan.preferences`. Older projects get defaults when loaded.

The plan is the shared source of truth for both visualizations. It contains floors, rooms, doors, windows, interior walls, furniture, network sources, RF settings, logs, geographic alignment, imported images, and view preferences. 2D and 3D views receive the same plan and editing callbacks.

## Editor interaction flow

```text
EditorQuickTools or Inspector
  → PlannerPage tool state
    → DesignPanel
      ├─ Plan2D SVG events ─┐
      └─ Plan3D scene events ├→ place / move / patchObj
                            └→ mutate(plan) → autosave
```

- `EditorQuickTools` sets Cursor, Rectangle, or Polygon mode. `Plan2D` accumulates polygon points and finishes the polygon when requested. Rectangle and completed polygon placement return to Cursor.
- `Plan2D` owns the SVG view box, zoom, Ctrl+drag panning, wall endpoints, polygon preview, and pointer interactions.
- `Plan3D` uses React Three Fiber and Drei. `OrbitControls` handles camera navigation; shared callbacks update the same plan objects used by 2D.
- `DesignPanel` renders the view, selection inspector, tool settings, and project properties. `PlannerPage` performs entity creation and project-level mutations.
- The room Width and Depth arrows choose the expansion side. `patchObj` updates the room origin and dimension together to keep the opposite edge anchored.
- Property visibility checkboxes are separate: room names, furniture/table names, and Wi-Fi antenna names. The Wi-Fi option does not hide cellular source labels.

## Import, analysis, and map flow

- **Building workbook:** `DataPanel` calls `src/services/imports.js`, which uses `src/utils/excelPlan.js` and `src/utils/floorPlan.js` to parse, normalize, and export floor data. `src/templates/buildingTemplate.js` builds the example workbook.
- **Floor image:** the local detector in `src/utils/imageDetection.js` can propose rooms. Optional AI tracing goes through `src/services/floorTrace.js`, `/api/floor-image/trace`, and `server/services/floorTrace.js`. The server keeps the OpenAI key private, validates and normalizes the response, then the UI presents a draft for review before applying it.
- **RF prediction:** `src/utils/prediction.js` samples the selected floor and estimates signal strength from source settings, free-space loss, directionality, and walls/doors. `NetworkPanel` configures parameters; `Plan2D` and `Plan3D` display the prediction overlay.
- **Measurement logs:** `src/services/sessions.js`, `src/utils/excelPlan.js`, `src/utils/indoorZip.js`, and `src/utils/logOverlay.js` load and aggregate measurements. `DataPanel` manages import and KPI settings; the plan views render points or grids.
- **Geographic alignment:** `AlignmentPanel` and `AlignmentControls.jsx` set the building anchor. `src/utils/geographicAlignment.js` converts between local plan coordinates and latitude/longitude and projects geographic logs. The Google Maps JavaScript API key is optional and configured with `VITE_GOOGLE_MAPS_API_KEY`.

## File responsibilities

### Application and routes

| File | Responsibility |
| --- | --- |
| `src/main.jsx` | Creates the React root and loads global styles. |
| `src/App.jsx` | Declares the project-list and planner routes. |
| `src/routes/ProjectsPage.jsx` | Project list, create, and delete UI. |
| `src/routes/PlannerPage.jsx` | Main application state, load/save lifecycle, editing operations, navigation, and planner layout. |

### Components

| Path | Responsibility |
| --- | --- |
| `src/components/panels/DesignPanel.jsx` | Editor canvas layout, inspector fields, drawing tool options, and property controls. |
| `src/components/panels/NetworkPanel.jsx` | RF settings, prediction summaries, and source navigation. |
| `src/components/panels/DataPanel.jsx` | Building/image/log imports, trace review, and export controls. |
| `src/components/panels/AlignmentPanel.jsx` | Geographic alignment form and map setup page. |
| `src/components/panels/AlignmentControls.jsx` | Google map loader, place lookup, building footprint preview, and alignment form. |
| `src/components/planner/Plan2D.jsx` | SVG floor plan, labels, overlays, zoom/pan, and 2D pointer interactions. |
| `src/components/planner/Plan3D.jsx` | Three.js floor geometry, furniture, openings, network sources, labels, and camera controls. |
| `src/components/planner/EditorMenu.jsx` | Header quick tools and the full drawing-tools panel. |
| `src/components/planner/PropertyMenu.jsx` | Project property controls, including independent label visibility. |
| `src/components/planner/RoomMaterials.jsx` | Room material choices and related wall settings. |
| `src/components/ui/Field.jsx` | Shared labeled input/select component. |

### Data, services, and server

| Path | Responsibility |
| --- | --- |
| `src/models/plan.js` | Initial plan schema and ID generation. |
| `src/services/api.js` | Shared JSON fetch wrapper for the local API. |
| `src/services/projects.js` | Frontend project CRUD calls. |
| `src/services/sessions.js` | Session file listing/loading and log normalization. |
| `src/services/imports.js` | Browser-side workbook, image, log import, and download workflows. |
| `src/services/floorTrace.js` | Frontend request for optional AI floor tracing. |
| `src/utils/geometry.js` | Room geometry, bounds, wall segments, intersections, and material loss helpers. |
| `src/utils/prediction.js` | RF prediction and color mapping. |
| `src/utils/excelPlan.js` | Building workbook and CSV/XLSX log parsing/export. |
| `src/utils/indoorZip.js` | ZIP log parsing and color settings. |
| `src/utils/logOverlay.js`, `src/utils/indoorPlanningUtils.js`, `src/utils/indoorLogKpis.js` | Log KPI selection, aggregation, colors, and measured-area overlays. |
| `src/utils/imageDetection.js` | Local floor-image region detection. |
| `src/utils/geographicAlignment.js` | Coordinate validation, projection, and log alignment. |
| `server/index.js` | Loads `.env` and starts the local server. |
| `server/app.js` | Express middleware, API routers, static production hosting, and error handling. |
| `server/routes/` | HTTP endpoints for projects, sessions, and floor tracing. |
| `server/services/projectService.js` | Project validation and CRUD behavior. |
| `server/repositories/projectRepository.js` | Queued JSON file reads and atomic project writes. |
| `server/services/sessionService.js` | Reads local CSV/JSON session files. |
| `server/services/floorTrace.js` | OpenAI request and validated trace normalization. |
| `server/config/paths.js` | Resolves data and production build directories. |
| `data/projects.json` | Local project database file. Back it up to retain projects. |

## Where to change common behavior

- Add a new planner section: add route/tab behavior in `src/App.jsx` and `PlannerPage.jsx`, then implement its panel under `src/components/panels/`.
- Add a saved preference: define its default in `src/models/plan.js`; read it when a project opens and include it in the preference save effect in `PlannerPage.jsx`; pass it to the relevant component and expose it in `PropertyMenu.jsx` or `EditorMenu.jsx`.
- Add an entity or drawing action: update `PlannerPage.jsx` creation/edit callbacks, `src/models/plan.js` if the plan schema needs a collection, and both views if it should appear in 2D and 3D.
- Change workbook compatibility: update `src/utils/excelPlan.js` and its corresponding tests under `test/`.
- Add an API endpoint: implement a route under `server/routes/`, put business logic in `server/services/`, and register it in `server/app.js`.

## Useful commands

```powershell
npm.cmd run dev
npm.cmd run build
npm.cmd test
node scripts/smoke.mjs
```

The smoke script requires the API to be running. The tests cover geometry, RF samples, geographic conversion, workbook imports/round trips, CSV logs, and ZIP logs.
