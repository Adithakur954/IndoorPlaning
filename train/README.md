# Training data for the floor-plan segmentation model

Everything for training lives in this folder; nothing here is used by the app.

    train/raw/resplan/           ResPlan.zip as downloaded (untrusted data)
    train/raw/resplan_data/      ResPlan.pkl (loaded only through safe_pickle.py, which allow-lists classes)
    train/render_plan.py         draws a plan as a random-style image + exact mask, then damages it
    train/make_dataset.py        builds many images with a progress bar and time estimate
    train/preview.py             image | label-overlay previews and contact sheets

Mask values: 0 background, 1 wall, 2 door opening, 3 window opening, 4 room floor.

Commands (use the worker venv python):

    python -I train/make_dataset.py --count 3 --out train/samples --pick 5,2003,9007 --workers 3
    python -I train/preview.py train/samples
    python -I train/make_dataset.py --count 25000 --out train/dataset_v3 --workers 12   # resumable
    python -I train/preview.py train/dataset_v3 --n 24

## Training

Separate environment (Python 3.10, PyTorch CUDA 12.8): `train/.venv` (git-ignore it).

    train/.venv/Scripts/python.exe train/train_seg.py --smoke                      # ~2 min speed / sanity check
    train/.venv/Scripts/python.exe train/train_seg.py --out train/runs/run1        # full run, resumable with --resume
    train/.venv/Scripts/python.exe train/evaluate.py --ckpt train/runs/run1/best.pt --split test
    train/.venv/Scripts/python.exe train/evaluate.py --ckpt train/runs/run1/best.pt --real <real plans folder>

U-Net (resnet34 encoder, no pretrained weights) trained from scratch. Stops automatically when the validation key IoU
(wall/door/window/column) gains less than 1e-4 for 5 evaluations in a row (after 6,000 steps); best.pt is always kept.

## Dataset v6 (hard cases) and the run-6 mix

`dataset_v4` is kept exactly as it is. The new hard-case images go into `dataset_v6`, and `mix_v6.json` tells
training to draw **40 %** of its images from `dataset_v4` and **60 %** from `dataset_v6`, reading both folders in
place (nothing is copied, nothing in v4 is written).

    train/render_hard.py       hard-case generator: exact geometry in metres -> image + labels + vector truth
    train/damage_v6.py         damage that moves image, mask and centre-lines together; 16-class label-aware shrink
    train/make_dataset_v6.py   builds dataset_v6 (resumable) and preview sheets
    train/audit_v6.py          checks labels, centre-lines, sizes, seeds, splits and that every room has a door path
    train/mix_v6.json          the 40 / 60 mix; train/mix_v6.py reads it (sampler + loader)

    python -I train/make_dataset_v6.py --count 30 --out train/samples_v6 --workers 10 --preview
    python -I train/make_dataset_v6.py --count 36000 --out train/dataset_v6 --workers 28
    python -I train/audit_v6.py train/dataset_v6
    python -I train/mix_v6.py train/mix_v6.json

Labels: the v4 classes 0-13 keep their meaning; two are new: **14 stairs** and **15 void** (hatched, cross-hatched,
dotted or grey-filled areas that are not wall: shafts, risers, voids, "open to sky", mezzanine fills).
Extra files per image: `lines/` (wall centre-lines, 255, never through openings) and `geom/` (room polygons, doors
with the two spaces they join, windows, wall lines). Old v4 images get their centre-lines from the wall mask at
load time.

What the hard cases contain (every element drawn from known geometry, so the labels are exact):
* building types: RF-design office, CAD office, factory / warehouse, schematic, hospital, hotel, mall,
  school with auditorium, car park, residential CAD; difficulty 1-5 per image
* geometry: L / U / T / chamfered / notched footprints, rotated wings, curved facades, circular and octagonal
  rooms with doors in the curve, heavier cores, variable wall thickness, double-loaded corridors, lift cores
* doors: swing, double, sliding, pocket, folding, roller shutter, revolving, plain gaps; every room reachable
* hard negatives (never wall): hatched voids beside hatched walls, stair treads, spiral stairs, lift X boxes,
  racks, conveyors, machines, parking bays, ducts, ceiling grids, sprinklers, lights, grid lines and bubbles,
  dimension chains (also across the plan), site roads, trees, truck docks, legends, title blocks, banners
* RF overlays: antenna / small-cell / Wi-Fi icons (class 6), ANT / AP / SPT / sector labels, cable runs that
  hug and cross walls, BBU boxes, coverage heat tints
* sheets: white, dark CAD, blueprint, sepia, grey; walls solid / outline / hatched / poche / thin / material
  colours / heavy exterior; department colour fills; highlighted room names; arrows
* damage: rotation, stretch, perspective, folds, torn corners (not judged), pen markups, stains, faded and
  broken ink, photocopies of photocopies, misregistered colour, low resolution, blur, noise, JPEG
