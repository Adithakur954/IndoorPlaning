"""The outer walls of a building drawn as a thick (often hatched) band near the
edge of the drawing, and the drawing's own frame."""
from __future__ import annotations

import cv2
import numpy as np

from .walls import Wall


def _column_density(binary: np.ndarray, half: int) -> np.ndarray:
    """For every pixel, the share of dark pixels in a (2*half+1)-tall window
    centred on it, along the vertical axis."""
    k = 2 * half + 1
    return cv2.boxFilter((binary > 0).astype(np.float32), -1, (1, k), normalize=True,
                         borderType=cv2.BORDER_CONSTANT)


def find_frame(gray: np.ndarray) -> dict[str, float | None]:
    """Page border: a long thin line close to each image edge. Returns the
    position (px) of each side that has one."""
    h, w = gray.shape
    dark = (gray < 215).astype(np.uint8)
    frame: dict[str, float | None] = {"top": None, "bottom": None, "left": None, "right": None}
    rows = dark.mean(axis=1)
    cols = dark.mean(axis=0)
    band_y, band_x = int(0.08 * h), int(0.08 * w)
    for name, series, lo, hi in (("top", rows, 0, band_y), ("bottom", rows, h - band_y, h),
                                 ("left", cols, 0, band_x), ("right", cols, w - band_x, w)):
        seg = series[lo:hi]
        if seg.size and seg.max() >= 0.85:
            frame[name] = float(lo + int(seg.argmax()))
    return frame


def find_perimeter(evidence: np.ndarray, thickness: float, frame: dict[str, float | None],
                   search: float = 0.18, min_cover: float = 0.6) -> dict[str, dict]:
    """Strongest thick band along each side (inside the page frame).

    A band counts where a window as thick as a wall is at least 30% drawn:
    hatching and solid fills pass, a 1-px frame line does not. Returns, per
    side, {"pos": px, "cover": share of the side that is covered}."""
    h, w = evidence.shape
    half = max(2, int(round(thickness * 0.6)))
    found: dict[str, dict] = {}
    # horizontal sides: scan rows near the top / bottom
    col_density = _column_density(evidence, half)          # (h, w): vertical window
    x0, x1 = int(0.06 * w), int(0.94 * w)
    for side, rows in (("top", range(int(frame["top"] or 0) + half + 2, int(search * h))),
                       ("bottom", range(int(h - search * h), int((frame["bottom"] or h) - half - 2)))):
        best = None
        for y in rows:
            cover = float((col_density[y, x0:x1] >= 0.30).mean())
            if best is None or cover > best["cover"] + 1e-6:
                best = {"pos": float(y), "cover": cover}
        if best and best["cover"] >= min_cover:
            found[side] = best
    row_density = _column_density(evidence.T.copy(), half).T   # horizontal window
    y0, y1 = int(0.06 * h), int(0.94 * h)
    for side, cols in (("left", range(int(frame["left"] or 0) + half + 2, int(search * w))),
                       ("right", range(int(w - search * w), int((frame["right"] or w) - half - 2)))):
        best = None
        for x in cols:
            cover = float((row_density[y0:y1, x] >= 0.30).mean())
            if best is None or cover > best["cover"] + 1e-6:
                best = {"pos": float(x), "cover": cover}
        if best and best["cover"] >= min_cover:
            found[side] = best
    return found


def perimeter_walls(found: dict[str, dict], frame: dict[str, float | None], size: tuple[int, int],
                    thickness: float, content_top: float | None = None) -> tuple[list[Wall], list[str]]:
    """Walls for the sides that have a band; the others are closed by a
    virtual wall at the drawing edge (flagged, low confidence)."""
    w, h = size
    notes: list[str] = []
    left = found.get("left", {}).get("pos")
    right = found.get("right", {}).get("pos")
    top = found.get("top", {}).get("pos")
    bottom = found.get("bottom", {}).get("pos")
    virtual: list[str] = []
    if top is None:
        top = (frame["top"] if frame["top"] is not None else (content_top or 0.0)) + 1.0
        virtual.append("top")
    if bottom is None:
        bottom = (frame["bottom"] if frame["bottom"] is not None else h - 1.0) - 1.0
        virtual.append("bottom")
    if left is None:
        left = (frame["left"] if frame["left"] is not None else 0.0) + 1.0
        virtual.append("left")
    if right is None:
        right = (frame["right"] if frame["right"] is not None else w - 1.0) - 1.0
        virtual.append("right")
    walls: list[Wall] = []
    sides = {"top": ((left, top), (right, top), "h"), "bottom": ((left, bottom), (right, bottom), "h"),
             "left": ((left, top), (left, bottom), "v"), "right": ((right, top), (right, bottom), "v")}
    for name, (a, b, orient) in sides.items():
        is_virtual = name in virtual
        wall = Wall(a, b, thickness, confidence=0.3 if is_virtual else 0.8, orientation=orient)
        wall.notes.append("drawing edge: the plan is cut off here (virtual wall, check it)"
                          if is_virtual else "outer wall found as a thick band along the drawing edge")
        wall.virtual = is_virtual  # type: ignore[attr-defined]
        walls.append(wall)
    if virtual:
        notes.append("no outer wall was found on the " + ", ".join(virtual) +
                     " side(s): the drawing edge was used as a virtual wall")
    return walls, notes
