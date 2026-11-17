"""Colour-coded drawings (CAD layers exported in colour).

Walls are drawn in neutral dark greys; furniture, planters, columns, door
swings, dimension lines and markers use saturated colours. Reading the colour
keeps planters (green), columns (yellow/orange), door arcs (yellow) and
dimension lines (teal) out of the wall mask. For black-and-white drawings none
of this applies and the plain ink mask is used.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class ColourLayers:
    coloured: bool                      # the drawing really uses colour
    neutral: np.ndarray                 # 0/255: dark, unsaturated strokes (wall candidates)
    symbol: np.ndarray                  # 0/255: any non-white stroke (door arcs, glazing, ...)
    columns: list[dict] = field(default_factory=list)   # filled yellow/orange blocks
    markers: list[dict] = field(default_factory=list)   # round yellow dots with a dark ring
    saturated_fraction: float = 0.0


def analyse(image_bgr: np.ndarray, ink_cut: float = 0.67) -> ColourLayers:
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    hue = hsv[..., 0].astype(np.float32) * 2.0          # degrees
    sat = hsv[..., 1].astype(np.float32) / 255.0
    val = hsv[..., 2].astype(np.float32) / 255.0

    drawn = val < 0.93
    # colour noise (scanner or JPEG speckle on a grey drawing) is not colour
    # coding: judge the colour of a median-filtered copy, where noise is gone
    smooth = cv2.cvtColor(cv2.medianBlur(image_bgr, 5), cv2.COLOR_BGR2HSV)
    smooth_sat = smooth[..., 1].astype(np.float32) / 255.0
    smooth_val = smooth[..., 2].astype(np.float32) / 255.0
    # strongly coloured, not just a hint of tint
    saturated = ((smooth_val < 0.95) & (smooth_val > 0.45) & (smooth_sat > 0.55)).astype(np.uint8)
    saturated = cv2.morphologyEx(saturated, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    fraction = float(saturated.sum()) / max(float((smooth_val < 0.93).sum()), 1.0)
    count_c, _, stats_c, _ = cv2.connectedComponentsWithStats(saturated, connectivity=8)
    blobs = int((stats_c[1:, cv2.CC_STAT_AREA] >= 25).sum())   # coherent coloured shapes
    neutral = ((sat < 0.30) & (val < ink_cut)).astype(np.uint8) * 255
    symbol = (drawn | (sat > 0.15)).astype(np.uint8) * 255

    # yellow / orange fills: columns (rectangles) and AP dots (small discs)
    warm = ((hue >= 18) & (hue <= 62) & (sat > 0.5) & (val > 0.7)).astype(np.uint8) * 255
    warm = cv2.morphologyEx(warm, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, _, stats, centroids = cv2.connectedComponentsWithStats(warm, connectivity=8)
    columns: list[dict] = []
    markers: list[dict] = []
    for i in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area < 150:
            continue
        fill = area / float(w * h)
        entry = {"x": float(centroids[i][0]), "y": float(centroids[i][1]),
                 "width": float(w), "height": float(h), "area": area}
        round_dot = 0.68 <= fill <= 0.86 and 0.8 <= w / h <= 1.25 and 14 <= w <= 40
        if round_dot:
            # a small round yellow dot is an AP marker (it sits inside a dark ring)
            markers.append(entry)
            continue
        if fill >= 0.8 and max(w, h) <= 120 and min(w, h) >= 10:
            columns.append(entry)
    return ColourLayers(coloured=blobs >= 12, neutral=neutral, symbol=symbol,
                        columns=columns, markers=markers, saturated_fraction=fraction)


def remove_markers(mask: np.ndarray, markers: list[dict], radius_factor: float = 2.8) -> np.ndarray:
    """Erases the dark ring around each AP marker. A wall that passes under a
    marker is not rebuilt here: the gap is bridged later because the line is
    still drawn on either side of the marker."""
    out = mask.copy()
    for m in markers:
        r = int(max(m["width"], m["height"]) / 2 * radius_factor)
        cv2.circle(out, (int(m["x"]), int(m["y"])), r, 0, -1)
    return out
