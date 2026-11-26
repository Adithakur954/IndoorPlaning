"""Audit of dataset v6 (hard cases): do labels, centre-lines and the vector truth agree?

    python -I train/audit_v6.py train/dataset_v6 [--sample 400]

Checks (all must pass for exit code 0):
  * image, mask and centre-line files exist and have the same size
  * mask values are known classes (0-8, 11, 14, 15) or 255
  * meta class_pixels equal the real counts (sampled)
  * centre-lines lie only on wall pixels; walls and doors are present in every image
  * no duplicate seeds; image numbers fall in the split their number gives
  * vector truth: every non-void room can be reached from the others through doors (sampled)
Then prints building types, difficulty, styles and class shares.
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
import render_hard  # noqa: E402

CLASSES = render_hard.CLASSES
KNOWN = {0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 255}
fails = []


def check(ok, msg):
    print(("  PASS  " if ok else "  FAIL  ") + msg)
    if not ok:
        fails.append(msg)


def reachable(gt):
    rooms = gt["rooms"]
    n = len(rooms)
    if n <= 1:
        return 1.0
    adj = collections.defaultdict(set)
    for d in gt["doors"]:
        if d["rooms"]:
            a, b = d["rooms"]
            adj[a].add(b)
            adj[b].add(a)
    want = [i for i, r in enumerate(rooms) if r["kind"] != "void"]
    if not want:
        return 1.0
    # -1 is the outside: rooms with an entrance door are reached from it
    start = -1 if adj[-1] else max(want, key=lambda i: len(adj[i]))
    seen, stack = {start}, [start]
    while stack:
        for j in adj[stack.pop()]:
            if j not in seen:
                seen.add(j)
                stack.append(j)
    return sum(1 for i in want if i in seen) / len(want)


def check_one(args):
    root, m = args
    d = os.path.join(root, m["split"])
    out = dict(name=m["name"], split=m["split"], problems=[], reach=None)
    try:
        imgs = glob.glob(os.path.join(d, "images", m["name"] + ".*"))
        img = cv2.imread(imgs[0]) if imgs else None
        mask = cv2.imread(os.path.join(d, "masks", m["name"] + ".png"), cv2.IMREAD_GRAYSCALE)
        lines = cv2.imread(os.path.join(d, "lines", m["name"] + ".png"), cv2.IMREAD_GRAYSCALE)
        if img is None or mask is None or lines is None or img.shape[:2] != mask.shape or lines.shape != mask.shape:
            out["problems"].append("size")
            return out
        if not set(np.unique(mask).tolist()) <= KNOWN:
            out["problems"].append("values")
        cnt = np.bincount(mask.ravel(), minlength=256)
        if any(cnt[v] != m["class_pixels"][k] for k, v in CLASSES.items()):
            out["problems"].append("counts")
        if ((lines > 0) & (mask != 1)).any():
            out["problems"].append("lines")
        gt = json.load(open(os.path.join(d, "geom", m["name"] + ".json")))
        out["reach"] = reachable(gt)
        if out["reach"] < 0.999:
            out["problems"].append("reach")
    except Exception as e:   # unreadable file
        out["problems"].append("size")
        out["error"] = str(e)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--sample", type=int, default=400, help="images whose files are read (0 = all)")
    ap.add_argument("--clean", action="store_true", help="delete left-over files of images that never finished")
    ap.add_argument("--remove-bad", action="store_true", help="delete images that fail a check")
    args = ap.parse_args()
    metas = [json.load(open(f)) for f in glob.glob(os.path.join(args.root, "*", "meta", "*.json"))]
    print(f"{len(metas)} images")
    print("  split:", dict(collections.Counter(m["split"] for m in metas)))
    check(len({m["seed"] for m in metas}) == len(metas), "no duplicate seeds")
    num = lambda m: int(m["name"].split("_x")[1])
    check(all(m["split"] == ("test" if num(m) % 10 == 0 else "val" if num(m) % 10 == 1 else "train") for m in metas),
          "every image is in the split its number gives")
    check(all(m["class_pixels"]["wall"] > 0 for m in metas), "every image has wall pixels")
    check(sum(m["class_pixels"]["door"] > 0 for m in metas) >= 0.98 * len(metas), "at least 98 % of images have doors")

    # ---- every file of every image, and nothing left over (an interrupted build writes the meta file last)
    orphans, missing = [], []
    for split in ("train", "val", "test"):
        d = os.path.join(args.root, split)
        if not os.path.isdir(d):
            continue
        names = {f[:-5] for f in os.listdir(os.path.join(d, "meta"))}
        for sub, ext in (("images", None), ("masks", ".png"), ("lines", ".png"), ("geom", ".json")):
            have = {os.path.splitext(f)[0] for f in os.listdir(os.path.join(d, sub))} if os.path.isdir(os.path.join(d, sub)) else set()
            missing += [f"{split}/{sub}/{n}" for n in names - have]
            orphans += [os.path.join(d, sub, f) for f in os.listdir(os.path.join(d, sub)) if os.path.splitext(f)[0] not in names] \
                if os.path.isdir(os.path.join(d, sub)) else []
    check(not missing, f"every image has its picture, mask, centre-lines and geometry ({len(missing)} missing)")
    if orphans and args.clean:
        for f in orphans:
            os.remove(f)
        print(f"         removed {len(orphans)} left-over files of unfinished images")
        orphans = []
    check(not orphans, f"no left-over files of unfinished images ({len(orphans)}; --clean removes them)")

    # ---- the content of each image (all of them with --sample 0)
    rng = random.Random(0)
    sample = metas if args.sample == 0 else rng.sample(metas, min(args.sample, len(metas)))
    from multiprocessing import Pool
    with Pool(max(1, (os.cpu_count() or 4) - 2)) as pool:
        res = pool.map(check_one, [(args.root, m) for m in sample], chunksize=16)
    bad = [r for r in res if r["problems"]]
    kinds = collections.Counter(p for r in bad for p in r["problems"])
    reach = [r["reach"] for r in res if r["reach"] is not None]
    print(f"  checked the files of {len(res)} images")
    for name, key in (("picture, mask and centre-lines open and have equal sizes", "size"),
                      ("mask values are known classes", "values"), ("meta class_pixels match the masks", "counts"),
                      ("centre-lines only on walls", "lines"), ("every room has a door path", "reach")):
        check(kinds[key] == 0, f"{name} ({kinds[key]} bad)")
    full = sum(r >= 0.999 for r in reach) / max(len(reach), 1)
    print(f"         rooms reachable: all rooms in {100 * full:.2f} % of plans, mean {100 * float(np.mean(reach)):.2f} % of rooms")
    if bad:
        with open(os.path.join(args.root, "audit_bad.txt"), "w") as f:
            for r in bad:
                f.write(f"{r['split']}/{r['name']}: {', '.join(r['problems'])}\n")
        print(f"         bad images listed in {os.path.join(args.root, 'audit_bad.txt')}")
        if args.remove_bad:
            for r in bad:
                for sub in ("images", "masks", "lines", "geom", "meta"):
                    for f in glob.glob(os.path.join(args.root, r["split"], sub, r["name"] + ".*")):
                        os.remove(f)
            print(f"         removed {len(bad)} bad images")

    print("\nbuilding types:", dict(collections.Counter(m["theme"] for m in metas).most_common()))
    print("difficulty    :", dict(sorted(collections.Counter(m["difficulty"] for m in metas).items())))
    print("sheet         :", dict(collections.Counter(m["style"]["mode"] for m in metas).most_common()))
    print("walls drawn   :", dict(collections.Counter(m["style"]["walls"] for m in metas).most_common()))
    dmg = collections.Counter(op.rstrip("0123456789.-x") for m in metas for op in m["damage"])
    print("damage        :", dict(dmg.most_common()))
    tot = collections.Counter()
    for m in metas:
        tot.update(m["class_pixels"])
    s = sum(v for k, v in tot.items() if k != "ignore")
    print("class share % :", {k: round(100 * v / s, 3) for k, v in tot.items() if v and k != "ignore"})
    wp = [m["wall_px"] for m in metas]
    print(f"wall px       : median {np.median(wp):.1f}, 10-90 % {np.percentile(wp, 10):.1f}-{np.percentile(wp, 90):.1f}")
    print(f"rooms / doors : median {np.median([m['rooms'] for m in metas]):.0f} / {np.median([m['doors'] for m in metas]):.0f}")
    print("\nRESULT:", "ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
