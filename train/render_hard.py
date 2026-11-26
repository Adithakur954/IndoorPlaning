"""Hard-case floor-plan renderer for dataset v6.

Every image is drawn from exact geometry built here (metres, shapely), so the labels are always right:

    mask   0 background (outside), 1 wall, 2 door opening, 3 window opening, 4 floor, 5 column, 6 AP marker,
           7 desk / table, 8 chair / seat, 11 plant, 14 stairs, 15 void (hatched / filled area that is NOT wall:
           shafts, risers, voids, "open to sky", mezzanine fills)
    lines  wall centre-lines (255), the same walls as class 1, not drawn through door / window openings
    geom   the vector ground truth: room polygons, doors (+ the two spaces they join), windows, wall centre-lines

What it adds over dataset v4 (see train/README.md, "Dataset v6"):
  * building types: RF-design office, CAD office, factory / warehouse, simple schematic, hospital, hotel, mall,
    school with auditorium, car park, residential CAD
  * geometry: L / U / T / chamfered / notched footprints, rotated wings (non-Manhattan), curved facades, circular
    and octagonal rooms (curved walls with doors in them), variable wall thickness, heavy cores
  * hard negatives: hatched voids next to hatched walls, stair treads, lift X boxes, racks, conveyors, parking
    bays, ducts, ceiling grids, grid lines, dimension chains, cables running along walls, text over walls
  * overlays of RF tools: antenna / small-cell icons (class 6), ANT / SPT / sector labels, cable runs, BBU boxes,
    coverage tints, legends, title blocks, banners
  * sheet styles: white, dark CAD, blueprint, sepia, department colour fills, thin-line schematics
Overlays never change a label: a wall under a cable or under text is still wall, a duct is still floor.
"""
from __future__ import annotations

import math
import string

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely import affinity
from shapely.geometry import LineString, MultiLineString, Point, Polygon, box
from shapely.ops import linemerge, substring, unary_union
from shapely.strtree import STRtree

import render_plan as rp

CLASSES = {**rp.CLASSES, "stairs": 14, "void": 15}
BG, WALL, DOOR, WINDOW, FLOOR, COLUMN, AP, DESK, CHAIR, PLANT = 0, 1, 2, 3, 4, 5, 6, 7, 8, 11
STAIRS, VOID = 14, 15
IGNORE = 255
MAX_SIDE = 2400

# ------------------------------------------------------------------ building types
THEMES = {
    "rf_office":   dict(w=(45, 95), d=(25, 55), room=(10, 60), layout=("bsp", "double"), furn="office", rf=0.95,
                        mep=0.25, void=0.07, cols=0.5, w_ext=(0.2, 0.45), w_int=(0.08, 0.18)),
    "cad_office":  dict(w=(35, 85), d=(22, 50), room=(9, 50), layout=("bsp", "double"), furn="office", rf=0.25,
                        mep=0.6, void=0.06, cols=0.6, w_ext=(0.2, 0.4), w_int=(0.08, 0.15)),
    "industrial":  dict(w=(80, 190), d=(40, 90), room=(200, 2600), layout=("bsp",), furn="industrial", rf=0.75,
                        mep=0.15, void=0.12, cols=0.7, w_ext=(0.25, 0.6), w_int=(0.15, 0.4)),
    "schematic":   dict(w=(40, 90), d=(24, 50), room=(35, 420), layout=("bsp",), furn="none", rf=0.15, mep=0.0,
                        void=0.12, cols=0.0, w_ext=(0.12, 0.3), w_int=(0.08, 0.2)),
    "hospital":    dict(w=(50, 110), d=(28, 55), room=(10, 34), layout=("double",), furn="hospital", rf=0.45,
                        mep=0.4, void=0.05, cols=0.4, w_ext=(0.2, 0.4), w_int=(0.1, 0.2)),
    "hotel":       dict(w=(40, 95), d=(16, 26), room=(18, 36), layout=("double",), furn="hotel", rf=0.4,
                        mep=0.3, void=0.04, cols=0.2, w_ext=(0.2, 0.4), w_int=(0.1, 0.2)),
    "mall":        dict(w=(60, 150), d=(40, 90), room=(40, 220), layout=("bsp", "double"), furn="retail", rf=0.45,
                        mep=0.3, void=0.12, cols=0.8, w_ext=(0.25, 0.5), w_int=(0.1, 0.25)),
    "school":      dict(w=(45, 110), d=(25, 60), room=(40, 80), layout=("double", "bsp"), furn="school", rf=0.35,
                        mep=0.2, void=0.05, cols=0.3, w_ext=(0.2, 0.4), w_int=(0.1, 0.22)),
    "parking":     dict(w=(50, 110), d=(35, 75), room=(700, 3200), layout=("bsp",), furn="parking", rf=0.4,
                        mep=0.2, void=0.08, cols=1.0, w_ext=(0.2, 0.45), w_int=(0.15, 0.3)),
    "residential": dict(w=(16, 42), d=(11, 28), room=(5, 30), layout=("bsp",), furn="home", rf=0.25, mep=0.1,
                        void=0.05, cols=0.15, w_ext=(0.2, 0.35), w_int=(0.08, 0.14)),
}
THEME_WEIGHTS = {"rf_office": 26, "cad_office": 16, "industrial": 18, "schematic": 8, "hospital": 7, "hotel": 5,
                 "mall": 7, "school": 6, "parking": 3, "residential": 4}

NAMES = {
    "office": ["OFFICE", "Meeting Room", "Conf. Room", "MD Cabin", "Admin Office", "Cabin", "Pantry", "Server Room",
               "HR", "Training Room", "Reception", "Board Room", "Huddle", "Store", "Work Station Area"],
    "industrial": ["Battery & Motor Stores", "Vehicle Unit Stores", "Accessories Packing", "FG Storage", "Rework",
                   "Offline Assy", "Paint Shop", "Dispatch", "QC Lab", "Tool Room", "Electrical Room", "Compressor"],
    "hospital": ["Ward", "ICU", "OT", "Nurse Station", "Consulting", "X-Ray", "Lab", "Pharmacy", "Recovery", "Waiting"],
    "hotel": ["Guest Room", "Suite", "Linen", "Housekeeping", "Lobby", "Lounge"],
    "retail": ["Shop", "Anchor Store", "Food Court", "Kiosk", "ICICI Bank", "ATM", "Cinema", "Exhibition Hall"],
    "school": ["Classroom", "Lab", "Library", "Staff Room", "Auditorium", "Back Stage", "Makeup-Room", "VIP Room"],
    "parking": ["Parking", "Ramp", "Drive Aisle", "Pump Room", "DG Room"],
    "home": ["Bedroom", "Living", "Kitchen", "Toilet", "Dining", "Balcony", "Utility", "Study"],
    "none": ["Utsav Restaurant", "Admin Office", "Exhibition Hall", "Theater", "Back Stage", "VIP Room"],
}
VOID_NAMES = ["SHAFT", "DUCT", "Open To SKY", "OTS", "Electrical Room", "Riser", "Void", "MEZZANINE", "LMR"]
CABLE_COLOURS = [(160, 40, 160), (200, 60, 40), (0, 200, 230), (40, 40, 210), (40, 170, 40), (0, 140, 255),
                 (200, 0, 120), (90, 90, 90)]  # BGR

_FONT_CACHE: dict = {}


def font(path, size):
    key = (path, int(size))
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(path, max(6, int(size)))
    return _FONT_CACHE[key]


# ------------------------------------------------------------------ geometry helpers (metres)
def parts(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for gg in getattr(g, "geoms", []) for p in parts(gg)]


def lines_of(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, LineString):
        return [g]
    if isinstance(g, MultiLineString):
        return list(g.geoms)
    out = []
    for gg in getattr(g, "geoms", []):
        out += lines_of(gg)
    return out


def rand_point(poly, rng, tries=60, inset=0.0):
    p0 = poly.buffer(-inset) if inset else poly
    if p0.is_empty:
        p0 = poly
    x0, y0, x1, y1 = p0.bounds
    for _ in range(tries):
        p = Point(rng.uniform(x0, x1), rng.uniform(y0, y1))
        if p0.contains(p):
            return p
    return p0.representative_point()


def regular(cx, cy, r, n, rot=0.0):
    return Polygon([(cx + r * math.cos(rot + 2 * math.pi * k / n), cy + r * math.sin(rot + 2 * math.pi * k / n))
                    for k in range(n)])


def footprint(rng, th, diff):
    """The building outline, as parts that are partitioned separately: (polygon, angle, pivot, mode)."""
    W, D = rng.uniform(*th["w"]), rng.uniform(*th["d"])
    main = box(0, 0, W, D)
    kinds = ["rect", "L", "U", "T", "chamfer", "notches", "wing", "curve", "pavilion"]
    weights = [16, 12, 7, 5, 8, 7, 14 + 4 * diff, 8 + 2 * diff, 6 + 2 * diff]
    shape = rng.choices(kinds, weights)[0]
    extra = []
    if shape == "L":
        a, b = rng.uniform(0.25, 0.5), rng.uniform(0.3, 0.6)
        main = main.difference(box(W * (1 - a), 0, W + 1, D * b))
    elif shape == "U":
        a = rng.uniform(0.25, 0.45)
        main = main.difference(box(W * (0.5 - a / 2), -1, W * (0.5 + a / 2), D * rng.uniform(0.25, 0.5)))
    elif shape == "T":
        a = rng.uniform(0.2, 0.35)
        main = main.difference(box(-1, D * (1 - a), W * 0.3, D + 1)).difference(box(W * 0.7, D * (1 - a), W + 1, D + 1))
    elif shape == "chamfer":
        c = min(W, D) * rng.uniform(0.12, 0.3)
        for (x, y, sx, sy) in rng.sample([(0, 0, 1, 1), (W, 0, -1, 1), (W, D, -1, -1), (0, D, 1, -1)], rng.randint(1, 3)):
            main = main.difference(Polygon([(x, y), (x + sx * c, y), (x, y + sy * c)]))
    elif shape == "notches":
        for _ in range(rng.randint(2, 6)):
            nw, nd = rng.uniform(2, 8), rng.uniform(1.5, 5)
            if rng.random() < 0.5:
                x = rng.uniform(0, W - nw)
                y = 0 if rng.random() < 0.5 else D - nd
                main = main.difference(box(x, y - 0.01, x + nw, y + nd + 0.01))
            else:
                y = rng.uniform(0, D - nw)
                x = 0 if rng.random() < 0.5 else W - nd
                main = main.difference(box(x - 0.01, y, x + nd + 0.01, y + nw))
    main = max(parts(main), key=lambda p: p.area)
    out = [(main, 0.0, (W / 2, D / 2), "plan")]
    if shape == "wing":
        ang = rng.choice([-1, 1]) * rng.uniform(15, 55)
        ww, wd = rng.uniform(0.35, 0.8) * W, rng.uniform(0.35, 0.8) * D
        corner = rng.choice([(W, 0), (W, D), (0, D), (0, 0)])
        wing = box(0, 0, ww, wd)
        wing = affinity.translate(wing, -0.15 * ww if corner[0] == 0 else -0.15 * ww, -0.5 * wd)
        wing = affinity.rotate(wing, ang, origin=(0, 0))
        wing = affinity.translate(wing, corner[0], corner[1])
        wing = wing.difference(main)
        wing = max(parts(wing), key=lambda p: p.area) if parts(wing) else None
        if wing is not None and wing.area > 0.08 * main.area:
            c = wing.centroid
            out.append((wing, ang, (c.x, c.y), "plan"))
    elif shape == "curve":
        side = rng.choice(["top", "bottom", "left", "right"])
        if side in ("top", "bottom"):
            L, R = W * rng.uniform(0.3, 0.8), None
            cx = rng.uniform(L / 2, W - L / 2)
            R = L / 2 / math.sin(rng.uniform(0.5, 1.4))
            h = R - math.sqrt(max(R * R - (L / 2) ** 2, 0))
            cy = (0 - h + R) if side == "top" else (D + h - R)
            disk = Point(cx, cy).buffer(R, 96)
            bulge = disk.intersection(box(cx - L / 2, -R * 2, cx + L / 2, 0) if side == "top"
                                      else box(cx - L / 2, D, cx + L / 2, D + R * 2))
        else:
            L = D * rng.uniform(0.3, 0.8)
            cy = rng.uniform(L / 2, D - L / 2)
            R = L / 2 / math.sin(rng.uniform(0.5, 1.4))
            h = R - math.sqrt(max(R * R - (L / 2) ** 2, 0))
            cx = (0 - h + R) if side == "left" else (W + h - R)
            disk = Point(cx, cy).buffer(R, 96)
            bulge = disk.intersection(box(-R * 2, cy - L / 2, 0, cy + L / 2) if side == "left"
                                      else box(W, cy - L / 2, W + R * 2, cy + L / 2))
        bulge = max(parts(bulge), key=lambda p: p.area) if parts(bulge) else None
        if bulge is not None and bulge.area > 4:
            out.append((bulge, 0.0, (0, 0), "single"))
    elif shape == "pavilion":
        r = min(W, D) * rng.uniform(0.18, 0.32)
        n = rng.choice([8, 8, 6, 64])
        cy = rng.uniform(r, D - r)
        cx = W + r * 0.55 if rng.random() < 0.5 else -r * 0.55
        pav = regular(cx, cy, r, n, rng.uniform(0, math.pi / n)).difference(main)
        pav = max(parts(pav), key=lambda p: p.area) if parts(pav) else None
        if pav is not None and pav.area > 6:
            out.append((pav, 0.0, (0, 0), "single"))
    return out


def bsp(poly, rng, area_rng, corridor_p, oblique_p=0.0):
    """Recursive splits of `poly` (axis-aligned frame) into rooms; sometimes a corridor strip at a split."""
    rooms, stack = [], [(poly, 0)]
    while stack:
        p, depth = stack.pop()
        target = math.exp(rng.uniform(math.log(area_rng[0]), math.log(area_rng[1])))
        x0, y0, x1, y1 = p.bounds
        w, h = x1 - x0, y1 - y0
        if p.area <= target or min(w, h) < 2.6 or depth > 14:
            rooms.append([p, "room"])
            continue
        horiz = w >= h if rng.random() < 0.85 else w < h
        t = rng.uniform(0.32, 0.68)
        corr = rng.random() < corridor_p and depth < 3 and (w if horiz else h) > 16
        cw = rng.uniform(1.8, 3.6) if corr else 0.0
        if horiz:
            s = x0 + w * t
            a, b = box(x0 - 1, y0 - 1, s - cw / 2, y1 + 1), box(s + cw / 2, y0 - 1, x1 + 1, y1 + 1)
            c = box(s - cw / 2, y0 - 1, s + cw / 2, y1 + 1)
        else:
            s = y0 + h * t
            a, b = box(x0 - 1, y0 - 1, x1 + 1, s - cw / 2), box(x0 - 1, s + cw / 2, x1 + 1, y1 + 1)
            c = box(x0 - 1, s - cw / 2, x1 + 1, s + cw / 2)
        if not corr and depth >= 2 and rng.random() < oblique_p:   # an angled partition inside a block
            ang = rng.choice([-1, 1]) * rng.uniform(12, 40)
            piv = (s, (y0 + y1) / 2) if horiz else ((x0 + x1) / 2, s)
            big = max(w, h) * 3 + 10
            half = box(x0 - big, y0 - big, s, y1 + big) if horiz else box(x0 - big, y0 - big, x1 + big, s)
            a = affinity.rotate(half, ang, origin=piv)
            b = box(x0 - big, y0 - big, x1 + big, y1 + big).difference(a)
        pieces = [q for half in (a, b) for q in parts(p.intersection(half))]
        if corr:
            for q in parts(p.intersection(c)):
                if q.area > 1.0:
                    rooms.append([q, "corridor"])
        big = [q for q in pieces if q.area >= 2.0]
        small = [q for q in pieces if q.area < 2.0]
        if not big:
            rooms.append([p, "room"])
            continue
        for q in small:  # slivers join their neighbour
            j = max(range(len(big)), key=lambda k: big[k].buffer(0.05).intersection(q).area)
            big[j] = unary_union([big[j], q])
            big[j] = max(parts(big[j]), key=lambda z: z.area)
        for q in big:
            stack.append((q, depth + 1))
    return rooms


def double_loaded(poly, rng, area_rng):
    """Corridor along the long axis with rooms on both sides (hospital, hotel, school)."""
    x0, y0, x1, y1 = poly.bounds
    w, h = x1 - x0, y1 - y0
    long_x = w >= h
    L, S = (w, h) if long_x else (h, w)
    cw = rng.uniform(1.8, 3.2)
    mid = S * rng.uniform(0.42, 0.58)
    rooms = []
    corr = box(x0 - 1, y0 + mid - cw / 2, x1 + 1, y0 + mid + cw / 2) if long_x else \
        box(x0 + mid - cw / 2, y0 - 1, x0 + mid + cw / 2, y1 + 1)
    for q in parts(poly.intersection(corr)):
        rooms.append([q, "corridor"])
    sides = [(y0 - 1, y0 + mid - cw / 2), (y0 + mid + cw / 2, y1 + 1)] if long_x else \
        [(x0 - 1, x0 + mid - cw / 2), (x0 + mid + cw / 2, x1 + 1)]
    for lo, hi in sides:
        depth = max(hi - lo - 1, 2.5)
        pos = (x0 if long_x else y0)
        end = (x1 if long_x else y1)
        while pos < end - 0.5:
            area = math.exp(rng.uniform(math.log(area_rng[0]), math.log(area_rng[1])))
            d_eff = depth / 2 if depth > 7.5 else depth
            step = min(max(area / d_eff, 2.4), end - pos)
            if end - pos - step < 2.4:
                step = end - pos
            cells = [box(pos, lo, pos + step, hi) if long_x else box(lo, pos, hi, pos + step)]
            if depth > 7.5 and rng.random() < 0.65:   # deep side: a front and a back room
                cut = lo + (hi - lo) * rng.uniform(0.4, 0.6)
                cells = [box(pos, lo, pos + step, cut), box(pos, cut, pos + step, hi)] if long_x else                     [box(lo, pos, cut, pos + step), box(cut, pos, hi, pos + step)]
            for cell in cells:
                for q in parts(poly.intersection(cell)):
                    if q.area >= 1.5:
                        rooms.append([q, "room"])
            pos += step
    return rooms


# ------------------------------------------------------------------ plan
class Plan:
    """Exact plan geometry in metres plus what to draw on it."""

    def __init__(self):
        self.rooms = []        # dict(poly, kind, name, part)
        self.items = []        # (kind, geom, info) furniture / stairs / columns / lifts, in world metres
        self.doors = []        # dict(line, poly, style, rooms, exterior)
        self.windows = []      # dict(line, poly, style)
        self.footprint = None
        self.t_ext = self.t_int = 0.2
        self.t_cut = 0.4       # half of this either side of an opening's line is cut out of any wall
        self.var = False       # interior walls vary in thickness
        self.t_heavy = 0.8     # very thick store / core walls (industrial)
        self.partials = []     # partition walls that end freely / just short of another wall


def furnish(local_rooms, th, rng, diff):
    """Furniture and fittings for the rooms of one part, in the part's axis-aligned frame."""
    items = []
    furn = th["furn"]
    for r in local_rooms:
        poly, kind = r["poly"], r["kind"]
        x0, y0, x1, y1 = poly.bounds
        w, h = x1 - x0, y1 - y0
        inner = poly.buffer(-0.6)
        if inner.is_empty or kind in ("corridor", "void", "atrium"):
            continue
        if kind == "stair":
            sw, sh = min(w - 0.6, rng.uniform(2.4, 5)), min(h - 0.6, rng.uniform(4, 7))
            if sw > 1.6 and sh > 2.2:
                sx, sy = x0 + (w - sw) / 2, y0 + (h - sh) / 2
                g = box(sx, sy, sx + sw, sy + sh)
                if poly.buffer(-0.1).contains(g):
                    items.append(("stairs", g, dict(vertical=sh > sw, tread=rng.uniform(0.22, 0.32))))
            continue
        if kind == "spiral":
            rr = min(w, h) / 2 - 0.4
            if rr > 0.8:
                c = poly.centroid
                items.append(("spiral", Point(c.x, c.y).buffer(rr, 48), dict(n=rng.randint(12, 20))))
            continue
        if kind == "lift":
            items.append(("lift", poly.buffer(-0.08), {}))
            continue
        if kind == "toilet":
            n = max(1, int(w // 1.2))
            for k in range(min(n, 6)):
                cx = x0 + 0.6 + k * 1.2
                if cx < x1 - 0.4:
                    items.append(("wc", box(cx - 0.22, y0 + 0.1, cx + 0.22, y0 + 0.7), {}))
            continue
        if furn == "office" and kind in ("room", "open"):
            if kind == "open" or poly.area > 45 or (poly.area > 20 and rng.random() < 0.5):
                items += workstations(poly, inner, rng, diff)
            elif poly.area > 12 and rng.random() < 0.7:
                tw, td = min(w - 2.2, rng.uniform(1.8, 5)), min(h - 2.2, rng.uniform(1.0, 1.6))
                if tw > 1 and td > 0.6:
                    c = poly.centroid
                    t = box(c.x - tw / 2, c.y - td / 2, c.x + tw / 2, c.y + td / 2)
                    if inner.contains(t):
                        items.append(("desk", t, {}))
                        for k in range(int(tw // 0.7)):
                            for yy in (c.y - td / 2 - 0.35, c.y + td / 2 + 0.35):
                                ch = Point(c.x - tw / 2 + 0.35 + k * 0.7, yy).buffer(0.22, 10)
                                if inner.contains(ch):
                                    items.append(("chair", ch, {}))
        elif furn == "industrial" and kind in ("room", "hall", "open"):
            mode = rng.choice(["racks", "conveyor", "machines", "assembly", "assembly", "racks"])
            if mode == "assembly":
                got = assembly_line(poly, inner, rng)
                if got:
                    items += got
                    for _ in range(rng.randint(2, 8)):
                        p = rand_point(inner, rng)
                        s = rng.uniform(0.8, 2.2)
                        g2 = box(p.x - s, p.y - s * 0.6, p.x + s, p.y + s * 0.6)
                        if inner.contains(g2) and not g2.intersects(got[0][1]):
                            items.append(("machine", g2, {}))
                else:
                    mode = "machines"
            if mode == "racks":
                rw = rng.uniform(1.0, 1.4)
                aisle = rng.uniform(2.5, 4)
                vertical = h > w
                pos = (x0 if not vertical else y0) + 1.5
                end = (x1 if not vertical else y1) - 1.5
                while pos + rw < end:
                    g = box(pos, y0 + 2, pos + rw, y1 - 2) if not vertical else box(x0 + 2, pos, x1 - 2, pos + rw)
                    if not g.is_empty and inner.contains(g):
                        items.append(("rack", g, dict(vertical=not vertical)))
                    pos += rw + aisle
            elif mode == "conveyor":
                cx0, cy0 = x0 + w * 0.1, y0 + h * 0.3
                cl, cr = w * 0.8, min(h * 0.18, 3.0)
                g = LineString([(cx0 + cr, cy0 + cr), (cx0 + cl - cr, cy0 + cr)]).buffer(cr, 24)
                if inner.contains(g):
                    items.append(("conveyor", g, dict(width=min(cr * 0.5, 1.2))))
                for k in range(rng.randint(3, 10)):
                    p = rand_point(inner, rng)
                    s = rng.uniform(0.6, 2.0)
                    g2 = box(p.x - s, p.y - s * 0.6, p.x + s, p.y + s * 0.6)
                    if inner.contains(g2):
                        items.append(("machine", g2, {}))
            elif mode == "machines":
                for k in range(rng.randint(4, 16)):
                    p = rand_point(inner, rng)
                    s = rng.uniform(0.6, 3.0)
                    g2 = box(p.x - s, p.y - s * 0.7, p.x + s, p.y + s * 0.7)
                    if inner.contains(g2):
                        items.append(("machine", g2, {}))
            if rng.random() < 0.8:
                items.append(("gangway", LineString([(x0 + 1, y1 - 1.0), (x1 - 1, y1 - 1.0)]), {}))
            if rng.random() < 0.6 and h > 12:
                items.append(("gangway", LineString([(x0 + 1.0, y0 + 1), (x0 + 1.0, y1 - 1)]), {}))
        elif furn == "hospital" and kind == "room":
            for k in range(min(4, int(w // 2.4))):
                g = box(x0 + 0.5 + k * 2.4, y0 + 0.3, x0 + 1.4 + k * 2.4, y0 + 2.3)
                if inner.buffer(0.4).contains(g):
                    items.append(("bed", g, {}))
        elif furn == "hotel" and kind == "room":
            g = box(x0 + 0.6, y0 + 0.6, x0 + 2.4, y0 + 2.6)
            if inner.buffer(0.3).contains(g):
                items.append(("bed", g, {}))
            items.append(("wc", box(x1 - 1.0, y1 - 1.0, x1 - 0.5, y1 - 0.4), {}))
        elif furn == "retail" and kind == "room":
            for k in range(rng.randint(0, 5)):
                p = rand_point(inner, rng)
                g = box(p.x - 1.5, p.y - 0.3, p.x + 1.5, p.y + 0.3)
                if inner.contains(g):
                    items.append(("shelf", g, {}))
        elif furn == "school" and kind in ("room", "auditorium"):
            if kind == "auditorium":
                c = poly.centroid
                rmax = min(w, h) * 0.42
                for ring in np.arange(rmax * 0.35, rmax, 0.9):
                    for a in np.linspace(0.2 * math.pi, 0.8 * math.pi, max(4, int(ring * 2))):
                        s = Point(c.x + ring * math.cos(a), c.y + ring * math.sin(a)).buffer(0.22, 8)
                        if inner.contains(s):
                            items.append(("chair", s, {}))
            else:
                for yy in np.arange(y0 + 1.5, y1 - 1.2, 1.4):
                    for xx in np.arange(x0 + 1.2, x1 - 1.5, 1.6):
                        g = box(xx, yy, xx + 1.2, yy + 0.5)
                        if inner.contains(g):
                            items.append(("desk", g, {}))
        elif furn == "parking" and kind in ("room", "hall", "open"):
            bw, bl = 2.5, 5.0
            for yy in np.arange(y0 + 1, y1 - bl, bl * 2 + 6):
                for xx in np.arange(x0 + 1, x1 - bw, bw):
                    for k in (0, 1):
                        top = yy + k * (bl + 6)
                        g = box(xx, top, xx + bw, top + bl)
                        if inner.contains(g):
                            items.append(("bay", g, dict(car=rng.random() < 0.45)))
        elif furn == "home" and kind == "room":
            if rng.random() < 0.6:
                c = rand_point(inner, rng)
                g = box(c.x - 0.9, c.y - 1.0, c.x + 0.9, c.y + 1.0)
                if inner.contains(g):
                    items.append(("bed", g, {}))
    return items


def workstations(poly, inner, rng, diff):
    """Open-office floor packed with workstation clusters (2 x k desks, divider, chairs), as real CAD
    office plans are: hundreds of small symbols, a few pixels each at low resolution."""
    items = []
    x0, y0, x1, y1 = inner.bounds
    dw, dd = rng.uniform(1.0, 1.6), rng.uniform(0.55, 0.8)
    k = rng.choice([2, 3, 3, 4, 4, 5, 6])
    ax, ay = rng.uniform(0.9, 1.6), rng.uniform(1.1, 1.9)     # aisles between clusters
    vertical = rng.random() < 0.35
    cw, ch = (2 * dd, k * dw) if vertical else (k * dw, 2 * dd)
    style = rng.choice(["rect", "rect", "L", "bench"])
    y = y0 + rng.uniform(0.3, 0.9)
    while y + ch < y1:
        x = x0 + rng.uniform(0.3, 0.9)
        while x + cw < x1:
            cl = box(x, y, x + cw, y + ch)
            if inner.contains(cl):
                for i in range(k):
                    for j in (0, 1):
                        if vertical:
                            g = box(x + j * dd, y + i * dw, x + (j + 1) * dd, y + (i + 1) * dw)
                            cp = (x - 0.32 if j == 0 else x + 2 * dd + 0.32, y + (i + 0.5) * dw)
                        else:
                            g = box(x + i * dw, y + j * dd, x + (i + 1) * dw, y + (j + 1) * dd)
                            cp = (x + (i + 0.5) * dw, y - 0.32 if j == 0 else y + 2 * dd + 0.32)
                        items.append(("desk", g, dict(style=style, vertical=vertical, side=j)))
                        if rng.random() < 0.9:
                            c = Point(*cp).buffer(0.24, 10)
                            if inner.contains(c):
                                items.append(("chair", c, {}))
                items.append(("divider", LineString([(x, y + dd), (x + cw, y + dd)] if not vertical else
                                                    [(x + dd, y), (x + dd, y + ch)]), {}))
            x += cw + ax
        y += ch + ay
    # pods, cabinets and plants between the clusters
    for _ in range(rng.randint(2, 6 + 2 * diff)):
        p = rand_point(inner, rng)
        r = rng.random()
        if r < 0.4:
            items.append(("plant", p.buffer(rng.uniform(0.2, 0.4), 10), {}))
        elif r < 0.75:
            s = rng.uniform(0.3, 0.6)
            g = box(p.x - s, p.y - s, p.x + s, p.y + s)
            if inner.contains(g):
                items.append(("cabinet", g, {}))
    return items


def assembly_line(poly, inner, rng):
    """Factory assembly line: a long double loop (stadium) track with stations on it and detail inside."""
    x0, y0, x1, y1 = inner.bounds
    w, h = x1 - x0, y1 - y0
    horiz = w >= h
    L, S = (w, h) if horiz else (h, w)
    if L < 20 or S < 7:
        return []
    r = min(S * rng.uniform(0.18, 0.3), 6.0)
    m = rng.uniform(0.06, 0.15) * L
    if horiz:
        a, b = (x0 + m + r, y0 + S / 2), (x1 - m - r, y0 + S / 2)
    else:
        a, b = (x0 + S / 2, y0 + m + r), (x0 + S / 2, y1 - m - r)
    spine = LineString([a, b])
    outer = spine.buffer(r, 32)
    if not inner.contains(outer):
        return []
    track = rng.uniform(0.6, 1.4)
    return [("assembly", outer, dict(spine=spine, r=r, track=track, horiz=horiz,
                                     pitch=rng.uniform(1.2, 3.0), n_rows=rng.randint(1, 3)))]


def add_columns(plan, th, rng):
    if rng.random() > th["cols"]:
        return
    s = rng.choice([6, 7.5, 8, 9, 10, 12]) if th["furn"] != "industrial" else rng.choice([12, 15, 20, 25])
    size = rng.uniform(0.35, 0.8) if th["furn"] != "industrial" else rng.uniform(0.5, 1.0)
    round_c = rng.random() < 0.2
    x0, y0, x1, y1 = plan.footprint.bounds
    inner = plan.footprint.buffer(-0.5)
    for x in np.arange(x0 + s / 2, x1, s):
        for y in np.arange(y0 + s / 2, y1, s):
            g = Point(x, y).buffer(size / 2, 16) if round_c else box(x - size / 2, y - size / 2, x + size / 2, y + size / 2)
            if inner.contains(g):
                plan.items.append(("column", g, {}))


def build_plan(rng, theme, diff):
    th = THEMES[theme]
    plan = Plan()
    plan.diff = diff
    plan.t_ext = rng.uniform(*th["w_ext"])
    plan.t_int = rng.uniform(*th["w_int"])
    fparts = footprint(rng, th, diff)
    plan.footprint = unary_union([p for p, *_ in fparts]).buffer(0.001).buffer(-0.001)
    furn_names = NAMES.get(th["furn"], NAMES["office"])
    for pi, (poly, ang, pivot, mode) in enumerate(fparts):
        local = affinity.rotate(poly, -ang, origin=pivot) if ang else poly
        if mode == "single":
            lr = [[local, "room"]]
        elif rng.choice(th["layout"]) == "double" and min(local.bounds[2] - local.bounds[0], local.bounds[3] - local.bounds[1]) > 9:
            lr = double_loaded(local, rng, th["room"])
        elif th["furn"] == "office" and local.area > 300:
            # real office floors: 30-60 % open work areas packed with desks, cabins and cores around them
            x0_, y0_, x1_, y1_ = local.bounds
            share = rng.uniform(0.3, 0.6)
            long_x = (x1_ - x0_) >= (y1_ - y0_)
            L_ = (x1_ - x0_) if long_x else (y1_ - y0_)
            start_ = rng.uniform(0.05, 0.95 - share) * L_
            strip = box(x0_ + start_, y0_ - 1, x0_ + start_ + share * L_, y1_ + 1) if long_x else \
                box(x0_ - 1, y0_ + start_, x1_ + 1, y0_ + start_ + share * L_)
            if rng.random() < 0.4:   # or an open band along one long side
                d_ = (y1_ - y0_) if long_x else (x1_ - x0_)
                cut_ = d_ * rng.uniform(0.35, 0.6)
                strip = box(x0_ - 1, y0_ - 1, x1_ + 1, y0_ + cut_) if long_x else box(x0_ - 1, y0_ - 1, x0_ + cut_, y1_ + 1)
            open_zone, rest = local.intersection(strip), local.difference(strip)
            lr = [[q, "open"] for z in parts(open_zone) for q, _k in bsp(z, rng, (150, 700), 0.0)]
            for z in parts(rest):
                if z.area > 2:
                    lr += bsp(z, rng, th["room"], 0.3, oblique_p=0.06 * max(0, diff - 2))
        else:
            lr = bsp(local, rng, th["room"], 0.35 if th["furn"] not in ("industrial", "parking") else 0.2,
                     oblique_p=(0.05 * max(0, diff - 2)) if th["furn"] in ("office", "none", "retail", "home") else 0.0)
        rooms = [dict(poly=p, kind=k, name="", part=pi) for p, k in lr if p.area > 0.8]
        # special rooms
        small = [r for r in rooms if r["kind"] == "room" and 5 < r["poly"].area < 40]
        rng.shuffle(small)
        n_void = int(round(len(rooms) * th["void"] * rng.uniform(0.5, 1.6))) + (1 if rng.random() < 0.5 else 0)
        for r in small[:n_void]:
            r["kind"] = "void"
        for r in small[n_void:n_void + rng.randint(0, 2)]:
            r["kind"] = rng.choice(["stair", "stair", "spiral"]) if diff >= 3 else "stair"
        for r in small[n_void + 2:n_void + 2 + rng.randint(0, 2)]:
            r["kind"] = "toilet"
        if th["furn"] in ("industrial",) and rooms:
            big = sorted(rooms, key=lambda r: -r["poly"].area)
            for r in big[1:1 + rng.randint(0, 2)]:
                if r["poly"].area > 150:
                    r["kind"] = "void"          # big hatched block (mezzanine / electrical yard)
            for r in rooms:                     # stores drawn with very thick black walls
                if r["kind"] == "room" and r["poly"].area > 60 and rng.random() < 0.45:
                    r["heavy"] = True
        if th["furn"] == "retail" and rooms and rng.random() < 0.7:
            max(rooms, key=lambda r: r["poly"].area)["kind"] = "atrium"
        if th["furn"] == "office":
            for r in rooms:
                if r["kind"] == "room" and r["poly"].area > 120:
                    r["kind"] = "open"
        # lift cores: split one small room into a row of lift cars
        cand = [r for r in rooms if r["kind"] == "room" and 8 < r["poly"].area < 30]
        if cand and rng.random() < 0.55:
            core = rng.choice(cand)
            x0, y0, x1, y1 = core["poly"].bounds
            n = max(1, min(4, int((x1 - x0) // 2.2)))
            cells = []
            for k in range(n):
                cell = core["poly"].intersection(box(x0 + k * (x1 - x0) / n, y0, x0 + (k + 1) * (x1 - x0) / n,
                                                     min(y1, y0 + 2.4)))
                if cell.area > 2:
                    cells.append(cell)
            rest = core["poly"].difference(unary_union(cells)) if cells else core["poly"]
            if cells and parts(rest):
                rooms.remove(core)
                for c in cells:
                    rooms.append(dict(poly=c, kind="lift", name="LIFT", part=pi))
                for q in parts(rest):
                    if q.area > 1:
                        rooms.append(dict(poly=q, kind="corridor", name="LIFT LOBBY", part=pi))
        # circular / octagonal room inside a big room (curved walls with doors in them)
        bigr = [r for r in rooms if r["kind"] in ("room", "open") and r["poly"].area > 70]
        if bigr and rng.random() < 0.18 + 0.06 * diff:
            host = rng.choice(bigr)
            inner = host["poly"].buffer(-2.0)
            if not inner.is_empty:
                c = inner.representative_point()
                rr = min(rng.uniform(2.5, 7), math.sqrt(inner.area) * 0.35)
                circ = regular(c.x, c.y, rr, rng.choice([8, 64, 64, 6]), rng.uniform(0, 1))
                if inner.contains(circ):
                    host["poly"] = host["poly"].difference(circ)
                    rooms.append(dict(poly=circ, kind="auditorium" if th["furn"] == "school" else "room",
                                      name="", part=pi))
        if th["furn"] == "school":
            for r in rooms:
                if r["kind"] == "room" and r["poly"].area > 150 and rng.random() < 0.5:
                    r["kind"] = "auditorium"
        for r in rooms:
            r["name"] = r["name"] or (rng.choice(VOID_NAMES) if r["kind"] == "void" else
                                      "Stair" if r["kind"] in ("stair", "spiral") else
                                      "Toilet" if r["kind"] == "toilet" else
                                      "Corridor" if r["kind"] == "corridor" and rng.random() < 0.3 else
                                      rng.choice(furn_names) if r["kind"] != "corridor" else "")
        items = furnish(rooms, th, rng, diff)
        if ang:
            for r in rooms:
                r["poly"] = affinity.rotate(r["poly"], ang, origin=pivot)
            items = [(k, affinity.rotate(g, ang, origin=pivot), i) for k, g, i in items]
        plan.rooms += rooms
        plan.items += items
    plan.rooms = [r for r in plan.rooms if r["poly"].area > 0.8 and isinstance(r["poly"], Polygon)]
    add_columns(plan, th, rng)
    return plan


def place_openings(plan, rng, diff, th):
    """Doors on a spanning tree of the room adjacency (every room reachable), extra doors, entrances, windows."""
    polys = [r["poly"] for r in plan.rooms]
    tree = STRtree(polys)
    adj = {}
    for i, p in enumerate(polys):
        for j in tree.query(p.buffer(0.05)):
            j = int(j)
            if j <= i:
                continue
            # within 1 cm: rooms rotated back from a wing frame do not share bit-identical edges
            shared = linemerge(lines_of(p.boundary.intersection(polys[j].boundary.buffer(0.01, cap_style=2))))
            pieces = [s for s in lines_of(shared) if s.length > 0.85]
            if pieces:
                adj[(i, j)] = max(pieces, key=lambda s: s.length)
    taken = []

    def free(line, pad):
        return all(line.distance(t) > pad for t in taken)

    def cut(piece, width, exterior, style, rooms, relaxed=False):
        t = plan.t_cut
        margin = (t / 2 + 0.08) if relaxed else (max(t, 0.25) + 0.15)
        if relaxed and piece.length < width + 2 * margin:
            width = max(0.6, piece.length - 2 * margin)
        if piece.length < width + 2 * margin:
            return False
        for _ in range(6 if not relaxed else 12):
            d = rng.uniform(margin + width / 2, piece.length - margin - width / 2)
            seg = substring(piece, d - width / 2, d + width / 2)
            if seg.length < width * 0.9 or not free(seg, 0.25 if relaxed else 0.5):
                continue
            poly = seg.buffer(t / 2 + 0.03, cap_style=2)
            taken.append(seg)
            plan.doors.append(dict(line=seg, poly=poly, style=style, rooms=rooms, exterior=exterior,
                                   hinge=rng.random() < 0.5, side=rng.choice([-1, 1])))
            return True
        return False

    kinds = [r["kind"] for r in plan.rooms]
    nogo = {"void"}
    # spanning tree from the largest corridor / room
    start = max(range(len(polys)), key=lambda k: (kinds[k] not in nogo, kinds[k] == "corridor", polys[k].area)) if polys else 0
    seen, frontier = {start}, [start]
    edges = sorted(adj, key=lambda e: -adj[e].length)
    rng.shuffle(edges)
    changed = True
    while changed:
        changed = False
        for (i, j) in edges:
            if (i in seen) == (j in seen):
                continue
            new = j if i in seen else i
            if kinds[new] in nogo and rng.random() < 0.7:
                continue
            style = door_style(rng, th, kinds[i], kinds[j], diff)
            w = door_width(rng, style, th)
            if cut(adj[(i, j)], w, False, style, (i, j)):
                seen.add(new)
                changed = True
    ext_pieces = []
    coords = list(plan.footprint.exterior.coords)
    for a_, b_ in zip(coords, coords[1:]):
        seg_ = LineString([a_, b_])
        if seg_.length > 2.5:
            ext_pieces.append(seg_)
    rng.shuffle(ext_pieces)
    # facade wall of every room (where a door to the outside can go)
    room_ext = {}
    fp_ring = plan.footprint.exterior.buffer(0.02)
    for k, p in enumerate(polys):
        segs = [q for q in lines_of(linemerge(lines_of(p.exterior.intersection(fp_ring)))) if q.length > 0.9]
        if segs:
            room_ext[k] = max(segs, key=lambda q: q.length)
    # entrances: only into rooms joined to the main door network, at least one
    cand = [k for k in room_ext if k in seen and kinds[k] not in nogo]
    cand.sort(key=lambda k: (kinds[k] != "corridor", -room_ext[k].length))
    want, made = rng.randint(1, 3), 0
    for k in cand[:8]:
        if made >= want:
            break
        style = rng.choice(["roller", "double", "swing"]) if th["furn"] in ("industrial", "parking") else             rng.choice(["double", "swing", "sliding", "revolving" if diff >= 3 else "double"])
        w = rng.uniform(3, 6) if style == "roller" else rng.uniform(1.6, 2.4) if style in ("double", "revolving") else rng.uniform(0.9, 1.2)
        if cut(room_ext[k], w, True, style, (k, -1)) or cut(room_ext[k], 0.9, True, "swing", (k, -1), relaxed=True):
            made += 1
    # rooms the tree could not reach: a narrower door on any wall shared with a reached room,
    # else a door to the outside on the room's own facade wall
    progress, _round = True, 0
    while progress or _round < 2:
        progress = False
        _round += 1
        for k in range(len(polys)):
            if k in seen or kinds[k] in nogo:
                continue
            for (i, j), piece in sorted(adj.items(), key=lambda e: -e[1].length):
                if k not in (i, j) or ((j if i == k else i) not in seen):
                    continue
                style = rng.choice(["swing", "swing", "gap", "sliding"])
                if cut(piece, door_width(rng, style, th), False, style, (i, j), relaxed=True):
                    seen.add(k)
                    progress = True
                    break
            if k not in seen and k in room_ext and _round >= 2:
                if cut(room_ext[k], rng.uniform(0.8, 1.1), True, "swing", (k, -1), relaxed=True):
                    seen.add(k)
                    progress = True
        if _round > 40:
            break
    for (i, j), piece in adj.items():  # some extra doors (rooms with several entrances)
        if rng.random() < 0.12 and kinds[i] not in nogo and kinds[j] not in nogo:
            style = door_style(rng, th, kinds[i], kinds[j], diff)
            cut(piece, door_width(rng, style, th), False, style, (i, j))
    # windows on the facade
    wstyle = rng.choice(["lines3", "lines2", "line1", "filled", "lines3"])
    curtain = rng.random() < 0.08 * diff
    for s in ext_pieces:
        if curtain and s.length > 6 and rng.random() < 0.4:
            seg = substring(s, 0.6, s.length - 0.6)
            if free(seg, 0.3):
                taken.append(seg)
                plan.windows.append(dict(line=seg, poly=seg.buffer(plan.t_cut / 2 + 0.03, cap_style=2), style="curtain"))
            continue
        if rng.random() < 0.25:
            continue
        ww = rng.uniform(1.0, 2.6)
        pitch = ww + rng.uniform(0.8, 4.0)
        n = int((s.length - 1.2) // pitch)
        for k in range(n):
            d = 0.6 + pitch * (k + 0.5)
            seg = substring(s, d - ww / 2, d + ww / 2)
            if seg.length > 0.6 and free(seg, 0.3):
                taken.append(seg)
                plan.windows.append(dict(line=seg, poly=seg.buffer(plan.t_cut / 2 + 0.03, cap_style=2), style=wstyle))


def door_style(rng, th, ka, kb, diff):
    if "lift" in (ka, kb):
        return "sliding"
    opts = ["swing"] * 6 + ["double"] * 2 + ["sliding"] + ["gap"] * 2 + (["pocket", "folding"] if diff >= 3 else [])
    if th["furn"] in ("industrial",):
        opts += ["roller", "gap", "double"]
    return rng.choice(opts)


def door_width(rng, style, th):
    if style == "roller":
        return rng.uniform(3, 5)
    if style in ("double", "folding"):
        return rng.uniform(1.4, 2.0)
    if style == "gap":
        return rng.uniform(0.9, 2.4)
    return rng.uniform(0.8, 1.05)


def add_partials(plan, rng, diff):
    """Partition walls that do not close a room: some end freely in the room, some stop 0.15-0.4 m short of
    the opposite wall (they look joined but are not). They are walls, but they never split a room."""
    if diff < 2:
        return
    doors = [d["line"] for d in plan.doors]
    for r in plan.rooms:
        if r["kind"] not in ("room", "open", "hall") or r["poly"].area < 30 or rng.random() > 0.1 + 0.06 * diff:
            continue
        ring = r["poly"].exterior
        for _ in range(rng.randint(1, 2)):
            d = rng.uniform(0.15, 0.85) * ring.length
            p = ring.interpolate(d)
            q = ring.interpolate(min(ring.length, d + 0.05))
            ux, uy = q.x - p.x, q.y - p.y
            n = math.hypot(ux, uy) or 1.0
            nx, ny = -uy / n, ux / n
            if not r["poly"].contains(Point(p.x + nx * 0.3, p.y + ny * 0.3)):
                nx, ny = -nx, -ny
            if any(p.distance(dl) < 1.0 for dl in doors):
                continue
            ray = LineString([(p.x, p.y), (p.x + nx * 200, p.y + ny * 200)])
            hit = ray.intersection(r["poly"].buffer(-0.01))
            segs = [s for s in lines_of(hit) if s.length > 1.0]
            if not segs:
                continue
            span = min(segs, key=lambda s: Point(s.coords[0]).distance(p)).length
            if span < 2.5:
                continue
            if rng.random() < 0.4 and span < 9:
                L = span - rng.uniform(0.15, 0.4)        # near miss
            else:
                L = min(span * rng.uniform(0.25, 0.6), 5.0)  # free end
            pw = LineString([(p.x, p.y), (p.x + nx * L, p.y + ny * L)])
            if all(pw.distance(o) > 0.6 for o in plan.partials):
                plan.partials.append(pw)


def wall_geometry(plan, rng, diff):
    """Wall polygons (before openings) and the wall centre-lines."""
    t_e, t_i = plan.t_ext, plan.t_int
    core_kinds = {"void", "stair", "spiral", "lift"}
    ext_line = plan.footprint.exterior
    pieces = [ext_line.buffer(t_e / 2, join_style=2, mitre_limit=5)]
    for hole in plan.footprint.interiors:
        pieces.append(LineString(hole.coords).buffer(t_e / 2, join_style=2))
    centre = [ext_line] + [LineString(h.coords) for h in plan.footprint.interiors]
    var = plan.var
    heavy = []
    for r in plan.rooms:
        b = r["poly"].exterior
        t = t_e if r["kind"] in core_kinds and rng.random() < 0.6 else t_i
        if var:
            t *= rng.uniform(0.8, 1.6)
        if r.get("heavy"):
            t = plan.t_heavy
            heavy.append(b.buffer(t / 2, join_style=2, mitre_limit=5))
        pieces.append(b.buffer(t / 2, join_style=2, mitre_limit=5))
        centre.append(b)
    for pw in plan.partials:   # free-ending and near-miss partition walls
        pieces.append(pw.buffer(t_i / 2, cap_style=2, join_style=2))
        centre.append(pw)
    walls = unary_union(pieces)
    # nothing of a wall outside the building's outer face
    clip = plan.footprint.buffer(t_e / 2, join_style=2)
    walls = walls.intersection(clip)
    heavy = unary_union(heavy).intersection(clip) if heavy else Polygon()
    centre = unary_union(centre)
    return walls, centre, heavy


# ------------------------------------------------------------------ drawing
class Canvas:
    def __init__(self, W, H, ppm, ox, oy, bg):
        self.W, self.H, self.ppm, self.ox, self.oy = W, H, ppm, ox, oy
        self.img = np.empty((H, W, 3), np.uint8)
        self.img[:] = bg
        self.mask = np.zeros((H, W), np.uint8)
        self.lines = np.zeros((H, W), np.uint8)
        self.texts = []

    def g(self, geom):
        return affinity.affine_transform(geom, [self.ppm, 0, 0, self.ppm, -self.ox * self.ppm, -self.oy * self.ppm])

    def p(self, x, y):
        return ((x - self.ox) * self.ppm, (y - self.oy) * self.ppm)


def _ipts(coords):
    return np.round(np.asarray(coords, np.float64) * 16).astype(np.int32)


def _window(arr_shape, p, pad=2):
    x0, y0, x1, y1 = p.bounds
    H, W = arr_shape[:2]
    ix0, iy0 = max(int(math.floor(x0)) - pad, 0), max(int(math.floor(y0)) - pad, 0)
    ix1, iy1 = min(int(math.ceil(x1)) + pad, W), min(int(math.ceil(y1)) + pad, H)
    return ix0, iy0, ix1, iy1


def _poly_local(p, ix0, iy0, shape):
    sub = np.zeros(shape, np.uint8)
    off = np.array([ix0, iy0], np.float64)
    cv2.fillPoly(sub, [_ipts(np.asarray(p.exterior.coords) - off)], 255, cv2.LINE_8, 4)
    for r in p.interiors:
        cv2.fillPoly(sub, [_ipts(np.asarray(r.coords) - off)], 0, cv2.LINE_8, 4)
    return sub > 0


def fill_geom(arr, geom, val):
    """Sets every pixel inside the polygons (holes stay as they are) to `val`; works on masks and images."""
    for p in parts(geom):
        ix0, iy0, ix1, iy1 = _window(arr.shape, p)
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        sub = _poly_local(p, ix0, iy0, (iy1 - iy0, ix1 - ix0))
        arr[iy0:iy1, ix0:ix1][sub] = val


def region(shape, geom):
    m = np.zeros(shape[:2], bool)
    for p in parts(geom):
        ix0, iy0, ix1, iy1 = _window(shape, p)
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        m[iy0:iy1, ix0:ix1] |= _poly_local(p, ix0, iy0, (iy1 - iy0, ix1 - ix0))
    return m


def stroke(img, geom, col, lw, closed=True):
    lw = max(1, int(round(lw)))
    for p in parts(geom):
        for ring in [p.exterior, *p.interiors]:
            cv2.polylines(img, [_ipts(ring.coords)], True, col, lw, cv2.LINE_AA, 4)
    for l in lines_of(geom):
        cv2.polylines(img, [_ipts(l.coords)], False, col, lw, cv2.LINE_AA, 4)


def polyline(img, pts, col, lw, closed=False, dash=None):
    pts = np.asarray(pts, np.float64)
    lw = max(1, int(round(lw)))
    if dash is None:
        cv2.polylines(img, [_ipts(pts)], closed, col, lw, cv2.LINE_AA, 4)
        return
    on, off = dash
    seq = list(pts) + ([pts[0]] if closed else [])
    for a, b in zip(seq, seq[1:]):
        L = float(np.hypot(*(b - a)))
        if L < 1e-6:
            continue
        u = (b - a) / L
        t = 0.0
        while t < L:
            e = min(L, t + on)
            cv2.line(img, tuple(np.round((a + u * t) * 16).astype(int)), tuple(np.round((a + u * e) * 16).astype(int)),
                     col, lw, cv2.LINE_AA, 4)
            t += on + off


def pattern(img, where, kind, spacing, col, lw=1):
    ys, xs = np.nonzero(where)
    if not len(ys):
        return
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    yy, xx = np.mgrid[y0:y1, x0:x1]
    s = max(3, int(spacing))
    if kind == "diag":
        m = ((xx + yy) % s) < lw
    elif kind == "anti":
        m = ((xx - yy) % s) < lw
    elif kind == "cross":
        m = (((xx + yy) % s) < lw) | (((xx - yy) % s) < lw)
    elif kind == "dots":
        m = ((xx % s) < lw) & ((yy % s) < lw)
    elif kind == "grid":
        m = ((xx % s) < lw) | ((yy % s) < lw)
    elif kind == "hstripes":
        m = (yy % s) < lw
    elif kind == "vstripes":
        m = (xx % s) < lw
    else:  # solid
        m = np.ones_like(xx, bool)
    sub = where[y0:y1, x0:x1] & m
    img[y0:y1, x0:x1][sub] = col


def text(cv, x, y, s, size, col, angle=0.0, anchor="mm", box_col=None, fontp=None, bold=False, min_size=6.5):
    if size < min_size or not s:
        return
    cv.texts.append((x, y, s, size, col, angle, anchor, box_col, fontp))


def render_texts(cv, rng):
    if not cv.texts:
        return
    pil = Image.fromarray(cv.img[:, :, ::-1].copy())
    draw = ImageDraw.Draw(pil)
    for (x, y, s, size, col, angle, anchor, box_col, fontp) in cv.texts:
        f = font(fontp or rng.choice(rp.FONTS), size)
        rgb = (int(col[2]), int(col[1]), int(col[0]))
        if not angle:
            if box_col is not None:
                bb = draw.textbbox((x, y), s, font=f, anchor=anchor)
                draw.rectangle([bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2], fill=(int(box_col[2]), int(box_col[1]), int(box_col[0])))
            draw.text((x, y), s, fill=rgb, font=f, anchor=anchor)
        else:
            bb = draw.textbbox((0, 0), s, font=f, anchor="lt")
            tw, th = bb[2] - bb[0] + 4, bb[3] - bb[1] + 4
            tmp = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
            d2 = ImageDraw.Draw(tmp)
            if box_col is not None:
                d2.rectangle([0, 0, tw, th], fill=(int(box_col[2]), int(box_col[1]), int(box_col[0]), 255))
            d2.text((2 - bb[0], 2 - bb[1]), s, fill=rgb + (255,), font=f)
            tmp = tmp.rotate(angle, expand=True, resample=Image.BICUBIC)
            pil.paste(tmp, (int(x - tmp.width / 2), int(y - tmp.height / 2)), tmp)
    cv.img = np.asarray(pil)[:, :, ::-1].copy()
    cv.texts = []


def sheet_style(rng, theme, diff):
    mode = rng.choices(["white", "white", "white", "dark", "blueprint", "sepia", "grey"], [30, 20, 10, 10, 6, 6, 6])[0]
    if mode == "dark":
        bg, ink, faint = (20, 18, 16), (235, 235, 235), (90, 90, 90)
    elif mode == "blueprint":
        bg, ink, faint = (120, 60, 20), (250, 240, 230), (170, 120, 80)
    elif mode == "sepia":
        bg, ink, faint = (200, 225, 238), (40, 50, 70), (150, 165, 180)
    elif mode == "grey":
        bg, ink, faint = (235, 235, 235), (30, 30, 30), (170, 170, 170)
    else:
        bg, ink, faint = (255, 255, 255), (rng.randint(0, 40),) * 3, (190, 190, 190)
    walls = rng.choices(["solid", "outline", "outline_hatch", "poche", "thin", "material", "mixed", "cad_colour"],
                        [16, 14, 10, 8, 16, 10, 10, 26 if theme in ("rf_office", "cad_office", "industrial") else 10])[0]
    if theme == "schematic":
        walls = rng.choice(["thin", "thin", "outline", "solid"])
    if walls in ("material", "cad_colour") and mode not in ("white", "grey"):
        walls = "solid" if walls == "material" else "cad_colour"
    return dict(mode=mode, bg=bg, ink=ink, faint=faint, walls=walls,
                fills=rng.random() < (0.35 if mode == "white" else 0.1),
                lw=rng.choice([1, 1, 1, 2]))


def draw_plan(plan, rng, np_rng, theme, diff):
    th = THEMES[theme]
    st = sheet_style(rng, theme, diff)
    x0, y0, x1, y1 = plan.footprint.bounds
    bw, bh = x1 - x0, y1 - y0
    mx = [rng.uniform(0.04, 0.22) * max(bw, bh) for _ in range(4)]
    cw_m, ch_m = bw + mx[0] + mx[2], bh + mx[1] + mx[3]
    # real plans arrive small: a 70-190 m building in 1,000-1,600 px is common (walls 1-2 px)
    target = rng.choices([rng.uniform(650, 1150), rng.uniform(1150, 1700), rng.uniform(1700, MAX_SIDE)],
                         [35, 40, 25])[0]
    ppm = target / max(cw_m, ch_m)
    W, H = int(cw_m * ppm), int(ch_m * ppm)
    cv = Canvas(W, H, ppm, x0 - mx[0], y0 - mx[1], st["bg"])
    ink, faint, bg = st["ink"], st["faint"], st["bg"]
    lw = max(1, st["lw"] if ppm > 12 else 1)

    # make walls visible at this scale (real small-scale drawings draw them 1-2 px)
    min_t = 1.6 / ppm
    plan.t_int = max(plan.t_int, min_t)
    plan.t_ext = max(plan.t_ext, min_t * 1.4)
    if st["walls"] == "thin":
        plan.t_int = plan.t_ext = max(1.6, lw + 1.0) / ppm
    plan.var = diff >= 3 and rng.random() < 0.5
    plan.t_heavy = max(rng.uniform(0.5, 1.1), 3.0 / ppm)
    has_heavy = any(r.get("heavy") for r in plan.rooms)
    plan.t_cut = max(plan.t_ext, plan.t_int * (1.6 if plan.var else 1.0), plan.t_heavy if has_heavy else 0) * 1.05
    place_openings(plan, rng, diff, th)
    add_partials(plan, rng, diff)
    walls, centre, heavy = wall_geometry(plan, rng, diff)
    gaps = unary_union([d["poly"] for d in plan.doors] + [w["poly"] for w in plan.windows])
    door_area = unary_union([d["poly"] for d in plan.doors]).intersection(walls)
    win_area = unary_union([w["poly"] for w in plan.windows]).intersection(walls)
    walls_cut = walls.difference(gaps)
    centre_cut = centre.difference(gaps.buffer(0.01))

    shape = (H, W)
    G = cv.g
    # ---- site around the building (hard negatives on background)
    if rng.random() < 0.35 + 0.08 * diff:
        draw_site(cv, plan, rng, st)
    # ---- floor, fills, voids
    fp = G(plan.footprint)
    fill_geom(cv.mask, fp, FLOOR)
    dept = [(230, 240, 250), (220, 245, 225), (245, 228, 225), (240, 240, 210), (235, 225, 245), (215, 235, 240)]
    void_kind = rng.choice(["diag", "anti", "cross", "solid", "dots", "diag", "X"])
    for r in plan.rooms:
        pr = G(r["poly"])
        if r["kind"] in ("void", "atrium"):
            fill_geom(cv.mask, pr, VOID)
            reg = region(shape, pr)
            k = void_kind if r["kind"] == "void" else rng.choice(["solid", "solid", "diag"])
            if k == "X":
                b = pr.bounds
                polyline(cv.img, [(b[0], b[1]), (b[2], b[3])], ink, lw)
                polyline(cv.img, [(b[0], b[3]), (b[2], b[1])], ink, lw)
            elif k == "solid":
                cv.img[reg] = (215, 215, 215) if st["mode"] in ("white", "grey") else faint
            else:
                pattern(cv.img, reg, k, rng.uniform(4, 14) if ppm > 8 else rng.uniform(3, 6), ink, 1)
        elif st["fills"] and r["kind"] != "corridor":
            reg = region(shape, pr)
            cv.img[reg] = rng.choice(dept)
    # ---- MEP / ceiling layer (floor hard negatives)
    if rng.random() < th["mep"] * (0.5 + 0.15 * diff):
        draw_mep(cv, plan, rng, st)
    # ---- items: furniture, stairs, lifts, columns
    lab = np.zeros(shape, np.uint8)
    for kind, g, info in plan.items:
        draw_item(cv, lab, kind, g, info, rng, st, lw)
    keep = cv.mask == FLOOR
    cv.mask[keep & (lab > 0)] = lab[keep & (lab > 0)]
    # ---- walls
    wc = G(walls_cut)
    draw_walls(cv, wc, G(plan.footprint), rng, st, lw, plan)
    if not heavy.is_empty:   # thick black store walls, whatever the wall style
        fill_geom(cv.img, G(heavy.difference(gaps)), (10, 10, 10) if st["mode"] != "dark" else st["ink"])
    n_breaks = break_walls(cv, G(centre_cut), plan, rng, st, diff)
    fill_geom(cv.mask, wc, WALL)
    fill_geom(cv.mask, G(door_area), DOOR)
    fill_geom(cv.mask, G(win_area), WINDOW)
    for kind, g, info in plan.items:      # columns win over walls
        if kind == "column":
            fill_geom(cv.mask, G(g), COLUMN)
    # ---- openings
    for d in plan.doors:
        draw_door(cv, d, rng, st, lw, plan)
    for wdw in plan.windows:
        draw_window(cv, wdw, st, lw, plan)
    # ---- centre-lines
    lt = 1 if plan.t_int * ppm < 6 else 2
    for l in lines_of(G(centre_cut)):
        cv2.polylines(cv.lines, [_ipts(l.coords)], False, 255, lt, cv2.LINE_8, 4)
    cv.lines[cv.mask != WALL] = 0
    # ---- annotations and overlays
    draw_labels(cv, plan, rng, st, theme)
    if rng.random() < 0.45 + 0.1 * diff:
        draw_dimensions(cv, plan, rng, st)
    if rng.random() < 0.15 + 0.08 * diff:
        draw_grid_lines(cv, plan, rng, st)
    if rng.random() < th["rf"]:
        draw_rf(cv, plan, rng, st, diff, walls_cut)
    if theme == "industrial" or rng.random() < 0.1:
        gw = rng.choice(["<<---- 4 M Gang Way ---->>", "<<--4 M Gang Way-->>", "<<--3M Material Gang Way-->>"])
        for kind, g, info in plan.items:
            if kind == "gangway":
                a, b = G(g).coords[0], G(g).coords[-1]
                L = math.hypot(b[0] - a[0], b[1] - a[1])
                vert = abs(b[0] - a[0]) < abs(b[1] - a[1])
                for t in np.arange(0.15, 1.0, max(0.25, 18 * ppm / max(L, 1))):
                    x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                    text(cv, x, y, gw, max(6.5, 0.6 * ppm), ink, angle=90 if vert else 0)
    if rng.random() < 0.25 + 0.1 * diff:
        draw_zones(cv, plan, rng, st)
    if rng.random() < 0.35 + 0.12 * diff:
        draw_clutter(cv, plan, rng, st, diff)
    if theme == "schematic" or rng.random() < 0.1:
        draw_arrows(cv, plan, rng, st)
    draw_sheet(cv, plan, rng, st, diff)
    render_texts(cv, rng)
    if rng.random() < 0.06 * diff:
        draw_watermark(cv, rng, st)
    gt = dict(
        rooms=[dict(kind=r["kind"], name=r["name"], polygon=[[round(x, 1), round(y, 1)] for x, y in G(r["poly"]).exterior.coords])
               for r in plan.rooms],
        doors=[dict(style=d["style"], rooms=d["rooms"], exterior=d["exterior"],
                    line=[[round(x, 1), round(y, 1)] for x, y in G(d["line"]).coords]) for d in plan.doors],
        windows=[dict(style=w["style"], line=[[round(x, 1), round(y, 1)] for x, y in G(w["line"]).coords])
                 for w in plan.windows],
        wall_lines=[[[round(x, 1), round(y, 1)] for x, y in l.coords] for l in lines_of(G(centre_cut))],
    )
    meta = dict(kind="hard", theme=theme, difficulty=diff, style=dict(mode=st["mode"], walls=st["walls"], fills=st["fills"],
                void=void_kind), px_per_m=round(ppm, 3), wall_px=round(plan.t_int * ppm, 2),
                ext_wall_px=round(plan.t_ext * ppm, 2), rooms=len(plan.rooms), doors=len(plan.doors),
                windows=len(plan.windows), partial_walls=len(plan.partials), drawn_breaks=n_breaks,
                dim_conflict=bool(st.get("dim_conflict")))
    return cv.img, cv.mask, cv.lines, meta, gt


def plan_diff(plan):
    return getattr(plan, "diff", 3)


def break_walls(cv, centre_px, plan, rng, st, diff):
    """Deliberate 1-3 px breaks in the DRAWN walls (scan dropouts, CAD gaps, faded joints). The label stays
    wall: the model must learn that a wall continues through a small gap."""
    if diff < 2 or rng.random() > 0.25 + 0.12 * diff:
        return 0
    segs = [l for l in lines_of(centre_px) if l.length > 12]
    if not segs:
        return 0
    n = rng.randint(3, 6 * diff)
    t = max(plan.t_int, plan.t_ext) * cv.ppm
    done = 0
    for _ in range(n):
        l = rng.choice(segs)
        d = rng.uniform(4, l.length - 4)
        p, q = l.interpolate(d), l.interpolate(min(l.length, d + 1.0))
        ux, uy = q.x - p.x, q.y - p.y
        m = math.hypot(ux, uy) or 1.0
        ux, uy = ux / m, uy / m
        g = rng.uniform(1.0, 3.0) / 2
        h = t / 2 + 1.5
        pts = [(p.x - ux * g - uy * h, p.y - uy * g + ux * h), (p.x + ux * g - uy * h, p.y + uy * g + ux * h),
               (p.x + ux * g + uy * h, p.y + uy * g - ux * h), (p.x - ux * g + uy * h, p.y - uy * g - ux * h)]
        cv2.fillPoly(cv.img, [_ipts(pts)], st["bg"], cv2.LINE_8, 4)
        done += 1
    return done


def draw_walls(cv, wc, fp, rng, st, lw, plan):
    img, ink = cv.img, st["ink"]
    reg = region(img.shape[:2], wc)
    mode = st["walls"]
    if mode == "solid":
        col = ink if rng.random() < 0.7 else rng.choice([(200, 190, 40), (120, 120, 120), (60, 60, 60), (40, 40, 160)])
        img[reg] = col
    elif mode in ("outline", "outline_hatch"):
        img[reg] = st["bg"]
        if mode == "outline_hatch":
            pattern(img, reg, rng.choice(["diag", "anti", "cross"]), rng.uniform(3, 7), ink, 1)
        stroke(img, wc, ink, lw)
    elif mode == "poche":
        img[reg] = (150, 150, 150) if st["mode"] in ("white", "grey", "sepia") else st["faint"]
        stroke(img, wc, ink, lw)
    elif mode == "thin":
        img[reg] = rng.choice([ink, ink, (110, 110, 40), (120, 60, 20)])
    elif mode == "cad_colour":
        # CAD export: exterior and cores as cyan / teal double lines, partitions thin grey or dark
        ext_col = rng.choice([(210, 200, 0), (200, 170, 0), (180, 180, 40), (220, 120, 0)])
        part_col = rng.choice([(120, 120, 120), (60, 60, 60), (150, 110, 60), (90, 90, 160)])
        ext = reg & region(img.shape[:2], fp.exterior.buffer(plan.t_ext * cv.ppm))
        img[reg] = part_col if rng.random() < 0.6 else st["bg"]
        if rng.random() < 0.5:
            img[ext] = ext_col
        else:
            img[ext] = st["bg"]
        stroke(img, wc, part_col, 1)
        ys, xs = np.nonzero(ext)
        if len(ys):
            sub = np.zeros(img.shape[:2], np.uint8)
            sub[ext] = 255
            edges = cv2.morphologyEx(sub, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
            img[edges & ext] = ext_col
    elif mode == "material":
        heavy = (230, 230, 0) if rng.random() < 0.6 else (60, 60, 60)
        ext = reg & region(img.shape[:2], fp.exterior.buffer(plan.t_ext * cv.ppm))
        img[reg] = (150, 150, 150)
        img[ext] = heavy
        stroke(img, wc, (40, 40, 40), 1)
    else:  # mixed: heavy exterior, outlined interior
        ext = reg & region(img.shape[:2], fp.exterior.buffer(plan.t_ext * cv.ppm * 0.75))
        img[reg] = st["bg"]
        stroke(img, wc, ink, lw)
        img[ext] = ink


def draw_item(cv, lab, kind, g, info, rng, st, lw):
    G, img, ink = cv.g, cv.img, st["ink"]
    gp = G(g)
    if kind == "column":
        col = rng.choice([ink, ink, (60, 120, 230), (130, 130, 130)])
        fill_geom(img, gp, col)
        return
    if kind == "stairs":
        fill_geom(lab, gp, STAIRS)
        b = gp.bounds
        stroke(img, gp, ink, lw)
        step = max(2.5, info["tread"] * cv.ppm)
        if info["vertical"]:
            for y in np.arange(b[1] + step, b[3], step):
                polyline(img, [(b[0], y), (b[2], y)], ink, 1)
            polyline(img, [((b[0] + b[2]) / 2, b[1]), ((b[0] + b[2]) / 2, b[3])], ink, 1)
        else:
            for x in np.arange(b[0] + step, b[2], step):
                polyline(img, [(x, b[1]), (x, b[3])], ink, 1)
            polyline(img, [(b[0], (b[1] + b[3]) / 2), (b[2], (b[1] + b[3]) / 2)], ink, 1)
        return
    if kind == "spiral":
        fill_geom(lab, gp, STAIRS)
        c = gp.centroid
        r = math.sqrt(gp.area / math.pi)
        cv2.circle(img, (int(c.x), int(c.y)), int(r), ink, 1, cv2.LINE_AA)
        cv2.circle(img, (int(c.x), int(c.y)), max(1, int(r * 0.2)), ink, 1, cv2.LINE_AA)
        for a in np.linspace(0, 2 * math.pi, info["n"], endpoint=False):
            polyline(img, [(c.x + r * 0.2 * math.cos(a), c.y + r * 0.2 * math.sin(a)),
                           (c.x + r * math.cos(a), c.y + r * math.sin(a))], ink, 1)
        return
    if kind == "lift":
        b = gp.bounds
        stroke(img, gp, ink, 1)
        polyline(img, [(b[0], b[1]), (b[2], b[3])], ink, 1)
        polyline(img, [(b[0], b[3]), (b[2], b[1])], ink, 1)
        return
    if kind == "gangway":
        polyline(img, list(gp.coords), ink, 1, dash=(8, 6))
        return
    cls = {"desk": DESK, "chair": CHAIR, "plant": PLANT}.get(kind, 0)
    if cls:
        fill_geom(lab, gp, cls)
    if kind == "desk":
        dstyle = info.get("style", "rect")
        if st.get("desk_fill") is None:
            st["desk_fill"] = rng.choice([st["bg"], st["bg"], (225, 225, 225), (210, 225, 235)])
            st["desk_ink"] = rng.choice([ink, ink, (90, 90, 90), (60, 60, 60)])
        fill_geom(img, gp, st["desk_fill"])
        stroke(img, gp, st["desk_ink"], 1)
        b = gp.bounds
        if dstyle == "L":   # return wing of an L desk
            w_, h_ = b[2] - b[0], b[3] - b[1]
            if info.get("vertical"):
                polyline(img, [(b[0], b[1] + h_ * 0.7), (b[2], b[1] + h_ * 0.7)], st["desk_ink"], 1)
            else:
                polyline(img, [(b[0] + w_ * 0.7, b[1]), (b[0] + w_ * 0.7, b[3])], st["desk_ink"], 1)
        elif dstyle == "bench":   # monitor line along the desk
            c = gp.centroid
            if info.get("vertical"):
                polyline(img, [(c.x, b[1] + 2), (c.x, b[3] - 2)], st["desk_ink"], 1)
            else:
                polyline(img, [(b[0] + 2, c.y), (b[2] - 2, c.y)], st["desk_ink"], 1)
    elif kind == "chair":
        c = gp.centroid
        r = math.sqrt(gp.area / math.pi)
        if r < 2.2:
            cv2.circle(img, (int(c.x), int(c.y)), max(1, int(round(r))), st.get("desk_ink", ink), -1, cv2.LINE_AA)
        else:
            cv2.circle(img, (int(c.x), int(c.y)), int(r), st.get("desk_ink", ink), 1, cv2.LINE_AA)
            if rng.random() < 0.5:   # chair back
                cv2.line(img, (int(c.x - r), int(c.y + r)), (int(c.x + r), int(c.y + r)), st.get("desk_ink", ink), 1, cv2.LINE_AA)
    elif kind == "divider":
        polyline(img, list(gp.coords), st.get("desk_ink", ink), 1)
    elif kind == "cabinet":
        fill_geom(img, gp, rng.choice([ink, (80, 80, 80), (150, 150, 150)]))
    elif kind == "assembly":
        a, b2 = np.array(G(info["spine"]).coords[0]), np.array(G(info["spine"]).coords[-1])
        r = info["r"] * cv.ppm
        tr = info["track"] * cv.ppm
        for rad in (r, max(2, r - tr)):
            loop = LineString([tuple(a), tuple(b2)]).buffer(rad, 32)
            stroke(img, loop, ink, 1)
        # stations: small cyan squares along both straights, rows of small boxes inside
        u = (b2 - a) / (np.hypot(*(b2 - a)) + 1e-9)
        n = np.array([-u[1], u[0]])
        L = float(np.hypot(*(b2 - a)))
        cyan = rng.choice([(220, 210, 0), (200, 200, 40), (230, 180, 0)])
        s = max(2, cv.ppm * rng.uniform(0.35, 0.6))
        for t in np.arange(0, L, max(4, info["pitch"] * cv.ppm)):
            for side in (-1, 1):
                p = a + u * t + n * side * (r - tr / 2)
                cv2.rectangle(img, (int(p[0] - s / 2), int(p[1] - s / 2)), (int(p[0] + s / 2), int(p[1] + s / 2)), cyan, -1)
                cv2.rectangle(img, (int(p[0] - s / 2), int(p[1] - s / 2)), (int(p[0] + s / 2), int(p[1] + s / 2)), ink, 1)
        for row in range(info["n_rows"]):
            off = (row + 1) / (info["n_rows"] + 1) * 2 - 1
            for t in np.arange(0, L, max(5, cv.ppm * rng.uniform(1.5, 3))):
                p = a + u * t + n * off * (r - tr) * 0.6
                q = p + u * cv.ppm * 0.9
                polyline(img, [p, q], ink, 1)
                cv2.rectangle(img, (int(p[0]), int(p[1] - 2)), (int(p[0] + 3), int(p[1] + 2)), ink, 1)
        # the dashed coloured zone box drawn around such lines, and an arc at one end
        zb = LineString([tuple(a), tuple(b2)]).buffer(r + cv.ppm * rng.uniform(1, 3), cap_style=3)
        polyline(img, list(zb.exterior.coords), rng.choice([(0, 140, 255), (0, 180, 230), (40, 40, 200)]), 1, dash=(9, 4))
        cv2.ellipse(img, (int(a[0]), int(a[1])), (int(r * 1.35), int(r * 1.35)), 0, 120, 240, (40, 40, 220), 1, cv2.LINE_AA)
    elif kind == "plant":
        fill_geom(img, gp, (60, 160, 60))
    elif kind == "rack":
        stroke(img, gp, ink, 1)
        b = gp.bounds
        n = max(2, int((b[3] - b[1] if info.get("vertical") else b[2] - b[0]) / max(cv.ppm * 2.7, 4)))
        for k in range(1, n):
            if info.get("vertical"):
                y = b[1] + (b[3] - b[1]) * k / n
                polyline(img, [(b[0], y), (b[2], y)], ink, 1)
            else:
                x = b[0] + (b[2] - b[0]) * k / n
                polyline(img, [(x, b[1]), (x, b[3])], ink, 1)
    elif kind == "conveyor":
        stroke(img, gp, ink, 1)
        inner = gp.buffer(-info["width"] * cv.ppm)
        stroke(img, inner, ink, 1)
        b = gp.bounds
        for x in np.arange(b[0], b[2], max(6, cv.ppm * 1.2)):
            polyline(img, [(x, b[1]), (x, b[1] + info["width"] * cv.ppm)], ink, 1)
    elif kind == "machine":
        stroke(img, gp, ink, 1)
        c = gp.centroid
        cv2.circle(img, (int(c.x), int(c.y)), max(2, int(math.sqrt(gp.area) * 0.25)), ink, 1, cv2.LINE_AA)
    elif kind == "bed":
        stroke(img, gp, ink, 1)
        b = gp.bounds
        polyline(img, [(b[0], b[1] + (b[3] - b[1]) * 0.22), (b[2], b[1] + (b[3] - b[1]) * 0.22)], ink, 1)
    elif kind == "wc":
        b = gp.bounds
        stroke(img, gp, ink, 1)
        cv2.ellipse(img, (int((b[0] + b[2]) / 2), int(b[3])), (max(1, int((b[2] - b[0]) / 2)), max(1, int((b[3] - b[1]) * 0.5))),
                    0, 0, 180, ink, 1, cv2.LINE_AA)
    elif kind == "shelf":
        stroke(img, gp, ink, 1)
    elif kind == "bay":
        b = gp.bounds
        polyline(img, [(b[0], b[1]), (b[0], b[3])], ink, 1)
        polyline(img, [(b[2], b[1]), (b[2], b[3])], ink, 1)
        if info.get("car"):
            stroke(img, gp.buffer(-0.3 * cv.ppm), ink, 1)


def draw_door(cv, d, rng, st, lw, plan):
    img, ink = cv.img, st["ink"]
    a = np.array(cv.p(*d["line"].coords[0]))
    b = np.array(cv.p(*d["line"].coords[-1]))
    L = float(np.hypot(*(b - a)))
    if L < 2:
        return
    u = (b - a) / L
    n = np.array([-u[1], u[0]]) * d["side"]
    t = (plan.t_ext if d["exterior"] else plan.t_int) * cv.ppm
    s = d["style"]
    if d["hinge"]:
        a, b, u = b, a, -u
    if s == "swing":
        tip = a + n * L
        polyline(img, [a, tip], ink, lw)
        ang0 = math.degrees(math.atan2(u[1], u[0]))
        ang1 = math.degrees(math.atan2(n[1], n[0]))
        span = ((ang1 - ang0 + 180) % 360) - 180
        cv2.ellipse(img, (int(a[0]), int(a[1])), (int(L), int(L)), ang0, 0, span, ink, 1, cv2.LINE_AA)
    elif s == "double":
        m = (a + b) / 2
        h = L / 2
        for p0, uu in ((a, u), (b, -u)):
            tip = p0 + n * h
            polyline(img, [p0, tip], ink, lw)
            a0 = math.degrees(math.atan2(uu[1], uu[0]))
            a1 = math.degrees(math.atan2(n[1], n[0]))
            cv2.ellipse(img, (int(p0[0]), int(p0[1])), (int(h), int(h)), a0, 0, ((a1 - a0 + 180) % 360) - 180, ink, 1, cv2.LINE_AA)
    elif s in ("sliding", "pocket"):
        off = n * max(1.5, t * 0.25)
        polyline(img, [a + off, a + off + u * L * 0.6], ink, lw)
        polyline(img, [b - off, b - off - u * L * 0.6], ink, lw)
    elif s == "folding":
        m = (a + b) / 2
        for p0, q in ((a, a + u * L * 0.25 + n * L * 0.2), (m, m - u * L * 0.25 + n * L * 0.2)):
            polyline(img, [p0, q, p0 + u * L * 0.5 if p0 is a else m - u * L * 0.5], ink, 1)
    elif s == "roller":
        polyline(img, [a, b], ink, 1, dash=(6, 4))
    elif s == "revolving":
        c = (a + b) / 2
        cv2.circle(img, (int(c[0]), int(c[1])), int(L / 2), ink, 1, cv2.LINE_AA)
        polyline(img, [c - u * L / 2, c + u * L / 2], ink, 1)
        polyline(img, [c - n * L / 2, c + n * L / 2], ink, 1)
    # "gap": nothing drawn, an opening only


def draw_window(cv, w, st, lw, plan):
    img, ink = cv.img, st["ink"]
    a = np.array(cv.p(*w["line"].coords[0]))
    b = np.array(cv.p(*w["line"].coords[-1]))
    L = float(np.hypot(*(b - a)))
    if L < 2:
        return
    u = (b - a) / L
    n = np.array([-u[1], u[0]])
    t = plan.t_ext * cv.ppm
    s = w["style"]
    if s == "filled":
        fill_geom(img, cv.g(w["poly"]).intersection(cv.g(plan.footprint).buffer(t / 2)), (235, 215, 170))
    offs = {"lines3": (-0.35, 0, 0.35), "lines2": (-0.2, 0.2), "line1": (0,), "filled": (-0.45, 0.45),
            "curtain": (-0.2, 0.2)}[s]
    for o in offs:
        polyline(img, [a + n * o * t, b + n * o * t], ink, 1)
    for e in (a, b):
        polyline(img, [e - n * t / 2, e + n * t / 2], ink, 1)
    if s == "curtain":
        for x in np.arange(0, L, max(6, cv.ppm * 1.5)):
            p = a + u * x
            polyline(img, [p - n * t / 2, p + n * t / 2], ink, 1)


def draw_labels(cv, plan, rng, st, theme):
    ink = st["ink"]
    ppm = cv.ppm
    fp = rng.choice(rp.FONTS)
    hi = theme == "schematic" or rng.random() < 0.15
    for r in plan.rooms:
        if not r["name"] or rng.random() < 0.15:
            continue
        p = r["poly"].representative_point()
        x, y = cv.p(p.x, p.y)
        b = r["poly"].bounds
        size = min(max(0.35, min(b[2] - b[0], b[3] - b[1]) * 0.09), 1.2) * ppm * rng.uniform(0.8, 1.3)
        size = max(size, 7)
        angle = 90 if (b[3] - b[1]) > 2.2 * (b[2] - b[0]) and rng.random() < 0.6 else 0
        col = ink if rng.random() < 0.7 else rng.choice([(40, 60, 160), (30, 30, 200), (120, 60, 20)])
        box_col = (0, 255, 255) if hi and rng.random() < 0.5 else None
        text(cv, x, y, r["name"], size, col, angle, box_col=box_col, fontp=fp)
        if rng.random() < 0.35 and r["kind"] not in ("corridor", "lift"):
            w, h = b[2] - b[0], b[3] - b[1]
            s2 = rng.choice([f"{w:.0f} x {h:.0f}m", f"{r['poly'].area:.0f} SQM", f"{r['poly'].area:.1f} m²",
                             f"{w * 3.28:.0f}'-0\" x {h * 3.28:.0f}'-0\""])
            text(cv, x, y + size * 1.3 if not angle else y, s2, size * 0.75, col, angle, fontp=fp)


def draw_dimensions(cv, plan, rng, st):
    ink = st["ink"] if rng.random() < 0.6 else rng.choice([(160, 80, 40), (60, 60, 200), (120, 120, 120)])
    x0, y0, x1, y1 = plan.footprint.bounds
    off = rng.uniform(1.5, 4)
    xs = sorted({round(x, 1) for x, _ in plan.footprint.exterior.coords})
    ys = sorted({round(y, 1) for _, y in plan.footprint.exterior.coords})
    size = max(7, cv.ppm * rng.uniform(0.5, 1.0))
    unit = rng.choice(["m", "", "mm", "ft"])

    wrong = rng.random() < 0.05 + 0.04 * plan_diff(plan)

    def fmt(v):
        if wrong and rng.random() < 0.3:   # printed value that disagrees with the drawing
            v *= rng.choice([0.5, 0.8, 1.25, 2.0, 10.0])
            st["dim_conflict"] = True
        return {"m": f"{v:.2f} m", "": f"{v:.2f}", "mm": f"{v * 1000:.0f}", "ft": f"{v * 3.28:.0f}'-{(v * 39.37) % 12:.0f}\""}[unit]
    yline = y0 - off
    for a, b in zip(xs, xs[1:]):
        if b - a < 1:
            continue
        pa, pb = cv.p(a, yline), cv.p(b, yline)
        polyline(cv.img, [pa, pb], ink, 1)
        for pp in (pa, pb):
            polyline(cv.img, [(pp[0] - 4, pp[1] + 4), (pp[0] + 4, pp[1] - 4)], ink, 1)
        text(cv, (pa[0] + pb[0]) / 2, pa[1] - size * 0.7, fmt(b - a), size, ink)
    xline = x0 - off
    for a, b in zip(ys, ys[1:]):
        if b - a < 1:
            continue
        pa, pb = cv.p(xline, a), cv.p(xline, b)
        polyline(cv.img, [pa, pb], ink, 1)
        text(cv, pa[0] - size * 0.8, (pa[1] + pb[1]) / 2, fmt(b - a), size, ink, angle=90)
    # overall size, like "190.00 m"
    if rng.random() < 0.7:
        yy = y1 + off * rng.uniform(1.2, 2.5)
        pa, pb = cv.p(x0, yy), cv.p(x1, yy)
        polyline(cv.img, [pa, pb], ink, 1)
        for pp in (pa, pb):
            polyline(cv.img, [(pp[0], pp[1] - 6), (pp[0], pp[1] + 6)], ink, 1)
        text(cv, (pa[0] + pb[0]) / 2, pa[1] + size * 1.2, f"{x1 - x0:.2f} m", size * 1.4, ink)
    # a dimension line drawn across the plan (crosses walls)
    if rng.random() < 0.35:
        y = rng.uniform(y0, y1)
        pa, pb = cv.p(x0 + 1, y), cv.p(x1 - 1, y)
        polyline(cv.img, [pa, pb], ink, 1)
        text(cv, (pa[0] + pb[0]) / 2, pa[1] - size * 0.7, fmt(x1 - x0 - 2), size, ink)


def draw_grid_lines(cv, plan, rng, st):
    col = rng.choice([(80, 80, 200), (150, 150, 150), st["faint"]])
    x0, y0, x1, y1 = plan.footprint.bounds
    s = rng.choice([6, 7.5, 8, 9])
    r = max(6, cv.ppm * 0.6)
    for k, x in enumerate(np.arange(x0, x1 + 0.01, s)):
        pa, pb = cv.p(x, y0 - 2), cv.p(x, y1 + 0.5)
        polyline(cv.img, [pa, pb], col, 1, dash=(14, 4))
        cv2.circle(cv.img, (int(pa[0]), int(pa[1] - r)), int(r), col, 1, cv2.LINE_AA)
        text(cv, pa[0], pa[1] - r, string.ascii_uppercase[k % 26], r * 1.1, col)
    for k, y in enumerate(np.arange(y0, y1 + 0.01, s)):
        pa, pb = cv.p(x0 - 2, y), cv.p(x1 + 0.5, y)
        polyline(cv.img, [pa, pb], col, 1, dash=(14, 4))
        cv2.circle(cv.img, (int(pa[0] - r), int(pa[1])), int(r), col, 1, cv2.LINE_AA)
        text(cv, pa[0] - r, pa[1], str(k + 1), r * 1.1, col)


def ap_icon(cv, x, y, r, kind, col):
    img = cv.img
    xi, yi, ri = int(x), int(y), max(3, int(r))
    if kind == "bowtie":
        cv2.circle(img, (xi, yi), ri, (40, 40, 220), -1, cv2.LINE_AA)
        cv2.circle(img, (xi, yi), ri, (255, 255, 255), 1, cv2.LINE_AA)
        tri = np.array([[xi - ri * 0.6, yi - ri * 0.6], [xi + ri * 0.6, yi - ri * 0.6], [xi, yi]], np.float64)
        cv2.fillPoly(img, [_ipts(tri)], (255, 255, 255), cv2.LINE_AA, 4)
        tri2 = np.array([[xi - ri * 0.6, yi + ri * 0.6], [xi + ri * 0.6, yi + ri * 0.6], [xi, yi]], np.float64)
        cv2.fillPoly(img, [_ipts(tri2)], (255, 255, 255), cv2.LINE_AA, 4)
    elif kind == "smallcell":
        cv2.circle(img, (xi, yi), ri, (255, 255, 255), -1, cv2.LINE_AA)
        cv2.circle(img, (xi, yi), ri, (140, 60, 20), max(1, ri // 5), cv2.LINE_AA)
        for k in (-1, 0, 1):
            cv2.ellipse(img, (xi, yi + k * ri // 3), (ri // 2, max(1, ri // 6)), 0, 180, 360, (140, 60, 20), max(1, ri // 6), cv2.LINE_AA)
    elif kind == "wifi":
        for k in (1, 2, 3):
            cv2.ellipse(img, (xi, yi + ri // 2), (ri * k // 3, ri * k // 3), 0, 220, 320, col, max(1, ri // 6), cv2.LINE_AA)
        cv2.circle(img, (xi, yi + ri // 2), max(1, ri // 6), col, -1, cv2.LINE_AA)
    else:  # square AP
        cv2.rectangle(img, (xi - ri, yi - ri), (xi + ri, yi + ri), col, -1, cv2.LINE_AA)
        cv2.circle(img, (xi, yi), max(1, ri // 3), (255, 255, 255), -1, cv2.LINE_AA)


def draw_rf(cv, plan, rng, st, diff, walls_cut):
    """Antenna / small-cell icons (class 6), ANT / SPT / sector labels and cable runs that hug and cross walls."""
    floor = [r for r in plan.rooms if r["kind"] not in ("void", "lift")]
    if not floor:
        return
    area = plan.footprint.area
    n = int(np.clip(area / rng.uniform(60, 300) * (0.7 + 0.15 * diff), 3, 45))
    kind = rng.choice(["bowtie", "bowtie", "bowtie", "smallcell", "wifi", "square"])
    r = max(4, cv.ppm * rng.uniform(0.3, 0.75))
    col = rng.choice([(40, 40, 220), (40, 40, 220), (180, 60, 160), (140, 60, 20)])
    # labels as large as on real RF exports: often taller than a desk row
    lab_size = max(7, cv.ppm * rng.uniform(0.7, 1.8))
    lab_col = rng.choice([(20, 50, 170), (30, 60, 190), (40, 40, 200), (60, 60, 60), (120, 60, 20)])
    cable_cols = rng.sample(CABLE_COLOURS, rng.randint(2, 4))
    clw = rng.choice([1, 1, 2, 2, 3])
    # corridor spines the cable trees follow (many cables run on top of corridor walls)
    spines = []
    for c in plan.rooms:
        if c["kind"] == "corridor":
            b = c["poly"].bounds
            if b[2] - b[0] >= b[3] - b[1]:
                spines.append(("h", cv.p(0, (b[1] + b[3]) / 2 + rng.choice([0, 0, -1, 1]) * (b[3] - b[1]) / 2)[1]))
            else:
                spines.append(("v", cv.p((b[0] + b[2]) / 2 + rng.choice([0, 0, -1, 1]) * (b[2] - b[0]) / 2, 0)[0]))
    hub_room = rng.choice(floor)
    hp = rand_point(hub_room["poly"], rng, inset=0.3)
    hub = np.array(cv.p(hp.x, hp.y))
    if rng.random() < 0.6:
        cv2.rectangle(cv.img, (int(hub[0] - r), int(hub[1] - r * 0.7)), (int(hub[0] + r), int(hub[1] + r * 0.7)), (0, 230, 255), -1)
        cv2.rectangle(cv.img, (int(hub[0] - r), int(hub[1] - r * 0.7)), (int(hub[0] + r), int(hub[1] + r * 0.7)), (30, 30, 220), 1)
        text(cv, hub[0], hub[1] - r * 2.2, rng.choice(["BBU 01", "BB1", "IDF", "RACK-1", "HEAD END"]), max(7, r * 1.1), (0, 0, 0),
             box_col=(0, 230, 255) if rng.random() < 0.5 else None)
    wall_ys = [c[1] for l in lines_of(walls_cut.boundary) for c in l.coords][:400]
    tmp = np.zeros(cv.mask.shape, np.uint8)
    for k in range(n):
        rr = rng.choice(floor)
        p = rand_point(rr["poly"], rng, inset=0.4)
        x, y = cv.p(p.x, p.y)
        # the cable: L-shaped run, often snapped onto a wall line
        ccol = rng.choice(cable_cols)
        if spines and rng.random() < 0.8:
            o, v = rng.choice(spines)
            if o == "h":
                pts = [hub, (hub[0], v), (x, v), (x, y)]
                sx, sy = x, v
            else:
                pts = [hub, (v, hub[1]), (v, y), (x, y)]
                sx, sy = v, y
        else:
            via_y = cv.p(0, rng.choice(wall_ys))[1] if wall_ys and rng.random() < 0.4 else hub[1]
            pts = [hub, (hub[0], via_y), (x, via_y), (x, y)]
            sx, sy = x, via_y
        polyline(cv.img, pts, ccol, clw, dash=(10, 5) if rng.random() < 0.15 else None)
        if rng.random() < 0.75:
            cv2.circle(cv.img, (int(sx), int(sy)), max(2, int(r * 0.35)), ccol, -1, cv2.LINE_AA)
            text(cv, sx + r * 1.2, sy - lab_size * 0.6, f"SPT{k + 1} ({rng.choice([3, 5, 7, 10, 15])}dB)" if rng.random() < 0.85
                 else f"SPT{k + 1} (3w)", lab_size * rng.uniform(0.8, 1.0), lab_col, anchor="lm")
        ap_icon(cv, x, y, r, kind, col)
        ri = int(max(3, r))
        if kind == "square":
            cv2.rectangle(tmp, (int(x) - ri, int(y) - ri), (int(x) + ri, int(y) + ri), 255, -1)
        elif kind == "wifi":
            cv2.circle(tmp, (int(x), int(y + ri // 2)), ri, 255, -1)
        else:
            cv2.circle(tmp, (int(x), int(y)), ri, 255, -1)
        lbl = rng.choice([f"ANT{k + 1}", f"ANT{k + 1}", f"AP{k + 1}", f"AP{k + 1} (3.5 GHz - 5G NR - Sector {k + 1})"])
        dx, dy = rng.choice([(0, 1), (0, -1), (1, 0), (-1, 0)])
        text(cv, x + dx * (r + lab_size * 1.6), y + dy * (r + lab_size * 0.7), lbl, lab_size, lab_col)
    keep = (tmp > 0) & (cv.mask == FLOOR)
    cv.mask[keep] = AP
    if rng.random() < 0.12 * diff:
        coverage_tint(cv, rng)


def draw_zones(cv, plan, rng, st):
    """Dashed / thin coloured zone outlines over the plan (coverage zones, fire zones, work areas)."""
    x0, y0, x1, y1 = plan.footprint.bounds
    for _ in range(rng.randint(1, 6)):
        w, h = rng.uniform(0.1, 0.45) * (x1 - x0), rng.uniform(0.1, 0.5) * (y1 - y0)
        zx, zy = rng.uniform(x0, x1 - w), rng.uniform(y0, y1 - h)
        col = rng.choice([(0, 140, 255), (0, 200, 255), (200, 0, 200), (40, 40, 220), (200, 120, 0)])
        pts = [cv.p(zx, zy), cv.p(zx + w, zy), cv.p(zx + w, zy + h), cv.p(zx, zy + h)]
        polyline(cv.img, pts, col, rng.choice([1, 1, 2]), closed=True, dash=(9, 4) if rng.random() < 0.6 else None)


def draw_clutter(cv, plan, rng, st, diff):
    """Tiny text all over the floor: desk numbers, room codes, area tags, level marks (unreadable at low res)."""
    floor = [r for r in plan.rooms if r["kind"] not in ("void",)]
    if not floor:
        return
    n = int(min(600, plan.footprint.area / rng.uniform(6, 25) * (0.5 + 0.2 * diff)))
    col = rng.choice([st["ink"], (90, 90, 90), (60, 60, 160), (40, 100, 40)])
    size = max(5, cv.ppm * rng.uniform(0.18, 0.35))
    fp = rng.choice(rp.FONTS)
    for _ in range(n):
        r = rng.choice(floor)
        p = rand_point(r["poly"], rng)
        x, y = cv.p(p.x, p.y)
        s = rng.choice([f"WS-{rng.randint(1, 450)}", f"{rng.choice('ABCDEF')}-{rng.randint(100, 399)}",
                        f"{rng.randint(2, 60)}.{rng.randint(0, 9)} m²", f"+{rng.uniform(0, 12):.2f}", f"D{rng.randint(1, 99)}",
                        rng.choice(["UP", "DN", "FHC", "DB", "AHU", "RAU", "IDF"])])
        text(cv, x, y, s, size, col, angle=rng.choice([0, 0, 0, 90]), fontp=fp, min_size=5)


def coverage_tint(cv, rng):
    H, W = cv.mask.shape
    small = np.random.default_rng(rng.randrange(1 << 30)).random((max(2, H // 120), max(2, W // 120))).astype(np.float32)
    field = cv2.resize(small, (W, H), interpolation=cv2.INTER_CUBIC)
    field = cv2.GaussianBlur(field, (0, 0), 25)
    field = (field - field.min()) / (np.ptp(field) + 1e-6)
    cmap = cv2.applyColorMap((field * 255).astype(np.uint8), cv2.COLORMAP_JET)
    inside = cv.mask != BG
    a = rng.uniform(0.18, 0.45)
    cv.img[inside] = (cv.img[inside] * (1 - a) + cmap[inside] * a).astype(np.uint8)


def draw_mep(cv, plan, rng, st):
    col = rng.choice([st["faint"], (200, 120, 60), (60, 140, 200), (120, 120, 120)])
    x0, y0, x1, y1 = plan.footprint.bounds
    inner = plan.footprint.buffer(-0.6)
    mode = rng.choice(["sprinkler", "lights", "ceiling", "duct", "duct"])
    if mode == "sprinkler":
        s = rng.uniform(2.5, 3.5)
        for x in np.arange(x0 + s / 2, x1, s):
            for y in np.arange(y0 + s / 2, y1, s):
                if inner.contains(Point(x, y)):
                    px, py = cv.p(x, y)
                    cv2.circle(cv.img, (int(px), int(py)), max(1, int(cv.ppm * 0.12)), col, 1, cv2.LINE_AA)
    elif mode == "lights":
        s = rng.uniform(2.4, 3.6)
        for x in np.arange(x0 + s / 2, x1, s):
            for y in np.arange(y0 + s / 2, y1, s):
                g = box(x - 0.3, y - 0.6, x + 0.3, y + 0.6)
                if inner.contains(g):
                    stroke(cv.img, cv.g(g), col, 1)
    elif mode == "ceiling":
        reg = region(cv.mask.shape, cv.g(inner))
        pattern(cv.img, reg, "grid", max(4, cv.ppm * 0.6), col, 1)
    else:  # ducts: two parallel lines along corridors, often right beside walls
        corr = [r for r in plan.rooms if r["kind"] == "corridor"] or plan.rooms[:3]
        for r in corr:
            c = r["poly"].centroid
            b = r["poly"].bounds
            w = rng.uniform(0.4, 0.9)
            if b[2] - b[0] > b[3] - b[1]:
                for o in (-w / 2, w / 2):
                    polyline(cv.img, [cv.p(b[0] + 0.5, c.y + o), cv.p(b[2] - 0.5, c.y + o)], col, 1)
            else:
                for o in (-w / 2, w / 2):
                    polyline(cv.img, [cv.p(c.x + o, b[1] + 0.5), cv.p(c.x + o, b[3] - 0.5)], col, 1)


def draw_site(cv, plan, rng, st):
    ink = st["ink"]
    x0, y0, x1, y1 = plan.footprint.bounds
    g = rng.uniform(3, 8)
    road = box(x0 - g - 7, y0 - g - 7, x1 + g + 7, y1 + g + 7).exterior
    inner = box(x0 - g, y0 - g, x1 + g, y1 + g).exterior
    stroke(cv.img, cv.g(road), ink, 2)
    stroke(cv.img, cv.g(inner), ink, 1)
    for k in range(rng.randint(0, 14)):  # truck docks / parking bays outside
        x = x0 + k * 3.2
        if x > x1 - 3:
            break
        stroke(cv.img, cv.g(box(x, y0 - g + 0.3, x + 2.5, y0 - 0.6)), ink, 1)
    for _ in range(rng.randint(0, 10)):  # trees
        x, y = rng.uniform(x0 - g - 6, x1 + g + 6), rng.choice([y0 - g - 3, y1 + g + 3])
        px, py = cv.p(x, y)
        cv2.circle(cv.img, (int(px), int(py)), max(3, int(cv.ppm * 1.2)), (60, 150, 60), 1, cv2.LINE_AA)


def draw_arrows(cv, plan, rng, st):
    col = rng.choice([(230, 160, 40), (220, 120, 30)])
    for d in plan.doors[: rng.randint(2, 9)]:
        c = d["line"].centroid
        x, y = cv.p(c.x, c.y)
        s = max(8, cv.ppm * rng.uniform(0.8, 1.6))
        ang = rng.choice([0, 90, 180, 270])
        pts = np.array([[0, -s], [s * 0.9, 0], [s * 0.35, 0], [s * 0.35, s], [-s * 0.35, s], [-s * 0.35, 0], [-s * 0.9, 0]])
        R = np.array([[math.cos(math.radians(ang)), -math.sin(math.radians(ang))],
                      [math.sin(math.radians(ang)), math.cos(math.radians(ang))]])
        pts = pts @ R.T + [x, y]
        cv2.fillPoly(cv.img, [_ipts(pts)], col, cv2.LINE_AA, 4)
        cv2.polylines(cv.img, [_ipts(pts)], True, (120, 70, 20), 1, cv2.LINE_AA, 4)


def draw_sheet(cv, plan, rng, st, diff):
    H, W = cv.mask.shape
    ink = st["ink"]
    size = max(8, min(W, H) * 0.012)
    if rng.random() < 0.5:   # frame
        m = int(min(W, H) * 0.01) + 2
        cv2.rectangle(cv.img, (m, m), (W - m, H - m), ink, rng.choice([1, 2]))
    if rng.random() < 0.45:  # banner
        bw, bh = W * rng.uniform(0.2, 0.35), H * rng.uniform(0.04, 0.07)
        x, y = W * rng.uniform(0.3, 0.5), H * 0.01 + 4
        if not (cv.mask[int(y):int(y + bh), int(x):int(x + bw)] != BG).any():
            cv2.rectangle(cv.img, (int(x), int(y)), (int(x + bw), int(y + bh)), (0, 255, 255), -1)
            cv2.rectangle(cv.img, (int(x), int(y)), (int(x + bw), int(y + bh)), (0, 0, 0), 1)
            text(cv, x + bw / 2, y + bh / 2, rng.choice(["Ground Floor", "First Floor", "Basement", "Level 03", "Mezzanine"]),
                 bh * 0.55, (0, 0, 0))
    # legends / title block, only where the sheet is empty
    for _ in range(rng.randint(0, 3)):
        lw_, lh_ = W * rng.uniform(0.12, 0.22), H * rng.uniform(0.08, 0.18)
        for _try in range(8):
            x, y = rng.uniform(0, W - lw_), rng.uniform(0, H - lh_)
            if not (cv.mask[int(y):int(y + lh_), int(x):int(x + lw_)] != BG).any():
                legend(cv, x, y, lw_, lh_, rng, st, size)
                break
    if rng.random() < 0.3:
        x, y = W * 0.03, H * 0.9
        if cv.mask[int(y), int(x)] == BG:
            polyline(cv.img, [(x, y), (x + 4 * cv.ppm, y)], ink, 2)
            for k in range(5):
                polyline(cv.img, [(x + k * cv.ppm, y - 4), (x + k * cv.ppm, y + 4)], ink, 1)
            text(cv, x + 2 * cv.ppm, y + size * 1.4, "0   1   2   3   4 m", size, ink)
    if rng.random() < 0.3:   # north arrow
        x, y, r = W * rng.uniform(0.85, 0.95), H * rng.uniform(0.05, 0.15), size * 2.2
        if cv.mask[int(y), int(x)] == BG:
            cv2.circle(cv.img, (int(x), int(y)), int(r), ink, 1, cv2.LINE_AA)
            cv2.fillPoly(cv.img, [_ipts([[x, y - r], [x + r * 0.35, y + r * 0.5], [x, y + r * 0.2]])], ink, cv2.LINE_AA, 4)
            text(cv, x, y - r * 1.5, "N", size * 1.2, ink)
    if rng.random() < 0.1 * diff:  # revision cloud
        x, y = rng.uniform(0.2, 0.7) * W, rng.uniform(0.2, 0.7) * H
        rw, rh = W * 0.12, H * 0.1
        pts = []
        for t in np.linspace(0, 2 * math.pi, 40):
            rr = 1 + 0.06 * math.sin(t * 20)
            pts.append((x + rw * rr * math.cos(t), y + rh * rr * math.sin(t)))
        polyline(cv.img, pts, (40, 40, 220), 2, closed=True)


def legend(cv, x, y, w, h, rng, st, size):
    ink = (0, 0, 0) if st["mode"] in ("white", "grey", "sepia") else st["ink"]
    head = rng.choice([(235, 210, 190), (220, 220, 220), (180, 230, 255)])
    cv2.rectangle(cv.img, (int(x), int(y)), (int(x + w), int(y + h)), (255, 255, 255), -1)
    cv2.rectangle(cv.img, (int(x), int(y)), (int(x + w), int(y + size * 2)), head, -1)
    cv2.rectangle(cv.img, (int(x), int(y)), (int(x + w), int(y + h)), (120, 120, 120), 1)
    title = rng.choice(["Cables legend", "Materials legend", "Pictograms legend", "Indoor prediction legend", "LEGEND",
                        "Title: Ground Floor  Rev A"])
    text(cv, x + size * 0.6, y + size, title, size * 0.95, ink, anchor="lm")
    rows = int((h - size * 2.5) // (size * 1.6))
    for k in range(max(0, rows)):
        yy = y + size * 2.6 + k * size * 1.6
        c = rng.choice(CABLE_COLOURS + [(230, 230, 0), (150, 150, 150)])
        if rng.random() < 0.5:
            cv2.line(cv.img, (int(x + size), int(yy)), (int(x + size * 3), int(yy)), c, 2, cv2.LINE_AA)
        else:
            cv2.rectangle(cv.img, (int(x + size), int(yy - size * 0.4)), (int(x + size * 3), int(yy + size * 0.4)), c, -1)
        text(cv, x + size * 3.6, yy, rng.choice(["Concrete [Heavy]", "Concrete [Light]", "Small Cell", "BB",
                                                  "002E81-33131-24", "Drywall", "Glass", "Coax 1/2\"", "Cat6A"]),
             size * 0.85, ink, anchor="lm")


def draw_watermark(cv, rng, st):
    H, W = cv.mask.shape
    over = cv.img.copy()
    s = rng.choice(["DRAFT", "CONFIDENTIAL", "FOR REVIEW", "NOT FOR CONSTRUCTION"])
    f = font(rng.choice(rp.FONTS), int(min(W, H) * 0.08))
    pil = Image.fromarray(over[:, :, ::-1].copy())
    tmp = Image.new("RGBA", pil.size, (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((W / 2, H / 2), s, fill=(180, 180, 180, 90), font=f, anchor="mm")
    tmp = tmp.rotate(rng.uniform(-35, 35), resample=Image.BICUBIC)
    pil.paste(tmp, (0, 0), tmp)
    cv.img = np.asarray(pil)[:, :, ::-1].copy()


# ------------------------------------------------------------------ entry point
def render(rng, np_rng, theme=None, difficulty=None):
    """(image BGR, mask, centre-lines, meta, vector ground truth) for one hard-case plan."""
    theme = theme or rng.choices(list(THEME_WEIGHTS), list(THEME_WEIGHTS.values()))[0]
    diff = difficulty or rng.choices([1, 2, 3, 4, 5], [5, 10, 25, 30, 30])[0]
    plan = build_plan(rng, theme, diff)
    return draw_plan(plan, rng, np_rng, theme, diff)
