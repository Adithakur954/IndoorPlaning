# Indoor Planner — User Manual

Version: November 2026

## 1. Introduction

Indoor Planner is a Windows application for designing indoor Wi-Fi networks. You draw or import a building, place access points (APs), predict coverage with ray tracing, let the optimiser find the best AP layout, design the cabling, and export reports.

A typical project follows these steps:

1. Install the application and activate your licence (section 2).
2. Create a project (section 3).
3. Build the floor plan: import a drawing, import Excel, or draw it (section 4).
4. Choose the AP model and place access points (section 5).
5. Run the coverage prediction (section 6).
6. Let the optimiser find the best AP layout (section 7).
7. Design the cabling, racks and switches (section 8).
8. Download the reports (section 9).

The screenshots in this manual use a sample 40 m × 24 m office with nine rooms.

All results are planning estimates based on standard building materials. Confirm the final design with an on-site survey before installing equipment.

## 2. Install and activate

### 2.1 Install

1. Run the Indoor Planner setup EXE you received. It installs for the current Windows user.
2. If asked, allow the installer to download Microsoft Edge WebView2. This needs an internet connection the first time.
3. Start **Indoor Planner** from the Start menu or desktop shortcut. Opening it a second time brings the existing window to the front.

You do not need to install anything else. Updates keep your existing projects.

### 2.2 Activate your licence

The first time you start the app, the **Activate Indoor Planner** screen opens.

![The activation screen. Copy the Machine ID, then paste the key you receive.](manual-images/activation.png)

1. Click the copy button at the right of **Machine ID**.
2. Send the Machine ID to your supplier.
3. Paste the key you receive into **Activation key**.
4. Click **Activate**. If you activated in another window, click **Check again**.

The licence is tied to this computer and works offline. Its number of days starts at the first activation. When it expires the app is locked, but your projects are never deleted; enter a new key to continue. Do not set the computer clock back, as the app rejects dates before activation.

## 3. Projects and the workspace

### 3.1 Create a project

After activation the project list opens. The header shows **License active**.

![The project list. Use + New project or Create indoor project to start.](manual-images/project_list.png)

1. Click **+ New project** (top right) or **Create indoor project →**.
2. Type a project name, for example "Demo Office", and confirm.
3. The project opens in the **Editor** with one empty floor called **Level 1**.

To reopen a project later, click its card under **Your projects**.

### 3.2 The workspace

![The Editor with an empty floor. The sidebar is on the left, the toolbar on top, the properties panel on the right and the status bar at the bottom.](manual-images/editor_empty.png)

| Area | What it holds |
| --- | --- |
| Left sidebar | **← Projects**, the project name, the modules (Editor, Network & RF, Imports & logs, Geo alignment, Cabling) and the **FLOORS** list |
| Top toolbar | Drawing tools, **More tools**, **Property**, **Prediction**, heatmap **Opacity**, **Show**, **Legend**, three download buttons and the save status |
| Right panel | Properties of the selected floor, room or AP, or the open tool panel |
| Bottom bar | Room count, floor area, number of sources, **Undo** / **Redo**, **2D** / **3D**, **Static**, **Show measurements** and zoom |

The three icon buttons at the top right are, from left to right: **Download the plot as it looks now (PNG)**, **Download Word report** and **Download the 2.4 GHz vs 5 GHz comparison report**.

Projects save automatically. Wait until the toolbar shows **Saved** before closing the app.

### 3.3 Floors

1. Click **＋** beside **FLOORS** to add a floor.
2. Click a floor to work on it. Click the arrow at its right to list its rooms.
3. With no object selected, the right panel shows **Floor properties**: **Floor name**, **Elevation (m)**, **Wall thickness (m)**, **Floor image rotation (°)** and **Clear this floor**.

## 4. Build the floor plan

There are three ways to get a building into the project. Importing a floor-plan image is the fastest.

| Method | Use it when |
| --- | --- |
| Floor plan image → building | You have a PNG, JPG or PDF drawing |
| Import building Excel | You have room sizes and positions in a spreadsheet |
| Draw by hand | You have no drawing, or need small corrections |

### 4.1 Import a floor-plan image

1. Click **Imports & logs** in the sidebar.

![The Imports & logs page. The floor-plan importer is at the top; Excel import and network logs are below.](manual-images/imports.png)

2. Click **Choose floor plan (PNG / JPG / PDF)** and pick your drawing. Detection starts immediately and runs only on your computer.
3. Wait for the **Result**. It shows how many walls, rooms and doors/windows were found, and how many items need review.

![Detection result for the sample office: 12 walls, 9 rooms, 16 doors and windows.](manual-images/import_result.png)

4. Check the overlay. Walls are green when confident, orange when unsure and red when doubtful. Blue marks doors and cyan marks windows. Use **Wall mask** and **Original (straightened)** to compare with the drawing.
5. Set the scale in the **Scale** section. If the drawing prints enough room sizes, the app finds the scale itself. Otherwise do one of these:
    - Click one end of a length you know (point A), then the other end (point B), and type the **Real distance between A and B (m)**.
    - Or type the **real width of the whole image (m)**.
6. Click **Apply this scale**.

![The Scale section. Here the real image width of 46 m is entered. Detection settings are open below.](manual-images/import_scale.png)

7. Optional: open **Detection settings** to change the **Wall drawing** style or the **Method** (Learned model, Hybrid or Classical), then click **Detect again**.
8. Leave **Replace what is already on this floor** ticked for a new floor.
9. Click **Use in the editor**.

The app returns to the Editor with rooms, doors, windows and columns added, and the drawing shown underneath.

![The imported office in the Editor. A message confirms what was added.](manual-images/editor_imported.png)

Image detection gives approximate geometry, not CAD-grade dimensions. Compare the result with the original drawing. Items marked with orange dashes are listed under **To review** in the floor properties.

### 4.2 Import a building from Excel

![The Building plans and Network logs sections of Imports & logs.](manual-images/import_excel_logs.png)

1. In **Imports & logs → Building plans**, click **Download example template**.
2. Fill in the floors, rooms and, optionally, doors, windows, interior walls and furniture. Metres, feet, centimetres and millimetres are converted automatically.
3. Click **Import building Excel** and select your .xlsx file.

### 4.3 Draw by hand

1. In the toolbar, choose a drawing tool:
    - **Cursor** selects and moves objects.
    - **Rectangle** adds a rectangular room where you click.
    - **Polygon** adds a point per click; finish after at least three points.
    - **Boundary** draws the building outline.
2. Click **More tools** for the full list: Select, Rectangle, Circle, Polygon, Boundary, Wall, Door, Window, Furniture, Cellular and Wi-Fi.

![More tools opens the Tools panel. Snap 0.5 m rounds positions to half-metre steps.](manual-images/more_tools.png)

3. Draw a wall by clicking its start point, then its end point.
4. Place doors and windows on a room wall. If placement fails, zoom in and click closer to the wall.
5. Tick **Snap 0.5 m** to round positions to half-metre steps.
6. Click **Cursor** to stop drawing.

### 4.4 Edit a room

Click a room with **Cursor** to open **Room properties**.

![Room properties for OFFICE 2, with the wall material of each side.](manual-images/room_selected.png)

1. Change the **name**, **shape**, position (**x**, **z**), **width**, **depth** and **height**.
2. Choose the room's **material** (drywall, wood, glass, brick, concrete or metal).
3. Set **AP mounting** to **excluded** for rooms where APs must not be installed.
4. Set **receiver Grid** to **excluded** for rooms that do not need coverage, such as a lift shaft.
5. Under **Wall materials**, set each side separately. A wall shared with another room changes for both rooms.
6. Use **Rotate**, **Use as building boundary** or **Delete room** as needed.

### 4.5 Project properties and wall materials

Click **Property** in the toolbar.

![Project properties: carpet area, building rotation, label options and wall materials.](manual-images/property.png)

- Enter the **Carpet area**, or its **Length (m)** and **Width (m)**, or click **Fit to external boundary**.
- Enter an angle in **Rotate whole building (°)** and click **Rotate**.
- **Static** locks rooms against accidental dragging.
- **Hide room names**, **Hide furniture/table names** and **Hide Wi-Fi antenna names** tidy the plan.
- Under **WALL MATERIALS**, see the default loss of each material at 2.4, 5 or 6 GHz, and override **Thickness (m)** or **Loss (dB)**. Leave a field empty to keep the default.

| Material | Default loss at 2.4 GHz, 0.18 m |
| --- | --- |
| Drywall / plasterboard | 7.7 dB |
| Wood | 6.0 dB |
| Glass | 6.1 dB |
| Brick | 5.7 dB |
| Concrete | 22.9 dB |
| Metal | Blocks all signal |

### 4.6 2D and 3D views

Click **3D** in the bottom bar to check walls, doors and windows in 3D. Click **2D** to return.

![The 3D view of the sample office.](manual-images/view_3d.png)

- **2D:** mouse wheel zooms; hold **Ctrl** and drag to pan.
- **3D:** drag to rotate, wheel to zoom, right mouse button to pan.

## 5. Access points

### 5.1 Choose the AP model

Set the AP model once in **Network & RF**. Every new AP you place uses it.

![Wi-Fi AP properties in Network & RF, with the list of placed APs below.](manual-images/network_ap.png)

1. Click **Network & RF** in the sidebar.
2. Pick a **Model**, or choose **+ Add new model…** to enter your own from its datasheet (.json or .csv).
3. Choose the band: **2.4 GHz**, **5 GHz** or **+ 6**.
4. Check **Transmit power (dBm)**, **Antenna gain (dBi)**, **Channel** and **Width (MHz)**. The line below shows the resulting EIRP and the model's maximum power.
5. Set **Receiver (client device) gain (dBi)** for the phones or laptops you plan for.
6. Set **New Wi-Fi AP height (m)**, the mounting height given to new APs.
7. Click **Use on existing APs** to apply these values to APs already on the plan, or **Duplicate profile** to keep a variant.

**Network sources** lists every AP on the floor. Click one to open its properties. **Export scene (.zip)** exports the 3D model for an external ray-tracing tool.

### 5.2 Place APs

1. In the Editor, click **More tools → Wi-Fi**.
2. Click on the plan where each AP will be mounted.
3. Click **Cursor** when done.

![Three APs placed: one in OFFICE 4, one in the open office and one in the store room.](manual-images/aps_placed.png)

### 5.3 Edit an AP

Click an AP with **Cursor** to open **Source properties**.

![Source properties of a Wi-Fi AP.](manual-images/ap_selected.png)

1. Change the **name**, position (**x**, **z**) and **height M**.
2. Change **tx Power Dbm**, **freq M Hz** and **antenna Gain Dbi**.
3. For a directional antenna, set **antenna Pattern** to **directional**, then **azimuth Deg** and **beamwidth Deg**. Click **+ Sector** for more sectors.
4. Drag the AP on the plan to move it, or click **Delete source**.

## 6. Predict coverage

### 6.1 Run a prediction

1. Click **Prediction** in the toolbar and stay on **A · Existing APs**.

![The Prediction panel.](manual-images/prediction_panel.png)

2. Choose the **Device**: **auto**, **gpu** or **cpu**. Both give the same map; a GPU is faster.
3. Keep the defaults or change them: **Resolution (m)** 0.5, **Ray depth** 5, **Samples per AP** 1,000,000. Finer values are more accurate but slower.
4. Choose the **Noise floor for SNR** that matches the site:

| Preset | 2.4 GHz (dBm) | 5 GHz (dBm) |
| --- | --- | --- |
| Quiet office | −95 | −97 |
| Typical office | −90 | −92 |
| Fairly noisy office (default) | −86 | −88 |
| Busy office | −85 | −87 |
| Very noisy environment | −80 | −82 |

5. Click **Run prediction**. The first run can take several minutes; later runs reuse saved results.

### 6.2 Read the heatmap

![Predicted signal strength (RSSI) of the three APs. The legend shows the colour bands.](manual-images/prediction_result.png)

1. Open **Legend** to see the colour bands, and choose the **KPI**: **RSSI (dBm)**, **SNR (dB)**, **DL throughput (Mbps)** or **UL throughput (Mbps)**.
2. Move the **Opacity** slider to see the plan through the colours.
3. At the bottom of the panel, read the latest run time and the **weak** area per floor, for example "weak 0.0 m² of 960.0 m² (0%)".
4. Use **Show** to hide or show layers, and **Clear prediction** to remove the result.
5. Tick **Recompute everything (ignore saved results)** to force a fresh calculation.

Common targets: −67 dBm is strict (voice and video), −70 dBm is standard, −75 dBm is the minimum usable signal.

## 7. Optimise AP placement

The optimiser finds how many APs are needed and where to mount them. Your existing APs are never changed until you click **Apply**.

### 7.1 Set up the optimisation

1. In the **Prediction** panel, click **B · Optimised**.

![Optimiser settings (the panel is shown in two columns here).](manual-images/optimise_settings.png)

2. Check the **AP PROFILE** line, and tick the **Bands to optimise** (2.4 GHz and/or 5 GHz). Each band is planned separately, then compared.
3. Under **TARGET**:
    - Choose the **Required signal (dBm)**: **−67**, **−70** or **−75**.
    - Choose **Fewest APs for target**, or **Best with AP budget** to get the best coverage from a set number of APs.
    - Choose the **Coverage target (%)**: **90%**, **95%** or **99%**.
    - Set **APs reaching each point** to 2 if every spot needs a backup AP.
4. Under **EXISTING APS**, choose one:
    - **Keep all of them; add new APs only where needed**
    - **Use my existing APs: keep, move or remove them**
    - **Start from scratch (ignore them)**
5. Under **MOUNTING**, tick **Wall-mounted** with its **Wall mounting height (m)**, **Ceiling-mounted**, or both. Open **Spacing and clearance** to set the distances between APs and from corners, doors and windows.
6. Tick **Preview candidate positions on the plan** to see where APs may be placed.
7. Under **RECEIVER AND ACCURACY**, set the **Device height (m)** and choose **fast**, **balanced** or **accurate**.
8. Open **Floors and rooms in the target** to include or exclude rooms, or to give a room its own required signal.
9. Click **Find AP placement**.

### 7.2 Review and apply the result

![Result of a "Start from scratch" run: one AP on the corridor's south wall (marker 1) reaches 100% coverage at −67 dBm.](manual-images/optimise_result.png)

1. Read the summary line under **RESULT**, for example "1 new AP(s) reach 100.0% predicted coverage (target 95%)".
2. Compare the **Before** and **After** tiles. Switch the map between **After**, **Before** and **Hide**, and between **Signal level** and **Covered / not**.
3. Under **RECOMMENDED APS**, check each new AP: its room, wall, position and mounting height. Numbered markers show them on the plan.
4. Open **COVERAGE BY FLOOR** and **Coverage by room** to see the change per floor and room.
5. If you optimised several bands, choose the band to view at the top of the panel. **Apply** uses the band shown.
6. Click **Apply 2.4 GHz to plan** (the label shows the band) to place the recommended APs. **Undo apply** restores the previous layout.
7. If you change the plan after a run, click **Run optimisation again**.

If your existing APs already meet the target, the result says **No new APs are needed**.

## 8. Design the cabling

**Cabling** routes one cable from every AP to a rack and lists the cable, switches, outlets and other parts. It is a preliminary estimate and never changes your plan. The page has three tabs: **Layout**, **Results** and **Settings**.

### 8.1 Racks, ceiling and routes (Layout)

![Layout tab after Suggest rack locations: the suggested rack in the store room and the three cable routes on the map.](manual-images/cabling_layout.png)

1. Click **Cabling** in the sidebar.
2. Under **Racks**, click **Suggest rack locations**. The app proposes a rack and draws a route from each AP.
3. Check the suggested rack's **Name**, **Floor**, **Role**, position (**x (m)**, **z (m)**), **Max APs**, **Space (U)**, **Power supplied (W)** and **Cooling (W heat)**.
4. Click **Confirm this rack** once the client agrees the room has power, ventilation and security. Use **Add rack to Level 1** or **Place rack on map** to add more, or drag a rack on the map.
5. For buildings with several floors, use **Add riser** or **Place riser on map**.
6. Under **Ceiling and walls**, set the **Ceiling** type, **Space above the ceiling** and **Do partitions reach the slab?** Until you do, every route is an estimate.
7. Use **Mark a wall on the map**, **Draw a cable tray**, **Draw a no-go area** and **Draw power cabling** to describe the real pathways.
8. Use **Edit a route on the map** to change a route.

On the map, green cable is within the 90 m limit, orange is near it and red is over it. A dashed cable rests on an assumption you have not confirmed. The number at each AP is that cable's length.

### 8.2 Results

![Results tab: summary, warnings and the bill of materials.](manual-images/cabling_results.png)

1. Click **Results**.
2. Read the summary line, for example "3 of 3 AP(s) routed · 86.1 m of cable · 1 switch(es)", and the warnings in orange.
3. Check the bill of materials: switches, patch panels, cable, jacks, outlets, patch cords and mounting kits.
4. Click **Download Excel (equipment list, cable schedule)** or **Download PowerPoint report**.
5. Check **Cable length per AP** and **PoE and space per rack**.

![The network schematic, with cable length, PoE voltage and power loss for each AP.](manual-images/cabling_schematic.png)

6. Under **Network schematic**, switch between **Layout (where it is on the floor)**, **Tree (branches in levels)** and **Show full size**. Click **Download schematic (SVG)** or **Download schematic (PNG)**.
7. Further down, **Network and racks** and **Compliance** list each rack and each requirement with its limit and the design value.

### 8.3 Settings and approval

![Settings tab: approval checks, equipment and limits, history and field test.](manual-images/cabling_settings.png)

1. Click **Settings**.
2. Under **Approval**, see the design level and the checks still open. Tick **I have verified the plan dimensions on site**, **I have verified the cable pathways on site** and **I have verified the equipment and parts on site** once done.

| Approval level | What it needs |
| --- | --- |
| Preliminary | Default; something still rests on an assumption |
| Validated | Ceiling and wall access stated, no estimated route, trays and racks confirmed, dimensions and pathways verified on site |
| Construction-ready | Also every route confirmed and the equipment verified |

3. Under **Equipment and limits**, choose the **AP PoE class**, **Switch**, **PoE margin kept spare (%)**, **Switch power supply**, **Fibre uplinks per switch**, **Highest oversubscription**, **Cable** and **PoE allocation**.
4. Open **Equipment catalogue (datasheet values)** to replace the illustrative part values with your real parts.
5. Use **Undo**, **Redo** and **Audit trail** to review changes.
6. After installation, click **Import field test (CSV)** to compare the certifier's measured lengths with the design.

## 9. Reports and other tools

### 9.1 Reports

| Report | Where | Needs |
| --- | --- | --- |
| Word design report (.docx) | Second icon at the top right of the Editor | A prediction; an optimisation adds the minimum AP count |
| 2.4 GHz vs 5 GHz comparison (.docx) | Third icon at the top right of the Editor | Wi-Fi APs on the plan |
| Plot image (.png) | First icon at the top right of the Editor | Nothing |
| Cabling Excel (.xlsx) | Cabling → Results | A cabling design |
| Cabling PowerPoint (.pptx) | Cabling → Results | A cabling design |
| Network schematic (.svg / .png) | Cabling → Results | A cabling design |

The Word design report includes, where data exists: executive summary, building analysis, Wi-Fi infrastructure, coverage per band, AP overlap, channel planning, AP placement, the optimisation result, room-by-room analysis, weak zones, validation against survey logs, recommendations, and appendices showing each AP alone.

### 9.2 Survey logs

1. In **Imports & logs → Network logs**, click **Import ZIP / CSV / Excel**, or type a session ID and click **Load session**.
2. Choose the **KPI** (rssi, snr, dl_thpt or ul_thpt) and tick **Show logs**.
3. Optional: tick **Aggregate to grid** and set the **Grid size (m)** and **Aggregation**.
4. Edit the **Threshold bands** to set colours and ranges.
5. Click **View overlays in editor**.

### 9.3 Geo alignment

GPS survey logs need the building placed on the map.

![Geo alignment.](manual-images/geo.png)

1. Click **Geo alignment** in the sidebar.
2. Click **Set up building on map** and click the building's location, or type the **Latitude** and **Longitude**.
3. Set **Plan anchor X (m)** and **Plan anchor Z (m)** to the matching point on the plan.
4. Set the **Rotation (°)**. At 0° the right of the plan is east and the top is north.
5. Click **Save alignment**. The **Geographic preview** shows the result.

### 9.4 Saving and backups

- Every edit saves automatically. The toolbar shows **Saving…**, **Saved**, **Unsaved** or **Save failed**.
- **Undo** and **Redo** are in the bottom bar (Ctrl+Z and Ctrl+Y).
- Projects are stored on your computer in the app's data folder. To back up, close the app and copy that folder.
- Licence expiry never deletes projects.

## 10. Troubleshooting

| Problem | What to do |
| --- | --- |
| Activation key is rejected | Check the key was issued for the Machine ID shown on this computer, and that the date and time are correct. |
| App locked after some days | The licence has expired. Send your Machine ID to your supplier for a new key; projects are kept. |
| Save status shows Save failed | Keep the app open and try the edit again. If it persists, restart the app. |
| Room moves when you try to select it | Choose **Cursor**. Turn on **Static** in the bottom bar or in Property. |
| Door will not place | Zoom in and click closer to a room wall. |
| 2D view moved out of position | Hold **Ctrl** and drag to pan back; use the mouse wheel to zoom. |
| "Place a Wi-Fi access point first" | Add at least one Wi-Fi AP before running a prediction. |
| Prediction is slow | Increase **Resolution (m)**, lower **Samples per AP**, or choose **gpu** as the device. |
| "The plan changed after this run" | Run the prediction, optimisation or simulation again. |
| **Use in the editor** is greyed out | No scale is set. Enter one known length or the real image width, then click **Apply this scale**. |
| Floor-plan import looks wrong | Check the scale, try another **Method** in Detection settings, then correct items under **To review**. |
| Cabling routes are dashed | Fill in the ceiling and wall settings, and confirm racks and routes. |
| Map search gives no results | Map search needs a configured Google Maps key; ask your administrator. |

All coverage and cabling figures are planning estimates. Validate the design with a site survey before installation.
