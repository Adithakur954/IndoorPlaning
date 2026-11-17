"""Draws a random *office / coworking* floor plan as an image plus its exact mask.

ResPlan only has homes, so offices are invented here: an outer wall ring, cabin
rows with glass or solid fronts, lift/shaft cores, a structural column grid, and
an open-plan zone filled with workstation pods, community tables, round tables,
lounges, planters and phone pods -- with chairs at every desk, dimension strings,
red seat-count captions, arrows and Wi-Fi marker dots, like a real CAD plan.

Same mask values as render_plan (0 bg, 1 wall, 2 door, 3 window, 4 floor, 5 column, 6 ap marker) plus the
furniture classes (7 desk, 8 chair, 9 table, 10 sofa, 11 plant, 12 pod / booth, 13 storage). Text, dimension lines
and arrows are not labelled. Every furniture symbol writes its footprint into a label canvas; walls drawn over it
keep priority, so only visible floor becomes furniture.
"""
import math
import os

import cv2
import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

import render_plan as rp
from render_plan import (TextLayer, circle, draw_door, draw_window, fill_mask, fill_pts, line, poly_binary,
                         poly_pts)

OFFICE_NAMES = ["CONFERENCE ROOM", "MEETING ROOM", "DISCUSSION", "MANAGER ROOM", "RECEPTION", "PANTRY",
                "STORAGE", "SERVER", "CABIN", "TRAINING ROOM", "BOARD ROOM", "HUDDLE"]
CAPTIONS = ["TOTAL WORKSTATIONS : {n}", "TOTAL SUPER SEATS : {n}", "TOTAL PRIVATE DESKS : {n}",
            "TOTAL COMMUNITY SEATS : {n}", "WORK SEATS : {n}", "HOT SEATS : {n}", "MID RISE"]


DESK, CHAIR, TABLE, SOFA, PLANT, POD, STORAGE = 7, 8, 9, 10, 11, 12, 13
_LAB = None            # furniture label canvas of the plan being drawn
_CHAIR_STYLE = "arms"


def _mark_poly(pts, cls):
    if _LAB is not None:
        cv2.fillPoly(_LAB, [np.round(np.asarray(pts, float)).astype(np.int32)], int(cls))


def _mark_circle(c, r, cls):
    if _LAB is not None:
        cv2.circle(_LAB, (int(round(c[0])), int(round(c[1]))), max(1, int(round(r))), int(cls), -1)


def ftin(m, rng=None):
    ft = m / 0.3048
    f = int(ft)
    i = int(round((ft - f) * 12))
    if i == 12:
        f, i = f + 1, 0
    return f"{f}'-{i}\"" if (rng is None or rng.random() < 0.5) else f"{f}'{i}\""


class View:
    """Maps plan metres to pixels, with a random 90-degree turn and mirror (text stays upright)."""

    def __init__(self, fw, fh, k, flip, s, ox, oy):
        self.fw, self.fh, self.k, self.flip, self.s, self.ox, self.oy = fw, fh, k, flip, s, ox, oy

    def pt(self, x, y):
        if self.flip:
            x = self.fw - x
        if self.k == 1:
            x, y = self.fh - y, x
        elif self.k == 2:
            x, y = self.fw - x, self.fh - y
        elif self.k == 3:
            x, y = y, self.fw - x
        return (self.ox + x * self.s, self.oy + y * self.s)

    def poly(self, pts):
        return [self.pt(x, y) for x, y in pts]

    def rect(self, x0, y0, x1, y1):
        return self.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])

    def geom(self, g):
        out = []
        for p in rp._parts(g):
            ext = self.poly(list(p.exterior.coords)[:-1])
            holes = [self.poly(list(r.coords)[:-1]) for r in p.interiors]
            out.append(Polygon(ext, holes))
        return MultiPolygon(out) if out else Polygon()


def hatch(img, pts, col, spacing, anti=False):
    pts = np.asarray(pts)
    x0, y0 = np.floor(pts.min(0)).astype(int)
    x1, y1 = np.ceil(pts.max(0)).astype(int)
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, img.shape[1]), min(y1, img.shape[0])
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    m = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(m, [np.round(pts - [x0, y0]).astype(np.int32)], 255)
    xx = np.arange(x0, x1)[None, :]
    yy = np.arange(y0, y1)[:, None]
    pat = (((xx - yy) if anti else (xx + yy)) % spacing) < 1
    sub = img[y0:y1, x0:x1]
    sub[(m > 0) & pat] = col


def render(rng, np_rng):
    global _LAB, _CHAIR_STYLE
    # ---------------------------------------------------------------- footprint
    fw, fh = rng.uniform(20, 44), rng.uniform(15, 34)
    to = rng.uniform(0.22, 0.34)
    pth = rng.uniform(0.09, 0.15)
    foot = box(0, 0, fw, fh)
    if rng.random() < 0.3:
        nw, nh = rng.uniform(0.15, 0.3) * fw, rng.uniform(0.15, 0.3) * fh
        cx, cy = rng.choice([(0, 0), (fw - nw, 0), (0, fh - nh), (fw - nw, fh - nh)])
        foot = foot.difference(box(cx, cy, cx + nw, cy + nh))
    interior = foot.buffer(-to, join_style=2)
    inner = interior.buffer(-0.12, join_style=2)

    # ---------------------------------------------------------------- view / scale
    k = rng.choices([0, 1, 2, 3], [50, 18, 14, 18])[0]
    flip = rng.random() < 0.4
    vw, vh = (fh, fw) if k in (1, 3) else (fw, fh)
    plan_long = rng.uniform(1150, 2300)
    s = plan_long / max(vw, vh)
    margin = rng.uniform(0.04, 0.09) * plan_long
    show_dims = rng.random() < 0.65          # overall dimension lines with the printed size, as on real exports
    if show_dims:
        margin = max(margin, rng.uniform(0.10, 0.15) * plan_long)
    W, H = int(vw * s + 2 * margin), int(vh * s + 2 * margin)
    view = View(fw, fh, k, flip, s, margin, margin)
    ppm = s

    # ---------------------------------------------------------------- style
    dark = rng.random() < 0.04
    wall_style = rng.choices(["band", "outline", "black", "hatch"], [38, 28, 18, 16])[0]
    bg = (18, 18, 22) if dark else rng.choice([(255, 255, 255)] * 5 + [(250, 250, 248), (245, 245, 243)])
    ink = rng.choice([(255, 255, 255), (0, 255, 255)]) if dark else rng.choice([(0, 0, 0), (30, 30, 30), (60, 60, 60)])
    band = rng.choice([(120, 120, 120), (140, 140, 140), (155, 155, 155), (100, 100, 100)])
    desk_fill = rng.choice([(236, 226, 206), (224, 224, 226), (232, 222, 200), (205, 205, 208), (245, 240, 225),
                            (226, 196, 150), (214, 182, 138), (200, 200, 200), (232, 214, 176)])
    desk_hatch = rng.random() < 0.55
    chair_col = rng.choice([(120, 90, 70), (90, 90, 90), (70, 70, 70), (150, 110, 80), (170, 110, 60), (60, 60, 60)])
    _CHAIR_STYLE = rng.choices(["arms", "round", "task", "outline"], [50, 15, 20, 15])[0]
    text_col = rng.choice([(40, 40, 40), (20, 20, 20), (60, 60, 60)])
    red = (200, 30, 30)
    teal = rng.choice([(0, 130, 130), (0, 110, 150), (80, 80, 80)])
    green = rng.choice([(40, 120, 50), (30, 100, 40), (60, 140, 60)])
    col_style = rng.choice(["orange", "orange", "grey", "black", "hatched"])
    font = rng.choice(rp.FONTS)
    lw = 1 if ppm < 55 else 2
    flipc = lambda c: tuple(int(v) for v in c[::-1])

    img = np.empty((H, W, 3), np.uint8)
    img[:] = flipc(bg)
    tl = TextLayer()
    occupied = []
    pod_polys = []  # workstation rows: long interior partitions are anchored on their edges
    opens = []  # (kind, polygon in metres)
    walls_main, walls_glass = [], []
    fsize = lambda f=1.0: max(8, int(ppm * 0.2 * f * rng.uniform(0.85, 1.2)))

    # ---------------------------------------------------------------- floor
    floor_px = view.geom(interior)
    mask = np.zeros((H, W), np.uint8)
    fill_mask(mask, floor_px, 4)
    _LAB = np.zeros((H, W), np.uint8)
    if not dark and rng.random() < 0.3:
        fm = poly_binary((H, W), floor_px)
        img[fm > 0] = flipc(rng.choice([(250, 248, 240), (244, 244, 246), (248, 244, 236)]))

    # ---------------------------------------------------------------- outer wall
    outer = foot.difference(interior)
    walls_main.append(outer)

    # ---------------------------------------------------------------- cabin rows
    cabin_bands = []
    glass_front = rng.random() < 0.4
    for side in rng.sample(["top", "bottom"], rng.choice([0, 1, 1, 2, 2])):
        dc = rng.uniform(3.0, 4.6)
        y0, y1 = (to, to + dc) if side == "top" else (fh - to - dc, fh - to)
        yf = y1 if side == "top" else y0
        x = to + rng.uniform(0, 1.5)
        end = fw - to - rng.uniform(0, 2)
        placed = False
        while x < end - 2.4:
            w = min(rng.uniform(2.8, 5.2), end - x)
            if w < 2.4:
                break
            cab = box(x, y0, x + w, y1)
            if not inner.contains(cab):
                x += w
                continue
            placed = True
            walls_main.append(box(x - pth / 2, y0, x + pth / 2, y1))
            front = box(x, yf - pth / 2, x + w, yf + pth / 2)
            (walls_glass if glass_front else walls_main).append(front)
            dw = rng.uniform(0.85, 1.05)
            dx = rng.uniform(x + 0.25, x + w - dw - 0.25)
            opens.append(("door", box(dx, yf - pth / 2, dx + dw, yf + pth / 2)))
            # contents
            if rng.random() < 0.55:
                tw, td = min(w * 0.6, 2.6), 1.0
                tx0, ty0 = x + (w - tw) / 2, (y0 + y1) / 2 - td / 2
                desk(img, view, tx0, ty0, tx0 + tw, ty0 + td, desk_fill, ink, desk_hatch, lw, rng)
                n = max(2, int(tw / 0.7))
                for i in range(n):
                    cxm = tx0 + (i + 0.5) * tw / n
                    chair(img, view, cxm, ty0 - 0.3, 0, 1, chair_col, lw)
                    chair(img, view, cxm, ty0 + td + 0.3, 0, -1, chair_col, lw)
            else:
                dy = y0 + 0.4 if side == "top" else y1 - 0.4 - 0.7
                desk(img, view, x + 0.4, dy, x + 0.4 + 1.6, dy + 0.7, desk_fill, ink, desk_hatch, lw, rng)
                chair(img, view, x + 1.2, dy + (1.0 if side == "top" else -0.3), 0, -1 if side == "top" else 1, chair_col, lw)
            lab = rng.choice(OFFICE_NAMES)
            ty = (y0 + 0.3) if side == "top" else (y1 - 0.3)
            px_ = view.pt(x + w / 2, ty)
            tl.add(lab, px_[0], px_[1], fsize(0.8), text_col, font)
            px_ = view.pt(x + w / 2, ty + (0.35 if side == "top" else -0.35))
            tl.add(f"{ftin(w)}X{ftin(dc)}", px_[0], px_[1], fsize(0.7), text_col, font)
            x += w
        if placed:
            walls_main.append(box(x - pth / 2, y0, x + pth / 2, y1))
            occupied.append(box(to, y0, fw - to, y1 + 0.05) if side == "top" else box(to, y0 - 0.05, fw - to, y1))
            cabin_bands.append((side, dc))

    # ---------------------------------------------------------------- cores
    cores = []
    for _ in range(rng.choice([0, 1, 1, 2])):
        cw, ch = rng.uniform(2.6, 4.2), rng.uniform(3.2, 5.4)
        for _t in range(40):
            cx = rng.choice([to + rng.uniform(0, 3), fw - to - cw - rng.uniform(0, 3), rng.uniform(to, fw - to - cw)])
            cy = rng.uniform(to, fh - to - ch)
            core = box(cx, cy, cx + cw, cy + ch)
            if inner.contains(core) and not any(core.buffer(0.4).intersects(o) for o in occupied):
                ring = core.difference(core.buffer(-0.2, join_style=2))
                walls_main.append(ring)
                dw = 0.95
                side = rng.choice("tblr")
                if side == "t":
                    opens.append(("door", box(cx + cw / 2 - dw / 2, cy, cx + cw / 2 + dw / 2, cy + 0.2)))
                elif side == "b":
                    opens.append(("door", box(cx + cw / 2 - dw / 2, cy + ch - 0.2, cx + cw / 2 + dw / 2, cy + ch)))
                elif side == "l":
                    opens.append(("door", box(cx, cy + ch / 2 - dw / 2, cx + 0.2, cy + ch / 2 + dw / 2)))
                else:
                    opens.append(("door", box(cx + cw - 0.2, cy + ch / 2 - dw / 2, cx + cw, cy + ch / 2 + dw / 2)))
                a, b = view.pt(cx + 0.3, cy + 0.3), view.pt(cx + cw - 0.3, cy + ch - 0.3)
                line(img, a, b, flipc(ink), 1)
                a, b = view.pt(cx + cw - 0.3, cy + 0.3), view.pt(cx + 0.3, cy + ch - 0.3)
                line(img, a, b, flipc(ink), 1)
                p = view.pt(cx + cw / 2, cy + ch / 2)
                tl.add(rng.choice(["LIFT", "SHAFT", "STAIR", "FHC", "AHU"]), p[0], p[1], fsize(0.8), red if rng.random() < .5 else text_col, font)
                occupied.append(core.buffer(0.25))
                cores.append(core)
                break

    # ---------------------------------------------------------------- columns (placed before furniture)
    columns = []
    sx, sy = rng.uniform(5.5, 9.0), rng.uniform(5.5, 9.0)
    cs = rng.uniform(0.4, 0.7)
    gx = np.arange(to + rng.uniform(2, sx), fw - to, sx)
    gy = np.arange(to + rng.uniform(2, sy), fh - to, sy)
    if rng.random() < 0.85:
        for xx in gx:
            for yy in gy:
                c = box(xx - cs / 2, yy - cs / 2, xx + cs / 2, yy + cs / 2)
                if inner.contains(c) and not any(c.intersects(o) for o in occupied):
                    columns.append(c)
    for c in columns:
        occupied.append(c.buffer(0.15))

    # ---------------------------------------------------------------- open-plan zone
    top_d = max([d + 1.0 for sd, d in cabin_bands if sd == "top"] or [0])
    bot_d = max([d + 1.0 for sd, d in cabin_bands if sd == "bottom"] or [0])
    zx0, zx1 = to + 0.5, fw - to - 0.5
    zy0, zy1 = to + top_d + 0.3, fh - to - bot_d - 0.3
    density = rng.choice([0.9, 1.0, 1.0, 1.0])
    captions = []
    pods_total = 0
    # two passes: the first lays out the rows, the second packs what is still free, as real plans are packed
    for _pass in range(2):
        y = zy0 + rng.uniform(0.3, 1.2) if _pass == 0 else zy0 + rng.uniform(0.0, 0.6)
        while y < zy1 - 1.2:
            n_before = len(occupied)
            kind = rng.choices(["pod", "community", "round", "single", "lounge", "empty"],
                               [48, 14, 9, 12, 8, 3] if _pass == 0 else [60, 8, 8, 14, 10, 0])[0]
            if rng.random() > density:
                kind = "empty"
            x = zx0 + rng.uniform(0, 2)
            row_h = 0.0
            row_seats = 0
            if kind == "pod":
                desk_w = rng.uniform(1.2, 1.6)
                dd = rng.uniform(0.65, 0.8)
                div = rng.uniform(0.05, 0.35)
                vertical = rng.random() < 0.35
                n_row = rng.randint(3, 6)
                Wd = 2 * (dd + 0.5) + div
                row_h = n_row * desk_w if vertical else Wd
                while x < zx1 - 2.5:
                    n = n_row if vertical else min(rng.randint(3, 8), int((zx1 - x) / desk_w))
                    L = n * desk_w
                    if n < 2 or (vertical and x + Wd > zx1):
                        break
                    if vertical:
                        poly = box(x - 0.05, y - 0.1, x + Wd + 0.05, y + L + 0.1)
                    else:
                        poly = box(x - 0.1, y - 0.05, x + L + 0.1, y + Wd + 0.05)
                    if inner.contains(poly) and not any(poly.intersects(o) for o in occupied):
                        def m(u, v, x=x, y=y, vertical=vertical):
                            return (x + v, y + u) if vertical else (x + u, y + v)

                        def span(u0, v0, u1, v1, m=m):
                            a, b = m(u0, v0), m(u1, v1)
                            return (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))

                        f1, f2 = ((1, 0), (-1, 0)) if vertical else ((0, 1), (0, -1))
                        for i in range(n):
                            a = i * desk_w
                            desk(img, view, *span(a, 0.5, a + desk_w, 0.5 + dd), desk_fill, ink, desk_hatch, lw, rng)
                            desk(img, view, *span(a, 0.5 + dd + div, a + desk_w, 0.5 + 2 * dd + div), desk_fill, ink, desk_hatch, lw, rng)
                            c1 = m(a + desk_w / 2, 0.5 - 0.28)
                            c2 = m(a + desk_w / 2, 0.5 + 2 * dd + div + 0.28)
                            chair(img, view, c1[0], c1[1], f1[0], f1[1], chair_col, lw)
                            chair(img, view, c2[0], c2[1], f2[0], f2[1], chair_col, lw)
                        if div > 0.12:
                            planter(img, view, *span(0, 0.5 + dd, L, 0.5 + dd + div), green, rng)
                        if rng.random() < 0.5 and not vertical:
                            a, b = view.pt(x, y - 0.12), view.pt(x + L, y - 0.12)
                            line(img, a, b, flipc(teal), 1)
                            p = view.pt(x + L / 2, y - 0.3)
                            tl.add(ftin(L, rng), p[0], p[1], fsize(0.6), teal, font)
                        occupied.append(poly)
                        row_seats += 2 * n
                        pod_polys.append(poly)
                        pods_total += 2 * n
                    x += (Wd if vertical else L) + rng.uniform(0.35, 1.1)
            elif kind == "community":
                row_h = 1.2 + 1.0
                while x < zx1 - 3:
                    L = min(rng.uniform(3.5, 6.0), zx1 - x)
                    if L < 3:
                        break
                    poly = box(x - 0.1, y - 0.05, x + L + 0.1, y + row_h + 0.05)
                    if inner.contains(poly) and not any(poly.intersects(o) for o in occupied):
                        ty0 = y + 0.5
                        desk(img, view, x, ty0, x + L, ty0 + 1.2, desk_fill, ink, desk_hatch, lw, rng, cls=TABLE)
                        n = int(L / 0.62)
                        for i in range(n):
                            cxm = x + (i + 0.5) * L / n
                            chair(img, view, cxm, ty0 - 0.28, 0, 1, chair_col, lw)
                            chair(img, view, cxm, ty0 + 1.2 + 0.28, 0, -1, chair_col, lw)
                        if rng.random() < 0.7:
                            planter(img, view, x + 0.2, ty0 + 0.52, x + L - 0.2, ty0 + 0.68, green, rng)
                        p = view.pt(x + L / 2, ty0 + 0.6)
                        tl.add(rng.choice(["MID RISE", "Community table", "HIGH TABLE"]), p[0], p[1] + fsize() * 0.8, fsize(0.7), text_col, font)
                        occupied.append(poly)
                        row_seats += 2 * n
                    x += L + rng.uniform(0.8, 2.2)
            elif kind == "round":
                row_h = 2.3
                while x < zx1 - 2.5:
                    r = rng.uniform(0.5, 0.75)
                    poly = Point(x + 1.1, y + 1.15).buffer(1.1)
                    if inner.contains(poly) and not any(poly.intersects(o) for o in occupied):
                        c = view.pt(x + 1.1, y + 1.15)
                        circle(img, c, r * ppm, flipc(ink), lw)
                        circle(img, c, r * ppm, flipc(desk_fill), fill=True)
                        circle(img, c, r * ppm, flipc(ink), lw)
                        _mark_circle(c, r * ppm, TABLE)
                        nch = rng.choice([3, 4, 4, 5])
                        for j in range(nch):
                            a = 2 * math.pi * j / nch + 0.4
                            cxm, cym = x + 1.1 + math.cos(a) * (r + 0.32), y + 1.15 + math.sin(a) * (r + 0.32)
                            fx, fy = -math.cos(a), -math.sin(a)
                            chair_free(img, view, cxm, cym, fx, fy, chair_col, lw)
                        occupied.append(poly)
                        row_seats += nch
                    x += 2.4 + rng.uniform(0.6, 2.0)
            elif kind == "single":
                row_h = 0.75 + 0.55
                desk_w = rng.uniform(1.2, 1.6)
                while x < zx1 - 3:
                    n = min(rng.randint(3, 8), int((zx1 - x) / desk_w))
                    L = n * desk_w
                    if n < 2:
                        break
                    poly = box(x - 0.05, y - 0.05, x + L + 0.05, y + row_h + 0.05)
                    if inner.contains(poly) and not any(poly.intersects(o) for o in occupied):
                        for i in range(n):
                            a = x + i * desk_w
                            desk(img, view, a, y, a + desk_w, y + 0.75, desk_fill, ink, desk_hatch, lw, rng)
                            chair(img, view, a + desk_w / 2, y + 0.75 + 0.28, 0, -1, chair_col, lw)
                        occupied.append(poly)
                        row_seats += n
                        pods_total += n
                    x += L + rng.uniform(0.7, 2.0)
            elif kind == "lounge":
                row_h = 2.2
                while x < zx1 - 3:
                    poly = box(x, y, x + 2.6, y + row_h)
                    if inner.contains(poly) and not any(poly.intersects(o) for o in occupied):
                        sofa(img, view, x, y, x + 2.0, y + 0.85, desk_fill, ink, lw)
                        desk(img, view, x + 0.5, y + 1.2, x + 1.5, y + 1.8, (235, 235, 235), ink, False, lw, rng, cls=TABLE)
                        plant(img, view, x + 2.3, y + 0.4, 0.25, green)
                        occupied.append(poly)
                    x += 3.0 + rng.uniform(0.5, 3.0)
            else:
                row_h = rng.uniform(0.6, 1.6)
            if row_seats and rng.random() < 0.75:
                captions.append((y + row_h + 0.55, row_seats))
            if _pass == 1 and len(occupied) == n_before:      # nothing fitted on this row: slide down a little
                y += 0.45
            else:
                y += row_h + rng.uniform(0.5, 1.2)

    # ---------------------------------------------------------------- phone pods / planters / plants
    for _ in range(rng.choice([0, 1, 2, 3])):
        for _t in range(30):
            x, y2 = rng.uniform(zx0, zx1 - 1.2), rng.uniform(zy0 - 1, zy1)
            pod = box(x, y2, x + 1.15, y2 + 1.15)
            if inner.contains(pod) and not any(pod.intersects(o) for o in occupied):
                fill_pts(img, view.rect(x, y2, x + 1.15, y2 + 1.15), flipc((255, 245, 160)))
                poly_pts(img, view.rect(x, y2, x + 1.15, y2 + 1.15), flipc(ink), max(lw, 2))
                _mark_poly(view.rect(x, y2, x + 1.15, y2 + 1.15), POD)
                p = view.pt(x + .575, y2 + .575)
                tl.add("PHONE POD", p[0], p[1] - fsize() * 0.5, fsize(0.55), text_col, font)
                tl.add("3'8\"X3'8\"", p[0], p[1] + fsize() * 0.5, fsize(0.5), text_col, font)
                occupied.append(pod.buffer(0.2))
                break
    for _ in range(rng.choice([0, 2, 4, 7])):
        for _t in range(20):
            x, y2 = rng.uniform(zx0, zx1), rng.uniform(zy0, zy1)
            c = Point(x, y2).buffer(0.3)
            if inner.contains(c) and not any(c.intersects(o) for o in occupied):
                plant(img, view, x, y2, 0.28, green)
                occupied.append(c)
                break
    # hedge rows of planters and tall storage units, as on real coworking plans
    if rng.random() < 0.45:
        for _t in range(15):
            xa = rng.uniform(zx0, max(zx0 + 0.1, zx1 - 6))
            xb = min(zx1, xa + rng.uniform(5, 14))
            yh = rng.uniform(zy0, zy1)
            strip = box(xa, yh - 0.3, xb, yh + 0.3)
            if inner.contains(strip) and not any(strip.intersects(o) for o in occupied):
                nb = max(3, int((xb - xa) / 0.32))
                for i_ in range(nb):
                    pc = view.pt(xa + (i_ + 0.5) * (xb - xa) / nb, yh + rng.uniform(-0.05, 0.05))
                    rr = rng.uniform(0.16, 0.24) * ppm
                    circle(img, pc, rr, flipc(green), fill=True)
                    circle(img, pc, rr * 0.55, (110, 200, 120), fill=True)
                    _mark_circle(pc, rr, PLANT)
                occupied.append(strip)
                break
    for _ in range(rng.choice([0, 1, 1, 2])):
        for _t in range(25):
            sw_, sd_ = rng.uniform(0.55, 0.8), rng.uniform(1.4, 2.8)
            if rng.random() < 0.5:
                sw_, sd_ = sd_, sw_
            x, y2 = rng.uniform(zx0, max(zx0 + 0.1, zx1 - sw_)), rng.uniform(zy0, max(zy0 + 0.1, zy1 - sd_))
            st_ = box(x, y2, x + sw_, y2 + sd_)
            if inner.contains(st_) and not any(st_.intersects(o) for o in occupied):
                pts_ = view.rect(x, y2, x + sw_, y2 + sd_)
                fill_pts(img, pts_, flipc((200, 200, 204)))
                poly_pts(img, pts_, flipc(ink), max(lw, 1))
                _mark_poly(pts_, STORAGE)
                pc = view.pt(x + sw_ / 2, y2 + sd_ / 2)
                tl.add(rng.choice(["Tall storage", "STORAGE", "Existing products", "Cabinet"]), pc[0], pc[1],
                       fsize(0.45), text_col, font)
                occupied.append(st_.buffer(0.2))
                break
    # Interior partitions, as in real coworking plans: long wall bands (0.12-0.22 m) running along the edge of a
    # workstation row, so desks touch them, with a few gaps for openings. Walls are painted over the furniture.
    if pod_polys and rng.random() < 0.8:
        thick = rng.uniform(0.12, 0.22)
        for _ in range(rng.choice([1, 1, 2, 3])):
            a = rng.choice(pod_polys)
            bx0, by0, bx1, by1 = a.bounds
            if rng.random() < 0.7:  # horizontal, across (most of) the open-plan zone
                yy = by0 if rng.random() < 0.5 else by1
                xa, xb = (zx0, zx1) if rng.random() < 0.6 else (rng.uniform(zx0, (zx0 + zx1) / 2), zx1)
                cuts = sorted(rng.uniform(xa + 2, xb - 2) for _ in range(rng.choice([0, 1, 2, 3])))
                spans, x_ = [], xa
                for c_ in cuts:
                    spans.append((x_, c_)); x_ = c_ + rng.uniform(0.9, 1.6)
                spans.append((x_, xb))
                segs = [box(u, yy - thick / 2, v, yy + thick / 2) for u, v in spans if v - u > 1.0]
            else:  # vertical stub along a row's end
                xx = bx0 if rng.random() < 0.5 else bx1
                ya = rng.uniform(zy0, max(zy0 + 0.1, by0 - 1))
                yb = min(zy1, ya + rng.uniform(4, 12))
                segs = [box(xx - thick / 2, ya, xx + thick / 2, yb)]
            for seg in segs:
                if inner.contains(seg):
                    walls_main.append(seg)
                    sx0_, sy0_, sx1_, sy1_ = seg.bounds     # a pier (orange square) at the ends, as on the real plans
                    ends_ = ([(sx0_, (sy0_ + sy1_) / 2), (sx1_, (sy0_ + sy1_) / 2)] if (sx1_ - sx0_) > (sy1_ - sy0_)
                             else [((sx0_ + sx1_) / 2, sy0_), ((sx0_ + sx1_) / 2, sy1_)])
                    for ex_, ey_ in ends_:
                        if rng.random() < 0.6:
                            col_ = box(ex_ - cs / 2, ey_ - cs / 2, ex_ + cs / 2, ey_ + cs / 2)
                            if inner.contains(col_) and not any(col_.intersects(c_) for c_ in columns):
                                columns.append(col_)

    # ---------------------------------------------------------------- windows and entrances on the outer wall
    for side in ("top", "bottom", "left", "right"):
        along = fw if side in ("top", "bottom") else fh
        t = to + rng.uniform(0.5, 3)
        curtain = rng.random() < 0.25
        while t < along - to - 1.5:
            w = rng.uniform(4, 8) if curtain else rng.uniform(1.2, 2.4)
            w = min(w, along - to - t - 0.5)
            if w < 1.0:
                break
            if side == "top":
                r_ = box(t, 0, t + w, to)
            elif side == "bottom":
                r_ = box(t, fh - to, t + w, fh)
            elif side == "left":
                r_ = box(0, t, to, t + w)
            else:
                r_ = box(fw - to, t, fw, t + w)
            if outer.intersection(r_).area > 0.9 * r_.area and rng.random() < 0.8:
                opens.append(("window", r_))
            t += w + rng.uniform(0.8, 4.0)
    for _ in range(rng.choice([1, 1, 2])):
        side = rng.choice(["top", "bottom", "left", "right"])
        along = fw if side in ("top", "bottom") else fh
        for _t in range(15):
            t = rng.uniform(to + 2, along - to - 3)
            w = rng.choice([1.8, 2.0, 2.4])
            r_ = {"top": box(t, 0, t + w, to), "bottom": box(t, fh - to, t + w, fh),
                  "left": box(0, t, to, t + w), "right": box(fw - to, t, fw, t + w)}[side]
            if outer.intersection(r_).area > 0.9 * r_.area and not any(r_.intersects(o) for kd, o in opens):
                opens.append(("door", r_))
                break
    # windows may not overlap other openings
    cleaned = []
    for kd, g in opens:
        if all(not g.intersects(o) or o is g for _, o in cleaned):
            cleaned.append((kd, g))
    opens = cleaned

    # ---------------------------------------------------------------- walls: carve openings, then paint
    open_union = unary_union([g for _, g in opens]) if opens else Polygon()
    main = unary_union(walls_main).difference(open_union)
    glass = unary_union(walls_glass).difference(open_union) if walls_glass else Polygon()
    main_px, glass_px = view.geom(main), view.geom(glass)
    wm = poly_binary((H, W), main_px)
    contours, _ = cv2.findContours(wm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if wall_style == "band":
        img[wm > 0] = flipc(band)
    elif wall_style == "black":
        img[wm > 0] = flipc(ink)
    elif wall_style == "hatch":
        img[wm > 0] = flipc(bg)
    else:
        img[wm > 0] = flipc(bg)
    if wall_style == "hatch":
        yy, xx = np.mgrid[0:H, 0:W] if H * W < 4e6 else (None, None)
        if yy is not None:
            img[(((xx + yy) % 7) < 1) & (wm > 0)] = flipc(ink)
    if wall_style != "black":
        for c in contours:
            if len(c) >= 3:
                poly_pts(img, c[:, 0, :], flipc(ink), 1 if wall_style == "band" else lw)
    if not glass.is_empty:
        gm = poly_binary((H, W), glass_px)
        img[gm > 0] = flipc((225, 240, 248) if not dark else bg)
        gc, _ = cv2.findContours(gm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in gc:
            if len(c) >= 3:
                poly_pts(img, c[:, 0, :], flipc((70, 120, 160) if not dark else ink), 1)
    fill_mask(mask, main_px, 1)
    if not glass.is_empty:
        fill_mask(mask, glass_px, 1)

    # ---------------------------------------------------------------- columns drawn over walls
    for c in columns:
        pts = view.rect(*c.bounds)
        if col_style == "orange":
            fill_pts(img, pts, flipc((255, 190, 20)))
            poly_pts(img, pts, flipc((200, 130, 0)), 1)
        elif col_style == "grey":
            fill_pts(img, pts, flipc((120, 120, 120)))
            poly_pts(img, pts, flipc(ink), 1)
        elif col_style == "black":
            fill_pts(img, pts, flipc(ink))
        else:
            fill_pts(img, pts, flipc(bg))
            hatch(img, pts, flipc(ink), 5)
            poly_pts(img, pts, flipc(ink), 1)
        fill_mask(mask, view.geom(c), 5)

    # ---------------------------------------------------------------- doors and windows
    dstyle = rng.choice(["swing", "swing", "swing_line", "rect"])
    wstyle = rng.choice(["lines3", "lines2", "glass", "box"])
    dlw = 1 if ppm < 55 else 2
    for kind_, g in opens:
        gp = view.geom(g)
        if kind_ == "door":
            fill_mask(mask, gp, 2)
            for p in rp._parts(gp):
                draw_door(img, p, dstyle, flipc(ink), dlw, flipc(bg), rng)
        else:
            fill_mask(mask, gp, 3)
            for p in rp._parts(gp):
                draw_window(img, p, wstyle, flipc((60, 100, 150) if not dark else ink), dlw, flipc(bg), rng)

    # ---------------------------------------------------------------- captions, title, arrows, markers, frame
    for yy_, n in captions:
        cap = rng.choice(CAPTIONS).format(n=n)
        p = view.pt(rng.uniform(zx0 + 4, zx1 - 4), yy_)
        tl.add(cap, p[0], p[1], fsize(0.72), red, font)
    if rng.random() < 0.7:
        p = view.pt(fw / 2 + rng.uniform(-4, 4), zy0 + 0.2)
        tl.add(rng.choice(["TT/ COWORK", "WORKSPACE", "OPEN OFFICE", "FLOOR 3"]), p[0], p[1], fsize(1.1), (20, 20, 20), font)
        tl.add(f"TOTAL WORK SEATS- {pods_total}", p[0], p[1] + fsize(1.1) * 1.2, fsize(1.0), (20, 20, 20), font)
    for _ in range(rng.choice([0, 0, 2, 3])):
        x, y2 = rng.uniform(zx0, zx1), rng.uniform(zy0, zy1)
        a = view.pt(x, y2)
        d = rng.choice([(1, 0), (-1, 0), (0, 1), (0, -1)])
        pa = np.array(a)
        dv = np.array(view.pt(x + d[0], y2 + d[1])) - pa
        dv = dv / max(np.hypot(*dv), 1e-9)
        nv = np.array([-dv[1], dv[0]])
        L = 0.6 * ppm
        col = flipc((240, 150, 160))
        fill_pts(img, [pa + dv * L, pa + nv * 0.28 * ppm, pa - nv * 0.28 * ppm], col)
        fill_pts(img, [pa + nv * 0.1 * ppm, pa - nv * 0.1 * ppm, pa - dv * L * 0.8 - nv * 0.1 * ppm, pa - dv * L * 0.8 + nv * 0.1 * ppm], col)
    # long thin dimension / grid lines running across the plan, as in real CAD exports (not labelled)
    if rng.random() < 0.8:
        lc = flipc(rng.choice([(110, 170, 170), (150, 170, 190), (170, 170, 170), (90, 150, 160)]))
        for _ in range(rng.randint(4, 18)):
            if rng.random() < 0.5:
                y2 = rng.uniform(zy0, zy1)
                a, b = view.pt(rng.uniform(zx0, zx0 + 6), y2), view.pt(rng.uniform(zx1 - 6, zx1), y2)
            else:
                x = rng.uniform(zx0, zx1)
                a, b = view.pt(x, rng.uniform(zy0, zy0 + 4)), view.pt(x, rng.uniform(zy1 - 4, zy1))
            cv2.line(img, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), lc, 1, cv2.LINE_AA)
    # Wi-Fi / access-point markers: labelled class 6 (ap). One symbol style per plan; many sit on wall lines
    mk_style = rng.choices(["dot", "wifi", "router"], [60, 22, 18])[0]
    mk_col = rng.choice([(0, 120, 215), (30, 140, 90), (200, 40, 40), (90, 90, 90)])
    wall_parts = [g for g in (getattr(main, "geoms", [main])) if g.area > 0.2]
    for _ in range(rng.choice([0, 0, 0, 2, 4, 6, 8, 10])):
        for _t in range(40):
            if wall_parts and rng.random() < 0.55:
                g = rng.choice(wall_parts)
                x0_, y0_, x1_, y1_ = g.bounds
                x, y2 = rng.uniform(x0_, x1_), rng.uniform(y0_, y1_)
                ok = g.contains(Point(x, y2))
            else:
                x, y2 = rng.uniform(to, fw - to), rng.uniform(to, fh - to)
                ok = inner.contains(Point(x, y2))
            if ok:
                p = view.pt(x, y2)
                R = rng.uniform(0.35, 0.7) * ppm
                if mk_style == "dot":
                    if rng.random() < 0.5:
                        fill_pts(img, [(p[0] + R * math.cos(math.pi / 8 + i * math.pi / 4),
                                        p[1] + R * math.sin(math.pi / 8 + i * math.pi / 4)) for i in range(8)], (0, 0, 0))
                    else:
                        circle(img, p, R, (0, 0, 0), fill=True)
                    circle(img, p, R * 0.62, flipc((255, 235, 0)), fill=True)
                elif mk_style == "wifi":
                    circle(img, p, R, flipc(mk_col), fill=True)
                    c0 = (int(p[0]), int(p[1] + R * 0.35))
                    cv2.circle(img, c0, max(1, int(R * 0.1)), (255, 255, 255), -1, cv2.LINE_AA)
                    for rr in (0.35, 0.62, 0.88):
                        cv2.ellipse(img, c0, (max(1, int(R * rr)),) * 2, 0, 225, 315, (255, 255, 255), max(1, int(R * 0.1)), cv2.LINE_AA)
                else:
                    a, b = (int(p[0] - R * 0.8), int(p[1] - R * 0.45)), (int(p[0] + R * 0.8), int(p[1] + R * 0.45))
                    cv2.rectangle(img, a, b, flipc(mk_col), -1, cv2.LINE_AA)
                    for dx in (-0.55, 0.55):
                        cv2.line(img, (int(p[0] + R * dx), a[1]), (int(p[0] + R * dx * 1.2), int(p[1] - R * 1.0)),
                                 flipc(mk_col), max(1, int(R * 0.12)), cv2.LINE_AA)
                    cv2.circle(img, (int(p[0]), int(p[1])), max(1, int(R * 0.12)), (255, 255, 255), -1, cv2.LINE_AA)
                cv2.circle(mask, (int(round(p[0])), int(round(p[1]))), max(2, int(round(R))), 6, -1)
                break
    for _ in range(rng.randint(12, 45)):
        p = view.pt(rng.uniform(zx0, zx1), rng.uniform(zy0, zy1))
        txt = rng.choice([ftin(rng.uniform(1, 6), rng), f"{rng.randint(1, 9)}.{rng.randint(0, 9)}'", "MID RISE", f"PD-{rng.randint(1, 9)}"])
        tl.add(txt, p[0], p[1], fsize(0.5), teal if rng.random() < 0.6 else text_col, font)
    print_dims = None
    if show_dims:
        corners = [view.pt(0, 0), view.pt(fw, 0), view.pt(0, fh), view.pt(fw, fh)]
        x0p, x1p = min(c_[0] for c_ in corners), max(c_[0] for c_ in corners)
        y0p, y1p = min(c_[1] for c_ in corners), max(c_[1] for c_ in corners)
        horiz_m, vert_m = (fw, fh) if k in (0, 2) else (fh, fw)
        blue_rgb = rng.choice([(0, 51, 153), (0, 70, 190), (20, 40, 140)])
        bcol = flipc(blue_rgb)
        off = 0.45 * margin
        yl, xl = y0p - off, x0p - off
        lwd = max(1, int(round(ppm * 0.06)))
        ah = max(6.0, 0.35 * ppm)

        def head(tip, d):
            dx, dy = d
            nx, ny = -dy, dx
            fill_pts(img, [tip, (tip[0] - dx * ah + nx * ah * 0.35, tip[1] - dy * ah + ny * ah * 0.35),
                           (tip[0] - dx * ah - nx * ah * 0.35, tip[1] - dy * ah - ny * ah * 0.35)], bcol)

        cv2.line(img, (int(x0p), int(yl)), (int(x1p), int(yl)), bcol, lwd, cv2.LINE_AA)
        head((x0p, yl), (-1, 0))
        head((x1p, yl), (1, 0))
        cv2.line(img, (int(xl), int(y0p)), (int(xl), int(y1p)), bcol, lwd, cv2.LINE_AA)
        head((xl, y0p), (0, -1))
        head((xl, y1p), (0, 1))
        for xe in (x0p, x1p):
            cv2.line(img, (int(xe), int(yl - off * 0.2)), (int(xe), int(y0p - 3)), bcol, 1, cv2.LINE_AA)
        for ye in (y0p, y1p):
            cv2.line(img, (int(xl - off * 0.2), int(ye)), (int(x0p - 3), int(ye)), bcol, 1, cv2.LINE_AA)
        fmt = rng.choice(["{:.2f} m", "{:.2f} m", "{:.1f} m", "{:.2f}m"])
        lab_h = fmt.format(horiz_m) + rng.choice([" (Length)", " (Length)", ""])
        lab_v = fmt.format(vert_m) + rng.choice([" (Width)", " (Width)", ""])
        ts = max(10, int(0.8 * off))
        tl.add(lab_h, (x0p + x1p) / 2, yl - ts * 0.9, ts, blue_rgb, font)
        tl.add(lab_v, xl - ts * 0.9, (y0p + y1p) / 2, ts, blue_rgb, font, angle=90)
        print_dims = {"horizontal_m": round(horiz_m, 2), "vertical_m": round(vert_m, 2),
                      "box_px": [round(x0p, 1), round(y0p, 1), round(x1p, 1), round(y1p, 1)], "labels": [lab_h, lab_v]}
    if rng.random() < 0.7:
        m = rng.randint(6, 18)
        cv2.rectangle(img, (m, m), (W - m, H - m), flipc((150, 150, 150) if not dark else ink), 1)
    img = tl.draw_on(img)

    fm = (_LAB > 0) & (mask == 4)          # furniture only where the floor is visible; walls and doors keep priority
    mask[fm] = _LAB[fm]
    furn_counts = {nm: int(cv2.connectedComponents((mask == cl).astype(np.uint8), connectivity=8)[0] - 1)
                   for nm, cl in (("desk", DESK), ("chair", CHAIR), ("table", TABLE), ("sofa", SOFA),
                                  ("plant", PLANT), ("pod", POD), ("storage", STORAGE))}
    meta = dict(kind="office", style=dict(wall_style=wall_style, col_style=col_style, dark=dark, glass_front=glass_front,
                                          density=density, view=[k, flip]),
                font=os.path.basename(font), px_per_m=round(float(ppm), 3), wall_px=round(float(pth * ppm), 2),
                size=[W, H], footprint_m=[round(fw, 1), round(fh, 1)], seats=pods_total,
                furniture=furn_counts, print_dims=print_dims)
    return img, mask, meta


# ---------------------------------------------------------------------- symbols
def desk(img, view, x0, y0, x1, y1, fill, ink, hatched, lw, rng, cls=DESK):
    pts = view.rect(x0, y0, x1, y1)
    _mark_poly(pts, cls)
    fill_pts(img, pts, tuple(int(v) for v in fill[::-1]))
    if hatched:
        hatch(img, pts, tuple(int(v) - 40 if v > 40 else v for v in fill[::-1]), 5, anti=(rng.random() < 0.5))
    poly_pts(img, pts, tuple(int(v) for v in ink[::-1]), lw)


def chair(img, view, cx, cy, fx, fy, col, lw):
    """Axis-aligned chair at (cx, cy) facing (fx, fy): seat, back and armrests."""
    chair_free(img, view, cx, cy, fx, fy, col, lw)


def chair_free(img, view, cx, cy, fx, fy, col, lw):
    n = (-fy, fx)
    c = tuple(int(v) for v in col[::-1])

    def P(a, b):
        return (cx + fx * a + n[0] * b, cy + fy * a + n[1] * b)

    # label: a slightly shrunk footprint, so chairs that touch still separate into single pieces
    _mark_poly(view.poly([P(-0.26, -0.2), P(0.18, -0.2), P(0.18, 0.2), P(-0.26, 0.2)]), CHAIR)
    style = _CHAIR_STYLE
    if style == "round":
        centre = view.pt(cx, cy)
        tip = view.pt(cx + fx, cy + fy)
        ang = math.degrees(math.atan2(tip[1] - centre[1], tip[0] - centre[0]))
        r = 0.2 * view.s
        circle(img, centre, r, (250, 250, 250), fill=True)
        circle(img, centre, r, c, lw)
        cv2.ellipse(img, (int(centre[0]), int(centre[1])), (int(r * 1.35),) * 2, 0, ang + 180 - 70, ang + 180 + 70,
                    c, max(lw, 2), cv2.LINE_AA)
        return
    seat = view.poly([P(-0.22, -0.25), P(0.22, -0.25), P(0.22, 0.25), P(-0.22, 0.25)])
    back = view.poly([P(-0.3, -0.24), P(-0.2, -0.24), P(-0.2, 0.24), P(-0.3, 0.24)])
    if style != "outline":
        fill_pts(img, seat, (250, 250, 250))
        fill_pts(img, back, c if style == "task" else (235, 235, 235))
    poly_pts(img, seat, c, lw)
    poly_pts(img, back, c, lw)
    for sgn in (-1, 1):
        arm = view.poly([P(-0.2, sgn * 0.22), P(0.12, sgn * 0.22), P(0.12, sgn * 0.3), P(-0.2, sgn * 0.3)])
        poly_pts(img, arm, c, 1)


def sofa(img, view, x0, y0, x1, y1, fill, ink, lw):
    pts = view.rect(x0, y0, x1, y1)
    _mark_poly(pts, SOFA)
    fill_pts(img, pts, tuple(int(v) for v in fill[::-1]))
    poly_pts(img, pts, tuple(int(v) for v in ink[::-1]), lw)
    poly_pts(img, view.rect(x0, y0, x1, y0 + 0.2), tuple(int(v) for v in ink[::-1]), 1)


def planter(img, view, x0, y0, x1, y1, green, rng):
    pts = view.rect(x0, y0, x1, y1)
    _mark_poly(pts, PLANT)
    fill_pts(img, pts, tuple(int(v) for v in green[::-1]))
    n = max(2, int((x1 - x0) / 0.35))
    for i in range(n):
        p = view.pt(x0 + (i + 0.5) * (x1 - x0) / n, (y0 + y1) / 2)
        circle(img, p, max(2, 0.1 * view.s), (90, 190, 100), fill=True)


def plant(img, view, x, y, r, green):
    p = view.pt(x, y)
    _mark_circle(p, r * view.s, PLANT)
    circle(img, p, r * view.s, tuple(int(v) for v in green[::-1]), fill=True)
    for a in range(0, 360, 60):
        q = (p[0] + math.cos(math.radians(a)) * r * view.s * 0.55, p[1] + math.sin(math.radians(a)) * r * view.s * 0.55)
        circle(img, q, r * view.s * 0.4, (110, 200, 120), fill=True)
