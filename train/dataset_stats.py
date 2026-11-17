"""Checks a finished dataset: counts, duplicate layouts, split leakage, class balance, sizes.

    python -I train/dataset_stats.py train/dataset
"""
import collections
import glob
import json
import os
import sys

import numpy as np

root = sys.argv[1]
metas = [json.load(open(f)) for f in glob.glob(os.path.join(root, "*", "meta", "*.json"))]
print("images:", len(metas))

by = collections.Counter((m["split"], m["kind"]) for m in metas)
for split in ("train", "val", "test"):
    print(f"  {split:5s} home {by[(split, 'home')]:6d}   office {by[(split, 'office')]:6d}")

# --- home layouts used more than once, and leakage between splits
homes = [m for m in metas if m["kind"] == "home"]
uses = collections.Counter(m["plan_index"] for m in homes)
print(f"home images {len(homes)}, unique ResPlan layouts {len(uses)}, "
      f"layouts drawn twice {sum(1 for v in uses.values() if v == 2)}, more than twice {sum(1 for v in uses.values() if v > 2)}")
splits_of = collections.defaultdict(set)
for m in homes:
    splits_of[m["plan_index"]].add(m["split"])
print("layouts present in more than one split (must be 0):", sum(1 for s in splits_of.values() if len(s) > 1))

# --- office: seeds are unique per image
seeds = collections.Counter(m["seed"] for m in metas)
print("duplicate seeds (must be 0):", sum(1 for v in seeds.values() if v > 1))

# --- class balance
tot = np.array([sum(m["class_pixels"].values()) for m in metas], float)
for kind in ("home", "office"):
    idx = [i for i, m in enumerate(metas) if m["kind"] == kind]
    print(f"class share of pixels, {kind}:", {k: round(100 * float(np.mean([metas[i]['class_pixels'][k] / tot[i] for i in idx])), 2)
                                               for k in metas[0]["class_pixels"]})
    # images that lack a class
    miss = {k: sum(1 for i in idx if metas[i]["class_pixels"][k] == 0) for k in ("wall", "door", "window", "floor", "column")}
    print(f"  images with zero pixels of the class, {kind}:", miss)

# --- sizes and wall thickness
w = np.array([m["size"][0] for m in metas])
h = np.array([m["size"][1] for m in metas])
print("image width  min/median/max:", w.min(), int(np.median(w)), w.max())
print("image height min/median/max:", h.min(), int(np.median(h)), h.max())
wp = np.array([m["wall_px"] for m in metas])
print("wall thickness px  p5/median/p95:", np.percentile(wp, [5, 50, 95]).round(1))
print("jpeg share:", round(100 * np.mean(["jpeg_quality" in m for m in metas]), 1), "%")
dam = collections.Counter(d.split("0")[0].rstrip("0123456789.-") for m in metas for d in m["damage"])
print("damage ops used:", dict(dam))
size = sum(os.path.getsize(f) for f in glob.glob(os.path.join(root, "**", "*.*"), recursive=True))
print(f"disk: {size / 1e9:.2f} GB")
