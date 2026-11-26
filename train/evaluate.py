"""Detailed report for a trained model.

    train/.venv/Scripts/python.exe train/evaluate.py --ckpt train/runs/run1/best.pt --split test
    train/.venv/Scripts/python.exe train/evaluate.py --ckpt train/runs/run1/best.pt --real path/to/real_plans \
        [--real-masks path/to/real_masks]

--split reports on the synthetic val/test set: per-class IoU / precision / recall / F1, a confusion matrix, and the
same numbers split by home/office, wall thickness, JPEG/damaged images and image size.  Synthetic scores come from the
same generators as training, so they are an upper bound.

--real runs the model on real plans the model never saw and writes overlay pictures; with --real-masks (same file
stems, class ids 0-5) it also scores them.  This is the number that says whether the model is production-ready.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import train_seg as T  # noqa: E402

COLORS = np.array([[0, 0, 0], [60, 60, 220], [60, 190, 60], [220, 140, 40], [150, 235, 240], [200, 60, 170], [0, 140, 255],
                   [0, 200, 255], [255, 110, 20], [180, 200, 0], [120, 0, 160], [60, 170, 60], [0, 90, 200], [150, 150, 150],
                   [220, 60, 180], [130, 130, 255]], np.uint8)  # BGR; the last two: stairs, void (run 6)


def load_model(path, device):
    """A trained model that returns class scores only (a run-6 centre-line channel is cut off), for evaluation
    and ONNX export."""
    ck = torch.load(path, map_location=device)
    n = ck.get("n_classes", 6)
    extra = 1 if ck.get("centreline") else 0
    model = T.make_model(ck["encoder"], n + extra).to(device).to(memory_format=torch.channels_last)
    model.load_state_dict(ck["model"])
    if extra:
        model = T.ClassLogits(model, n).to(device)
    model.n_classes = n
    return model.eval(), ck


def table(title, cm):
    s = T.scores(cm)
    print(f"\n{title}   key IoU {s['key']:.4f}   mIoU {s['miou']:.4f}")
    print(f"  {'class':11s} {'IoU':>6s} {'prec':>6s} {'recall':>6s} {'F1':>6s}")
    for i, c in enumerate(T.CLASSES):
        print(f"  {c:11s} {s['iou'][i]:6.3f} {s['precision'][i]:6.3f} {s['recall'][i]:6.3f} {s['f1'][i]:6.3f}")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", default=os.path.join(HERE, "dataset_v3"))
    ap.add_argument("--split", choices=["val", "test"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--real")
    ap.add_argument("--real-masks")
    ap.add_argument("--out", help="folder for overlay pictures (default next to the checkpoint)")
    args = ap.parse_args()
    device = torch.device("cuda")
    model, ck = load_model(args.ckpt, device)
    out = args.out or os.path.join(os.path.dirname(args.ckpt), "eval")
    os.makedirs(out, exist_ok=True)
    print(f"checkpoint step {ck['step']}  score {ck['score']:.4f}")
    report = {}

    if args.split:
        items = T.list_split(args.data, args.split)
        if args.limit:
            items = items[:args.limit]
        groups = {}
        total = np.zeros((len(T.CLASSES),) * 2, np.int64)
        for n, it in enumerate(items):
            img, mask = T.PlanData.load(it)
            meta = json.load(open(it[2]))
            cm = T.confusion(T.predict(model, img, device), mask)
            total += cm
            w = meta["wall_px"]
            tags = ["kind=" + meta["kind"],
                    "wall<5px" if w < 5 else "wall5-10px" if w < 10 else "wall>10px",
                    "jpeg" if "jpeg_quality" in meta else "png",
                    "small(<1000px)" if max(meta["size"]) < 1000 else "large(>=1000px)",
                    "damaged" if meta.get("damage") else "clean"]
            if meta.get("shrink"):
                tags.append("shrunk")
            for t in tags:
                groups.setdefault(t, np.zeros((len(T.CLASSES),) * 2, np.int64))
                groups[t] += cm
            if n % 200 == 0:
                print(f"  {n}/{len(items)}", flush=True)
        report["overall"] = T.scores(total)
        table(f"{args.split} - all {len(items)} images", total)
        print("\nconfusion matrix (rows = truth, columns = predicted), % of the truth class:")
        print("  " + " ".join(f"{c[:5]:>6s}" for c in T.CLASSES))
        for i, c in enumerate(T.CLASSES):
            print(f"  {c[:5]:5s} " + " ".join(f"{100 * v:6.1f}" for v in total[i] / max(total[i].sum(), 1)))
        print("\nby group (IoU per class | key IoU):")
        for t in sorted(groups):
            s = T.scores(groups[t])
            print(f"  {t:18s} " + " ".join(f"{c[:4]} {v:.2f}" for c, v in zip(T.CLASSES, s["iou"])) + f" | {s['key']:.3f}")
        report["groups"] = {t: T.scores(g)["key"] for t, g in groups.items()}

    if args.real:
        names = sorted(f for f in os.listdir(args.real) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")))
        total = np.zeros((len(T.CLASSES),) * 2, np.int64)
        for f in names:
            img = cv2.imread(os.path.join(args.real, f), cv2.IMREAD_COLOR)
            if img is None:
                continue
            pred = T.predict(model, img, device)
            ov = cv2.addWeighted(img, 0.55, COLORS[pred], 0.45, 0)
            cv2.imwrite(os.path.join(out, os.path.splitext(f)[0] + "_pred.png"), np.hstack([img, ov]))
            if args.real_masks:
                mp = os.path.join(args.real_masks, os.path.splitext(f)[0] + ".png")
                if os.path.exists(mp):
                    total += T.confusion(pred, cv2.imread(mp, cv2.IMREAD_GRAYSCALE))
        print(f"\nwrote {len(names)} overlays to {out}")
        if total.sum():
            report["real"] = T.scores(total)
            table("REAL plans", total)

    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump(report, f, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o), indent=1)


if __name__ == "__main__":
    main()
