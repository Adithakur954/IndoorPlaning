"""Writes preview PNGs: the image on the left, the same image with the label mask on the right.

    python train/preview.py train/samples            # every image in the folder
    python train/preview.py train/dataset --n 24     # a random sample, as one contact sheet
Colours: wall = red, door = green, window = blue, floor = pale yellow.
"""
import argparse
import glob
import os
import random

import cv2
import numpy as np

COLOURS = {1: (60, 60, 230), 2: (60, 200, 60), 3: (230, 140, 40), 4: (150, 230, 240), 5: (200, 60, 200), 6: (0, 140, 255),
           7: (0, 200, 255), 8: (255, 110, 20), 9: (180, 200, 0), 10: (120, 0, 160), 11: (60, 170, 60), 12: (0, 90, 200), 13: (150, 150, 150)}  # BGR


def overlay(img, mask):
    out = img.copy()
    for v, c in COLOURS.items():
        out[mask == v] = (0.45 * out[mask == v] + 0.55 * np.array(c)).astype(np.uint8)
    return out


def pair(img_path, max_w=1500):
    img = cv2.imread(img_path)
    name = os.path.splitext(os.path.basename(img_path))[0]
    mask = cv2.imread(os.path.join(os.path.dirname(os.path.dirname(img_path)), "masks", name + ".png"), 0)
    both = np.hstack([img, overlay(img, mask)])
    if both.shape[1] > max_w:
        f = max_w / both.shape[1]
        both = cv2.resize(both, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    return both, name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--n", type=int, default=0, help="random sample as a contact sheet")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.folder, "*", "images", "*.*")))
    out = os.path.join(args.folder, "preview")
    os.makedirs(out, exist_ok=True)
    if args.n:
        random.Random(7).shuffle(files)
        tiles = []
        for p in files[:args.n]:
            both, _ = pair(p, 700)
            h = 330
            tiles.append(cv2.resize(both, (int(both.shape[1] * h / both.shape[0]), h)))
        w = max(t.shape[1] for t in tiles)
        rows = [np.hstack([cv2.copyMakeBorder(t, 0, 0, 0, w - t.shape[1], cv2.BORDER_CONSTANT, value=(255, 255, 255)) for t in tiles[i:i + 2]])
                for i in range(0, len(tiles) - 1, 2)]
        sheet = np.vstack(rows)
        cv2.imwrite(os.path.join(out, "contact_sheet.png"), sheet)
        print(os.path.join(out, "contact_sheet.png"))
    else:
        for p in files:
            both, name = pair(p)
            cv2.imwrite(os.path.join(out, name + "_preview.png"), both)
            print(os.path.join(out, name + "_preview.png"))


if __name__ == "__main__":
    main()
