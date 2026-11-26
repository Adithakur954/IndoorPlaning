"""Image damage for dataset v6 (and, at training time, for the old v4 images).

Geometric changes move the image and every label map together (nearest-neighbour for labels), so a label never
points at the wrong pixels. Photometric changes touch the image only: a wall that is faded, broken by a photocopy
or crossed by a pen stroke is still labelled wall, which is exactly what the model must learn.

    img, maps, ops = damage(img, [mask, lines], rng, np_rng, strength)
    img, mask, lines = shrink(img, mask, lines, f)      # label-aware downscale for 16 classes + centre-lines
"""
from __future__ import annotations

import math

import cv2
import numpy as np

IGNORE = 255
# class weights for the label-aware shrink: thin classes win over the floor around them
WEIGHTS = np.array([1.0, 2.5, 2.5, 2.5, 1.0, 2.5, 2.5,      # background, wall, door, window, floor, column, ap
                    2.0, 2.5, 2.0, 2.0, 2.0, 2.0, 2.0,      # desk, chair, table, sofa, plant, pod, storage
                    2.0, 1.2], np.float32)                  # stairs, void


def shrink(img, mask, lines, f):
    h, w = mask.shape
    nw, nh = max(8, int(round(w * f))), max(8, int(round(h * f)))
    out = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    best = np.full((nh, nw), -1.0, np.float32)
    lab = np.zeros((nh, nw), np.uint8)
    present = np.unique(mask)
    for c in present:
        wgt = WEIGHTS[c] if c < len(WEIGHTS) else 1.0
        ch = cv2.resize((mask == c).astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA) * wgt
        upd = ch > best
        best[upd] = ch[upd]
        lab[upd] = c
    ln = None
    if lines is not None:
        ln = (cv2.resize((lines > 0).astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA) > 0.12).astype(np.uint8) * 255
        ln[lab != 1] = 0
    return out, lab, ln


def _warp(img, maps, M, size, persp=False, bg=(255, 255, 255)):
    W, H = size
    f = cv2.warpPerspective if persp else cv2.warpAffine
    img = f(img, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=bg)
    maps = [None if m is None else f(m, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0) for m in maps]
    return img, maps


def damage(img, maps, rng, np_rng, strength=1.0):
    """strength 0..1.5: how likely each kind of damage is."""
    H, W = img.shape[:2]
    bg = tuple(int(v) for v in img[2, 2])
    ops = []
    s = strength

    def p(x):
        return rng.random() < min(0.95, x * s)

    # ---------------- geometry (image + labels)
    if p(0.4):
        ang = rng.uniform(-4, 4)
        img, maps = _warp(img, maps, cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0), (W, H), bg=bg)
        ops.append(f"rot{ang:.1f}")
    if p(0.15):   # scanner stretch: different x and y scale
        sx, sy = rng.uniform(0.9, 1.1), rng.uniform(0.9, 1.1)
        M = np.float32([[sx, 0, (1 - sx) * W / 2], [0, sy, (1 - sy) * H / 2]])
        img, maps = _warp(img, maps, M, (W, H), bg=bg)
        ops.append(f"stretch{sx:.2f}x{sy:.2f}")
    if p(0.14):
        d = rng.uniform(0.01, 0.06)
        src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        dst = src + np.float32([[rng.uniform(-d, d) * W, rng.uniform(-d, d) * H] for _ in range(4)])
        img, maps = _warp(img, maps, cv2.getPerspectiveTransform(src, dst), (W, H), persp=True, bg=bg)
        ops.append("persp")
    if p(0.08):   # fold: one band of the sheet slips by a few pixels, with a crease
        y = rng.randint(H // 5, 4 * H // 5)
        dy = rng.randint(-4, 4) or 2
        img = img.copy()
        img[y:] = np.roll(img[y:], dy, axis=0)
        maps = [None if m is None else np.concatenate([m[:y], np.roll(m[y:], dy, axis=0)]) for m in maps]
        cv2.line(img, (0, y), (W, y), tuple(int(v * 0.6) for v in bg), 1, cv2.LINE_AA)
        ops.append("fold")
    if p(0.06):   # a missing / torn corner: nothing to see there, nothing to judge
        cw, ch = int(W * rng.uniform(0.08, 0.25)), int(H * rng.uniform(0.08, 0.25))
        x0 = 0 if rng.random() < 0.5 else W - cw
        y0 = 0 if rng.random() < 0.5 else H - ch
        img = img.copy()
        img[y0:y0 + ch, x0:x0 + cw] = bg
        maps = [None if m is None else m.copy() for m in maps]
        if maps[0] is not None:
            maps[0][y0:y0 + ch, x0:x0 + cw] = IGNORE
        for m in maps[1:]:
            if m is not None:
                m[y0:y0 + ch, x0:x0 + cw] = 0
        ops.append("torn")
    if p(0.12):
        pad = int(max(W, H) * rng.uniform(0.03, 0.1))
        col = rng.choice([(0, 0, 0), (20, 20, 20), (110, 110, 110), (235, 235, 235)])
        img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=col)
        maps = [None if m is None else cv2.copyMakeBorder(m, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0) for m in maps]
        ops.append("border")

    # ---------------- ink and paper (image only)
    f = img.astype(np.float32)
    if p(0.12):   # handwritten corrections / markups across the plan
        for _ in range(rng.randint(1, 6)):
            col = rng.choice([(200, 40, 30), (30, 30, 200), (80, 80, 80), (30, 140, 30)])
            x, y = rng.uniform(0, f.shape[1]), rng.uniform(0, f.shape[0])
            pts = []
            a = rng.uniform(0, 2 * math.pi)
            for _k in range(rng.randint(6, 30)):
                a += rng.uniform(-0.6, 0.6)
                x += math.cos(a) * rng.uniform(5, 25)
                y += math.sin(a) * rng.uniform(5, 25)
                pts.append((x, y))
            cv2.polylines(f, [np.int32(pts)], False, col, rng.randint(1, 3), cv2.LINE_AA)
        ops.append("pen")
    if p(0.1):    # stains
        for _ in range(rng.randint(1, 3)):
            m = np.zeros(f.shape[:2], np.float32)
            cv2.circle(m, (rng.randrange(f.shape[1]), rng.randrange(f.shape[0])), rng.randint(30, max(31, f.shape[0] // 4)), 1.0, -1)
            m = cv2.GaussianBlur(m, (0, 0), 25)[..., None]
            tint = np.array([rng.uniform(150, 200), rng.uniform(170, 215), rng.uniform(190, 235)], np.float32)
            f = f * (1 - 0.35 * m) + tint * 0.35 * m
        ops.append("stain")
    if p(0.12):   # faded / broken lines: ink pulled towards the paper in random patches
        noise = cv2.resize(np_rng.random((max(2, f.shape[0] // 24), max(2, f.shape[1] // 24))).astype(np.float32),
                           (f.shape[1], f.shape[0]), interpolation=cv2.INTER_LINEAR)
        k = np.clip((noise - 0.55) * 2.2, 0, 0.75)[..., None]
        f = f * (1 - k) + np.array(bg, np.float32) * k
        ops.append("faded")
    if p(0.08):   # photocopy of a photocopy: threshold, spread, again
        for _ in range(rng.randint(1, 3)):
            g = cv2.cvtColor(np.clip(f, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
            g = cv2.GaussianBlur(g, (0, 0), rng.uniform(0.5, 1.1))
            g = np.where(g < rng.uniform(120, 190), g * 0.4, 255 - (255 - g) * 0.3)
            f = np.repeat(g[..., None], 3, axis=2)
        ops.append("photocopy")
    if p(0.06):   # colour channels out of register
        dx, dy = rng.randint(-3, 3), rng.randint(-3, 3)
        f[..., 0] = np.roll(np.roll(f[..., 0], dx, axis=1), dy, axis=0)
        ops.append("misregister")
    img = np.clip(f, 0, 255).astype(np.uint8)
    if p(0.45):
        q = rng.uniform(0.35, 0.85)
        h, w = img.shape[:2]
        small = cv2.resize(img, (max(8, int(w * q)), max(8, int(h * q))), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC if rng.random() < .5 else cv2.INTER_LINEAR)
        ops.append(f"lowres{q:.2f}")
    if p(0.3):
        sg = rng.uniform(0.4, 1.6)
        img = cv2.GaussianBlur(img, (0, 0), sg)
        ops.append(f"blur{sg:.1f}")
    f = img.astype(np.float32)
    if p(0.28):
        k = rng.uniform(0.6, 0.95)
        f = 255 - (255 - f) * k if rng.random() < .5 else f * k + (1 - k) * 128
        ops.append("lowcontrast")
    if p(0.25):
        f = f * np.array([rng.uniform(.88, 1.0), rng.uniform(.92, 1.0), rng.uniform(.95, 1.0)])[None, None, :]
        ops.append("tint")
    if p(0.25):
        h, w = f.shape[:2]
        f = f * np.linspace(rng.uniform(.8, 1), rng.uniform(.9, 1.05), w)[None, :, None] \
              * np.linspace(rng.uniform(.85, 1), rng.uniform(.9, 1.05), h)[:, None, None]
        ops.append("shade")
    if p(0.32):
        sg = rng.uniform(2, 12)
        f = f + np_rng.normal(0, sg, f.shape).astype(np.float32)
        ops.append(f"noise{sg:.0f}")
    if p(0.1):
        n = int(f.shape[0] * f.shape[1] * rng.uniform(1e-4, 8e-4))
        f[np_rng.integers(0, f.shape[0], n), np_rng.integers(0, f.shape[1], n)] = rng.choice([0, 255])
        ops.append("specks")
    return np.clip(f, 0, 255).astype(np.uint8), maps, ops
