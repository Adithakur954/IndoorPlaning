"""Reads the v6 training mix (mix_v6.json): old and new images from their own folders, in place.

    items = list_mix("train/mix_v6.json", "train")   # [(image, mask, meta, lines_or_None, source_index), ...]
    pick = MixSampler(items, manifest)                # draws a source by its share, then an image of it
    img, mask, lines = load(item, rng, np_rng, manifest)   # lines from file, or from the wall mask for v4

Nothing is copied and nothing in dataset_v4 is written. Run 6 (train_seg.py) will use this; it can also be run
on its own to check the mix:  python -I train/mix_v6.py train/mix_v6.json
"""
from __future__ import annotations

import json
import os
import random
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import damage_v6  # noqa: E402


def read_manifest(path):
    with open(path) as f:
        m = json.load(f)
    base = os.path.dirname(os.path.abspath(path))
    for s in m["sources"]:
        s["path"] = s["root"] if os.path.isabs(s["root"]) else os.path.join(base, s["root"])
    total = sum(s["share"] for s in m["sources"])
    for s in m["sources"]:
        s["share"] = s["share"] / total
    return m


def list_mix(manifest, split):
    m = read_manifest(manifest) if isinstance(manifest, str) else manifest
    items = []
    for si, s in enumerate(m["sources"]):
        d = os.path.join(s["path"], split)
        if not os.path.isdir(os.path.join(d, "meta")):
            continue
        ext = {os.path.splitext(f)[0]: f for f in os.listdir(os.path.join(d, "images"))}
        has_lines = os.path.isdir(os.path.join(d, "lines"))
        for f in sorted(os.listdir(os.path.join(d, "meta"))):
            name = f[:-5]
            if name in ext:
                items.append((os.path.join(d, "images", ext[name]), os.path.join(d, "masks", name + ".png"),
                              os.path.join(d, "meta", f),
                              os.path.join(d, "lines", name + ".png") if has_lines else None, si))
    return items


class MixSampler:
    """Draws a source by its share, then a random image of that source."""

    def __init__(self, items, manifest):
        m = read_manifest(manifest) if isinstance(manifest, str) else manifest
        self.by_source = {}
        for it in items:
            self.by_source.setdefault(it[4], []).append(it)
        self.sources = [i for i in range(len(m["sources"])) if i in self.by_source]
        self.shares = [m["sources"][i]["share"] for i in self.sources]

    def __call__(self, rng):
        si = rng.choices(self.sources, self.shares)[0]
        lst = self.by_source[si]
        return lst[rng.randrange(len(lst))]


def lines_from_mask(mask):
    """Wall centre-lines of an old image (no vector truth there): a morphological skeleton of the wall class."""
    wall = (mask == 1).astype(np.uint8)
    if hasattr(cv2, "ximgproc"):
        return cv2.ximgproc.thinning(wall * 255)
    skel = np.zeros_like(wall)
    k = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    cur = wall.copy()
    while cur.any():
        er = cv2.erode(cur, k)
        skel |= cur & ~cv2.dilate(er, k)
        cur = er
    return skel * 255


def load(item, rng=None, np_rng=None, manifest=None):
    img = cv2.imread(item[0], cv2.IMREAD_COLOR)
    mask = cv2.imread(item[1], cv2.IMREAD_GRAYSCALE)
    lines = cv2.imread(item[3], cv2.IMREAD_GRAYSCALE) if item[3] else lines_from_mask(mask)
    if manifest is not None and rng is not None:
        m = read_manifest(manifest) if isinstance(manifest, str) else manifest
        strength = m["sources"][item[4]].get("extra_damage", 0.0)
        if strength > 0:
            img, (mask, lines), _ = damage_v6.damage(img, [mask, lines], rng, np_rng or np.random.default_rng(), strength)
    return img, mask, lines


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "mix_v6.json")
    m = read_manifest(path)
    for split in ("train", "val", "test"):
        items = list_mix(m, split)
        per = {}
        for it in items:
            per[it[4]] = per.get(it[4], 0) + 1
        print(split, {m["sources"][k]["root"]: v for k, v in per.items()})
    items = list_mix(m, "train")
    if items:
        smp = MixSampler(items, m)
        rng = random.Random(0)
        got = [smp(rng)[4] for _ in range(20000)]
        for i, s in enumerate(m["sources"]):
            print(f"  drawn from {s['root']}: {100 * got.count(i) / len(got):.1f} % (share {100 * s['share']:.0f} %)")


if __name__ == "__main__":
    main()
