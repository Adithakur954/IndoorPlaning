# Floor-plan segmentation model

`floorplan_unet_run6.onnx` (current, from 2026-11-24; run5 and run4 kept: to go back, set `MODEL_NAME` in
`floorplan/model.py`) (not in git; 97.8 MB). Run 6: U-Net (ResNet-34 encoder) trained from scratch on the dataset_v6
mix (40 % dataset_v4, 60 % hard cases: dense CAD and RF exports, low resolution, hatched voids, overlays) with
Skeleton Recall Loss and a wall centre-line head (the head is cut off in the export). 16 classes: the 14 below plus
14 stairs and 15 void. Best checkpoint step 76,000 (structure score 0.937 on v6 validation). Export checked against
PyTorch: 99.999-100 % label agreement.

Previous: `floorplan_unet_run5.onnx` (current; run4 kept as `floorplan_unet_run4.onnx` — to go back, set `MODEL_NAME` in `floorplan/model.py`) (not in git; 97.7 MB). A U-Net (ResNet-34 encoder) trained from scratch, no pretrained
weights, on synthetic plans. Classes: 0 background, 1 wall, 2 door, 3 window, 4 floor, 5 column, 6 AP marker.
Input: BGR image / 127.5 - 1, any size (padded to a multiple of 32). Runs on the CPU with onnxruntime
(about 1 s for a 1600 x 1400 plan).

Regenerate: `train/.venv/Scripts/python.exe train/export_onnx.py --ckpt train/runs/run4/best.pt --out worker/models/floorplan_unet_v1.onnx`
(run4, step 33,000; the export is checked against PyTorch: 99.998 % label agreement).

## Data and licences
Homes: ResPlan (17,000 vector plans, data CC BY 4.0, code MIT) rendered by our own renderer. Offices: our own
generator. No CubiCasa5K / FloorPlanCAD / ArchCAD data (non-commercial) was used. ResPlan attribution:
see `train/LICENSES.md`. Not legal advice.

## Measured accuracy (be careful how you read this)
Synthetic test split (2,719 images, same generators as training, so an upper bound): key IoU 0.924
(wall 0.94, door 0.88, window 0.92, column 0.94, AP marker 0.94).

The only real drawing with a (hand-traced, loose) truth, `worker/samples/floorplan/real_coworking.jpg`:

| engine | wall recall | wall precision | rooms found (10 in truth) | room IoU |
|---|---|---|---|---|
| classical (built and tuned on this plan) | 0.98 | 0.91 | 10 | 0.93 |
| learned model | 0.82 | 0.75 | 3 | 0.00 |
| hybrid | 0.98 | 0.71 | 16 | 0.71 |

The classical method was developed against this very plan, so this favours it. The model has never seen it.
The model gives per-pixel labels, not a building: the wall-line, opening and room code after it is the same for
all engines. Known weak spots: images under about 1,000 px, the outer edge strip of some plans, symbols that
look like AP markers.
