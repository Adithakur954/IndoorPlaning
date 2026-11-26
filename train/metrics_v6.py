"""Structure metrics for floor-plan segmentation: not only pixel IoU, but whether walls connect and rooms close.

All metrics are computed from label maps that are aligned with the image (mask + wall centre-lines), so they work
for dataset v6, for the old v4 images (centre-lines from the wall mask) and for hand-labelled real plans.

    m = plan_metrics(pred, mask, lines, px_per_m)    # one image
    agg = Aggregate(); agg.add(m); agg.result()      # a whole set

Metrics
  wall_iou                 pixel IoU of the wall class
  door_p / door_r          door openings found as objects (connected regions), precision / recall
  window_p / window_r      the same for windows
  false_wall_rate          share of predicted wall pixels that are not structure in the truth (2 px tolerance),
                           with the classes they really were (desk, stairs, void, text on background, ...)
  centreline_recall        share of the true wall centre-line covered by predicted structure (1 px tolerance)
  breaks_per_100m          gaps of 3 px or more along the true centre-line, per 100 m of wall
  junction_acc             share of true wall junctions (T, X, L) whose surroundings are fully covered
  room_closure             share of true rooms (doors sealed) matched by a predicted closed region, IoU >= 0.7
  room_merge / room_split  true rooms swallowed by a bigger predicted region / broken into pieces
  geometry_err_cm          median distance from the true centre-line to the predicted wall's centre, in cm
"""
from __future__ import annotations

import cv2
import numpy as np

WALL, DOOR, WINDOW, COLUMN = 1, 2, 3, 5
STRUCT = (WALL, DOOR, WINDOW, COLUMN)
IGNORE = 255
NAMES = {0: "background", 1: "wall", 2: "door", 3: "window", 4: "floor", 5: "column", 6: "ap", 7: "desk", 8: "chair",
         9: "table", 10: "sofa", 11: "plant", 12: "pod", 13: "storage", 14: "stairs", 15: "void"}
K3 = np.ones((3, 3), np.uint8)


try:
    from skimage.morphology import skeletonize as _skeletonize
except ImportError:      # pragma: no cover
    _skeletonize = None


def thin(binary):
    b = (binary > 0).astype(np.uint8) * 255
    if hasattr(cv2, "ximgproc"):
        return cv2.ximgproc.thinning(b) > 0
    if _skeletonize is not None:
        return _skeletonize(b > 0)
    # Zhang-Suen thinning (numpy)
    img = (b > 0).astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            p = np.pad(img, 1)
            P2, P3, P4, P5 = p[:-2, 1:-1], p[:-2, 2:], p[1:-1, 2:], p[2:, 2:]
            P6, P7, P8, P9 = p[2:, 1:-1], p[2:, :-2], p[1:-1, :-2], p[:-2, :-2]
            nb = [P2, P3, P4, P5, P6, P7, P8, P9]
            B = sum(x.astype(np.int32) for x in nb)
            seq = nb + [P2]
            A = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.int32) for i in range(8))
            if step == 0:
                c = (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
            else:
                c = (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
            rm = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any():
                img[rm] = 0
                changed = True
    return img > 0


def junctions(skel):
    """Pixels of a 1-px skeleton with 3 or more neighbours (T, X and Y junctions)."""
    s = skel.astype(np.uint8)
    nb = cv2.filter2D(s, -1, np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.float32), borderType=cv2.BORDER_CONSTANT)
    j = (s == 1) & (nb >= 3)
    n, lab, st, cen = cv2.connectedComponentsWithStats(j.astype(np.uint8), connectivity=8)
    return [tuple(map(int, cen[k])) for k in range(1, n)]


def objects(binary, min_area=3):
    n, lab, st, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    return [(lab == k) for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= min_area], lab, n


def object_pr(pred_bin, true_bin, tol=2):
    """Precision / recall of openings as objects: a true opening is found if a predicted one touches it."""
    pd = cv2.dilate(pred_bin.astype(np.uint8), K3, iterations=tol) > 0
    td = cv2.dilate(true_bin.astype(np.uint8), K3, iterations=tol) > 0
    n_t, lab_t, st_t, _ = cv2.connectedComponentsWithStats(true_bin.astype(np.uint8), connectivity=8)
    n_p, lab_p, st_p, _ = cv2.connectedComponentsWithStats(pred_bin.astype(np.uint8), connectivity=8)
    true_ids = [k for k in range(1, n_t) if st_t[k, cv2.CC_STAT_AREA] >= 3]
    pred_ids = [k for k in range(1, n_p) if st_p[k, cv2.CC_STAT_AREA] >= 3]
    hit_t = set(np.unique(lab_t[pd & (lab_t > 0)]).tolist())
    hit_p = set(np.unique(lab_p[td & (lab_p > 0)]).tolist())
    return dict(tp_true=sum(1 for k in true_ids if k in hit_t), n_true=len(true_ids),
                tp_pred=sum(1 for k in pred_ids if k in hit_p), n_pred=len(pred_ids))


def regions(labels, min_area):
    """Closed spaces: everything inside the building that is not wall / door / window / column (doors seal)."""
    free = ~np.isin(labels, STRUCT) & (labels != 0) & (labels != IGNORE)
    n, lab, st, _ = cv2.connectedComponentsWithStats(free.astype(np.uint8), connectivity=4)
    keep = [k for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= min_area]
    return lab, keep, st


def room_scores(pred, mask, min_area):
    tl, tk, tst = regions(mask, min_area)
    pl, pk, pst = regions(pred, min_area)
    if not tk:
        return dict(rooms_true=0, rooms_closed=0, rooms_merged=0, rooms_split=0, rooms_pred=len(pk))
    # overlap table between true and predicted regions
    both = (tl > 0) & (pl > 0)
    pairs = tl[both].astype(np.int64) * (pl.max() + 1) + pl[both]
    ids, counts = np.unique(pairs, return_counts=True)
    inter = {}
    for i, c in zip(ids, counts):
        inter[(int(i // (pl.max() + 1)), int(i % (pl.max() + 1)))] = int(c)
    closed = merged = split = 0
    tset, pset = set(tk), set(pk)
    best_of_pred = {}
    for (t, p), c in inter.items():
        if t in tset and p in pset:
            best_of_pred.setdefault(p, []).append((t, c))
    for t in tk:
        a_t = tst[t, cv2.CC_STAT_AREA]
        cand = [(p, c) for (tt, p), c in inter.items() if tt == t and p in pset]
        if not cand:
            continue
        p, c = max(cand, key=lambda x: x[1])
        iou = c / (a_t + pst[p, cv2.CC_STAT_AREA] - c)
        if iou >= 0.7:
            closed += 1
        elif len([1 for tt, cc in best_of_pred.get(p, []) if cc > 0.5 * tst[tt, cv2.CC_STAT_AREA]]) >= 2:
            merged += 1      # this room leaked into a neighbour (a missing wall or door seal)
        elif c < 0.6 * a_t:
            split += 1       # broken into pieces (false walls across it)
    return dict(rooms_true=len(tk), rooms_closed=closed, rooms_merged=merged, rooms_split=split, rooms_pred=len(pk))


def plan_metrics(pred, mask, lines=None, px_per_m=None):
    """pred, mask: class per pixel (same size); lines: true wall centre-lines (255) or None (made from the mask)."""
    valid = mask != IGNORE
    pw, tw = (pred == WALL) & valid, (mask == WALL) & valid
    inter, union = int((pw & tw).sum()), int((pw | tw).sum())
    out = dict(wall_inter=inter, wall_union=union)
    for name, c in (("door", DOOR), ("window", WINDOW)):
        r = object_pr((pred == c) & valid, (mask == c) & valid)
        out.update({f"{name}_{k}": v for k, v in r.items()})
    # false walls
    t_struct = cv2.dilate(np.isin(mask, STRUCT).astype(np.uint8), K3, iterations=2) > 0
    fw = pw & ~t_struct
    out["pred_wall_px"] = int(pw.sum())
    out["false_wall_px"] = int(fw.sum())
    if fw.any():
        cls, cnt = np.unique(mask[fw], return_counts=True)
        out["false_wall_by_class"] = {NAMES.get(int(c), str(int(c))): int(n) for c, n in zip(cls, cnt)}
    else:
        out["false_wall_by_class"] = {}
    # centre-line coverage, breaks, junctions, geometry
    if lines is None:
        skel = thin(mask == WALL)
    else:
        skel = thin(lines > 0)
    skel &= valid
    p_struct = np.isin(pred, STRUCT)
    cov = cv2.dilate(p_struct.astype(np.uint8), K3, iterations=1) > 0
    n_line = int(skel.sum())
    covered = skel & cov
    out["line_px"] = n_line
    out["line_covered_px"] = int(covered.sum())
    miss = (skel & ~cov).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(miss, connectivity=8)
    out["breaks"] = int(sum(1 for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= 3))
    ppm = float(px_per_m) if px_per_m else None
    out["line_m"] = n_line / ppm if ppm else None
    js = junctions(skel)
    r = 4
    ok = 0
    for (x, y) in js:
        y0, y1, x0, x1 = max(0, y - r), y + r + 1, max(0, x - r), x + r + 1
        s = skel[y0:y1, x0:x1]
        if s.any() and cov[y0:y1, x0:x1][s].all():
            ok += 1
    out["junctions"] = len(js)
    out["junctions_ok"] = ok
    if covered.any() and (pred == WALL).any():
        pskel = thin(pred == WALL)
        dist = cv2.distanceTransform((~pskel).astype(np.uint8), cv2.DIST_L2, 3)
        d = dist[covered]
        out["geom_err_px"] = float(np.median(d))
        out["geom_err_cm"] = float(np.median(d) / ppm * 100) if ppm else None
    else:
        out["geom_err_px"] = out["geom_err_cm"] = None
    # rooms (doors sealed): at least ~1 m2 at this scale, or 60 px
    min_area = max(60, int((ppm or 10) ** 2 * 1.0))
    out.update(room_scores(np.where(valid, pred, IGNORE), mask, min_area))
    # the same with 1-2 px holes in the predicted walls bridged (what simple post-processing would do)
    bridged = pred.copy()
    closed_struct = cv2.morphologyEx(np.isin(pred, STRUCT).astype(np.uint8), cv2.MORPH_CLOSE, K3) > 0
    bridged[closed_struct & ~np.isin(pred, STRUCT)] = WALL
    rb = room_scores(np.where(valid, bridged, IGNORE), mask, min_area)
    out["rooms_closed_bridged"] = rb["rooms_closed"]
    return out


class Aggregate:
    def __init__(self):
        self.items = []

    def add(self, m):
        self.items.append(m)

    def result(self):
        it = self.items
        if not it:
            return {}

        def s(k):
            return sum(m[k] for m in it if m.get(k) is not None)

        def ratio(a, b):
            return round(a / b, 4) if b else None

        fwc = {}
        for m in it:
            for k, v in m["false_wall_by_class"].items():
                fwc[k] = fwc.get(k, 0) + v
        tot_fw = sum(fwc.values()) or 1
        line_m = s("line_m")
        geo = [m["geom_err_cm"] for m in it if m.get("geom_err_cm") is not None]
        return dict(
            images=len(it),
            wall_iou=ratio(s("wall_inter"), s("wall_union")),
            door_p=ratio(s("door_tp_pred"), s("door_n_pred")), door_r=ratio(s("door_tp_true"), s("door_n_true")),
            window_p=ratio(s("window_tp_pred"), s("window_n_pred")),
            window_r=ratio(s("window_tp_true"), s("window_n_true")),
            false_wall_rate=ratio(s("false_wall_px"), s("pred_wall_px")),
            false_wall_is={k: round(v / tot_fw, 3) for k, v in sorted(fwc.items(), key=lambda x: -x[1])[:8]},
            centreline_recall=ratio(s("line_covered_px"), s("line_px")),
            breaks_per_100m=round(100 * s("breaks") / line_m, 2) if line_m else None,
            junction_acc=ratio(s("junctions_ok"), s("junctions")),
            room_closure=ratio(s("rooms_closed"), s("rooms_true")),
            room_closure_bridged=ratio(s("rooms_closed_bridged"), s("rooms_true")),
            room_merge=ratio(s("rooms_merged"), s("rooms_true")),
            room_split=ratio(s("rooms_split"), s("rooms_true")),
            room_count_ratio=ratio(s("rooms_pred"), s("rooms_true")),
            geometry_err_cm=round(float(np.median(geo)), 2) if geo else None,
        )


def topo_score(r):
    """One number to choose between runs: rooms that close, walls that connect, few false walls."""
    parts = [r.get("room_closure_bridged"), r.get("centreline_recall"), r.get("junction_acc"),
             None if r.get("false_wall_rate") is None else 1 - r["false_wall_rate"],
             r.get("door_r")]
    parts = [p for p in parts if p is not None]
    return round(float(np.mean(parts)), 4) if parts else 0.0
