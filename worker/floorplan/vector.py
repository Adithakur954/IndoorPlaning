"""Walls of any angle from a wall mask, gap closing for any angle, and dropping false walls.

The older reading (walls.py) finds horizontal and vertical walls with long line kernels and treats every slanted
wall as an afterthought: an octagonal hall, a chamfered corner, a slanted office wing or a curved wall is lost, and
walls thinner than the main wall thickness are opened away. Here the learned model's wall pixels are thinned to a
one-pixel centre-line, traced branch by branch between junctions, and each branch is simplified to a polyline:
straight walls become one segment whatever their angle, curves become a chain of short segments, and a thin wall is
as good as a thick one. Segments within a few degrees of horizontal or vertical are made exactly so, so the rest of
the pipeline (merging, door gaps, junction snapping) works on them as before.

`connect_ends` closes the gaps the reading leaves, for any angle: a free wall end is carried along its own
direction onto the wall it points at, and two free ends that face each other across a door or a small break are
joined. `building_mask` / `drop_false_walls` remove walls the model's labels say are outside the building or lie
on furniture, stairs or a hatched void.
"""
from __future__ import annotations

import math

import cv2
import numpy as np
from skimage.morphology import skeletonize

from .walls import Wall

_NB = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.uint8)
_STEPS = [(0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)]   # 4-neighbours first


def _orient(a, b, snap_deg: float, snap_px: float = 0.0) -> str:
    """"h" / "v" when the segment is within `snap_deg` of the axis, or strays from it by at most `snap_px` pixels
    over its length (a short wall piece whose ends sit on slightly different pixel rows)."""
    dx, dy = abs(b[0] - a[0]), abs(b[1] - a[1])
    ang = math.degrees(math.atan2(dy, dx))
    if ang <= snap_deg or (dy <= snap_px and dx >= 2 * dy):
        return "h"
    if ang >= 90 - snap_deg or (dx <= snap_px and dy >= 2 * dx):
        return "v"
    return "d"


def _drop_jogs(verts: list, min_edge: float) -> list:
    """Removes polyline corners closer than `min_edge` to the previous kept one: the thinning leaves one- and
    two-pixel jogs at junctions and corners, which would otherwise become tiny slanted walls. Both ends stay."""
    if len(verts) <= 2:
        return verts
    out = [verts[0]]
    for v in verts[1:-1]:
        if math.hypot(v[0] - out[-1][0], v[1] - out[-1][1]) >= min_edge:
            out.append(v)
    last = verts[-1]
    if len(out) > 1 and math.hypot(last[0] - out[-1][0], last[1] - out[-1][1]) < min_edge:
        out[-1] = last
    else:
        out.append(last)
    return out


def make_wall(a, b, thickness: float, snap_deg: float = 4.0, snap_px: float = 0.0, **kw) -> Wall:
    """A wall from a to b; near horizontal / vertical (see _orient) it is made exactly so (around its middle)."""
    o = _orient(a, b, snap_deg, snap_px)
    if o == "h":
        y = (a[1] + b[1]) / 2
        a, b = (a[0], y), (b[0], y)
        if a[0] > b[0]:
            a, b = b, a
    elif o == "v":
        x = (a[0] + b[0]) / 2
        a, b = (x, a[1]), (x, b[1])
        if a[1] > b[1]:
            a, b = b, a
    return Wall((float(a[0]), float(a[1])), (float(b[0]), float(b[1])), float(thickness), orientation=o, **kw)


def _trace(branch: set, start) -> list:
    path, seen, cur = [start], {start}, start
    while True:
        nxt = None
        for dy, dx in _STEPS:
            q = (cur[0] + dy, cur[1] + dx)
            if q in branch and q not in seen:
                nxt = q
                break
        if nxt is None:
            return path
        path.append(nxt)
        seen.add(nxt)
        cur = nxt


def skeleton_segments(mask: np.ndarray, thickness: float, min_len: float, *, eps: float | None = None,
                      snap_deg: float = 4.0) -> list[Wall]:
    """Wall segments of any angle from a wall mask (uint8 0/255 or bool): centre-line branches between junctions,
    each simplified to a polyline (Douglas-Peucker, tolerance `eps`, default about a third of the wall thickness).

    Dropped: spurs (a branch with one free end shorter than about two wall thicknesses: the thinning leaves them
    at every thick corner) and loose pieces (no junction at either end) shorter than `min_len`."""
    binary = mask > 0
    if binary.sum() < 10:
        return []
    dt = cv2.distanceTransform(binary.astype(np.uint8), cv2.DIST_L2, 3)
    sk = skeletonize(binary)
    nb = cv2.filter2D(sk.astype(np.uint8), -1, _NB, borderType=cv2.BORDER_CONSTANT)
    junction = sk & (nb >= 3)
    # junction pixels a wall thickness apart are one junction (a thick T or cross leaves several)
    jk = max(3, int(round(thickness)) | 1)
    cluster = sk & (cv2.dilate(junction.astype(np.uint8), np.ones((jk, jk), np.uint8)) > 0)
    n_cl, cl_lab, _, cl_cent = cv2.connectedComponentsWithStats(cluster.astype(np.uint8), connectivity=8)
    branches = (sk & ~cluster).astype(np.uint8)
    n_br, br_lab = cv2.connectedComponents(branches, connectivity=8)
    h, w = mask.shape
    eps = eps if eps is not None else max(1.2, 0.35 * thickness)
    spur = max(2.2 * thickness, 6.0)
    ys, xs = np.nonzero(branches)
    groups: dict[int, list] = {}
    for y, x in zip(ys.tolist(), xs.tolist()):
        groups.setdefault(int(br_lab[y, x]), []).append((y, x))
    walls: list[Wall] = []
    for pix in groups.values():
        branch = set(pix)
        ends = [p for p in pix if sum((p[0] + dy, p[1] + dx) in branch for dy, dx in _STEPS) <= 1]
        closed = not ends
        path = _trace(branch, ends[0] if ends else pix[0])

        def junction_at(p):
            y0, y1, x0, x1 = max(0, p[0] - 1), min(h, p[0] + 2), max(0, p[1] - 1), min(w, p[1] + 2)
            ids = cl_lab[y0:y1, x0:x1]
            ids = ids[ids > 0]
            return int(ids[0]) if ids.size else 0

        pts = [(float(x), float(y)) for y, x in path]
        joined = 0
        if not closed:
            ja, jb = junction_at(path[0]), junction_at(path[-1])
            if ja:
                pts.insert(0, (float(cl_cent[ja][0]), float(cl_cent[ja][1])))
                joined += 1
            if jb and (jb != ja or len(path) > 2):
                pts.append((float(cl_cent[jb][0]), float(cl_cent[jb][1])))
                joined += 1
        length = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
        if not closed and ((joined == 1 and length < spur) or (joined == 0 and length < min_len)):
            continue
        if closed and length < max(min_len, 4 * thickness):
            continue
        thick = 2.0 * float(np.median([dt[y, x] for y, x in path])) if path else thickness
        thick = max(1.0, thick)
        poly = cv2.approxPolyDP(np.array(pts, np.float32).reshape(-1, 1, 2), eps, closed)[:, 0, :]
        verts = [tuple(map(float, v)) for v in poly]
        if closed and len(verts) >= 3:
            verts.append(verts[0])
        verts = _drop_jogs(verts, max(3.0, 1.2 * thick))
        snap_px = max(1.5, 0.5 * thick)
        for a, b in zip(verts[:-1], verts[1:]):
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 1.0:
                continue
            wl = make_wall(a, b, thick, snap_deg, snap_px=snap_px)
            if wl.orientation == "d":
                wl.confidence = 0.8
                wl.notes.append("slanted or curved wall")
            walls.append(wl)
    return walls


# --------------------------------------------------------------------------
def _seg_arrays(walls: list[Wall]):
    A = np.array([w.a for w in walls], float).reshape(-1, 2)
    B = np.array([w.b for w in walls], float).reshape(-1, 2)
    return A, B


def _dist_to_segments(p, A, B) -> np.ndarray:
    d = B - A
    ll = np.maximum((d * d).sum(1), 1e-9)
    t = np.clip(((p[0] - A[:, 0]) * d[:, 0] + (p[1] - A[:, 1]) * d[:, 1]) / ll, 0, 1)
    return np.hypot(A[:, 0] + t * d[:, 0] - p[0], A[:, 1] + t * d[:, 1] - p[1])


def _cover(evidence: np.ndarray | None, p, q) -> float:
    if evidence is None:
        return 0.0
    h, w = evidence.shape
    n = max(4, int(math.hypot(q[0] - p[0], q[1] - p[1]) / 2))
    hit = 0
    for k in range(1, n + 1):
        x = int(round(p[0] + (q[0] - p[0]) * k / n))
        y = int(round(p[1] + (q[1] - p[1]) * k / n))
        hit += 0 <= y < h and 0 <= x < w and bool(evidence[y, x])
    return hit / n


def connect_ends(walls: list[Wall], *, tol: float, max_extend: float, free_px: float, max_bridge: float,
                 evidence: np.ndarray | None = None, snap_deg: float = 4.0) -> tuple[int, list[Wall]]:
    """Closes the gaps a reading leaves, at any angle. Returns (ends moved, walls added).

    1. A free end (no other wall within `tol`) is carried along its own direction onto the first wall it meets,
       up to `max_extend`: always when the stretch is at most `free_px`, else when `evidence` (wall, door and window
       pixels) covers 60 % of it. An end that overshoots a wall by up to `tol` is pulled back onto it.
    2. Two free ends at most `max_bridge` apart that face each other (the joining line within 25 degrees of one of
       the two walls) are joined by a new wall: a door or a break in the drawn wall. When that wall is horizontal
       or vertical its whole length is recorded as a gap, so the door / window reading classifies it."""
    moved = 0
    if not walls:
        return 0, []

    def free_ends():
        A, B = _seg_arrays(walls)
        out = []
        for i, w in enumerate(walls):
            for end in (0, 1):
                p = w.a if end == 0 else w.b
                d = _dist_to_segments(p, A, B)
                d[i] = np.inf
                if d.min() > tol:
                    out.append((i, end))
        return out

    for i, end in free_ends():
        w = walls[i]
        p = np.array(w.a if end == 0 else w.b, float)
        q = np.array(w.b if end == 0 else w.a, float)
        ln = float(np.hypot(*(p - q)))
        if ln < 1e-6:
            continue
        u = (p - q) / ln
        A, B = _seg_arrays(walls)
        best = None
        for j in range(len(walls)):
            if j == i:
                continue
            d = B[j] - A[j]
            dl = float(np.hypot(*d))
            den = u[0] * d[1] - u[1] * d[0]
            if dl < 1e-6 or abs(den) < 1e-6 * dl:
                continue
            ap = A[j] - p
            t = (ap[0] * d[1] - ap[1] * d[0]) / den
            s = (ap[0] * u[1] - ap[1] * u[0]) / den
            e = tol / dl
            if not (-e <= s <= 1 + e) or t < -tol or t > max_extend or -t >= 0.5 * ln:
                continue
            if best is None or abs(t) < abs(best[0]):
                best = (t, p + t * u)
        if best is None:
            continue
        t, hit = best
        if abs(t) < 0.5:
            continue
        if t > free_px and _cover(evidence, p, hit) < 0.6:
            continue
        new = (float(hit[0]), float(hit[1]))
        if w.orientation == "h":
            new = (new[0], w.a[1])
        elif w.orientation == "v":
            new = (w.a[0], new[1])
        if end == 0:
            w.a = new
        else:
            w.b = new
        moved += 1

    # 2. facing free ends
    added: list[Wall] = []
    ends = free_ends()
    cands = []
    for x, (i, ei) in enumerate(ends):
        for j, ej in ends[x + 1:]:
            if i == j:
                continue
            p = np.array(walls[i].a if ei == 0 else walls[i].b, float)
            q = np.array(walls[j].a if ej == 0 else walls[j].b, float)
            gap = float(np.hypot(*(q - p)))
            if gap > max_bridge or gap < 1.0:
                continue
            ok = False
            for k, ek, src in ((i, ei, p), (j, ej, q)):
                wk = walls[k]
                other = np.array(wk.b if ek == 0 else wk.a, float)
                out = src - other
                dst = q if src is p else p
                v = dst - src
                cosang = float(out @ v) / max(float(np.hypot(*out)) * float(np.hypot(*v)), 1e-9)
                if cosang >= math.cos(math.radians(25)):
                    ok = True
            if not ok:
                continue
            if gap > free_px and _cover(evidence, p, q) < 0.5:
                continue
            cands.append((gap, i, ei, j, ej, p, q))
    used: set = set()
    for gap, i, ei, j, ej, p, q in sorted(cands, key=lambda c: c[0]):
        if (i, ei) in used or (j, ej) in used:
            continue
        used.add((i, ei))
        used.add((j, ej))
        thick = (walls[i].thickness + walls[j].thickness) / 2
        o = _orient(p, q, snap_deg)
        a, b = (float(p[0]), float(p[1])), (float(q[0]), float(q[1]))
        note = ["closes a gap between two wall ends (door or break)"]
        # the new wall runs exactly from end to end (so the rooms close); when it is (nearly) horizontal or
        # vertical its length is a gap, so the door / window reading classifies it like any other gap
        if o == "h" and abs(a[1] - b[1]) <= 1.5:
            a, b = sorted((a, b))
            wl = Wall(a, b, thick, orientation="h", gaps=[(a[0], b[0])], notes=note)
        elif o == "v" and abs(a[0] - b[0]) <= 1.5:
            a, b = sorted((a, b), key=lambda c: c[1])
            wl = Wall(a, b, thick, orientation="v", gaps=[(a[1], b[1])], notes=note)
        else:
            wl = Wall(a, b, thick, orientation="d", confidence=0.6, notes=note)
        added.append(wl)
    walls.extend(added)
    return moved, added


def weld(walls: list[Wall], tol: float) -> int:
    """Makes wall ends that stop near another wall actually meet it, so the room faces close: the rooms are the
    closed faces of the wall centre-lines and a 0.5 px miss leaves a room open. An end within `tol` of another
    wall's end takes that end's exact position; otherwise it is carried along its own line just across the wall
    it nearly touches (a horizontal / vertical wall stays exactly so). Returns how many ends moved."""
    moved = 0
    if len(walls) < 2:
        return 0
    for i, w in enumerate(walls):
        for end in (0, 1):
            A, B = _seg_arrays(walls)
            p = np.array(w.a if end == 0 else w.b, float)
            d = _dist_to_segments(p, A, B)
            d[i] = np.inf
            if d.min() <= 1e-6 or d.min() > tol:
                continue
            # another wall's end close by: share it exactly
            ends = np.vstack([A, B])
            de = np.hypot(ends[:, 0] - p[0], ends[:, 1] - p[1])
            de[i] = de[i + len(walls)] = np.inf
            k = int(de.argmin())
            q = np.array(w.b if end == 0 else w.a, float)
            if de[k] <= tol:
                target = ends[k]
                if w.orientation in ("h", "v") and abs(target[1 if w.orientation == "h" else 0] - p[1 if w.orientation == "h" else 0]) > 1.5:
                    target = None
                if target is not None and float(np.hypot(*(target - q))) < 1.0:
                    target = None
                if target is not None:
                    new = (float(target[0]), float(target[1]))
                    if end == 0:
                        w.a = new
                    else:
                        w.b = new
                    moved += 1
                    continue
            j = int(d.argmin())
            ln = float(np.hypot(*(p - q)))
            if ln < 1e-6:
                continue
            u = (p - q) / ln
            dj = B[j] - A[j]
            den = u[0] * dj[1] - u[1] * dj[0]
            if abs(den) < 1e-3 * max(float(np.hypot(*dj)), 1e-6):
                continue           # parallel: nothing to cross
            ap = A[j] - p
            t = (ap[0] * dj[1] - ap[1] * dj[0]) / den
            if abs(t) > 1.5 * tol:
                continue
            hit = p + (t + 0.5) * u     # half a pixel across, so the two lines cross
            new = (float(hit[0]), float(hit[1]))
            if w.orientation == "h":
                new = (new[0], w.a[1])
            elif w.orientation == "v":
                new = (w.a[0], new[1])
            if end == 0:
                w.a = new
            else:
                w.b = new
            moved += 1
    return moved


def drop_short_dangling(walls: list[Wall], min_len: float, tol: float) -> list[Wall]:
    """Short walls are kept only when both ends join another wall (a piece of a curve, a short stub between two
    walls); a short wall with a free end is a fragment."""
    if not walls:
        return walls
    A, B = _seg_arrays(walls)
    keep = []
    for i, w in enumerate(walls):
        if w.length >= min_len:
            keep.append(w)
            continue
        ok = True
        for p in (w.a, w.b):
            d = _dist_to_segments(p, A, B)
            d[i] = np.inf
            if d.min() > tol:
                ok = False
                break
        if ok and w.length >= 1.0:
            keep.append(w)
    return keep


# --------------------------------------------------------------------------
def building_mask(labels: np.ndarray, thickness: float, classes: dict) -> np.ndarray | None:
    """The building's footprint from the model's labels: everything labelled as inside a building (floor, doors,
    windows, columns, furniture, stairs, voids), closed over small breaks, with holes filled and small separate
    pieces left out. None when too little of the picture is labelled (no reliable footprint)."""
    inside = np.isin(labels, classes["inside"]).astype(np.uint8)
    h, w = labels.shape
    if inside.sum() < 0.04 * h * w:
        return None
    k = max(5, int(round(2.5 * thickness)) | 1)
    inside = cv2.morphologyEx(inside, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    # walls that close the footprint count while filling holes (a room labelled only by its walls is inside)
    solid = (inside | np.isin(labels, classes["wall"])).astype(np.uint8)
    flood = solid.copy()
    pad = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, pad, (0, 0), 2) if solid[0, 0] == 0 else None
    filled = np.where(flood == 2, 0, 1).astype(np.uint8) if solid[0, 0] == 0 else solid
    filled = filled & cv2.dilate(inside, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    filled = cv2.morphologyEx(filled, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(filled, connectivity=8)
    if n <= 1:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros(n, bool)
    keep[1:] = areas >= 0.1 * areas.max()
    out = keep[lab]
    if out.sum() < 0.04 * h * w:
        return None
    return out


def _samples(w: Wall, step: float = 2.0):
    n = max(2, int(w.length / step))
    for k in range(n + 1):
        t = k / n
        yield w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t


def drop_false_walls(walls: list[Wall], labels: np.ndarray, building: np.ndarray | None, thickness: float,
                     classes: dict) -> tuple[list[Wall], int, int]:
    """Walls the model's labels contradict. Returns (walls kept, dropped outside the building, dropped on clutter).

    Outside: less than 40 % of the wall within a few wall thicknesses of the footprint. Clutter: under 25 % of the
    wall near a wall / door / window pixel while at least half of it lies on furniture, stairs or a hatched void
    (a desk row, a conveyor, stair treads or hatching read as a wall)."""
    h, w = labels.shape
    near_b = None
    if building is not None:
        r = int(round(3 * thickness)) + 3
        near_b = cv2.dilate(building.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1,) * 2)) > 0
    r = int(round(thickness)) + 3
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1,) * 2)
    wallish = cv2.dilate(np.isin(labels, classes["wall"] + classes["opening"]).astype(np.uint8), k) > 0
    clutter = cv2.dilate(np.isin(labels, classes["clutter"]).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    keep: list[Wall] = []
    outside = on_clutter = 0
    for wl in walls:
        if getattr(wl, "virtual", False):
            keep.append(wl)
            continue
        pts = [(int(round(x)), int(round(y))) for x, y in _samples(wl)]
        pts = [(x, y) for x, y in pts if 0 <= x < w and 0 <= y < h]
        if not pts:
            outside += 1
            continue
        xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
        if near_b is not None and near_b[ys, xs].mean() < 0.4:
            outside += 1
            continue
        if wallish[ys, xs].mean() < 0.25 and clutter[ys, xs].mean() >= 0.5:
            on_clutter += 1
            continue
        keep.append(wl)
    return keep, outside, on_clutter


def snap_to_main_angles(walls: list[Wall], tol_deg: float = 5.0, min_share: float = 0.08) -> int:
    """A slanted wing is drawn at one or two angles (its walls and the walls across them). The angles that carry at
    least `min_share` of the slanted wall length are found, and every slanted wall within `tol_deg` of one of them
    is turned onto it exactly (about its middle), so a wing's walls come out straight and parallel. Curves (many
    angles, none dominant) are left alone. Returns how many walls were turned."""
    d = [w for w in walls if w.orientation == "d" and w.length > 0]
    if not d:
        return 0
    ang = np.array([math.degrees(math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0])) % 180 for w in d])
    ln = np.array([w.length for w in d])
    hist = np.zeros(180)
    for a, l in zip(ang, ln):
        for k in range(-2, 3):       # smooth over +-2 degrees
            hist[int(round(a + k)) % 180] += l * (3 - abs(k)) / 3
    total = ln.sum()
    peaks = []
    for i in np.argsort(-hist):
        if hist[i] < min_share * total * 2:
            break
        if all(min(abs(i - p), 180 - abs(i - p)) > 2 * tol_deg for p in peaks):
            # refine: length-weighted mean angle of the walls near this peak
            near = [(a, l) for a, l in zip(ang, ln) if min(abs(a - i), 180 - abs(a - i)) <= tol_deg]
            ref = math.degrees(math.atan2(sum(l * math.sin(math.radians(2 * a)) for a, l in near),
                                          sum(l * math.cos(math.radians(2 * a)) for a, l in near))) / 2 % 180
            peaks.append(ref)
    turned = 0
    for w, a in zip(d, ang):
        for p in peaks:
            diff = (a - p + 90) % 180 - 90
            if abs(diff) <= tol_deg and abs(diff) > 1e-3:
                cx, cy = (w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2
                half = w.length / 2
                sign = 1 if math.cos(math.radians(a - p)) >= 0 else -1
                ux, uy = math.cos(math.radians(p)) * sign, math.sin(math.radians(p)) * sign
                w.a, w.b = (cx - ux * half, cy - uy * half), (cx + ux * half, cy + uy * half)
                turned += 1
                break
    return turned


def merge_parallel_duplicates(walls: list[Wall], max_gap: float, min_overlap: float = 0.6,
                              max_angle_deg: float = 5.0) -> int:
    """One wall drawn twice side by side: a CAD wall with an RF overlay line along it, or both faces of a thick wall
    traced separately. Two nearly parallel walls closer than `max_gap` that overlap along at least `min_overlap` of
    the shorter one become one: the longer (or the one with door/window gaps) stays and is lengthened to cover
    both. Edits `walls` in place and returns how many were merged away."""
    removed = 0
    changed = True
    while changed:
        changed = False
        order = sorted(range(len(walls)), key=lambda i: -walls[i].length)
        for ii, i in enumerate(order):
            a = walls[i]
            if a.length < 1e-6:
                continue
            ux, uz = (a.b[0] - a.a[0]) / a.length, (a.b[1] - a.a[1]) / a.length
            for j in order[ii + 1:]:
                b = walls[j]
                if b.length < 1e-6:
                    continue
                vx, vz = (b.b[0] - b.a[0]) / b.length, (b.b[1] - b.a[1]) / b.length
                if abs(ux * vz - uz * vx) > math.sin(math.radians(max_angle_deg)):
                    continue
                off = lambda p: abs(-uz * (p[0] - a.a[0]) + ux * (p[1] - a.a[1]))  # noqa: E731
                if max(off(b.a), off(b.b)) > max_gap:
                    continue
                t = lambda p: (p[0] - a.a[0]) * ux + (p[1] - a.a[1]) * uz  # noqa: E731
                lo_b, hi_b = sorted((t(b.a), t(b.b)))
                overlap = min(a.length, hi_b) - max(0.0, lo_b)
                if overlap < min_overlap * min(a.length, b.length):
                    continue
                keep, drop = (a, b) if (len(a.gaps) >= len(b.gaps)) else (b, a)
                # the kept wall covers both, along its own line (a horizontal / vertical wall stays so)
                ku, kz = (keep.b[0] - keep.a[0]) / keep.length, (keep.b[1] - keep.a[1]) / keep.length
                tk = lambda p: (p[0] - keep.a[0]) * ku + (p[1] - keep.a[1]) * kz  # noqa: E731
                lo = min(0.0, tk(drop.a), tk(drop.b))
                hi = max(keep.length, tk(drop.a), tk(drop.b))
                ax, az = keep.a
                keep.a = (ax + ku * lo, az + kz * lo)
                keep.b = (ax + ku * hi, az + kz * hi)
                keep.thickness = max(keep.thickness, drop.thickness)
                keep.gaps = keep.gaps or drop.gaps
                walls.remove(drop)
                removed += 1
                changed = True
                break
            if changed:
                break
    return removed
