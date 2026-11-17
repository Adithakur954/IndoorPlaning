# Floor-plan image → editable building

Upload a PNG, JPG or PDF floor plan; get walls, doors/windows and rooms in
metres as ordinary objects of this planner (editable in 2D, shown in 3D,
exported to the Sionna RT scene). Everything runs **locally and for free**: no
cloud service, no API key.

Status: a working prototype. It is measured on drawn-by-code office plans and
on **one real drawing** (the colour-coded coworking floor in
`worker/samples/floorplan/real_coworking.jpg`, scored against a reference traced
by eye). Everything else about real drawings is still unmeasured. Read "Limits
and what is not done" before relying on it.

## Where it is in the app

**Imports & logs → Floor plan image → building**

1. **Choose floor plan** (PNG / JPG / PDF). Detection starts at once, with no
   clicks (walls, openings, rooms, columns, markers, text).
2. **Scale.** The program first looks for printed sizes ("PHONE POD 3'8" X
   3'8"", "PD-7 8'6" X 6'") on closed boxes; if at least two independent labels
   agree it uses that scale and says so. Otherwise it asks for **one** known
   length: click two points whose real distance you know and type it, or enter
   the real width of the picture. No scale is ever guessed from the picture;
   without one the result stays in pixels and **Use in the editor** is disabled.
3. **Detect.** Runs in a background process (the page stays usable). Shows
   walls, rooms, doors/windows found, how many items are uncertain, an overlay
   of what was detected (green = confident, orange = unsure, red = doubtful;
   blue door, cyan window, purple unclear; red circles = wall ends that join
   nothing), the wall mask, timings and peak RAM, warnings, and the list of
   assumptions.
4. **Use in the editor.** Adds the rooms, doors, windows, loose partition
   walls and columns to the chosen floor (optionally replacing what is on it),
   sets the wall thickness, and puts the straightened drawing under the plan as
   the floor image. Items read with low confidence are marked with orange
   dashes and listed under **To review** (least certain first) in the floor
   properties; each can be confirmed or corrected with the normal editor tools.
   **Geometry checks** list invalid outlines, duplicates, openings that do not
   fit their wall, and rooms that lie off the drawing.

Rooms can be marked **receiver grid: excluded** (room properties); they are then
left out of the prediction map/statistics and of the optimiser's coverage target.

## Install

```bash
cd worker
python -m venv .venv            # already present if Sionna RT is installed
.venv\Scripts\python -m pip install -r requirements.txt
```

The floor-plan part needs `opencv-python-headless`, `scikit-image`, `shapely`,
`pypdfium2`, `rapidocr` and `onnxruntime` (all in `requirements.txt`). The OCR
models ship inside the `rapidocr` wheel: no separate weight download.
Nothing here needs a GPU; the whole pipeline runs on the CPU.

Run it directly:

```bash
python -m floorplan preview plan.pdf preview.png
python -m floorplan job.json     # {"image": ..., "out_dir": ..., "scale": {...}, "options": {...}}
```

The Node API (`/api/floorplan/...`) runs the same thing as a background job:
`POST /uploads` → `POST /jobs/:id/run` → `GET /jobs/:id` (poll) →
`GET /jobs/:id/files/{overlay,walls_mask,deskewed}.png`. Uploads and results
live in `data/floorplan/` and are deleted after 7 days.

Restart `npm run dev` (the API changed) after pulling.

## How it works

| Step | Method |
|---|---|
| Load | PNG/JPG (EXIF-aware); PDF page rendered with pypdfium2 at 200 dpi |
| Size | long side shrunk to ≤ 4000 px; under 1500 px enlarged up to 3x so thin partitions stay several pixels wide; all geometry is mapped back through the recorded factor |
| Straighten | dominant line angle from long Hough lines; rotation recorded (`image.deskewDeg`); the straightened image is what the plan is drawn on |
| Ink | contrast stretch, Otsu cut limited to clearly dark strokes; a second, lighter cut keeps thin door arcs and glazing lines |
| Text | RapidOCR finds room labels and dimension text; those boxes are erased before wall detection; labels are put into the room that contains them |
| Wall thickness | stroke width along the skeleton; each width peak scored by how much of it forms long (≳ 2.5 m) strokes, so furniture outlines and symbols do not win |
| Walls | thick strokes only (morphological opening sized from the thickness), long line kernels for horizontal/vertical walls, a second pass for slanted ones (lower confidence); double-line walls are detected by pairing parallel lines at the common spacing and filling between them |
| Clean-up | collinear pieces merged (a gap of 0.3–2.6 m becomes an opening candidate), ends snapped onto the walls they meet, short isolated marks dropped, small square isolated blocks reported as columns |
| Openings | a quarter-circle arc around either end of the gap → door (with hinge and swing side); a line across the gap inside the wall → window; otherwise "opening" (flagged for review) |
| Rooms | closed faces of the wall centre-lines (Shapely polygonize); openings sit inside continuous wall lines so rooms stay closed through them |
| Topology | free wall ends, invalid or overlapping rooms, rooms whose outline is not on detected walls, anything touching the image edge |
| Confidence | wall: how much of its line lies on drawn wall (outside gaps), free ends and image-edge contact lower it; room: wall support, irregularity, border contact; opening: arc/line evidence |

The result (`result.json`) holds pixel and metre coordinates for every wall,
opening, room and column, confidences and notes, the topology report, the list
of uncertain items, the scale with its source, the assumptions, and timings.

## Models evaluated (CubiCasa5K, RoomFormer, Raster2Seq)

I read their public pages; I did not download or run any of them. They are
**not used** in this prototype, for these reasons:

* **RoomFormer** (code labelled MIT on its GitHub page). It predicts room
  polygons from a *density map of a point cloud* (Structured3D, SceneCAD), not
  from a raster architectural drawing, so it does not fit this input without
  retraining. Weights/dataset licences are not stated on the page.
* **CubiCasa5K.** A segmentation network trained on 5,000 (mostly
  residential) plans, with a LICENSE file in the repository. I could not read
  the licence text, and I could not confirm the terms of the dataset or the
  pretrained weights. Treat them as unverified (possibly non-commercial) until
  the LICENSE and the Zenodo/Drive pages are read.
* **Raster2Seq.** Converts raster plans to room/door/window polygons; the page
  mentions code but no released weights, and states no licence.

None of them claims or was measured to be 90% accurate on commercial office
plans, and none produces wall centre-lines with openings in the form this app
needs. Adding one later (for example as a segmentation prior for the wall
mask) is possible where the licence allows; the pipeline is modular for that.

Licences of what **is** used: OpenCV (Apache-2.0), scikit-image (BSD),
Shapely (BSD), pypdfium2 (Apache-2.0/BSD), RapidOCR (Apache-2.0, PaddleOCR
models Apache-2.0), onnxruntime (MIT).

## Accuracy: what has been measured

`python evaluate_floorplan.py --synthetic` (CPU, results on this PC).
**These plans are drawn by code with exact reference geometry; they prove the
pipeline works, not that it works on your drawings.**

| case | wall P / R | centre-line dev (cm) | room IoU | room P / R | opening P / R | door-vs-window | seconds | peak RAM (MB) |
|---|---|---|---|---|---|---|---|---|
| clean office | 1.00 / 1.00 | 3.8 | 0.98 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 | 0.4 | 147 |
| skewed 3° | 1.00 / 1.00 | 3.8 | 0.98 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 | 0.3 | 151 |
| noisy + skewed | 1.00 / 1.00 | 3.7 | 0.98 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 | 0.5 | 154 |
| double-line walls | 1.00 / 1.00 | 4.9 | 0.98 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 | 0.3 | 154 |
| same plan as PDF | 1.00 / 1.00 | 2.4 | 0.99 | 1.00 / 1.00 | 1.00 / 1.00 | 0.94 | 1.4 | 290 |
| large 7360 × 4800 px | 1.00 / 1.00 | 2.4 | 0.99 | 1.00 / 1.00 | 1.00 / 1.00 | 0.94 | 1.4 | 400 |
| with OCR | 1.00 / 1.00 | 2.4 | 0.99 | 1.00 / 1.00 | 1.00 / 1.00 | 0.94 | 2.8 | 497 |

Also checked by hand: pastel room fills, grey (not black) walls, half
resolution (needed the small-image enlargement above), hatched walls.

Metrics are separate structural measurements (wall precision/recall within
25 cm, centre-line deviation, room IoU and matching at IoU ≥ 0.5, opening
matching within 0.5 m, dangling ends, scale error). They are **model
predictions**; the "user-corrected" figures the brief asks for need real
plans that someone has corrected, and do not exist yet.

To measure a real drawing:

```bash
python evaluate_floorplan.py --image plan.png --truth truth.json --px-per-m 40
```

`truth.json` format: see `worker/floorplan/evaluate.py` (walls, openings, rooms
in metres, origin top-left of the image).

## Performance

Whole pipeline, one floor: 0.3–1.4 s without OCR, ~3 s with OCR (CPU,
24 threads), peak RAM 150–500 MB. The RTX 5070 Ti is not used: there is no
neural network in the pipeline yet. It runs in a separate process, one job at a
time (queue of 4), with a 10-minute limit, so the web app stays responsive.

## Limits and what is not done

Real failure modes to expect (not yet seen on real drawings, but by design):

* **Walls drawn only as thin single lines** (no fill, no second line) are line
  work, not walls; there is no thickness to separate them from furniture.
* **Curved walls**, walls under dense text/dimensions, wall hatching that breaks
  the outline, plans where doors have no gap in the wall line.
* **Colour-coded plans** where walls and furniture share a colour and weight.
* **Doors/windows in walls that are not part of a closed room** are dropped
  (reported as a warning); partition walls are kept but without openings.
* Door vs window comes from drawn symbols; unclear gaps are "opening" and are
  marked for review (treated as doors until you decide).
* A drawing cropped at the image edge is flagged, not repaired.

Not implemented from the brief: stairs, lift shafts and floor-boundary
detection; furniture as objects (it is only suppressed; columns are kept);
automatic scale from OCR dimensions (dimension text is read and returned, but
the scale is only ever taken from you); neural-network detection and tiled
inference; automatic alignment of several floors (each floor is imported on
its own and aligned by hand, e.g. by editing positions or rotating a floor);
persistent "corrections as data" beyond the edited plan itself (corrections are
stored in the plan, so re-importing the same file starts again); floor/ceiling
surfaces beyond what the existing scene export already creates; material
detection (every wall is drywall until you set it; marked as an assumption).

Walls, rooms and openings are the part that works. Treat everything else above
as open work, and send me real plans with a known dimension to measure it.


## The real coworking plan (first real drawing)

`worker/samples/floorplan/real_coworking.jpg`: a 1600 × 1396 px JPEG of an
open-plan coworking floor: colour-coded CAD layers, hatched outer walls, desks
and chairs everywhere, planters, columns as yellow/orange blocks, door swings
in yellow, dimension lines in teal, and black round AP markers already drawn on
it. Only the cabins/pods and a few partitions are enclosed.

What the first attempt did (before this work): it called desk spines, planters,
the AP markers and text "walls" and found 2 rooms.

What was added for this kind of drawing:

* **Colour layers.** Walls are read from neutral dark strokes only; green
  planters, yellow/orange columns, yellow door arcs, teal dimension lines and
  coloured text are kept out of the wall mask (and used for columns/doors).
* **AP markers** (black ring around a yellow dot) are recognised, removed from
  the wall mask and returned in `result.markers` (positions in px and metres).
* **Hatched outer walls** are read from their two thin outlines (double-line
  detection) and from a band-density search along each edge of the drawing.
* **Weak-evidence bridging.** A wall that is still drawn along a gap (a marker
  or faint hatching over the line) is joined, not turned into an opening.
* **Free ends** that stop at a marker are carried on to the wall behind it.
* **Building envelope.** A side with no outer wall found is closed by the
  drawing frame as a *virtual wall* (flagged, confidence 0.3) so the floor
  becomes a room; this plan is cut off at the top.
* **Furniture scraps.** Thick filled blocks (desk tops), tiny isolated pieces
  and small wall networks not attached to the envelope are dropped; loose
  low-confidence wall pieces are not added to the plan (they would block the
  signal in the simulation) but are reported.

Result against a reference traced by eye (about ±5 px, so read it loosely),
with the scale 45.6 px/m read from the plan's own dimension chain
(13' = 180 px, 14'-10" = 206 px):

| | measured |
|---|---|
| walls (precision / recall, 35 cm tolerance) | 0.88 / 0.98 |
| rooms: mean IoU, precision / recall | 0.93, 0.90 / 1.00 (all 9 reference rooms matched, 1 extra) |
| found | upper floor area (500 m²), lower floor area (327 m²), 7 cabin rooms, the lift-shaft area; 12 columns, 8 AP markers |
| time (CPU, with OCR) | about 4 s without the scale search, up to ~15 s with it |

The precision is below 1 because the detector also finds real walls that my
reference leaves out (the glass offices at the top) and a few scraps next to
the markers (low confidence, listed under **To review**).

Not found on this plan: the lighter grey band at about y = 472 is only partly
a wall in the result; the two lift-shaft rooms are not closed (their right side
is hatched piers with gaps) and merge into the floor; door types are partly
unclear ("opening"); wall hatching in very faint JPEGs can be missed.

**Scale on this plan is not automatic.** The dimension numbers are about 5 px
tall in this JPEG and could not be read (only one of them came out, as "1410"),
and only one pod label was legible, so the "two labels must agree" rule correctly
refuses to guess. With a vector PDF or a higher-resolution export of the same
drawing, OCR of the dimension chain would very likely work; that matching
(number to dimension line) is not built yet. Until then this plan needs one
click-pair and one number.
