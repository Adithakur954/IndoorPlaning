"""Makes genuinely small (or small-then-enlarged) versions of a rendered plan and its mask.

A plain blur keeps the pixel size, so walls stay thick.  Here the picture is shrunk with area averaging
(walls become 2-8 px, doors a few px) and the mask is shrunk with class-wise area averaging in which the thin
classes (wall, door, window, column) are boosted, so a thin wall is not lost to the floor around it.
"""
import math

import cv2
import numpy as np

WEIGHTS = np.array([1.0, 2.5, 2.5, 2.5, 1.0, 2.5, 2.5,           # background, wall, door, window, floor, column, ap
                    2.0, 2.5, 2.0, 2.0, 2.0, 2.0, 2.0], np.float32)  # desk, chair, table, sofa, plant, pod, storage
IGNORE = 255
MAX_SIDE = 2400  # no training image is larger than this on its longest side


def shrink(img, mask, f):
    h, w = mask.shape
    nw, nh = max(8, int(round(w * f))), max(8, int(round(h * f)))
    out = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    best = np.full((nh, nw), -1.0, np.float32)
    lab = np.zeros((nh, nw), np.uint8)
    for c in list(range(len(WEIGHTS))) + [IGNORE]:
        ch = cv2.resize((mask == c).astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA) * (WEIGHTS[c] if c < len(WEIGHTS) else 1.0)
        upd = ch > best
        best[upd] = ch[upd]
        lab[upd] = c
    return out, lab


def enlarge(img, mask, g):
    h, w = mask.shape
    nw, nh = int(round(w * g)), int(round(h * g))
    return (cv2.resize(img, (nw, nh), interpolation=cv2.INTER_CUBIC if g > 1.6 else cv2.INTER_LINEAR),
            cv2.resize(mask, (nw, nh), interpolation=cv2.INTER_NEAREST))


def cap_size(img, mask, meta, limit=MAX_SIDE):
    """Shrinks an over-large image (and its mask, label-aware) so the longest side is at most `limit`."""
    longest = max(mask.shape)
    if longest <= limit:
        return img, mask
    f = limit / longest
    img, mask = shrink(img, mask, f)
    meta.update(wall_px=round(float(meta["wall_px"]) * f, 2), px_per_m=round(float(meta["px_per_m"]) * f, 3),
                capped=True)
    return img, mask


def make_small(img, mask, meta, rng):
    """Returns the rescaled (img, mask) and updates meta; about half are enlarged back, as the pipeline does."""
    wall = max(float(meta["wall_px"]), 1.0)
    target = math.exp(rng.uniform(math.log(2.0), math.log(8.0)))   # wall thickness wanted after shrinking
    f = min(0.85, target / wall)
    f = max(f, 360.0 / max(mask.shape))                             # keep at least ~360 px on the long side
    f = min(f, 0.85)
    img, mask = shrink(img, mask, f)
    scale = f
    enlarged = rng.random() < 0.5
    if enlarged:
        want = math.exp(rng.uniform(math.log(8.0), math.log(14.0)))
        g = want / max(wall * f, 0.5)
        g = min(max(g, 1.5), 4.0, MAX_SIDE / max(mask.shape))      # never past the size cap
        if g < 1.3:
            enlarged = False
        else:
            img, mask = enlarge(img, mask, g)
            scale *= g
    meta.update(shrink=round(f, 3), enlarged=enlarged, wall_px=round(wall * scale, 2),
                px_per_m=round(float(meta["px_per_m"]) * scale, 3))
    return img, mask
