"""Annotated sample pictures: what the model will be trained to find.

    python train/show_samples.py train/dataset_v4 train/samples --n 5

For each picked training image it writes `<name>_annotated.png`: the original on the left, and on the right the same
picture with the labels drawn on it -- walls (red), doors (green), windows (blue), columns, Wi-Fi markers, and a
bounding box with a name on every desk, chair, table, sofa, plant, pod and storage unit, plus a box on each room
(homes) or on the whole floor (offices). A legend with the instance counts is printed on the picture.
The old contents of the output folder are removed first.
"""
import argparse
import glob
import json
import os
import random
import shutil
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_plan  # noqa: E402

NAMES = {v: k for k, v in render_plan.CLASSES.items()}
# BGR
COL = {1: (40, 40, 230), 2: (60, 200, 60), 3: (230, 140, 40), 4: (150, 230, 240), 5: (200, 60, 200), 6: (0, 140, 255),
       7: (0, 190, 255), 8: (255, 110, 20), 9: (190, 200, 0), 10: (150, 0, 190), 11: (60, 170, 60), 12: (0, 90, 220),
       13: (130, 130, 130)}
FURN = [7, 8, 9, 10, 11, 12, 13]


def annotate(img, mask):
    over = img.copy()
    for cls in (1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13):
        over[mask == cls] = COL[cls]
    out = cv2.addWeighted(img, 0.5, over, 0.5, 0)
    out[mask == 0] = img[mask == 0]
    counts = {}
    # furniture: a box on every instance
    for cls in FURN + [5, 6]:
        n, _, st, _ = cv2.connectedComponentsWithStats((mask == cls).astype(np.uint8), connectivity=8)[0:4]
        k = 0
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 6:
                continue
            k += 1
            cv2.rectangle(out, (x - 1, y - 1), (x + w + 1, y + h + 1), COL[cls], 1)
            if cls not in (8, 5) and a > 120:      # name on the larger pieces only (chairs would be unreadable)
                cv2.putText(out, NAMES[cls], (x, max(10, y - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, COL[cls], 1, cv2.LINE_AA)
        counts[NAMES[cls]] = k
    # rooms: connected floor regions that are not furniture (homes: one per room); the whole floor for an office
    floor = ((mask == 4) | np.isin(mask, FURN + [255])).astype(np.uint8)
    floor = cv2.morphologyEx(floor, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(floor, connectivity=4)[0:4]
    rooms = 0
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 0.004 * mask.size:
            continue
        rooms += 1
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 0, 0), 2)
        cv2.putText(out, f"room {rooms}", (x + 4, y + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    counts["rooms / floor regions"] = rooms
    wall_n = cv2.connectedComponents((mask == 1).astype(np.uint8), connectivity=8)[0] - 1
    counts["wall pieces"] = int(wall_n)
    return out, counts


def legend(counts, height):
    w = 330
    pad = np.full((height, w, 3), 255, np.uint8)
    y = 24
    cv2.putText(pad, "What the model learns", (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)
    y += 26
    rows = [("wall (red fill)", 1, counts.get("wall pieces")), ("door (green)", 2, None), ("window (blue)", 3, None),
            ("column", 5, counts.get("column")), ("Wi-Fi marker", 6, counts.get("ap")),
            ("desk / bench", 7, counts.get("desk")), ("chair", 8, counts.get("chair")), ("table", 9, counts.get("table")),
            ("sofa", 10, counts.get("sofa")), ("plant / planter", 11, counts.get("plant")),
            ("pod / booth", 12, counts.get("pod")), ("storage", 13, counts.get("storage"))]
    for label, cls, n in rows:
        cv2.rectangle(pad, (10, y - 12), (28, y + 2), COL[cls], -1)
        cv2.putText(pad, label + (f":  {n}" if n is not None else ""), (38, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
        y += 24
    cv2.rectangle(pad, (10, y - 12), (28, y + 2), (0, 0, 0), 2)
    cv2.putText(pad, f"room / whole floor:  {counts.get('rooms / floor regions')}", (38, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    y += 30
    cv2.putText(pad, "Boxes = one object each.", (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (60, 60, 60), 1, cv2.LINE_AA)
    return pad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("out")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    metas = [json.load(open(f)) for f in glob.glob(os.path.join(args.root, "train", "meta", "*.json"))]
    rng = random.Random(args.seed)
    offices = [m for m in metas if m["kind"] == "office" and m.get("print_dims") and m["size"][0] >= 1100]
    offices.sort(key=lambda m: -sum((m.get("furniture") or {}).values()))
    top = offices[: max(20, len(offices) // 5)]           # the most furnished fifth: the complex ones
    picks = rng.sample(top, min(args.n - 1, len(top)))
    homes = [m for m in metas if m["kind"] == "home" and m["size"][0] >= 900]
    picks.append(rng.choice(homes))
    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out)
    for m in picks:
        img = cv2.imread(glob.glob(os.path.join(args.root, "train", "images", m["name"] + ".*"))[0])
        mask = cv2.imread(os.path.join(args.root, "train", "masks", m["name"] + ".png"), cv2.IMREAD_GRAYSCALE)
        ann, counts = annotate(img, mask)
        sheet = np.hstack([img, ann, legend(counts, img.shape[0])]) if img.shape[0] >= 330 else np.hstack([img, ann])
        path = os.path.join(args.out, f"{m['name']}_annotated.png")
        cv2.imwrite(path, sheet)
        print(m["kind"], m["name"], img.shape[1], "x", img.shape[0], {k: v for k, v in counts.items() if v})
    print("written to", args.out)


if __name__ == "__main__":
    main()
