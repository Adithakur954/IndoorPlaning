"""Builds dataset v7: run 6 plans with the run 7 hard cases (render_v7.py) on top, plus a stretched aspect and more
very low resolution images. dataset_v4 and dataset_v6 are not touched; the training mix is in mix_v7.json.

    python -I train/make_dataset_v7.py --count 24 --out train/samples_v7 --workers 8 --preview
    python -I train/make_dataset_v7.py --count 30000 --out train/dataset_v7 --workers 28      # resumable

Same layout, checks and splits as make_dataset_v6.py (images, masks, lines, geom, meta per split).
"""
import argparse
import math
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import damage_v6  # noqa: E402
import make_dataset_v6 as v6  # noqa: E402
import render_hard  # noqa: E402
import render_v7  # noqa: E402


def _scale_gt_xy(gt, fx, fy):
    def sc(pts):
        return [[round(x * fx, 1), round(y * fy, 1)] for x, y in pts]
    return dict(rooms=[{**r, "polygon": sc(r["polygon"])} for r in gt["rooms"]],
                doors=[{**d, "line": sc(d["line"])} for d in gt["doors"]],
                windows=[{**w, "line": sc(w["line"])} for w in gt["windows"]],
                wall_lines=[sc(l) for l in gt["wall_lines"]])


def stretch(img, mask, lines, fy):
    """The picture resized without keeping its proportions (as a client's screenshot often is)."""
    h, w = mask.shape
    nh = max(8, int(round(h * fy)))
    img = cv2.resize(img, (w, nh), interpolation=cv2.INTER_AREA if fy < 1 else cv2.INTER_LINEAR)
    mask = cv2.resize(mask, (w, nh), interpolation=cv2.INTER_NEAREST)
    lines = cv2.resize(lines, (w, nh), interpolation=cv2.INTER_NEAREST)
    lines[mask != 1] = 0
    return img, mask, lines


def _make(seed, small_ratio, theme):
    import random

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)
    img, mask, lines, meta, gt = render_v7.render(rng, np_rng, theme=theme)
    diff = meta["difficulty"]
    # genuinely small pictures: real exports of big buildings are often 4-10 px per metre (walls 1-3 px)
    if rng.random() < small_ratio:
        wall = max(float(meta["wall_px"]), 1.0)
        f = min(0.85, max(math.exp(rng.uniform(math.log(1.3), math.log(5.0))) / wall, 420.0 / max(mask.shape)))
        if f < 0.97:
            img, mask, lines = damage_v6.shrink(img, mask, lines, f)
            meta.update(shrink=round(f, 3), wall_px=round(meta["wall_px"] * f, 2), px_per_m=round(meta["px_per_m"] * f, 3))
            gt = v6.scale_gt(gt, f)
    if rng.random() < 0.4:
        fy = rng.uniform(0.85, 1.15)
        img, mask, lines = stretch(img, mask, lines, fy)
        meta["stretch_y"] = round(fy, 3)
        gt = _scale_gt_xy(gt, 1.0, fy)
    img, (mask, lines), ops = damage_v6.damage(img, [mask, lines], rng, np_rng, strength=0.55 + 0.15 * diff)
    if max(mask.shape) > render_hard.MAX_SIDE:
        f = render_hard.MAX_SIDE / max(mask.shape)
        img, mask, lines = damage_v6.shrink(img, mask, lines, f)
        meta.update(capped=True, wall_px=round(meta["wall_px"] * f, 2), px_per_m=round(meta["px_per_m"] * f, 3))
        gt = v6.scale_gt(gt, f)
    meta["damage"] = ops
    return img, mask, lines, meta, gt, rng


# make_dataset_v6's worker builds each image with this module's _make (also in the worker processes, which
# import this file as their main module)
v6._make = _make


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=24)
    ap.add_argument("--out", default=os.path.join(HERE, "samples_v7"))
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--seed", type=int, default=7_000_000)
    ap.add_argument("--small-ratio", type=float, default=0.55)
    ap.add_argument("--theme", default=None)
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()
    jobs = [(a.out, n, a.seed + n * 1009, a.small_ratio, a.theme) for n in range(a.count)]
    t0 = time.time()
    done = failed = 0
    from multiprocessing import Pool

    with Pool(a.workers) as pool:
        for name, sec, err in pool.imap_unordered(v6._job, jobs, chunksize=2):
            if err:
                failed += 1
                print(f"{name}: {err.splitlines()[-1] if err else ''}", flush=True)
            else:
                done += 1
            if (done + failed) % 50 == 0:
                print(f"{done + failed}/{len(jobs)} ({time.time() - t0:.0f}s)", flush=True)
    print(f"done {done}, dropped {failed}, {time.time() - t0:.0f}s", flush=True)
    if a.preview:
        v6.preview(a.out, n=a.count)


if __name__ == "__main__":
    main()
