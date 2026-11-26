# Wi-Fi cabling design

The **Cabling** tab plans the cable and network behind the access points (APs):
where the racks go, how every AP is cabled, which switches serve them, how floor
rooms connect to the main room, what to buy, and whether the design meets its
limits. It reads the plan; it never changes it. Its own settings are stored in
the project under `plan.cabling`.

> **Status: a planning tool.** Lengths come from the plan geometry and the
> pathway facts you give. Every report says how much of the design is confirmed.
> It does not certify an installation. Part values are placeholders until you
> enter the real ones (see *Catalogue*).

## What it does

| Area | What the tool does |
| --- | --- |
| Racks | Suggests rack rooms (exact search for small problems, swap-improved greedy for large ones), keeps them clear of APs, honours a per-rack capacity, and marks every suggestion "to confirm". Racks can be dragged on the map. |
| Routes | One Ethernet cable per AP, routed on a right-angle grid with straight runs and shared trunks. Routes can be edited with waypoints and confirmed one by one. |
| Pathways | Ceiling type and void access (project and per room), wall marks (opening, sleeve, fire-stopped sleeve, not permitted, fire-rated, structural), drawn cable trays (new or existing), no-go areas, power cabling to keep away from, columns as obstacles. Unknown facts give an estimate, flagged on the map and in every report. |
| Layers | Each route reports metres on tray, in surface conduit, wall penetrations and over partitions. |
| Floors | Risers join floors; riser cross-section and fill are checked; a riser diagram is drawn. |
| Network | Main room (MDF) and floor rooms (IDF), fibre uplinks (strands, length, limit), oversubscription, rack space, power and heat, switch selection (fixed or automatic), PoE margin and N+1 power supply. |
| Electrical | PoE voltage at the AP and power lost in the cable (temperature adjusted). |
| Cable engineering | Tray fill and the width needed, power/data separation, fire-stop kits, bend-radius and bundle-heating assumptions. |
| Capacity | A separate **Capacity** tab with two checks. People are spread over the whole floor (the prediction map, or the building outline), evenly or weighted by desks and seats, with optional zones that hold a set number of people or nobody; the result includes a map of who joins which AP and a table of how the answer changes if the assumptions are wrong. Internet: plan speed with spare headroom against the minimum, typical and peak speed of the active devices, download and upload. Wi-Fi radio: each device's signal (from the ray-traced prediction when run) gives its data rate for the chosen Wi-Fi standard, band, width and streams; the rate gives the airtime it needs; APs on the same channel share the air. It reports the share of devices that get the minimum speed and says whether the bottleneck is the internet plan, the radio or the coverage. All rate, SNR and efficiency figures are illustrative until checked. |
| Catalogue | Editable parts (values from datasheets), added parts, JSON import and export; the report says how many lines still rest on illustrative values. |
| History | Undo and redo, and an audit trail of every change. |
| Field test | Import a certifier's CSV and compare measured with designed length and pass or fail. |
| Deliverables | Excel (project, equipment list, PoE and switches, compliance, cable schedule, checks, assumptions, schematic, history, field test); PowerPoint (summary, approval, floor plans, schematic, topology, rack elevation, riser, BoQ, cable schedule, compliance, assumptions); SVG and PNG drawings. |

## Approval levels

| Level | Meaning |
| --- | --- |
| preliminary | The default. Something rests on an assumption. |
| validated | Ceiling and wall access stated, no route is an estimate, drawn trays and racks confirmed, and you have ticked that the plan dimensions and the cable pathways were verified on site. |
| construction-ready | Also every route confirmed and the equipment verified. This only means every check was marked done; the tool plans and does not certify. |

## How to use it

1. Place APs (Editor), or run the optimiser and press **Apply the optimiser's APs and cable them**.
2. Open **Cabling** and press **Suggest rack locations**; confirm or drag the racks.
3. Give the ceiling and wall facts; draw trays, no-go areas and power cabling; mark walls.
4. Edit and confirm routes; set the network options and the catalogue.
5. Read the compliance table, then download Excel or PowerPoint.

## Limits

- Capacity uses the ray-traced signal when the prediction has been run and a distance estimate (no walls) otherwise; device association is a planning assumption, and the model has not been checked against real APs and measured speeds.
- Signal quality of Ethernet (return loss, crosstalk), bend radius, pulling tension and bundle heating are not calculated.
- Rack, tray and route data cannot be read from a picture: they come from you and the client.
- Catalogue values are illustrative until replaced.

## Code

`src/infra/core` (routing, plan geometry, pathway rules, bill of quantities, Excel), `src/infra/wifi` (design, racks, network, schematic, exports, capacity, catalogue, history, field test), `src/infra/model` (infrastructure data model), `src/infra/cellular` (cellular engine). Tests: `test/infra*.test.js`.
