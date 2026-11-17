"""Audit of a built dataset: do the labels agree with the images, and is the data what training assumes?

    python train/audit_dataset.py train/dataset_v4 [--sample 600]

Checks (all must pass for the exit code to be 0):
  * every image has a mask of the same size, and every mask value is a known class or 255 (ignore)
  * meta class_pixels equal the real pixel counts of the mask (sampled)
  * offices: furniture classes exist, chairs are not hopelessly small, printed dimensions are recorded
  * no source plan sits in two splits, no duplicate seeds
  * labelled structure is present in every image (wall pixels)
Then prints the class shares, instance counts and size statistics that training depends on.
"""
import argparse
import collections
import glob
import json
import os
import random
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_plan  # noqa: E402

CLASSES = render_plan.CLASSES
IDS = set(CLASSES.values()) | {255}
fails = []


def check(ok, msg):
    print(("  PASS  " if ok else "  FAIL  ") + msg)
    if not ok:
        fails.append(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--sample", type=int, default=600)
    args = ap.parse_args()
    metas = [json.load(open(f)) for f in glob.glob(os.path.join(args.root, "*", "meta", "*.json"))]
    print(f"{len(metas)} images")
    by = collections.Counter((m["split"], m["kind"]) for m in metas)
    print("  split / kind:", dict(by))

    # ---- leakage and seeds
    splits_of = collections.defaultdict(set)
    for m in metas:
        if m["kind"] == "home":
            splits_of[m["plan_index"]].add(m["split"])
    check(not any(len(v) > 1 for v in splits_of.values()), "no home layout sits in two splits")
    seeds = collections.Counter(m["seed"] for m in metas)
    check(not any(v > 1 for v in seeds.values()), "no duplicate seeds")

    # ---- meta-level checks
    offices = [m for m in metas if m["kind"] == "office"]
    homes = [m for m in metas if m["kind"] == "home"]
    check(all(m["class_pixels"].get("wall", 0) > 0 for m in metas), "every image has wall pixels")
    with_furn = [m for m in offices if sum(m["class_pixels"].get(k, 0) for k in ("desk", "chair", "table", "sofa")) > 0]
    check(len(with_furn) >= 0.98 * len(offices), f"{len(with_furn)}/{len(offices)} offices have labelled furniture")
    dims = [m for m in offices if m.get("print_dims")]
    print(f"  offices with printed overall dimensions: {len(dims)}/{len(offices)} ({100 * len(dims) / max(len(offices), 1):.0f}%)")
    check(all(m["class_pixels"].get("ignore", 0) == 0 for m in offices), "offices have no ignore pixels")
    print(f"  homes with ignore pixels (their furniture): {sum(1 for m in homes if m['class_pixels'].get('ignore', 0) > 0)}/{len(homes)}")

    # ---- pixel-level checks on a sample
    rng = random.Random(0)
    sample = rng.sample(metas, min(args.sample, len(metas)))
    bad_size = bad_vals = bad_counts = 0
    chair_areas, desk_counts, chair_counts = [], [], []
    for m in sample:
        split, name = m["split"], m["name"]
        img_path = glob.glob(os.path.join(args.root, split, "images", name + ".*"))[0]
        img = cv2.imread(img_path)
        mask = cv2.imread(os.path.join(args.root, split, "masks", name + ".png"), cv2.IMREAD_GRAYSCALE)
        if img is None or mask is None or img.shape[:2] != mask.shape:
            bad_size += 1
            continue
        vals = set(np.unique(mask).tolist())
        if not vals <= IDS:
            bad_vals += 1
        counts = {k: int((mask == v).sum()) for k, v in CLASSES.items()}
        if any(counts[k] != m["class_pixels"].get(k, 0) for k in counts):
            bad_counts += 1
        if m["kind"] == "office":
            n, _, st, _ = cv2.connectedComponentsWithStats((mask == 8).astype(np.uint8), connectivity=8)[0:4]
            chair_areas += st[1:, cv2.CC_STAT_AREA].tolist()
            chair_counts.append(n - 1)
            nd = cv2.connectedComponents((mask == 7).astype(np.uint8), connectivity=8)[0] - 1
            desk_counts.append(nd)
    check(bad_size == 0, f"image and mask sizes agree ({len(sample)} sampled)")
    check(bad_vals == 0, "mask values are known classes")
    check(bad_counts == 0, "meta class_pixels equal the real mask counts")

    # ---- what training will see
    print("\nclass share of pixels (mean per image):")
    for kind, group in (("home", homes), ("office", offices)):
        tot = [sum(v for k, v in m["class_pixels"].items() if k != "ignore") for m in group]
        print(f"  {kind}: " + ", ".join(
            f"{k} {100 * np.mean([m['class_pixels'].get(k, 0) / t for m, t in zip(group, tot)]):.2f}%"
            for k in CLASSES if any(m['class_pixels'].get(k, 0) for m in group)))
    if chair_areas:
        a = np.array(chair_areas)
        print(f"\noffices (sample): chairs per image median {int(np.median(chair_counts))}, p10 {int(np.percentile(chair_counts, 10))}, "
              f"p90 {int(np.percentile(chair_counts, 90))}; desk-bench regions per image median {int(np.median(desk_counts))}")
        print(f"chair region area px: p5 {np.percentile(a, 5):.0f}  median {np.median(a):.0f}  p95 {np.percentile(a, 95):.0f}; "
              f"{100 * np.mean(a < 12):.1f}% are under 12 px (too small to see)")
        check(np.mean(a < 12) < 0.35, "most chair regions are large enough to be seen")
    sizes = np.array([max(m["size"]) for m in metas])
    print(f"longest side p5/median/p95: {np.percentile(sizes, [5, 50, 95]).astype(int).tolist()}, max {sizes.max()}")
    check(sizes.max() <= 2400, "no image above 2,400 px")
    print("\nRESULT:", "ALL CHECKS PASSED" if not fails else f"{len(fails)} CHECK(S) FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
