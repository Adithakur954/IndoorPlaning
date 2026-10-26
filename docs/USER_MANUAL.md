# Indoor Planner user manual

Indoor Planner lets you draw or import a building floor plan, place network equipment, estimate radio coverage, compare measurements, and align a floor to a real location. This manual explains the main screens and common workflows.

## 1. Open the application

For a local installation, start the app from the project folder:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the **Local** URL printed in the terminal. The project list is the starting page. See the [README](../README.md) for production startup and optional integrations.

## 2. Create and manage projects

1. On the project list, choose **New project** or **Create indoor project**.
2. Enter a project name. A new project opens in the Editor with an initial floor.
3. Use the sidebar to rename the project, return to the project list, switch sections, and manage floors.
4. Projects save automatically after edits. The Editor header shows the save status. Wait for **Saved** before closing the app or navigating away after a large import.
5. Select a project card to reopen it. Use its delete action to remove a project.

Projects and their plans are stored locally by the app server. Back up `data/projects.json` to keep a copy of saved project data.

## 3. Draw and edit a floor

### Choose a drawing tool

The Editor header contains quick tools:

- **Cursor** selects objects and allows them to be moved when the floor is not set to Static.
- **Rectangle** adds a rectangular room where you click. After placing it, the active tool returns to Cursor.
- **Polygon** adds a point with each click. Choose **Finish polygon** after at least three points; the active tool then returns to Cursor.

Choose **More tools** for Circle, Wall, Door, Window, Furniture, Cellular, and Wi-Fi tools. A wall is drawn by clicking its start point and then its end point. Select **Cursor** to stop drawing and work with existing objects.

### Navigate the plan

- In 2D, use the mouse wheel to zoom and hold **Ctrl** while dragging to pan the floor.
- In 3D, drag to rotate the view, use the wheel to zoom, and use the right mouse button to pan.
- Choose 2D, 3D, or Split in **More tools**. In Split view, both views show the same floor data.
- **Snap 0.5 m** rounds placement and dragging to half-metre increments.

### Select and resize objects

1. Choose **Cursor**, then select a room, wall, source, furniture item, door, or window.
2. Edit the selected object's fields in the right-hand inspector. Use the delete button at the bottom of the inspector to remove it.
3. For rectangular rooms, the arrow beside **Width** or **Depth** chooses which side expands when the dimension changes. Click the arrow to reverse direction; the opposite edge stays in place.
4. Polygon rooms can be reshaped by dragging a corner or edge in the 2D view, or by editing their vertices in the inspector.
5. A door must be placed on a room wall. If placement fails, zoom in and click closer to the wall edge.

### Manage floors

Use the **+** beside **Floors** in the sidebar to add a floor. Select a floor to edit it. Expand a floor row to see its rooms. Floor names and elevations are part of the saved project.

## 4. Adjust project properties and labels

Choose **Property** in the Editor header. Project properties include carpet area, static behavior, and independent label visibility:

- **Hide room names** hides room labels.
- **Hide furniture/table names** hides furniture labels.
- **Hide Wi-Fi antenna names** hides Wi-Fi labels only. Cellular source labels are controlled separately and remain visible.

These display preferences are saved with the project. **Static** locks room dragging; turn it off to move rooms with the Cursor tool.

## 5. Add Wi-Fi or cellular sources and estimate coverage

1. Open **More tools** and choose **Wi-Fi** or **Cellular**.
2. Click on the floor to add a source. Select the source to edit its name, technology, power, frequency, antenna gain, pattern, height, and direction. Directional sources can have sectors.
3. Open **Network & RF** in the sidebar to adjust grid step, coverage threshold, receiver gain, and wall or door loss.
4. Turn on **Show prediction heatmap** to view the estimate. The panel reports sample count, covered cells, and estimated covered/uncovered area.

Coverage is a planning estimate based on the drawn geometry and configured source values. It is not a calibrated measurement or a guarantee of real-world signal.

## 6. Import a building or floor-plan image

Open **Imports & logs** in the sidebar.

### Import a building workbook

Choose **Import building Excel** and select an `.xlsx` file. Supported workbook layouts include `BuildingMeta` with `Floor_1`, `Floor_2`, etc., or `FloorMeta` with `Rooms`; optional sheets can describe doors, windows, interior walls, and furniture. Coordinates in metres, feet, centimetres, and millimetres are converted to metres. Choose **Download example template** for a starter workbook.

### Upload an image

1. Set the image width in metres and choose **Upload image and quick scan**. PNG, JPEG, and WebP images up to 8 MB are accepted.
2. The quick scan proposes enclosed rooms. For more complex or open office drawings, choose **Trace full plan with AI** if the integration is configured.
3. Review the proposed rooms, walls, and desk groups. Preview them in the Editor, edit the draft, then apply or discard it. You can download a reviewed trace workbook.

Image detection and AI tracing produce approximate geometry. Check the dimensions and boundaries against the source plan before using them for coverage estimates.

## 7. Import and display measurement logs

In **Imports & logs**, choose an input file or load a session:

- Import a `.csv`, `.xlsx`, or ZIP containing `NetworkLog_*.csv` files.
- Use **Browse** to see session files available on the local server, or enter a session ID and choose **Load session**.
- Select a KPI, turn **Show logs** on or off, and optionally aggregate measurements to a grid. Adjust grid size and aggregation method as needed.
- Edit the threshold-band colors and ranges to match the display you need.
- Use **View overlays in editor** to inspect measurements on the floor plan.

GPS measurements need a saved geographic alignment before they can be projected onto a floor. Session files are read from the server's `data/sessions/` directory.

## 8. Align a building to a real location

1. Open **Geo alignment** in the sidebar.
2. Choose **Set up building on map**. Search for a place with the map search button if place search is configured, or navigate the map and click the building location. The marker can also be dragged.
3. Use the latitude and longitude fields for the geographic point, and the plan anchor X and Z fields for its matching point in the floor plan.
4. Set the rotation and choose **Save building alignment**. The room outlines are shown over the satellite map to help line up the building.

At zero rotation, local +X points east and local +Z points north. For map place search, configure `VITE_GOOGLE_MAPS_API_KEY` in `.env`, enable Maps JavaScript API and Places for the key's Google Cloud project, and restart the dev server. If search fails while the map loads, check the error shown in the search panel and verify that the key's API restrictions and billing settings allow the required services.

## 9. Common issues

| Issue | What to check |
| --- | --- |
| Project list or editor does not load | Confirm the local API started with the dev command. Check the terminal for the API URL and startup errors. |
| Save status stays on Saving or shows an error | Keep the app open and check that the local server is running. Look for an API error notice in the page. |
| Places search has no suggestions | The satellite map and place search use different Google services. Check the API key, enabled Maps JavaScript and Places APIs, billing, and key restrictions. |
| Floor image trace looks inaccurate | Treat detections as a draft. Review dimensions, remove incorrect proposals, and compare with the original image. |
| Room moves instead of selecting | Choose Cursor. If the floor is Static, turn Static off in Properties to allow dragging. |
| 2D view moved out of position | Hold Ctrl and drag to pan back; use the mouse wheel to zoom. |

For installation, server configuration, data storage, and implementation details, see the [README](../README.md) and [project code guide](PROJECT_GUIDE.md).
