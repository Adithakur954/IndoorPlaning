"""Builds the training dataset: rendered plan images + exact masks.

    python train/make_dataset.py --count 3 --out train/samples --pick 0,2005,9001
    python train/make_dataset.py --count 25000 --out train/dataset --workers 12

Shows a progress bar with speed and the estimated time left.  Safe to stop and
restart: files that already exist are skipped.  Plans are split by *source
plan* (so the same plan never lands in two splits): index % 10 == 0 -> test,
== 1 -> val, otherwise train.
"""
import argparse
import json
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
import render_office  # noqa: E402
import render_plan  # noqa: E402
import rescale  # noqa: E402
import safe_pickle  # noqa: E402

PKL = os.path.join(HERE, "raw", "resplan_data", "ResPlan.pkl")
_plans = None


def split_of(plan_idx):
    return "test" if plan_idx % 10 == 0 else "val" if plan_idx % 10 == 1 else "train"


def _init():
    global _plans
    _plans = safe_pickle.load(PKL)


def _job(args):
    out_dir, n, plan_idx, seed, kind, small_ratio = args
    split = split_of(plan_idx if kind == "home" else n)
    name = f"{split[:2]}_{kind[0]}{n:06d}"
    stem = os.path.join(out_dir, split)
    done = os.path.join(stem, "meta", name + ".json")
    if os.path.exists(done):
        return name, 0.0, None
    t0 = time.time()
    try:
        rng = random.Random(seed)
        np_rng = np.random.default_rng(seed)
        if kind == "office":
            img, mask, meta = render_office.render(rng, np_rng)
        else:
            img, mask, meta = render_plan.render(_plans[plan_idx], rng, np_rng)
            meta["kind"] = "home"
        if rng.random() < small_ratio:
            img, mask = rescale.make_small(img, mask, meta, rng)
        img, mask = rescale.cap_size(img, mask, meta, int(rescale.MAX_SIDE / 1.2))  # room left for a border
        img, mask, ops = render_plan.degrade(img, mask, rng, np_rng)
        img, mask = rescale.cap_size(img, mask, meta)
        for sub in ("images", "masks", "meta"):
            os.makedirs(os.path.join(stem, sub), exist_ok=True)
        if rng.random() < 0.75:
            q = rng.randint(40, 95)
            ext, params = ".jpg", [cv2.IMWRITE_JPEG_QUALITY, q]
            meta["jpeg_quality"] = q
        else:
            ext, params = ".png", []
        cv2.imwrite(os.path.join(stem, "images", name + ext), img, params)
        cv2.imwrite(os.path.join(stem, "masks", name + ".png"), mask)
        meta.update(name=name, split=split, plan_index=plan_idx, seed=seed, damage=ops,
                    size=[img.shape[1], img.shape[0]],
                    class_pixels={**{k: int((mask == v).sum()) for k, v in render_plan.CLASSES.items()},
                                  "ignore": int((mask == render_plan.IGNORE).sum())})
        with open(done, "w") as f:
            json.dump(meta, f)
        return name, time.time() - t0, None
    except Exception:
        return name, time.time() - t0, traceback.format_exc()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--offset", type=int, default=0, help="first image number (adds to an existing dataset without name clashes)")
    ap.add_argument("--pick", help="comma separated plan indices (for samples)")
    ap.add_argument("--office-ratio", type=float, default=0.4, help="share of office-style images")
    ap.add_argument("--small-ratio", type=float, default=0.4, help="share of images shrunk to genuinely small sizes")
    ap.add_argument("--kinds", help="explicit kind per image, e.g. office,office,home (samples)")
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    n_plans = 17000
    if args.pick:
        picks = [int(x) for x in args.pick.split(",")]
    else:
        order = list(range(n_plans))
        random.Random(args.seed).shuffle(order)
        picks = [order[i % n_plans] for i in range(args.count)]
    if args.kinds:
        kinds = args.kinds.split(",")
    else:
        kinds = ["office" if random.Random(args.seed * 7919 + i).random() < args.office_ratio else "home"
                 for i in range(args.count)]
    jobs = [(out_dir, args.offset + i, picks[i % len(picks)], args.seed * 1_000_003 + args.offset + i,
             kinds[i % len(kinds)], args.small_ratio) for i in range(args.count)]

    from tqdm import tqdm
    errors = []
    times = []
    t_start = time.time()
    workers = max(1, min(args.workers, args.count))
    print(f"Rendering {args.count} images with {workers} workers into {out_dir}")
    print("(each worker first loads the 17,000 plans: ~20-40 s before the bar moves)")
    with Pool(workers, initializer=_init) as pool, tqdm(total=args.count, unit="img", dynamic_ncols=True,
                                                       bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]") as bar:
        for name, dt, err in pool.imap_unordered(_job, jobs, chunksize=4):
            bar.update(1)
            if dt:
                times.append(dt)
            if err:
                errors.append((name, err))
    total = time.time() - t_start
    print(f"\nDone: {args.count - len(errors)} ok, {len(errors)} failed, {total:.0f} s total")
    if times:
        per = float(np.mean(times))
        print(f"mean render time per image {per:.2f} s per worker -> "
              f"25,000 images with {workers} workers would take about {25000 * per / workers / 60:.0f} min")
    if errors:
        with open(os.path.join(out_dir, "errors.txt"), "w") as f:
            for name, err in errors:
                f.write(f"== {name}\n{err}\n")
        print(f"errors written to {os.path.join(out_dir, 'errors.txt')}; first one:\n{errors[0][1]}")


if __name__ == "__main__":
    main()
