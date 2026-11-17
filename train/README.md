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
