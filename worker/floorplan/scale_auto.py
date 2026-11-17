"""Scale from what the drawing says about itself.

Plans print the size of small closed objects: "PHONE POD 3'8" X 3'8"",
"PD-7 8'6" X 6'", "OFFICE 14' X 11'2"". When such a label sits inside a closed
box whose outline can be measured, the label and the box together give pixels
per metre. Several independent labels must agree before the scale is accepted;
a single label never is. OCR drops quote marks and misreads digits, so each
number is read in every plausible way and the readings vote.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict

import cv2
import numpy as np

FT = 0.3048
IN = 0.0254
_SIZE = re.compile(
    r"(\d{1,3})\s*[°'’´`\"”]*\s*(\d{0,2})\s*[\"”']*\s*[xX×*]\s*\.?\s*(\d{1,3})\s*[°'’´`\"”]*\s*(\d{0,2})")


def _readings(feet: str, inches: str) -> list[float]:
    """Plausible lengths (m) for one side of a size label."""
    out: list[float] = []
    if inches and 0 <= int(inches) <= 11:
        out.append(int(feet) * FT + int(inches) * IN)           # 11'2"
    elif not inches:
        out.append(int(feet) * FT)                              # 14'
        if len(feet) == 2 and 0 <= int(feet[1]) <= 11 and int(feet[0]) > 0:
            out.append(int(feet[0]) * FT + int(feet[1]) * IN)   # "38" read as 3'8"
        if len(feet) == 3 and 0 <= int(feet[2:]) <= 11:
            out.append(int(feet[:2]) * FT + int(feet[2:]) * IN)  # "117" read as 11'7"
    return [v for v in out if 0.5 <= v <= 12.0]


def size_labels(texts: list[dict]) -> list[dict]:
    found: list[dict] = []
    for t in sorted(texts, key=lambda t: -t.get("score", 0)):
        # the same label read at two resolutions is one label
        if any(abs(t["x"] - f["x"]) < 12 and abs(t["y"] - f["y"]) < 12 for f in found):
            continue
        m = _SIZE.search(t["text"].replace(" ", ""))
        if not m:
            continue
        a_ft, a_in, b_ft, b_in = m.groups()
        a, b = _readings(a_ft, a_in), _readings(b_ft, b_in)
        if a and b:
            found.append({**t, "a": a, "b": b, "raw": t["text"]})
    return found


def _box_around(image_bgr: np.ndarray, x: float, y: float, box: np.ndarray, limit_px: int) -> tuple[float, float] | None:
    """Sides (px, long >= short) of the closed, filled box that contains the label.

    The fill colour is sampled just outside the text; the box is the connected
    area of that colour, which stops at the outline. If it leaks (open space) or
    is not a clean rectangle, there is no answer."""
    h, w = image_bgr.shape[:2]
    pts = np.asarray(box, dtype=float)
    x0, y0 = int(pts[:, 0].min()), int(pts[:, 1].min())
    x1, y1 = int(pts[:, 0].max()), int(pts[:, 1].max())
    # fill colour: the most common colour in a ring just around the text
    pad = 4
    ring = image_bgr[max(0, y0 - pad):min(h, y1 + pad), max(0, x0 - pad):min(w, x1 + pad)].reshape(-1, 3)
    if ring.size == 0:
        return None
    quant = (ring // 12).astype(np.int32)
    keys, counts = np.unique(quant[:, 0] * 10000 + quant[:, 1] * 100 + quant[:, 2], return_counts=True)
    key = int(keys[counts.argmax()])
    fill = np.array([key // 10000, (key // 100) % 100, key % 100]) * 12 + 6
    if fill.min() > 235:      # white: an open room, not a box with its own fill
        return None
    diff = np.abs(image_bgr.astype(np.int32) - fill[None, None, :]).max(axis=2)
    same = (diff <= 26).astype(np.uint8)
    # the text itself interrupts the fill: close small holes
    same = cv2.morphologyEx(same, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(same, connectivity=4)
    label = labels[min(h - 1, max(0, int(y0 - pad))), min(w - 1, max(0, int(x0 - pad)))]
    if label == 0:
        label = labels[int(y), int(x)]
    if label == 0:
        return None
    bx, by, bw, bh, area = (int(v) for v in stats[label])
    if area > limit_px or min(bw, bh) < 12:
        return None
    if area / float(bw * bh) < 0.65:          # not a clean rectangle
        return None
    return float(max(bw, bh)), float(min(bw, bh))


def estimate(image_bgr: np.ndarray, texts: list[dict]) -> dict:
    """Votes of every readable size label that sits in a closed box.
    The result must also make sense for the page: a building between 5 m and
    400 m wide."""
    """{"pxPerM", "votes", "labels", "spreadPct", "confidence"} or {"pxPerM": None, ...}."""
    labels = size_labels(texts)
    limit = int(0.02 * image_bgr.shape[0] * image_bgr.shape[1])
    votes: list[tuple[float, int]] = []   # (px per m, index of the label)
    used = []
    for i, lab in enumerate(labels):
        sides = _box_around(image_bgr, lab["x"], lab["y"], np.array(lab["box"]), limit)
        if not sides:
            continue
        long_px, short_px = sides
        used.append({"text": lab["raw"], "boxPx": [round(long_px, 1), round(short_px, 1)]})
        # label order is width x depth; the box may be turned, so try both ways
        for first, second in ((lab["a"], lab["b"]), (lab["b"], lab["a"])):
            for m_long in first:
                for m_short in second:
                    if m_long >= m_short * 0.999:
                        for px, m in ((long_px, m_long), (short_px, m_short)):
                            votes.append((px / m, len(used) - 1))
    if not votes:
        return {"pxPerM": None, "votes": 0, "labels": used, "confidence": 0.0}
    width_px = image_bgr.shape[1]
    votes = [v for v in votes if 5.0 <= width_px / v[0] <= 400.0]
    if not votes:
        return {"pxPerM": None, "votes": 0, "labels": used, "confidence": 0.0}
    arr = np.array([v[0] for v in votes])
    best = None
    for centre in arr:
        near = [i for i, v in enumerate(arr) if abs(v - centre) / centre <= 0.06]
        distinct = {votes[i][1] for i in near}
        score = (len(distinct), len(near))
        if best is None or score > best[0]:
            best = (score, near)
    (distinct_labels, _), near = best
    chosen = arr[near]
    px_per_m = float(np.median(chosen))
    spread = float((chosen.max() - chosen.min()) / px_per_m * 100)
    # a single label is never enough; two agree "somewhat", three or more are reliable
    confidence = 0.0 if distinct_labels < 2 else (0.5 if distinct_labels == 2 else min(0.9, 0.6 + 0.1 * distinct_labels))
    return {"pxPerM": px_per_m if distinct_labels >= 2 else None, "votes": int(distinct_labels),
            "labels": used, "spreadPct": round(spread, 1), "confidence": round(confidence, 2),
            "candidatePxPerM": px_per_m}


def box_texts(image_bgr: np.ndarray, read_text, max_boxes: int = 4) -> list[dict]:
    """Text inside small coloured boxes (pods, labelled cabins), read from an
    enlarged crop so small print is legible. Positions are in image pixels."""
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[..., 1].astype(np.float32) / 255.0
    val = hsv[..., 2].astype(np.float32) / 255.0
    filled = ((sat > 0.2) & (val > 0.8) & (val < 0.99)).astype(np.uint8) * 255
    filled = cv2.morphologyEx(filled, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(filled, connectivity=8)
    h, w = image_bgr.shape[:2]
    boxes = []
    for i in range(1, count):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        if 700 <= area <= 20000 and area / float(bw * bh) >= 0.6 and 0.4 <= bw / bh <= 2.5:
            boxes.append((area, x, y, bw, bh))
    out: list[dict] = []
    for _, x, y, bw, bh in sorted(boxes, reverse=True)[:max_boxes]:
        pad = 4
        x0, y0 = max(0, x - pad), max(0, y - pad)
        crop = image_bgr[y0:min(h, y + bh + pad), x0:min(w, x + bw + pad)]
        big = cv2.resize(crop, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
        for t in read_text(gray):
            if t.get("kind") == "error":
                continue
            t["x"] = x0 + t["x"] / 5
            t["y"] = y0 + t["y"] / 5
            t["width"] /= 5
            t["height"] /= 5
            t["box"] = [[x0 + p[0] / 5, y0 + p[1] / 5] for p in t["box"]]
            out.append(t)
    return out
