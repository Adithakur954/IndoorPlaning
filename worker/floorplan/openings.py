"""Doors, windows and plain openings, read from the gaps in wall lines."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .walls import Wall


@dataclass
class Opening:
    wall_index: int
    kind: str                 # "door" | "window" | "opening" (unclassified)
    start: tuple[float, float]  # px, ends of the gap on the wall centre-line
    end: tuple[float, float]
    width: float              # px
    confidence: float
    swing: str | None = None  # side the door leaf swings to, when seen
    hinge: str | None = None  # "start" | "end", when seen


def _has_ink(ink: np.ndarray, x: float, y: float, reach: int = 2) -> bool:
    h, w = ink.shape
    xi, yi = int(round(x)), int(round(y))
    if xi < 0 or yi < 0 or xi >= w or yi >= h:
        return False
    return bool(ink[max(0, yi - reach):yi + reach + 1, max(0, xi - reach):xi + reach + 1].any())


def _arc_score(ink: np.ndarray, hinge: tuple[float, float], radius: float,
               start_angle: float, sweep: float) -> float:
    n = max(24, int(radius))
    hits = 0
    for i in range(n + 1):
        a = start_angle + sweep * i / n
        if _has_ink(ink, hinge[0] + radius * math.cos(a), hinge[1] + radius * math.sin(a)):
            hits += 1
    return hits / (n + 1)


def _door_swing(ink: np.ndarray, wall: Wall, g0: float, g1: float) -> tuple[float, str | None, str | None]:
    """Best quarter-circle arc around either end of the gap, on either side.

    A door leaf is hinged at one end of the gap; its closed position lies along
    the wall and its open position across it, so the swing is a quarter circle
    centred on the hinge with the gap width as radius."""
    radius = g1 - g0
    horizontal = wall.orientation == "h"
    level = wall.a[1] if horizontal else wall.a[0]
    pi2 = math.pi / 2
    best: tuple[float, str | None, str | None] = (0.0, None, None)
    for hinge_name in ("start", "end"):
        for side_name, side in (("positive", 1), ("negative", -1)):
            if horizontal:
                hinge = (g0 if hinge_name == "start" else g1, level)
                a0 = 0.0 if hinge_name == "start" else math.pi
                a1 = side * pi2 if hinge_name == "start" else math.pi - side * pi2
            else:
                hinge = (level, g0 if hinge_name == "start" else g1)
                a0 = pi2 if hinge_name == "start" else -pi2
                a1 = pi2 - side * pi2 if hinge_name == "start" else -pi2 + side * pi2
            score = _arc_score(ink, hinge, radius, a0, a1 - a0)
            if score > best[0]:
                best = (score, hinge_name, side_name)
    return best


def _window_lines(ink: np.ndarray, wall: Wall, g0: float, g1: float) -> int:
    """Thin glazing lines running along the gap, inside the wall band."""
    horizontal = wall.orientation == "h"
    level = wall.a[1] if horizontal else wall.a[0]
    rows = []
    half = max(2, int(round(wall.thickness * 0.6)))
    for off in range(-half, half + 1):
        hits = 0
        n = max(8, int(g1 - g0))
        for i in range(n):
            t = g0 + (g1 - g0) * (i + 0.5) / n
            hits += _has_ink(ink, t if horizontal else level + off, level + off if horizontal else t, reach=1)
        rows.append(hits / n)
    # count separate line groups (rows above 0.8 coverage, split by gaps)
    groups, inside = 0, False
    for r in rows:
        if r >= 0.8 and not inside:
            groups += 1
            inside = True
        elif r < 0.8:
            inside = False
    return groups


def classify_gaps(walls: list[Wall], ink_fine: np.ndarray, thickness: float,
                  min_open_px: float, max_open_px: float) -> list[Opening]:
    openings: list[Opening] = []
    for wi, wall in enumerate(walls):
        if wall.orientation not in ("h", "v"):
            continue
        for g0, g1 in wall.gaps:
            width = g1 - g0
            if width < min_open_px or width > max_open_px:
                continue
            level = wall.a[1] if wall.orientation == "h" else wall.a[0]
            start = (g0, level) if wall.orientation == "h" else (level, g0)
            end = (g1, level) if wall.orientation == "h" else (level, g1)
            swing_score, hinge, side = _door_swing(ink_fine, wall, g0, g1)
            lines = _window_lines(ink_fine, wall, g0, g1)
            if swing_score >= 0.55:
                kind, conf = "door", min(1.0, 0.55 + swing_score * 0.45)
            elif lines >= 1:
                # a line running across the whole gap inside the wall band is
                # glazing; a plain gap has none
                kind, conf = "window", 0.8 if lines >= 2 else 0.7
            else:
                kind, conf = "opening", 0.5
            openings.append(Opening(wi, kind, start, end, width, conf,
                                    swing=side if kind == "door" else None,
                                    hinge=hinge if kind == "door" else None))
    return openings


def classify_gaps_labels(walls: list[Wall], labels: np.ndarray, ink_fine: np.ndarray, thickness: float,
                         min_open_px: float, max_open_px: float, door: int = 2, window: int = 3) -> list[Opening]:
    """Like classify_gaps, but the type comes from the network's door / window pixels inside the gap. The swing
    side and hinge of a door are still read from the drawing (the arc). When the network labelled neither, the
    drawing evidence decides, exactly as in classify_gaps."""
    h, w = labels.shape
    half = max(1, int(round(thickness * 0.8)))
    offs = np.arange(-half, half + 1)
    openings: list[Opening] = []
    for wi, wall in enumerate(walls):
        if wall.orientation not in ("h", "v"):
            continue
        horizontal = wall.orientation == "h"
        level = wall.a[1] if horizontal else wall.a[0]
        for g0, g1 in wall.gaps:
            width = g1 - g0
            if width < min_open_px or width > max_open_px:
                continue
            start = (g0, level) if horizontal else (level, g0)
            end = (g1, level) if horizontal else (level, g1)
            ts = np.linspace(g0, g1, max(8, int(width)))
            along, across = ts[:, None] + 0 * offs[None, :], level + offs[None, :] + 0 * ts[:, None]
            xs, ys = (along, across) if horizontal else (across, along)
            vals = labels[np.clip(np.rint(ys).astype(int), 0, h - 1), np.clip(np.rint(xs).astype(int), 0, w - 1)]
            door_frac, window_frac = float((vals == door).mean()), float((vals == window).mean())
            swing = hinge = None
            if door_frac >= 0.2 and door_frac >= window_frac:
                kind, conf = "door", min(1.0, 0.6 + 0.6 * door_frac)
                score, hinge, swing = _door_swing(ink_fine, wall, g0, g1)
                if score < 0.4:
                    hinge = swing = None
            elif window_frac >= 0.2:
                kind, conf = "window", min(1.0, 0.6 + 0.6 * window_frac)
            else:
                score, hinge, swing = _door_swing(ink_fine, wall, g0, g1)
                lines = _window_lines(ink_fine, wall, g0, g1)
                if score >= 0.55:
                    kind, conf = "door", min(1.0, 0.55 + score * 0.45)
                elif lines >= 1:
                    kind, conf = "window", 0.8 if lines >= 2 else 0.7
                else:
                    kind, conf, hinge, swing = "opening", 0.5, None, None
            openings.append(Opening(wi, kind, start, end, width, conf,
                                    swing=swing if kind == "door" else None,
                                    hinge=hinge if kind == "door" else None))
    return openings
