"""Run 7 hard cases: what run 6 still reads wrong on real RF / CAD exports (measured on the user's factory drawing).

Each plan is a run 6 plan (render_hard.render), then the features below are drawn on top. The labels follow the
rule "a wall is only a wall": everything added here is NOT wall (floor inside the building, background outside),
except the thick grey exterior band, which IS wall.

1. RF wall overlay: a coloured line (cyan, blue, grey, magenta) running ALONG the walls a little to one side, as RF
   tools draw their own wall model over the CAD drawing. Run 6 read it as a second, parallel wall.
2. Machinery and racks: dense line-work in the same black ink and stroke width as the walls (rack rows with bays,
   machine footprints with inner detail, part grids). Run 6 read it as walls.
3. Conveyors: double tracks with rungs and stations, straight runs and U loops.
4. Gang-way markings: dashed double lines with arrow heads and "<<-- 4 M Gang Way -->>" text.
5. Solid equipment blocks: filled grey / black rectangles standing in the floor (not walls).
6. A thick grey exterior wall band (this one IS wall): run 6 missed the heavy grey outer wall.
7. The site outside: rounded kerbs, roads with dashed centre lines, a row of round tanks / silos, parking boxes.

Low resolution and a stretched aspect are applied by make_dataset_v7.py (labels move with the image).
"""
import math
import random

import cv2
import numpy as np

import render_hard as rh

WALL, FLOOR, BG = rh.CLASSES["wall"], rh.CLASSES["floor"], rh.CLASSES["background"]

# what run 6 struggles with: industrial and RF exports weigh most
THEME_WEIGHTS_V7 = {"industrial": 34, "rf_office": 22, "cad_office": 10, "mall": 8, "parking": 6, "schematic": 6,
                    "hospital": 5, "school": 4, "hotel": 3, "residential": 2}
OVERLAY_COLOURS = [(255, 255, 0), (240, 230, 60), (230, 200, 40), (200, 120, 40), (150, 150, 150), (200, 60, 200),
                   (60, 200, 255)]


def _ink(img):
    """The darkest common colour of the drawing (its wall ink)."""
    g = img.mean(axis=2)
    dark = img[g < np.percentile(g, 2) + 1]
    return tuple(int(v) for v in np.median(dark, axis=0)) if len(dark) else (20, 20, 20)


def _wall_stroke(mask):
    """Typical drawn wall width in px (from the wall label)."""
    w = (mask == WALL).astype(np.uint8)
    if not w.any():
        return 2
    dt = cv2.distanceTransform(w, cv2.DIST_L2, 3)
    return int(max(1, min(6, round(2 * np.median(dt[dt > 0])))))


FURNITURE = [rh.CLASSES[k] for k in ("desk", "chair", "plant") if k in rh.CLASSES]


def _free_floor(mask, margin_px):
    """Floor (or furniture, which equipment may replace) at least `margin_px` from any wall, stair, void, door or
    window: equipment stands in the open floor, never on the building's structure."""
    structure = ~np.isin(mask, [FLOOR, *FURNITURE])
    dist = cv2.distanceTransform((~structure).astype(np.uint8), cv2.DIST_L2, 3)
    return (~structure) & (dist >= margin_px)


def _claim(mask, x, y, w, h):
    """The rectangle now holds equipment: what was furniture there is floor (equipment is not furniture)."""
    sub = mask[y:y + h + 1, x:x + w + 1]
    sub[np.isin(sub, FURNITURE)] = FLOOR


def _fit(free, wm, hm, ppm, rng, min_px=12):
    """A place for a wm x hm metre block, trying smaller sizes when it does not fit: (x, y, w, h) or None."""
    for f in (1.0, 0.7, 0.5, 0.35, 0.25):
        w, h = int(wm * f * ppm), int(hm * f * ppm)
        if min(w, h) < min_px:
            return None
        at = _rect_in(free, w, h, rng)
        if at is not None:
            return at[0], at[1], w, h
    return None


def _rect_in(free, w, h, rng, tries=60):
    """Top-left of a w x h rectangle fully inside `free`, or None."""
    H, W = free.shape
    if w >= W - 2 or h >= H - 2:
        return None
    ys, xs = np.nonzero(free)
    if len(xs) == 0:
        return None
    integral = cv2.integral(free.astype(np.uint8))
    for _ in range(tries):
        i = rng.randrange(len(xs))
        x, y = int(xs[i] - w / 2), int(ys[i] - h / 2)
        if x < 1 or y < 1 or x + w >= W - 1 or y + h >= H - 1:
            continue
        s = integral[y + h, x + w] - integral[y, x + w] - integral[y + h, x] + integral[y, x]
        if s == w * h:
            return x, y
    return None


# ---- 1. RF wall overlay -------------------------------------------------------------------------------------
def rf_wall_overlay(img, mask, lines, rng, ppm):
    """A coloured line along part of the walls, shifted a little to one side; never on the wall label."""
    col = rng.choice(OVERLAY_COLOURS)
    off = max(2, int(round(ppm * rng.uniform(0.12, 0.9))))
    lw = rng.choice([1, 1, 2, 2, 3])
    cl = (lines > 0).astype(np.uint8)
    k = max(8, int(ppm * 1.5))
    horiz = cv2.morphologyEx(cl, cv2.MORPH_OPEN, np.ones((1, k), np.uint8))
    vert = cv2.morphologyEx(cl, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8))
    sh = np.zeros_like(cl)
    dy, dx = rng.choice([-1, 1]) * off, rng.choice([-1, 1]) * off
    sh |= np.roll(horiz, dy, axis=0)
    sh |= np.roll(vert, dx, axis=1)
    if rng.random() < 0.35:   # sometimes right on the wall too (where it changes nothing in the labels)
        sh |= cl
    # only along part of the building (RF tools model some walls, not all)
    H, W = mask.shape
    field = cv2.resize(np.random.default_rng(rng.randrange(1 << 30)).random((max(2, H // 90), max(2, W // 90))),
                       (W, H), interpolation=cv2.INTER_LINEAR)
    sh &= (field > rng.uniform(0.2, 0.55)).astype(np.uint8)
    if lw > 1:
        sh = cv2.dilate(sh, np.ones((lw, lw), np.uint8))
    paint = (sh > 0) & (mask != WALL)
    img[paint] = col
    return int(paint.sum())


# ---- 2. machinery and racks ---------------------------------------------------------------------------------
def machinery(img, mask, rng, ppm, ink, stroke):
    free = _free_floor(mask, max(3, 0.6 * ppm))
    placed = 0
    for _ in range(rng.randint(2, 7)):
        kind = rng.choice(["racks", "racks", "machine", "machine", "grid", "cells"])
        got = _fit(free, rng.uniform(5, 26), rng.uniform(4, 16), ppm, rng)
        if got is None:
            continue
        x, y, w, h = got
        _claim(mask, x, y, w, h)
        lw = max(1, stroke + rng.choice([-1, 0, 0, 1]))
        col = ink if rng.random() < 0.75 else (70, 70, 70)
        if kind == "racks":                      # rows of long racks, each split into bays
            n = max(2, int(h / max(6, ppm * rng.uniform(1.4, 2.6))))
            rh_ = h / n
            for i in range(n):
                y0 = int(y + i * rh_ + rh_ * 0.15)
                y1 = int(y + i * rh_ + rh_ * 0.65)
                cv2.rectangle(img, (x, y0), (x + w, y1), col, lw)
                step = max(4, int(ppm * rng.uniform(0.9, 2.7)))
                for bx in range(x + step, x + w, step):
                    cv2.line(img, (bx, y0), (bx, y1), col, max(1, lw - 1))
        elif kind == "machine":                  # a footprint with inner parts, sometimes filled
            cv2.rectangle(img, (x, y), (x + w, y + h), col, lw)
            for _ in range(rng.randint(3, 12)):
                iw, ih = int(rng.uniform(0.1, 0.45) * w), int(rng.uniform(0.1, 0.45) * h)
                ix, iy = x + rng.randint(1, max(2, w - iw - 1)), y + rng.randint(1, max(2, h - ih - 1))
                if rng.random() < 0.3:
                    cv2.circle(img, (ix + iw // 2, iy + ih // 2), max(2, min(iw, ih) // 2), col, max(1, lw - 1), cv2.LINE_AA)
                elif rng.random() < 0.25:
                    cv2.rectangle(img, (ix, iy), (ix + iw, iy + ih), (60, 60, 60) if rng.random() < 0.5 else col, -1)
                else:
                    cv2.rectangle(img, (ix, iy), (ix + iw, iy + ih), col, max(1, lw - 1))
        elif kind == "grid":                     # a part grid / pallet grid
            s = max(4, int(ppm * rng.uniform(0.8, 2.0)))
            for gx in range(x, x + w + 1, s):
                cv2.line(img, (gx, y), (gx, y + h), col, max(1, lw - 1))
            for gy in range(y, y + h + 1, s):
                cv2.line(img, (x, gy), (x + w, gy), col, max(1, lw - 1))
        else:                                    # work cells: small boxes in a block, some filled
            s = max(6, int(ppm * rng.uniform(1.2, 3.0)))
            for gx in range(x, x + w - s, s + 2):
                for gy in range(y, y + h - s, s + 2):
                    if rng.random() < 0.8:
                        cv2.rectangle(img, (gx, gy), (gx + s, gy + s), col, -1 if rng.random() < 0.2 else max(1, lw - 1))
        free[y - 2:y + h + 3, x - 2:x + w + 3] = False
        placed += 1
    return placed


# ---- 3. conveyors -------------------------------------------------------------------------------------------
def conveyor(img, mask, rng, ppm, ink, stroke):
    free = _free_floor(mask, max(3, 0.8 * ppm))
    horiz = rng.random() < 0.6
    Lm, Sm = rng.uniform(18, 60), rng.uniform(4, 9)
    got = _fit(free, Lm if horiz else Sm, Sm if horiz else Lm, ppm, rng)
    if got is None:
        return 0
    x, y, w, h = got
    _claim(mask, x, y, w, h)
    S = min(w, h)
    col = ink if rng.random() < 0.6 else rng.choice([(90, 90, 90), (40, 40, 160), (160, 90, 40)])
    lw = max(1, stroke - rng.choice([0, 1]))
    track = max(3, int(ppm * rng.uniform(0.5, 1.2)))
    if rng.random() < 0.5:   # a U loop (stadium)
        r = (min(w, h) - 2) // 2
        a = (x + r, y + r) if horiz else (x + r, y + r)
        b = (x + w - r, y + r) if horiz else (x + r, y + h - r)
        for rad in (r, max(2, r - track)):
            if horiz:
                cv2.line(img, (a[0], a[1] - rad), (b[0], b[1] - rad), col, lw)
                cv2.line(img, (a[0], a[1] + rad), (b[0], b[1] + rad), col, lw)
                cv2.ellipse(img, a, (rad, rad), 0, 90, 270, col, lw, cv2.LINE_AA)
                cv2.ellipse(img, b, (rad, rad), 0, -90, 90, col, lw, cv2.LINE_AA)
            else:
                cv2.line(img, (a[0] - rad, a[1]), (b[0] - rad, b[1]), col, lw)
                cv2.line(img, (a[0] + rad, a[1]), (b[0] + rad, b[1]), col, lw)
                cv2.ellipse(img, a, (rad, rad), 0, 180, 360, col, lw, cv2.LINE_AA)
                cv2.ellipse(img, b, (rad, rad), 0, 0, 180, col, lw, cv2.LINE_AA)
    else:                    # straight double tracks with rungs and stations
        for k in range(rng.randint(1, 3)):
            o = int(k * (S / 3))
            if horiz:
                cv2.line(img, (x, y + o), (x + w, y + o), col, lw)
                cv2.line(img, (x, y + o + track), (x + w, y + o + track), col, lw)
                for rx in range(x, x + w, max(3, int(ppm * rng.uniform(0.5, 1.5)))):
                    cv2.line(img, (rx, y + o), (rx, y + o + track), col, 1)
            else:
                cv2.line(img, (x + o, y), (x + o, y + h), col, lw)
                cv2.line(img, (x + o + track, y), (x + o + track, y + h), col, lw)
                for ry in range(y, y + h, max(3, int(ppm * rng.uniform(0.5, 1.5)))):
                    cv2.line(img, (x + o, ry), (x + o + track, ry), col, 1)
        for _ in range(rng.randint(2, 8)):   # stations
            sx, sy = x + rng.randint(0, max(1, w - 8)), y + rng.randint(0, max(1, h - 8))
            ss = max(4, int(ppm * rng.uniform(0.8, 2.0)))
            cv2.rectangle(img, (sx, sy), (sx + ss, sy + ss), rng.choice([col, (230, 200, 0), (0, 200, 230)]), -1 if rng.random() < 0.4 else 1)
    return 1


# ---- 4. gang-way markings -----------------------------------------------------------------------------------
def gangways(cv_texts, img, mask, rng, ppm, ink):
    free = _free_floor(mask, max(2, 0.4 * ppm))
    n = 0
    for _ in range(rng.randint(1, 4)):
        horiz = rng.random() < 0.6
        Lm, Gm = rng.uniform(15, 70), rng.uniform(1.5, 4.0)
        got = _fit(free, Lm if horiz else Gm, Gm if horiz else Lm, ppm, rng, min_px=3)
        if got is None:
            continue
        x, y, w, h = got
        _claim(mask, x, y, w, h)
        gap = h if horiz else w
        col = rng.choice([ink, (90, 90, 90), (40, 40, 160)])
        dash = (max(4, int(ppm * 0.8)), max(3, int(ppm * 0.5)))
        for o in (0, gap):
            a = (x, y + o) if horiz else (x + o, y)
            b = (x + w, y + o) if horiz else (x + o, y + h)
            rh.polyline(img, [a, b], col, 1, dash=dash)
        cx, cy = x + w // 2, y + h // 2
        size = max(6.5, ppm * rng.uniform(0.55, 1.0))
        label = rng.choice(["<<---- 4 M Gang Way ---->>", "<<--4 M Gang Way-->>", "<<--3M Material Gang Way-->>",
                            "<-- WALKWAY -->", "<< FORKLIFT PATH >>"])
        cv_texts.append((cx, cy, label, size, col, 0 if horiz else 90, "mm", None, None))
        n += 1
    return n


# ---- 5. solid equipment blocks ------------------------------------------------------------------------------
def solid_blocks(img, mask, rng, ppm):
    free = _free_floor(mask, max(3, 0.5 * ppm))
    n = 0
    for _ in range(rng.randint(1, 5)):
        got = _fit(free, rng.uniform(1.5, 8), rng.uniform(1.2, 6), ppm, rng, min_px=5)
        if got is None:
            continue
        x, y, w, h = got
        _claim(mask, x, y, w, h)
        col = rng.choice([(40, 40, 40), (90, 90, 90), (120, 120, 120), (70, 70, 70)])
        cv2.rectangle(img, (x, y), (x + w, y + h), col, -1)
        free[y - 2:y + h + 3, x - 2:x + w + 3] = False
        n += 1
    return n


# ---- 6. thick grey exterior wall band (IS wall) ------------------------------------------------------------
def grey_exterior_band(img, mask, rng, ppm):
    wall = (mask == WALL).astype(np.uint8)
    outside = (mask == BG).astype(np.uint8)
    t = max(2, int(round(ppm * rng.uniform(0.4, 1.2))))
    ext = wall & (cv2.dilate(outside, np.ones((3, 3), np.uint8)) > 0)          # wall pixels on the outside face
    band = (cv2.dilate(ext, np.ones((2 * t + 1, 2 * t + 1), np.uint8)) > 0) & (outside > 0)
    # only along part of the outline (often one side drawn heavy)
    H, W = mask.shape
    side = rng.choice(["right", "left", "top", "bottom", "all"])
    keep = np.ones_like(band)
    if side == "right":
        keep[:, : int(W * 0.6)] = False
    elif side == "left":
        keep[:, int(W * 0.4):] = False
    elif side == "top":
        keep[int(H * 0.4):, :] = False
    elif side == "bottom":
        keep[: int(H * 0.6), :] = False
    band &= keep
    col = rng.choice([(110, 110, 110), (130, 130, 130), (90, 90, 90)])
    img[band] = col
    img[(wall > 0) & keep & (cv2.dilate(band.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)] = col
    mask[band] = WALL
    return int(band.sum())


# ---- 7. site outside the building --------------------------------------------------------------------------
def site(img, mask, rng, ppm, ink):
    bg = (mask == BG).astype(np.uint8)
    building = (mask != BG).astype(np.uint8)
    ys, xs = np.nonzero(building)
    if len(xs) == 0:
        return 0
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    H, W = mask.shape
    paint = np.zeros((H, W), np.uint8)
    col = rng.choice([ink, (110, 110, 110), (150, 150, 150)])
    # rounded kerb / boundary around the building
    g = int(ppm * rng.uniform(2, 9))
    r = int(ppm * rng.uniform(3, 12))
    rect = (max(1, x0 - g), max(1, y0 - g), min(W - 2, x1 + g), min(H - 2, y1 + g))
    _rounded(paint, rect, r, 255, rng.choice([1, 1, 2]))
    if rng.random() < 0.7:   # road: two lines and a dashed centre line along one side
        side_y = min(H - 3, y1 + g + int(ppm * rng.uniform(2, 6)))
        width = int(ppm * rng.uniform(4, 8))
        for o in (0, width):
            if side_y + o < H - 1:
                cv2.line(paint, (0, side_y + o), (W - 1, side_y + o), 255, 1)
        if side_y + width // 2 < H - 1:
            rh.polyline(paint, [(0, side_y + width // 2), (W - 1, side_y + width // 2)], 255, 1,
                        dash=(max(4, int(ppm)), max(3, int(ppm * 0.7))))
    if rng.random() < 0.6:   # a row of round tanks / silos against one side
        n = rng.randint(5, 14)
        rr = max(3, int(ppm * rng.uniform(0.6, 1.4)))
        yy = max(rr + 1, y0 - rr - 2)
        for i in range(n):
            cx = int(x0 + (i + 1) * (x1 - x0) / (n + 2))
            cv2.circle(paint, (cx, yy), rr, 255, 1, cv2.LINE_AA)
            cv2.circle(paint, (cx, yy), max(1, rr // 2), 255, 1, cv2.LINE_AA)
    if rng.random() < 0.5:   # a parking / bus box
        bw, bh = int(ppm * rng.uniform(5, 14)), int(ppm * rng.uniform(1.5, 3))
        bx, by = int(x0 + (x1 - x0) * rng.uniform(0.1, 0.6)), max(2, y0 - g - bh - 4)
        cv2.rectangle(paint, (bx, by), (bx + bw, by + bh), 255, 1)
    on = (paint > 0) & (bg > 0)
    img[on] = col
    return int(on.sum())


def _rounded(canvas, rect, r, col, lw):
    x0, y0, x1, y1 = rect
    r = max(1, min(r, (x1 - x0) // 2, (y1 - y0) // 2))
    cv2.line(canvas, (x0 + r, y0), (x1 - r, y0), col, lw)
    cv2.line(canvas, (x0 + r, y1), (x1 - r, y1), col, lw)
    cv2.line(canvas, (x0, y0 + r), (x0, y1 - r), col, lw)
    cv2.line(canvas, (x1, y0 + r), (x1, y1 - r), col, lw)
    for c, a in (((x0 + r, y0 + r), 180), ((x1 - r, y0 + r), 270), ((x1 - r, y1 - r), 0), ((x0 + r, y1 - r), 90)):
        cv2.ellipse(canvas, c, (r, r), 0, a, a + 90, col, lw, cv2.LINE_AA)


def render(rng, np_rng, theme=None):
    """(image, mask, centre-lines, meta, vector truth): a run 6 plan with the run 7 hard cases drawn on top."""
    theme = theme or rng.choices(list(THEME_WEIGHTS_V7), list(THEME_WEIGHTS_V7.values()))[0]
    # harder plans: run 7 is about real, busy exports
    diff = rng.choices([2, 3, 4, 5], [10, 25, 35, 30])[0]
    img, mask, lines, meta, gt = rh.render(rng, np_rng, theme=theme, difficulty=diff)
    ppm = float(meta["px_per_m"])
    ink = _ink(img)
    stroke = _wall_stroke(mask)
    added = {}
    industrial = theme in ("industrial", "parking", "mall")
    if rng.random() < (0.85 if industrial else 0.35):
        added["machinery"] = machinery(img, mask, rng, ppm, ink, stroke)
    if rng.random() < (0.6 if industrial else 0.1):
        added["conveyor"] = conveyor(img, mask, rng, ppm, ink, stroke)
    texts = []
    if rng.random() < (0.7 if industrial else 0.15):
        added["gangways"] = gangways(texts, img, mask, rng, ppm, ink)
    if rng.random() < (0.5 if industrial else 0.15):
        added["solid_blocks"] = solid_blocks(img, mask, rng, ppm)
    if rng.random() < 0.6:
        added["rf_overlay_px"] = rf_wall_overlay(img, mask, lines, rng, ppm)
    if rng.random() < 0.3:
        added["grey_band_px"] = grey_exterior_band(img, mask, rng, ppm)
    if rng.random() < (0.75 if industrial else 0.35):
        added["site_px"] = site(img, mask, rng, ppm, ink)
    if texts:   # gang-way labels, drawn like every other text of the plan
        cv = rh.Canvas(img.shape[1], img.shape[0], ppm, 0, 0, (255, 255, 255))
        cv.img = img
        cv.texts = texts
        rh.render_texts(cv, rng)
        img = cv.img
    meta["v7"] = added
    meta["kind"] = "hard_v7"
    return img, mask, lines, meta, gt
