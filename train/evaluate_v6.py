"""Scores a model on the v6 mix with the structure metrics (metrics_v6.py): rooms that close, walls that
connect, false walls, doors found. Evaluation only, nothing is trained.

    # the model in use (run 5, ONNX, CPU) - worker venv
    python -I train/evaluate_v6.py --onnx worker/models/floorplan_unet_run5.onnx --limit 150 --out train/runs/run5/eval_v6.json
    # a training checkpoint (GPU) - train venv
    train/.venv/Scripts/python.exe train/evaluate_v6.py --ckpt train/runs/run6/best.pt --limit 150

Each source of the mix (dataset_v4 and dataset_v6) is reported on its own and together; the per-theme and
per-difficulty split of v6 shows where a model fails.
"""
import argparse
import json
import os
import random
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import metrics_v6 as M  # noqa: E402
import mix_v6  # noqa: E402


def onnx_predictor(path):
    sys.path.insert(0, os.path.join(HERE, "..", "worker"))
    os.environ["FLOORPLAN_MODEL"] = os.path.abspath(path)
    from floorplan import model as net  # noqa: E402
    net.MODEL_PATH = type(net.MODEL_PATH)(os.path.abspath(path))
    net._session = None

    def predict(img):
        labels, _ = net.segment(img)
        return labels
    return predict


def ckpt_predictor(path):
    import torch
    import train_seg
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    ck = torch.load(path, map_location=dev)
    n = ck.get("n_classes", len(train_seg.CLASSES))
    model = train_seg.make_model(ck.get("encoder", "resnet34"), n + (1 if ck.get("centreline") else 0)).to(dev)
    model.load_state_dict(ck["model"])
    model.eval()

    def predict(img):
        return train_seg.predict(model, img, dev, n_classes=n)
    return predict


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--onnx")
    g.add_argument("--ckpt")
    ap.add_argument("--mix", default=os.path.join(HERE, "mix_v6.json"))
    ap.add_argument("--split", default="val")
    ap.add_argument("--limit", type=int, default=150, help="images per source (0 = all)")
    ap.add_argument("--out")
    args = ap.parse_args()
    manifest = mix_v6.read_manifest(args.mix)
    predict = onnx_predictor(args.onnx) if args.onnx else ckpt_predictor(args.ckpt)
    items = mix_v6.list_mix(manifest, args.split)
    rng = random.Random(0)
    report = {"model": args.onnx or args.ckpt, "split": args.split, "sources": {}}
    every = M.Aggregate()
    by_theme, by_diff = {}, {}
    t0 = time.time()
    for si, src in enumerate(manifest["sources"]):
        lst = [it for it in items if it[4] == si]
        rng.shuffle(lst)
        lst = lst[: args.limit or None]
        agg = M.Aggregate()
        for k, it in enumerate(lst):
            img, mask, lines = mix_v6.load(it)
            meta = json.load(open(it[2]))
            pred = predict(img)
            m = M.plan_metrics(pred, mask, lines, meta.get("px_per_m"))
            agg.add(m)
            every.add(m)
            if "theme" in meta:
                by_theme.setdefault(meta["theme"], M.Aggregate()).add(m)
                by_diff.setdefault(meta["difficulty"], M.Aggregate()).add(m)
            if (k + 1) % 25 == 0:
                print(f"  {src['root']}: {k + 1}/{len(lst)}  ({time.time() - t0:.0f} s)", flush=True)
        r = agg.result()
        r["topo_score"] = M.topo_score(r)
        report["sources"][src["root"]] = r
    allr = every.result()
    allr["topo_score"] = M.topo_score(allr)
    report["all"] = allr
    report["v6_by_theme"] = {k: {**v.result(), "topo_score": M.topo_score(v.result())} for k, v in sorted(by_theme.items())}
    report["v6_by_difficulty"] = {k: {**v.result(), "topo_score": M.topo_score(v.result())} for k, v in sorted(by_diff.items())}
    keys = ["images", "topo_score", "wall_iou", "room_closure", "room_closure_bridged", "room_merge", "centreline_recall",
            "breaks_per_100m", "junction_acc", "false_wall_rate", "door_p", "door_r", "window_r", "geometry_err_cm"]
    print("\n" + " " * 14 + "  ".join(f"{k[:11]:>11s}" for k in keys))
    for name, r in list(report["sources"].items()) + [("ALL", allr)]:
        print(f"{name:14s}" + "  ".join(f"{(r.get(k) if r.get(k) is not None else float('nan')):>11.3f}" for k in keys))
    print("\nv6 by building type (topo score / room closure bridged / false walls):")
    for k, v in report["v6_by_theme"].items():
        print(f"  {k:12s} {v['topo_score']:.3f}  {v['room_closure_bridged'] or 0:.3f}  {v['false_wall_rate'] or 0:.3f}")
    print("v6 by difficulty:", {k: v["topo_score"] for k, v in report["v6_by_difficulty"].items()})
    print("false walls are really:", allr["false_wall_is"])
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(report, f, indent=1)
        print("written", args.out)


if __name__ == "__main__":
    main()
