"""Builds dataset v6: the hard-case plans of render_hard.py. dataset_v4 is not touched; the training mix of
old (40 %) and new (60 %) images is described in mix_v6.json and read from both folders in place.

    python -I train/make_dataset_v6.py --count 24 --out train/samples_v6 --workers 8 --preview
    python -I train/make_dataset_v6.py --count 36000 --out train/dataset_v6 --workers 28      # resumable

Layout (same as v4, plus two folders):
    <out>/<split>/images/*.jpg|png   the drawing
    <out>/<split>/masks/*.png        class per pixel (0..15, 255 = not judged)
    <out>/<split>/lines/*.png        wall centre-lines (255)
    <out>/<split>/geom/*.json        vector ground truth: rooms, doors (+ the spaces they join), windows, wall lines
    <out>/<split>/meta/*.json        theme, difficulty, style, damage, scale, pixel count per class
Split by image number: n % 10 == 0 -> test, == 1 -> val, otherwise train.
"""
import argparse
import json
import math
import os
import random
import sys
import time
import traceback
from multiprocessing import Pool

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import damage_v6  # noqa: E402
import render_hard  # noqa: E402

NAMES = {v: k for k, v in render_hard.CLASSES.items()}
PALETTE = {0: (255, 255, 255), 1: (40, 40, 40), 2: (0, 140, 255), 3: (255, 160, 0), 4: (210, 235, 210),
           5: (0, 0, 200), 6: (200, 0, 200), 7: (60, 120, 180), 8: (120, 200, 255), 11: (0, 160, 0),
           14: (180, 60, 220), 15: (130, 130, 255), 255: (128, 128, 128)}


def split_of(n):
    return "test" if n % 10 == 0 else "val" if n % 10 == 1 else "train"


def _job(args):
    out_dir, n, seed, small_ratio, theme = args
    split = split_of(n)
    name = f"{split[:2]}_x{n:06d}"
    stem = os.path.join(out_dir, split)
    done = os.path.join(stem, "meta", name + ".json")
    if os.path.exists(done):
        return name, 0.0, None
    t0 = time.time()
    try:
        for attempt in range(3):
            s_ = seed + attempt * 7_777_777
            got = _make(s_, small_ratio, theme)
            problem = check(*got[1:3], got[4])
            if not problem:
                break
        else:
            return name, time.time() - t0, f"dropped after 3 attempts: {problem}"
        img, mask, lines, meta, gt, rng, seed = *got, s_
        meta["attempt"] = attempt
    except Exception:
        return name, time.time() - t0, traceback.format_exc()
    try:
        for sub in ("images", "masks", "lines", "geom", "meta"):
            os.makedirs(os.path.join(stem, sub), exist_ok=True)
        if rng.random() < 0.75:
            q = rng.randint(40, 95)
            ext, params = ".jpg", [cv2.IMWRITE_JPEG_QUALITY, q]
            meta["jpeg_quality"] = q
        else:
            ext, params = ".png", []
        cv2.imwrite(os.path.join(stem, "images", name + ext), img, params)
        cv2.imwrite(os.path.join(stem, "masks", name + ".png"), mask)
        cv2.imwrite(os.path.join(stem, "lines", name + ".png"), lines)
        # the vector truth is in drawing pixels before damage: warps are listed in "damage"
        with open(os.path.join(stem, "geom", name + ".json"), "w") as f:
            json.dump(gt, f, separators=(",", ":"))
        counts = np.bincount(mask.ravel(), minlength=256)
        meta.update(name=name, split=split, seed=seed, size=[img.shape[1], img.shape[0]],
                    class_pixels={**{k: int(counts[v]) for k, v in render_hard.CLASSES.items()}, "ignore": int(counts[255])},
                    line_pixels=int((lines > 0).sum()))
        # written last and atomically: a stopped build leaves no meta (image redone) or a complete one
        tmp = done + ".tmp"
        with open(tmp, "w") as f:
            json.dump(meta, f)
        os.replace(tmp, done)
        return name, time.time() - t0, None
    except Exception:
        return name, time.time() - t0, traceback.format_exc()


KNOWN = {0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 255}


def check(mask, lines, gt):
    """Why this image must not be used, or None."""
    import audit_v6
    if not set(np.unique(mask).tolist()) <= KNOWN:
        return "unknown mask value"
    if ((lines > 0) & (mask != 1)).any():
        return "centre-line off the wall"
    if (mask == 1).sum() == 0 or (mask == 2).sum() == 0:
        return "no wall or no door"
    if audit_v6.reachable(gt) < 0.999:
        return "a room has no door path"
    return None


def _make(seed, small_ratio, theme):
    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)
    if True:
        img, mask, lines, meta, gt = render_hard.render(rng, np_rng, theme=theme)
        diff = meta["difficulty"]
        # genuinely small images (thin walls a few px), as real low-resolution plans
        if rng.random() < small_ratio:
            wall = max(float(meta["wall_px"]), 1.0)
            f = min(0.85, max(math.exp(rng.uniform(math.log(1.6), math.log(6.0))) / wall, 420.0 / max(mask.shape)))
            if f < 0.97:
                img, mask, lines = damage_v6.shrink(img, mask, lines, f)
                meta.update(shrink=round(f, 3), wall_px=round(meta["wall_px"] * f, 2),
                            px_per_m=round(meta["px_per_m"] * f, 3))
                gt = scale_gt(gt, f)
        img, (mask, lines), ops = damage_v6.damage(img, [mask, lines], rng, np_rng, strength=0.55 + 0.15 * diff)
        if max(mask.shape) > render_hard.MAX_SIDE:
            f = render_hard.MAX_SIDE / max(mask.shape)
            img, mask, lines = damage_v6.shrink(img, mask, lines, f)
            meta.update(capped=True, wall_px=round(meta["wall_px"] * f, 2), px_per_m=round(meta["px_per_m"] * f, 3))
            gt = scale_gt(gt, f)
        meta["damage"] = ops
        return img, mask, lines, meta, gt, rng


def scale_gt(gt, f):
    def sc(pts):
        return [[round(x * f, 1), round(y * f, 1)] for x, y in pts]
    return dict(rooms=[{**r, "polygon": sc(r["polygon"])} for r in gt["rooms"]],
                doors=[{**d, "line": sc(d["line"])} for d in gt["doors"]],
                windows=[{**w, "line": sc(w["line"])} for w in gt["windows"]],
                wall_lines=[sc(l) for l in gt["wall_lines"]])


def colour(mask):
    out = np.zeros(mask.shape + (3,), np.uint8)
    for c, col in PALETTE.items():
        out[mask == c] = col
    return out


def preview(out_dir, n=24, width=1500):
    """For each image: drawing | labels | centre-lines over the drawing; plus one contact sheet."""
    rows = []
    for split in ("train", "val", "test"):
        meta_dir = os.path.join(out_dir, split, "meta")
        if not os.path.isdir(meta_dir):
            continue
        for f in sorted(os.listdir(meta_dir))[:n]:
            name = f[:-5]
            imgs = [x for x in os.listdir(os.path.join(out_dir, split, "images")) if x.startswith(name + ".")]
            if not imgs:
                continue
            img = cv2.imread(os.path.join(out_dir, split, "images", imgs[0]))
            mask = cv2.imread(os.path.join(out_dir, split, "masks", name + ".png"), cv2.IMREAD_GRAYSCALE)
            lines = cv2.imread(os.path.join(out_dir, split, "lines", name + ".png"), cv2.IMREAD_GRAYSCALE)
            ov = (img * 0.45 + 140).astype(np.uint8)
            ov[lines > 0] = (0, 0, 255)
            trio = np.hstack([img, colour(mask), ov])
            s = width / trio.shape[1]
            trio = cv2.resize(trio, (width, int(trio.shape[0] * s)), interpolation=cv2.INTER_AREA)
            meta = json.load(open(os.path.join(meta_dir, f)))
            cv2.putText(trio, f"{name} {meta['theme']} d{meta['difficulty']} {meta['style']['walls']}/{meta['style']['mode']}",
                        (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            os.makedirs(os.path.join(out_dir, "preview"), exist_ok=True)
            cv2.imwrite(os.path.join(out_dir, "preview", name + ".jpg"), trio, [cv2.IMWRITE_JPEG_QUALITY, 88])
            rows.append(trio)
    print(f"previews in {os.path.join(out_dir, 'preview')} ({len(rows)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--seed", type=int, default=6006)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--small-ratio", type=float, default=0.3)
    ap.add_argument("--theme", help="only this building type (samples)")
    ap.add_argument("--preview", action="store_true", help="write preview pictures afterwards")
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    jobs = [(out_dir, args.offset + i, args.seed * 1_000_003 + args.offset + i, args.small_ratio, args.theme)
            for i in range(args.count)]
    from tqdm import tqdm
    errors, times = [], []
    t_start = time.time()
    workers = max(1, min(args.workers, args.count))
    print(f"Rendering {args.count} hard-case plans with {workers} workers into {out_dir}")
    with Pool(workers) as pool, tqdm(total=args.count, unit="img", dynamic_ncols=True) as bar:
        for name, dt, err in pool.imap_unordered(_job, jobs, chunksize=2):
            bar.update(1)
            if dt:
                times.append(dt)
            if err:
                errors.append((name, err))
    total = time.time() - t_start
    print(f"\nDone: {args.count - len(errors)} ok, {len(errors)} failed, {total:.0f} s total")
    if times:
        per = float(np.mean(times))
        print(f"mean {per:.2f} s per image per worker -> 36,000 images with {workers} workers ~ {36000 * per / workers / 60:.0f} min")
    if errors:
        with open(os.path.join(out_dir, "errors.txt"), "a") as f:
            for name, err in errors:
                f.write(f"== {name}\n{err}\n")
        print(f"errors in {os.path.join(out_dir, 'errors.txt')}; first one:\n{errors[0][1]}")
    if args.preview:
        preview(out_dir)


if __name__ == "__main__":
    main()
