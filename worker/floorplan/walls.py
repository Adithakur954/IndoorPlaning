"""Wall mask, centre-line extraction, merging and junction snapping.

Walls are found as thick dark strokes. Furniture outlines, dimension lines and
text are thinner, so a morphological opening sized from the wall thickness
removes them without touching walls. Orthogonal walls (the common case) are
read with long line kernels; slanted walls are read from what is left.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from skimage.morphology import skeletonize


@dataclass
class Wall:
    a: tuple[float, float]
    b: tuple[float, float]
    thickness: float
    confidence: float = 1.0
    orientation: str = "h"            # "h", "v" or "d" (slanted)
    # (start, end) of each gap, as absolute pixel coordinates along the wall
    # (x for a horizontal wall, y for a vertical one)
    gaps: list[tuple[float, float]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def length(self) -> float:
        return math.hypot(self.b[0] - self.a[0], self.b[1] - self.a[1])


# --------------------------------------------------------------------------
def estimate_thickness(ink: np.ndarray, long_px: float, default: float = 6.0) -> tuple[float, list[float]]:
    """Stroke width (px) of the walls, among strokes thicker than a drawn line.

    Stroke width = 2 x distance-to-background along the skeleton. Each width
    peak is scored by how much of it forms LONG connected strokes: walls do,
    furniture outlines and symbols do not (a stroke counts as long from `long_px`
    pixels, about 2.5 m). Of the peaks that score well, the thinnest is returned
    (partitions), the others are listed as candidates.
    """
    binary = ink > 0
    if binary.sum() < 50:
        return default, []
    dt = cv2.distanceTransform(binary.astype(np.uint8), cv2.DIST_L2, 3)
    skeleton = skeletonize(binary)
    widths = np.where(skeleton, 2.0 * dt, 0.0)
    flat = widths[skeleton]
    flat = flat[flat >= 3.5]
    if flat.size < 30:
        return default, []
    top = int(min(120, math.ceil(flat.max())))
    hist, edges = np.histogram(flat, bins=np.arange(3, top + 2, 1.0))
    smooth = np.convolve(hist, np.ones(3) / 3, mode="same")
    peaks = [i for i in range(1, len(smooth) - 1)
             if smooth[i] >= smooth[i - 1] and smooth[i] >= smooth[i + 1] and smooth[i] >= 0.05 * smooth.max()]
    if not peaks:
        peaks = [int(smooth.argmax())]
    scores: dict[int, float] = {}
    for i in peaks:
        centre = edges[i] + 0.5
        sel = (skeleton & (widths >= centre * 0.8) & (widths <= centre * 1.2)).astype(np.uint8)
        count, _, stats, _ = cv2.connectedComponentsWithStats(sel, connectivity=8)
        long_px = sum(int(stats[k, cv2.CC_STAT_AREA]) for k in range(1, count)
                      if max(stats[k, cv2.CC_STAT_WIDTH], stats[k, cv2.CC_STAT_HEIGHT]) >= max(long_px, 10 * centre))
        scores[i] = float(long_px)
    best_score = max(scores.values())
    if best_score <= 0:
        return default, []
    strong = [i for i in peaks if scores[i] >= 0.35 * best_score]
    best = min(strong)
    centre = float(edges[best] + 0.5)
    others = sorted({round(float(edges[i] + 0.5), 1) for i in strong if i != best})
    return centre, others


def double_line_mask(ink: np.ndarray, min_len: int) -> tuple[np.ndarray, float | None]:
    """Walls drawn as two thin parallel lines.

    Long thin lines are collected per axis; two lines that face each other at a
    typical spacing (the spacings found most often, weighted by how far the
    lines overlap) are one wall, and the strip between them is filled. Lone
    lines (furniture, dimension lines) have no partner and are dropped.
    Returns (mask, wall thickness in px)."""
    lines_by_axis: dict[bool, list[tuple[float, float, float]]] = {}
    candidates: list[tuple[bool, float, float, float, float, float]] = []
    for horizontal in (True, False):
        k = (min_len, 1) if horizontal else (1, min_len)
        opened = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, k))
        count, _, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
        lines = []
        for i in range(1, count):
            x, y, w, h, _ = stats[i]
            if horizontal and h <= 6 and w >= min_len:
                lines.append((y + h / 2, float(x), float(x + w)))
            if not horizontal and w <= 6 and h >= min_len:
                lines.append((x + w / 2, float(y), float(y + h)))
        lines.sort()
        lines_by_axis[horizontal] = lines
        for i, (pos, lo, hi) in enumerate(lines):
            for pos2, lo2, hi2 in lines[i + 1:]:
                d = pos2 - pos
                if d > 60:
                    break
                overlap = min(hi, hi2) - max(lo, lo2)
                if d >= 4 and overlap >= 0.5 * min(hi - lo, hi2 - lo2):
                    candidates.append((horizontal, pos, pos2, max(lo, lo2), min(hi, hi2), d))
    if not candidates:
        return np.zeros_like(ink), None
    ds = np.array([c[5] for c in candidates])
    ws = np.array([c[4] - c[3] for c in candidates])
    hist, edges = np.histogram(ds, bins=np.arange(3, 62, 1.0), weights=ws)
    smooth = np.convolve(hist, np.ones(3) / 3, mode="same")
    peaks = [i for i in range(1, len(smooth) - 1)
             if smooth[i] >= smooth[i - 1] and smooth[i] >= smooth[i + 1] and smooth[i] >= 0.25 * smooth.max()]
    if not peaks:
        peaks = [int(smooth.argmax())]
    spacings = [float(edges[i] + 0.5) for i in peaks]
    mask = np.zeros_like(ink)
    used = 0
    for horizontal, pos, pos2, lo, hi, d in candidates:
        if not any(abs(d - sp) <= 2.2 for sp in spacings):
            continue
        used += 1
        if horizontal:
            cv2.rectangle(mask, (int(lo), int(round(pos - 1))), (int(hi), int(round(pos2 + 1))), 255, -1)
        else:
            cv2.rectangle(mask, (int(round(pos - 1)), int(lo)), (int(round(pos2 + 1)), int(hi)), 255, -1)
    if not used:
        return np.zeros_like(ink), None
    return mask, min(spacings) + 2.0   # + the line widths


def wall_mask(ink: np.ndarray, thickness: float) -> np.ndarray:
    """Strokes at least ~0.7 x the wall thickness; thinner ink is dropped."""
    r = max(1, int(round(0.35 * thickness)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    core = cv2.morphologyEx(ink, cv2.MORPH_OPEN, k)
    # give the stroke its original edges back (geodesic: only ink next to the core)
    return cv2.bitwise_and(cv2.dilate(core, k), ink)


def close_double_lines(ink: np.ndarray, thickness: float) -> np.ndarray:
    """Walls drawn as two thin parallel lines: close the gap between them."""
    r = max(2, int(round(0.6 * thickness)))
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * r + 1, 2 * r + 1))
    return cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k)


# --------------------------------------------------------------------------
def _segments_one_direction(mask: np.ndarray, length_px: int, horizontal: bool) -> list[Wall]:
    k = (length_px, 1) if horizontal else (1, length_px)
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, k))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    walls: list[Wall] = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if horizontal:
            if w < length_px:
                continue
            thick = area / w
            yc = _mean_coordinate(labels, i, x, y, w, h, axis=0)
            walls.append(Wall((float(x), yc), (float(x + w), yc), thick, orientation="h"))
        else:
            if h < length_px:
                continue
            thick = area / h
            xc = _mean_coordinate(labels, i, x, y, w, h, axis=1)
            walls.append(Wall((xc, float(y)), (xc, float(y + h)), thick, orientation="v"))
    return walls


def _mean_coordinate(labels, i, x, y, w, h, axis: int) -> float:
    ys, xs = np.nonzero(labels[y:y + h, x:x + w] == i)
    return float(ys.mean() + y + 0.5) if axis == 0 else float(xs.mean() + x + 0.5)


def _diagonal_segments(mask: np.ndarray, orth: np.ndarray, thickness: float, min_len: int) -> list[Wall]:
    """Long, thick, slanted strokes that the orthogonal pass did not explain."""
    grow = cv2.dilate(orth, cv2.getStructuringElement(cv2.MORPH_RECT, (int(thickness) * 2 + 1,) * 2))
    left = cv2.bitwise_and(mask, cv2.bitwise_not(grow))
    left = cv2.morphologyEx(left, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(left, connectivity=8)
    walls: list[Wall] = []
    for i in range(1, count):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_len * thickness * 0.5:
            continue
        pts = np.column_stack(np.nonzero(labels == i))[:, ::-1].astype(np.float32)
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(pts)
        long_side, short_side = max(rw, rh), min(rw, rh)
        if long_side < min_len or short_side < 0.6 * thickness or long_side / max(short_side, 1) < 4:
            continue
        theta = math.radians(ang if rw >= rh else ang + 90)
        dx, dy = math.cos(theta) * long_side / 2, math.sin(theta) * long_side / 2
        walls.append(Wall((cx - dx, cy - dy), (cx + dx, cy + dy), short_side,
                          confidence=0.5, orientation="d",
                          notes=["slanted wall (lower confidence)"]))
    return walls


def extract_segments(mask: np.ndarray, thickness: float, min_length_px: int) -> list[Wall]:
    walls = _segments_one_direction(mask, min_length_px, True)
    walls += _segments_one_direction(mask, min_length_px, False)
    orth = np.zeros_like(mask)
    for w in walls:
        cv2.line(orth, (int(w.a[0]), int(w.a[1])), (int(w.b[0]), int(w.b[1])), 255,
                 max(1, int(round(w.thickness))))
    walls += _diagonal_segments(mask, orth, thickness, min_length_px)
    return walls


# --------------------------------------------------------------------------
def _line_evidence(evidence: np.ndarray, orient: str, level: float, lo: float, hi: float, half_band: float) -> float:
    """Share of the stretch lo..hi along a wall line that has any drawn stroke
    close to it (weak evidence that the wall continues)."""
    if hi - lo < 2:
        return 1.0
    h, w = evidence.shape
    if orient == "h":
        y0, y1 = max(0, int(level - half_band)), min(h, int(level + half_band) + 1)
        band = evidence[y0:y1, max(0, int(lo)):min(w, int(hi))]
        if band.size == 0:
            return 0.0
        return float((band > 0).any(axis=0).mean())
    x0, x1 = max(0, int(level - half_band)), min(w, int(level + half_band) + 1)
    band = evidence[max(0, int(lo)):min(h, int(hi)), x0:x1]
    if band.size == 0:
        return 0.0
    return float((band > 0).any(axis=1).mean())


def merge_collinear(walls: list[Wall], thickness: float, min_gap_px: float, max_gap_px: float,
                    evidence: np.ndarray | None = None, bridge_max_px: float = 0.0,
                    min_evidence: float = 0.6) -> list[Wall]:
    """Joins collinear segments. A gap between min and max becomes an opening
    candidate (recorded in `gaps`); a smaller gap is just a broken line. With
    `evidence` (any drawn stroke), a longer gap that is still drawn along its
    length (a hatched wall whose hatching is faint) is bridged as wall."""
    out: list[Wall] = []
    for orient in ("h", "v"):
        group = [w for w in walls if w.orientation == orient]
        axis = 1 if orient == "h" else 0     # coordinate shared by the group
        along = 0 if orient == "h" else 1
        group.sort(key=lambda w: w.a[axis])
        clusters: list[list[Wall]] = []
        for w in group:
            if clusters and abs(w.a[axis] - np.mean([c.a[axis] for c in clusters[-1]])) <= max(1.0 * thickness, 5.0):
                clusters[-1].append(w)
            else:
                clusters.append([w])
        for cluster in clusters:
            level = float(np.mean([c.a[axis] for c in cluster]))
            cluster.sort(key=lambda w: w.a[along])
            current = [cluster[0].a[along], cluster[0].b[along], cluster[0].thickness, cluster[0].length]
            gaps: list[tuple[float, float]] = []

            def flush():
                lo, hi, thick = current[0], current[1], current[2]
                a = (lo, level) if orient == "h" else (level, lo)
                b = (hi, level) if orient == "h" else (level, hi)
                wall = Wall(a, b, thick, orientation=orient)
                wall.gaps = list(gaps)
                out.append(wall)

            for w in cluster[1:]:
                gap = w.a[along] - current[1]
                drawn = (evidence is not None and gap > min_gap_px and
                         _line_evidence(evidence, orient, level, current[1], w.a[along],
                                        0.5 * thickness + 1) >= min_evidence)
                joinable = gap <= max_gap_px or (drawn and gap <= bridge_max_px)
                if joinable:
                    if gap > min_gap_px and not drawn:
                        gaps.append((current[1], w.a[along]))
                    wt = current[3] + w.length
                    current[2] = (current[2] * current[3] + w.thickness * w.length) / wt
                    current[3] = wt
                    current[1] = max(current[1], w.b[along])
                else:
                    flush()
                    gaps = []
                    current = [w.a[along], w.b[along], w.thickness, w.length]
            flush()
    out += [w for w in walls if w.orientation == "d"]
    return out


def snap_junctions(walls: list[Wall], tol: float) -> list[Wall]:
    """Moves each end of an orthogonal wall onto the wall it meets (T, L and
    cross joints) so rooms close exactly."""
    hs = [w for w in walls if w.orientation == "h"]
    vs = [w for w in walls if w.orientation == "v"]

    def snap_end(w: Wall, end: int, others: list[Wall], horizontal: bool) -> None:
        p = list(w.a if end == 0 else w.b)
        best, best_d = None, float("inf")
        for o in others:
            reach = tol + o.thickness / 2   # a wall end may stop at the far face
            if horizontal:        # w is horizontal, o vertical: o.x is the target x
                lo, hi = sorted((o.a[1], o.b[1]))
                if lo - reach <= w.a[1] <= hi + reach:
                    d = abs(p[0] - o.a[0])
                    if d <= reach and (best is None or d < best_d):
                        best, best_d = o.a[0], d
            else:
                lo, hi = sorted((o.a[0], o.b[0]))
                if lo - reach <= w.a[0] <= hi + reach:
                    d = abs(p[1] - o.a[1])
                    if d <= reach and (best is None or d < best_d):
                        best, best_d = o.a[1], d
        if best is None:
            return
        if horizontal:
            p[0] = best
        else:
            p[1] = best
        if end == 0:
            w.a = (p[0], p[1])
        else:
            w.b = (p[0], p[1])

    for w in hs:
        for end in (0, 1):
            snap_end(w, end, vs, True)
    for w in vs:
        for end in (0, 1):
            snap_end(w, end, hs, False)
    return walls


def drop_short_and_dupes(walls: list[Wall], min_len: float) -> list[Wall]:
    kept = [w for w in walls if w.length >= min_len]
    return kept


def extract_columns(mask: np.ndarray, thickness: float, max_side_px: float) -> tuple[list[dict], np.ndarray]:
    """Small, compact, isolated dark blocks are columns, not walls. Returns
    (columns, mask without them)."""
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    columns: list[dict] = []
    cleaned = mask.copy()
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        side_max, side_min = max(w, h), min(w, h)
        if side_max > max_side_px or side_min < 0.7 * thickness:
            continue
        if side_max / max(side_min, 1) > 2.5 or area / float(w * h) < 0.6:
            continue
        columns.append({"x": float(centroids[i][0]), "y": float(centroids[i][1]),
                        "width": float(w), "height": float(h)})
        cleaned[labels == i] = 0
    return columns, cleaned


def drop_small_components(ink: np.ndarray, max_side_px: float) -> np.ndarray:
    """Removes isolated specks and text-sized blobs (letters, digits, chair
    circles). Anything attached to a drawn wall belongs to a bigger component
    and stays."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    keep[1:] = np.maximum(stats[1:, cv2.CC_STAT_WIDTH], stats[1:, cv2.CC_STAT_HEIGHT]) >= max_side_px
    return np.where(keep[labels], ink, 0).astype(np.uint8)


def extend_free_ends(walls: list[Wall], thickness: float, max_extend: float,
                     evidence: np.ndarray | None = None, discs: list[tuple[float, float, float]] | None = None) -> int:
    """A wall that stops just short of another wall (a marker or a symbol was
    drawn over the join) is carried on to it when the stretch in between is
    covered by drawn strokes or lies under a marker. Returns how many ends moved."""
    discs = discs or []
    moved = 0
    tol = max(1.5 * thickness, 4.0)

    def joined(p, skip):
        for j, o in enumerate(walls):
            if j == skip:
                continue
            if o.orientation == "h":
                lo, hi = sorted((o.a[0], o.b[0]))
                if lo - tol <= p[0] <= hi + tol and abs(p[1] - o.a[1]) <= tol:
                    return True
            elif o.orientation == "v":
                lo, hi = sorted((o.a[1], o.b[1]))
                if lo - tol <= p[1] <= hi + tol and abs(p[0] - o.a[0]) <= tol:
                    return True
        return False

    def under_disc(x, y):
        return any((x - cx) ** 2 + (y - cy) ** 2 <= r * r for cx, cy, r in discs)

    for i, w in enumerate(walls):
        if w.orientation not in ("h", "v"):
            continue
        horizontal = w.orientation == "h"
        for end in (0, 1):
            p = w.a if end == 0 else w.b
            if joined(p, i):
                continue
            # outward direction along the wall axis
            q = w.b if end == 0 else w.a
            sign = (1 if p[0] > q[0] else -1) if horizontal else (1 if p[1] > q[1] else -1)
            best = None
            for j, o in enumerate(walls):
                if j == i or o.orientation == w.orientation or o.orientation not in ("h", "v"):
                    continue
                if horizontal:       # o is vertical: its x is the target, its y-span must hold w's y
                    lo, hi = sorted((o.a[1], o.b[1]))
                    if not (lo - tol <= p[1] <= hi + tol):
                        continue
                    d = (o.a[0] - p[0]) * sign
                else:
                    lo, hi = sorted((o.a[0], o.b[0]))
                    if not (lo - tol <= p[0] <= hi + tol):
                        continue
                    d = (o.a[1] - p[1]) * sign
                if 0 < d <= max_extend and (best is None or d < best[0]):
                    best = (d, j)
            if best is None:
                continue
            d, j = best
            steps = max(4, int(d / 3))
            covered = under = 0
            for k in range(1, steps + 1):
                t = d * k / steps
                x = p[0] + (sign * t if horizontal else 0)
                y = p[1] + (0 if horizontal else sign * t)
                if under_disc(x, y):
                    under += 1
                if evidence is not None and 0 <= int(y) < evidence.shape[0] and 0 <= int(x) < evidence.shape[1]                         and evidence[int(y), int(x)]:
                    covered += 1
            if (covered + under) / steps >= 0.6:
                target = walls[j].a[0] if horizontal else walls[j].a[1]
                if horizontal:
                    new = (target, p[1])
                else:
                    new = (p[0], target)
                if end == 0:
                    w.a = new
                else:
                    w.b = new
                moved += 1
    return moved
