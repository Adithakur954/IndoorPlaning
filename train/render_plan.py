"""Draws one ResPlan vector plan as a floor-plan *image* plus its exact label mask.

The training data is made here: ResPlan only has geometry, so every picture is
drawn by this file in a randomly chosen drawing style (wall style, floor
colours/textures, furniture, door/window symbols, room names, size labels,
dimension chains, frame/title block) and then damaged like a real scan or
photo (rotation, perspective, blur, noise, JPEG).  The mask comes from the same
polygons, so it is pixel-exact without anyone labelling anything.

Mask values: 0 background/outside, 1 wall, 2 door opening, 3 window opening,
4 floor of an enclosed room.  Text, furniture, dimension lines, frames and door
swings are *not* labelled (the model must learn to ignore them).
"""
import math
import os
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely import affinity
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

CLASSES = {"background": 0, "wall": 1, "door": 2, "window": 3, "floor": 4, "column": 5, "ap": 6,
           "desk": 7, "chair": 8, "table": 9, "sofa": 10, "plant": 11, "pod": 12, "storage": 13}
IGNORE = 255   # pixels the loss must not judge (home furniture: the home renderer does not label it)
PLACED = []    # footprints of the furniture placed in the last home render
ROOM_KEYS = ["living", "bedroom", "kitchen", "bathroom", "storage", "stair"]

FONT_DIR = r"C:\Windows\Fonts"
FONT_FILES = [
    "arial.ttf", "arialbd.ttf", "ARIALN.TTF", "calibri.ttf", "calibrib.ttf", "segoeui.ttf",
    "tahoma.ttf", "verdana.ttf", "times.ttf", "cour.ttf", "consola.ttf", "trebuc.ttf",
    "Candara.ttf", "framd.ttf", "georgia.ttf", "gadugi.ttf", "micross.ttf", "l_10646.ttf",
    "ebrima.ttf", "corbel.ttf",
]
FONTS = [os.path.join(FONT_DIR, f) for f in FONT_FILES if os.path.exists(os.path.join(FONT_DIR, f))]

NAMES = {
    "living": ["Living Room", "Living", "Lounge", "Hall", "Family Room", "Dining", "Living/Dining", "Sala", "Salon"],
    "bedroom": ["Bedroom", "Bed Room", "Master Bedroom", "BR", "Bedroom 1", "Bedroom 2", "Guest Room", "Kids Room", "Chambre"],
    "kitchen": ["Kitchen", "Kitchenette", "Cuisine", "Cook"],
    "bathroom": ["Bath", "Bathroom", "WC", "Toilet", "Powder Bath", "Shower", "Washroom", "Wash"],
    "storage": ["Storage", "Closet", "Walk-in Closet", "Pantry", "Store", "Laundry", "Utility"],
    "stair": ["Stairs", "Stair", "Up"],
    "balcony": ["Balcony", "Terrace", "Porch", "Patio"],
}

FLOOR_COLOURS = {
    "living": (238, 228, 210), "bedroom": (240, 232, 218), "kitchen": (232, 232, 216),
    "bathroom": (205, 226, 236), "storage": (228, 228, 228), "stair": (222, 222, 222),
    "balcony": (222, 224, 214),
}


@lru_cache(maxsize=256)
def _font(path, size):
    return ImageFont.truetype(path, int(size))


def _parts(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for gg in getattr(geom, "geoms", []) for g in _parts(gg)]


def _pts(coords, shift=4):
    return np.round(np.asarray(coords) * (1 << shift)).astype(np.int32)


def fill_mask(mask, geom, value):
    """Fills polygons with holes respected; big ones first so islands inside a hole survive."""
    for p in sorted(_parts(geom), key=lambda q: -q.area):
        cv2.fillPoly(mask, [_pts(p.exterior.coords)], value, cv2.LINE_8, 4)
        for r in p.interiors:
            cv2.fillPoly(mask, [_pts(r.coords)], 0, cv2.LINE_8, 4)


def poly_binary(shape, geom):
    m = np.zeros(shape, np.uint8)
    fill_mask(m, geom, 255)
    return m


def line(img, a, b, col, lw=1):
    cv2.line(img, (int(round(a[0])), int(round(a[1]))), (int(round(b[0])), int(round(b[1]))),
             col, max(1, int(lw)), cv2.LINE_AA)


def poly_pts(img, pts, col, lw=1, closed=True):
    cv2.polylines(img, [np.round(np.asarray(pts)).astype(np.int32)], closed, col, max(1, int(lw)), cv2.LINE_AA)


def fill_pts(img, pts, col):
    cv2.fillPoly(img, [np.round(np.asarray(pts) * 16).astype(np.int32)], col, cv2.LINE_AA, 4)


def circle(img, c, r, col, lw=1, fill=False):
    cv2.circle(img, (int(round(c[0])), int(round(c[1]))), max(1, int(round(r))), col,
               -1 if fill else max(1, int(lw)), cv2.LINE_AA)


# ------------------------------------------------------------------ styles
def sample_style(rng):
    s = {}
    s["dark_mode"] = rng.random() < 0.05
    s["wall_style"] = rng.choices(
        ["solid", "outline_white", "outline_hatch", "outline_poche", "outline_cross", "coloured", "thin_lines"],
        [30, 17, 12, 8, 4, 9, 10])[0]
    s["floor_style"] = rng.choices(["white", "pastel", "wood_tile", "gray", "paper"], [28, 24, 22, 10, 16])[0]
    s["furniture"] = rng.choices([0, 0.4, 0.8, 1.0], [24, 22, 26, 28])[0]
    s["door_style"] = rng.choices(["swing", "swing_line", "gap", "sliding", "rect"], [52, 14, 10, 10, 14])[0]
    s["window_style"] = rng.choices(["lines3", "lines2", "glass", "box", "gap"], [32, 27, 22, 15, 4])[0]
    s["room_names"] = rng.random() < 0.8
    s["size_labels"] = rng.random() < 0.55
    s["size_mode"] = rng.choice(["m_comma", "m_dot", "ftin", "ft", "mm", "plain", "area"])
    s["chains"] = rng.random() < 0.6
    s["chain_tick"] = rng.choice(["tick", "slash", "dot", "arrow"])
    s["frame"] = rng.random() < 0.18
    s["title_block"] = s["frame"] and rng.random() < 0.6
    s["north"] = rng.random() < 0.15
    s["scale_bar"] = rng.random() < 0.12
    s["balcony_rail"] = rng.random() < 0.8
    s["font"] = rng.choice(FONTS)
    s["wall_lw"] = rng.choice([1, 1, 2, 2, 3])
    return s


def palette(style, rng):
    if style["dark_mode"]:
        line_col = rng.choice([(255, 255, 255), (230, 230, 230), (0, 255, 255), (80, 255, 80)])
        return dict(bg=(18, 18, 22), wall=line_col, wall_line=line_col, hatch=line_col,
                    text=line_col, thin=line_col, furn=(150, 150, 160), open=(18, 18, 22),
                    dim=rng.choice([(0, 255, 255), (80, 255, 80), (255, 255, 0)]),
                    door=line_col, window=rng.choice([(0, 255, 255), line_col]))
    dark = rng.choice([(0, 0, 0), (20, 20, 20), (35, 35, 35), (60, 60, 60)])
    wall = dark
    if style["wall_style"] == "coloured":
        wall = rng.choice([(110, 45, 40), (50, 70, 110), (90, 60, 40), (70, 70, 70), (140, 40, 40), (40, 90, 70)])
    bg = rng.choice([(255, 255, 255)] * 6 + [(250, 248, 242), (245, 245, 245), (252, 250, 235)])
    return dict(bg=bg, wall=wall, wall_line=dark, hatch=dark,
                text=rng.choice([(20, 20, 20), (40, 40, 40), (30, 30, 90), (90, 30, 30), (60, 60, 60)]),
                thin=rng.choice([(0, 0, 0), (50, 50, 50), (110, 110, 110)]),
                furn=rng.choice([(70, 70, 70), (120, 120, 120), (150, 150, 150), (90, 90, 120)]),
                open=bg,
                dim=rng.choice([(0, 120, 120), (0, 0, 0), (40, 40, 40), (150, 40, 40), (0, 100, 160)]),
                door=rng.choice([dark, dark, (90, 90, 90), (140, 110, 40), (0, 0, 0)]),
                window=rng.choice([dark, (60, 100, 150), (90, 90, 90), (0, 0, 0)]))


# ------------------------------------------------------------------ layout
def layout(plan, rng, style):
    walls = plan["wall"]
    geoms = [walls] + [plan[k] for k in ROOM_KEYS + ["balcony"] if k in plan]
    x0, y0, x1, y1 = unary_union([g for g in geoms if not g.is_empty]).bounds
    k = rng.choices([0, 1, 2, 3], [55, 15, 15, 15])[0]
    flip = rng.random() < 0.5
    th = k * math.pi / 2
    c, s_ = round(math.cos(th)), round(math.sin(th))
    F = np.array([[-1.0 if flip else 1.0, 0], [0, 1.0]])
    R = np.array([[c, -s_], [s_, c]], dtype=float)
    M = R @ F
    corners = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) @ M.T
    bx0, by0 = corners.min(0)
    bx1, by1 = corners.max(0)
    bw, bh = bx1 - bx0, by1 - by0

    plan_long = math.exp(rng.uniform(math.log(620), math.log(2000)))
    s = plan_long / max(bw, bh)
    pw, ph = bw * s, bh * s
    chains = style["chains"]
    base_m = 0.0 if not chains else rng.uniform(0.12, 0.2)
    if rng.random() < 0.35:
        W = pw / rng.uniform(0.72, 0.92)
        H = W / rng.choice([1.0, 1.25, 1.414, 1.5, 0.707]) if rng.random() < 0.6 else ph / rng.uniform(0.72, 0.92)
    else:
        mx = max(20.0, base_m * max(pw, ph)) + rng.uniform(10, 60)
        W, H = pw + 2 * mx, ph + 2 * mx
    W = max(W, pw + 60)
    H = max(H, ph + 60)
    if chains:
        W = max(W, pw + 220)
        H = max(H, ph + 220)
    W, H = int(min(W, 2600)), int(min(H, 2600))
    ox = (W - pw) / 2 + rng.uniform(-0.03, 0.03) * W * (1 if chains else 0)
    oy = (H - ph) / 2 + rng.uniform(-0.03, 0.03) * H * (1 if chains else 0)
    # world -> pixel: p' = s * M p + t, with the bbox min mapped to (ox, oy)
    t = np.array([ox, oy]) - s * np.array([bx0, by0])
    A = s * M
    matrix = [A[0, 0], A[0, 1], A[1, 0], A[1, 1], t[0], t[1]]
    m_per_unit = float(np.clip(math.sqrt(max(plan.get("area", 100), 30) / max(plan["inner"].area, 1)), 0.04, 0.075))
    return dict(W=W, H=H, matrix=matrix, s=s, px_per_m=s / m_per_unit,
                bbox=(ox, oy, ox + pw, oy + ph), wall_px=plan.get("wall_depth", 4) * s)


# ------------------------------------------------------------------ text helpers
def fmt_len(m, mode, rng=None):
    if mode == "m_comma":
        return f"{m:.2f} m".replace(".", ",")
    if mode == "m_dot":
        return f"{m:.2f} m" if (rng is None or rng.random() < 0.7) else f"{m:.2f}"
    if mode == "mm":
        return f"{int(round(m * 100) * 10)}"
    if mode == "plain":
        return f"{m:.2f}".replace(".", ",") if (rng and rng.random() < 0.5) else f"{m:.1f}"
    if mode in ("ftin", "ft", "area"):
        ft = m / 0.3048
        feet = int(ft)
        inch = int(round((ft - feet) * 12))
        if inch == 12:
            feet, inch = feet + 1, 0
        return f"{feet}'-{inch}\"" if mode == "ftin" else f"{int(round(ft))}'"
    return f"{m:.2f}"


def fmt_size(w, d, mode, rng):
    if mode == "area":
        return f"{w * d:.1f} m²" if rng.random() < 0.6 else f"{w * d * 10.764:.0f} sq ft"
    a, b = fmt_len(w, mode, rng), fmt_len(d, mode, rng)
    sep = rng.choice([" x ", "x", " X ", " × "])
    if mode in ("m_comma", "m_dot"):
        return f"{a.replace(' m', '')}{sep}{b}"
    return f"{a}{sep}{b}"


class TextLayer:
    def __init__(self):
        self.items = []

    def add(self, text, cx, cy, size, col, font, angle=0, anchor="c"):
        self.items.append((text, cx, cy, size, col, font, angle))

    def draw_on(self, bgr):
        pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        d = ImageDraw.Draw(pil)
        for text, cx, cy, size, col, font, angle in self.items:
            f = _font(font, max(8, size))
            try:
                bb = d.textbbox((0, 0), text, font=f)
            except Exception:
                continue
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            if angle == 0:
                d.text((cx - tw / 2 - bb[0], cy - th / 2 - bb[1]), text, fill=tuple(col), font=f)
            else:
                tmp = Image.new("L", (tw + 6, th + 6), 0)
                ImageDraw.Draw(tmp).text((3 - bb[0], 3 - bb[1]), text, fill=255, font=f)
                tmp = tmp.rotate(angle, expand=True)
                pil.paste(Image.new("RGB", tmp.size, tuple(col)), (int(cx - tmp.width / 2), int(cy - tmp.height / 2)), tmp)
        return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)


# ------------------------------------------------------------------ textures
def wood_texture(H, W, rng, base):
    ph = rng.randint(7, 16)
    img = np.empty((H, W, 3), np.uint8)
    img[:] = base
    y = 0
    while y < H:
        tone = rng.randint(-14, 14)
        row = np.clip(np.array(base, int) + tone, 0, 255).astype(np.uint8)
        img[y:y + ph] = row
        x = rng.randint(0, 200)
        while x < W:
            img[y:y + ph, x:x + 1] = np.clip(row.astype(int) - 40, 0, 255)
            x += rng.randint(120, 380)
        img[y:y + 1] = np.clip(row.astype(int) - 45, 0, 255)
        y += ph
    return img


def tile_texture(H, W, base, step):
    img = np.empty((H, W, 3), np.uint8)
    img[:] = base
    g = np.clip(np.array(base, int) - 45, 0, 255).astype(np.uint8)
    img[::step] = g
    img[:, ::step] = g
    return img


# ------------------------------------------------------------------ furniture
class Furn:
    """Furniture symbols placed against a room wall in local (along, inward) coordinates."""

    def __init__(self, img, col, lw, ppm):
        self.img, self.col, self.lw, self.ppm = img, col, lw, ppm

    def mapper(self, side, ax, ay):
        def f(u, v):
            u, v = u * self.ppm, v * self.ppm
            if side == 0:
                return (ax + u, ay + v)
            if side == 2:
                return (ax + u, ay - v)
            if side == 3:
                return (ax + v, ay + u)
            return (ax - v, ay + u)
        return f

    def rect(self, f, u0, v0, u1, v1, fill=None):
        pts = [f(u0, v0), f(u1, v0), f(u1, v1), f(u0, v1)]
        if fill is not None:
            fill_pts(self.img, pts, fill)
        poly_pts(self.img, pts, self.col, self.lw)

    def ln(self, f, u0, v0, u1, v1):
        line(self.img, f(u0, v0), f(u1, v1), self.col, self.lw)

    def circ(self, f, u, v, r, fill=None):
        c = f(u, v)
        if fill is not None:
            circle(self.img, c, r * self.ppm, fill, fill=True)
        circle(self.img, c, r * self.ppm, self.col, self.lw)

    # symbols: each returns (width_along, depth_inward) and a drawer
    def bed(self, f, w=1.6, d=2.0):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.rect(f, -w / 2 + .08, .05, -.04, .4)
        self.rect(f, .04, .05, w / 2 - .08, .4)
        self.ln(f, -w / 2, .75, w / 2, .75)

    def sofa(self, f, w=2.0, d=.9):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.rect(f, -w / 2, 0, w / 2, .22)
        self.rect(f, -w / 2, 0, -w / 2 + .2, d)
        self.rect(f, w / 2 - .2, 0, w / 2, d)

    def table(self, f, w=1.6, d=.9, chairs=True):
        self.rect(f, -w / 2, 0, w / 2, d)
        if chairs:
            n = max(2, int(w / .6))
            for i in range(n):
                u = -w / 2 + (i + .5) * w / n
                self.rect(f, u - .2, d + .04, u + .2, d + .42)

    def wardrobe(self, f, w=1.8, d=.6):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.ln(f, -w / 2, 0, w / 2, d)
        self.ln(f, -w / 2, d, w / 2, 0)

    def counter(self, f, w=2.6, d=.62):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.rect(f, -.35, .08, .35, d - .08)
        self.circ(f, 0, d / 2, .1)
        for u in (w / 2 - .35, w / 2 - .85):
            self.circ(f, u, d / 2, .09)

    def toilet(self, f, **_):
        self.rect(f, -.2, 0, .2, .2)
        self.circ(f, 0, .44, .24)

    def basin(self, f, w=.6, d=.45):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.circ(f, 0, d / 2, .15)

    def bath(self, f, w=.75, d=1.7):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.rect(f, -w / 2 + .06, .06, w / 2 - .06, d - .06)
        self.circ(f, 0, .22, .05)

    def shower(self, f, w=.9, d=.9):
        self.rect(f, -w / 2, 0, w / 2, d)
        self.ln(f, -w / 2, 0, w / 2, d)
        self.circ(f, 0, d / 2, .08)

    def plant(self, f, **_):
        self.circ(f, 0, .2, .2)
        for a in range(0, 360, 45):
            ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
            self.ln(f, 0, .2, ca * .2, .2 + sa * .2)

    def tvunit(self, f, w=1.6, d=.4):
        self.rect(f, -w / 2, 0, w / 2, d)

    def shelf(self, f, w=1.2, d=.4):
        self.rect(f, -w / 2, 0, w / 2, d)
        for i in range(1, 4):
            self.ln(f, -w / 2 + i * w / 4, 0, -w / 2 + i * w / 4, d)

    def stairs(self, f, w=1.0, d=3.0):
        self.rect(f, -w / 2, 0, w / 2, d)
        n = int(d / .28)
        for i in range(1, n):
            self.ln(f, -w / 2, i * d / n, w / 2, i * d / n)
        self.ln(f, 0, .1, 0, d - .1)


SPECS = {
    "bed": ((1.6, 2.0), "bed"), "sofa": ((2.0, .9), "sofa"), "table": ((1.6, .9), "table"),
    "wardrobe": ((1.8, .6), "wardrobe"), "counter": ((2.6, .62), "counter"),
    "toilet": ((.4, .7), "toilet"), "basin": ((.6, .45), "basin"), "bath": ((.75, 1.7), "bath"),
    "shower": ((.9, .9), "shower"), "plant": ((.4, .4), "plant"), "tvunit": ((1.6, .4), "tvunit"),
    "shelf": ((1.2, .4), "shelf"), "stairs": ((1.0, 3.0), "stairs"),
}
ROOM_FURN = {
    "bedroom": [("bed", 1.0), ("wardrobe", .7), ("plant", .2), ("shelf", .15)],
    "living": [("sofa", 1.0), ("tvunit", .6), ("table", .6), ("plant", .4)],
    "kitchen": [("counter", 1.0), ("table", .3), ("counter", .4)],
    "bathroom": [("bath", .6), ("shower", .4), ("toilet", 1.0), ("basin", 1.0)],
    "storage": [("shelf", 1.0), ("shelf", .6)],
    "stair": [("stairs", 1.0)],
}


def place_furniture(img, rooms, avoid, ppm, wall_px, col, lw, rng, density):
    PLACED.clear()
    if density <= 0:
        return
    fr = Furn(img, col, lw, ppm)
    occupied = []
    for kind, room in rooms:
        if kind not in ROOM_FURN or room.area < (ppm * 1.3) ** 2:
            continue
        inner = room.buffer(-wall_px * 0.7)
        if inner.is_empty:
            continue
        for name, prob in ROOM_FURN[kind]:
            if rng.random() > prob * density:
                continue
            (w, d), meth = SPECS[name]
            if name == "counter":
                w = rng.choice([1.8, 2.4, 3.0])
            elif name in ("bed",):
                w = rng.choice([1.2, 1.6, 1.8])
            elif name == "stairs":
                d = rng.choice([2.4, 3.0, 3.6])
            for _ in range(14):
                bx0, by0, bx1, by1 = inner.bounds
                side = rng.randrange(4)
                if side in (0, 2):
                    ax = rng.uniform(bx0 + w * ppm / 2, max(bx0 + w * ppm / 2 + 1, bx1 - w * ppm / 2))
                    ay = by0 if side == 0 else by1
                else:
                    ay = rng.uniform(by0 + w * ppm / 2, max(by0 + w * ppm / 2 + 1, by1 - w * ppm / 2))
                    ax = bx0 if side == 3 else bx1
                f = fr.mapper(side, ax, ay)
                dd = d + (0.45 if name == "table" else 0)
                poly = Polygon([f(-w / 2, 0), f(w / 2, 0), f(w / 2, dd), f(-w / 2, dd)])
                if not inner.contains(poly):
                    continue
                if avoid is not None and poly.intersects(avoid):
                    continue
                if any(poly.intersects(o) for o in occupied):
                    continue
                getattr(fr, meth)(f, w=w, d=d)
                PLACED.append(poly)
                occupied.append(poly.buffer(ppm * 0.08))
                break


# ------------------------------------------------------------------ openings
def _rect_axes(p):
    r = p.minimum_rotated_rectangle
    if r.geom_type != "Polygon":
        return None
    c = np.asarray(r.exterior.coords)[:4]
    e = [c[1] - c[0], c[2] - c[1]]
    l = [np.hypot(*v) for v in e]
    i = 0 if l[0] >= l[1] else 1
    u = e[i] / max(l[i], 1e-9)
    return np.asarray(r.centroid.coords)[0], u, l[i], l[1 - i]


def draw_door(img, p, style, col, lw, open_col, rng):
    ax = _rect_axes(p)
    if ax is None:
        return
    c, u, W, T = ax
    if W < 4:
        return
    n = np.array([-u[1], u[0]])
    A, B = c - u * W / 2, c + u * W / 2
    fill_pts(img, list(p.exterior.coords), open_col)
    if style == "gap":
        return
    if style == "rect":
        poly_pts(img, [A + n * T / 2, B + n * T / 2, B - n * T / 2, A - n * T / 2], col, lw)
        return
    if style == "sliding":
        line(img, A + n * T * .2, B + n * T * .2, col, lw)
        line(img, A - n * T * .2 + u * W * .15, B - n * T * .2 - u * W * .15, col, lw)
        return
    sg = rng.choice([-1, 1])
    legs = [(A, B)] if rng.random() < 0.82 else [(A, c), (B, c)]
    for hinge, free in legs:
        rad = float(np.hypot(*(free - hinge)))
        tip = hinge + n * sg * rad
        line(img, hinge, tip, col, lw)
        if style == "swing":
            a1 = math.degrees(math.atan2(*(free - hinge)[::-1]))
            a2 = math.degrees(math.atan2(*(tip - hinge)[::-1]))
            d = (a2 - a1 + 540) % 360 - 180
            s0, e0 = (a1, a1 + d) if d > 0 else (a1 + d, a1)
            cv2.ellipse(img, (int(round(hinge[0])), int(round(hinge[1]))), (int(rad), int(rad)), 0, s0, e0,
                        col, max(1, lw - 1 if lw > 1 else 1), cv2.LINE_AA)


def draw_window(img, p, style, col, lw, open_col, rng):
    ax = _rect_axes(p)
    if ax is None:
        return
    c, u, W, T = ax
    if W < 4:
        return
    n = np.array([-u[1], u[0]])
    A, B = c - u * W / 2, c + u * W / 2
    fill_pts(img, list(p.exterior.coords), open_col)
    if style == "gap":
        return
    if style in ("box", "glass"):
        poly_pts(img, [A + n * T / 2, B + n * T / 2, B - n * T / 2, A - n * T / 2], col, lw)
        if style == "glass":
            line(img, A, B, col, max(1, lw - 1))
        return
    k = 3 if style == "lines3" else 2
    for i in range(k):
        off = (i - (k - 1) / 2) * (T / (k - 1 + 0.5 if k > 1 else 1))
        line(img, A + n * off, B + n * off, col, 1 if i not in (0, k - 1) else lw)
    line(img, A + n * T / 2, A - n * T / 2, col, lw)
    line(img, B + n * T / 2, B - n * T / 2, col, lw)


# ------------------------------------------------------------------ dimension chains
def _cluster(vals, tol):
    vals = sorted(vals)
    out = [vals[0]]
    for v in vals[1:]:
        if v - out[-1] > tol:
            out.append(v)
    return out


def draw_chains(img, tl, rooms, bbox, ppm, st, pal, rng):
    x0, y0, x1, y1 = bbox
    H, W = img.shape[:2]
    xs = _cluster([x for _, r in rooms for x in (r.bounds[0], r.bounds[2])], 0.6 * ppm)
    ys = _cluster([y for _, r in rooms for y in (r.bounds[1], r.bounds[3])], 0.6 * ppm)
    while len(xs) > 8:
        i = min(range(len(xs) - 1), key=lambda k: xs[k + 1] - xs[k])
        xs.pop(i + 1)
    while len(ys) > 8:
        i = min(range(len(ys) - 1), key=lambda k: ys[k + 1] - ys[k])
        ys.pop(i + 1)
    tcol = pal["dim"] if not st["dark_mode"] else pal["text"]  # RGB, for the text layer
    col = pal["dim"][::-1]  # BGR, for cv2
    mode = st["size_mode"] if st["size_mode"] != "area" else "m_comma"
    size = int(np.clip(0.28 * ppm, 10, 30))
    tick = st["chain_tick"]

    def chain(vals, horizontal, where):
        off = rng.uniform(0.5, 0.9) * ppm
        if horizontal:
            pos = (y0 - off) if where == 0 else (y1 + off)
            if not (12 < pos < H - 12):
                return
            line(img, (vals[0], pos), (vals[-1], pos), col, 1)
            ext0 = y0 - 4 if where == 0 else y1 + 4
            for v in vals:
                line(img, (v, ext0), (v, pos + (-4 if where == 0 else 4)), (150, 150, 150) if not st["dark_mode"] else col, 1)
        else:
            pos = (x0 - off) if where == 0 else (x1 + off)
            if not (12 < pos < W - 12):
                return
            line(img, (pos, vals[0]), (pos, vals[-1]), col, 1)
            ext0 = x0 - 4 if where == 0 else x1 + 4
            for v in vals:
                line(img, (ext0, v), (pos + (-4 if where == 0 else 4), v), (150, 150, 150) if not st["dark_mode"] else col, 1)
        for i, v in enumerate(vals):
            p = (v, pos) if horizontal else (pos, v)
            if tick == "tick":
                line(img, (p[0], p[1] - 6) if horizontal else (p[0] - 6, p[1]), (p[0], p[1] + 6) if horizontal else (p[0] + 6, p[1]), col, 1)
            elif tick == "slash":
                line(img, (p[0] - 5, p[1] + 5), (p[0] + 5, p[1] - 5), col, 2)
            elif tick == "dot":
                circle(img, p, 3, col, fill=True)
            elif tick == "arrow" and 0 < i:
                q = (vals[i - 1], pos) if horizontal else (pos, vals[i - 1])
                d = np.array(p) - np.array(q)
                d = d / max(np.hypot(*d), 1e-9)
                nn = np.array([-d[1], d[0]])
                fill_pts(img, [np.array(p), np.array(p) - d * 9 + nn * 3, np.array(p) - d * 9 - nn * 3], col)
                fill_pts(img, [np.array(q), np.array(q) + d * 9 + nn * 3, np.array(q) + d * 9 - nn * 3], col)
        for a, b in zip(vals[:-1], vals[1:]):
            m = (b - a) / ppm
            if m < 0.7:
                continue
            txt = fmt_len(m, mode, rng)
            mid = (a + b) / 2
            if horizontal:
                tl.add(txt, mid, pos - size * 0.85, size, tcol, st["font"])
            else:
                tl.add(txt, pos - size * 0.85, mid, size, tcol, st["font"], angle=90)

    if len(xs) >= 2:
        chain(xs, True, 0)
        if rng.random() < 0.3:
            chain(xs, True, 1)
    if len(ys) >= 2:
        chain(ys, False, 0)
        if rng.random() < 0.3:
            chain(ys, False, 1)


# ------------------------------------------------------------------ render
def render(plan, rng, np_rng):
    st = sample_style(rng)
    pal = palette(st, rng)
    lay = layout(plan, rng, st)
    W, H = lay["W"], lay["H"]
    T = lambda g: affinity.affine_transform(g, lay["matrix"]) if g is not None and not g.is_empty else g
    ppm = lay["px_per_m"]
    wall_px = lay["wall_px"]
    lw = st["wall_lw"]

    img = np.empty((H, W, 3), np.uint8)
    img[:] = pal["bg"][::-1]
    # note: all colours below are RGB tuples; cv2 wants BGR, so flip once here
    flip = lambda c: tuple(int(v) for v in c[::-1])

    walls = T(plan["wall"])
    doors = [T(plan["door"])] + ([T(plan["front_door"])] if "front_door" in plan and not plan["front_door"].is_empty else [])
    windows = T(plan["window"]) if "window" in plan else None
    rooms = []
    for k in ROOM_KEYS + ["balcony"]:
        if k in plan and not plan[k].is_empty:
            for p in _parts(plan[k]):
                if p.area > 4:
                    rooms.append((k, T(p)))

    # ---- mask first: exact labels
    mask = np.zeros((H, W), np.uint8)
    for k, r in rooms:
        if k != "balcony":
            fill_mask(mask, r, 4)
    fill_mask(mask, walls, 1)
    for d in doors:
        fill_mask(mask, d, 2)
    if windows is not None:
        fill_mask(mask, windows, 3)

    # ---- floors
    fs = st["floor_style"]
    floor_img = None
    if fs == "wood_tile":
        floor_img = wood_texture(H, W, rng, flip((205, 170, 125)))
        tile_img = tile_texture(H, W, flip((232, 232, 218)), rng.randint(14, 26))
        bath_img = tile_texture(H, W, flip((160, 200, 218)), 16)
    for k, r in rooms:
        m = poly_binary((H, W), r)
        if fs == "white":
            col = None if k != "balcony" else (232, 232, 226)
        elif fs == "gray":
            col = (225, 225, 225) if k != "balcony" else (240, 240, 240)
        elif fs == "paper":
            col = (250, 246, 236)
        elif fs == "pastel":
            col = tuple(int(np.clip(c + rng.randint(-12, 12), 0, 255)) for c in FLOOR_COLOURS[k])
        else:
            col = None
        if st["dark_mode"]:
            col = None
        if fs == "wood_tile" and not st["dark_mode"]:
            if k in ("bathroom", "kitchen"):
                tex = bath_img if k == "bathroom" else tile_img
                img[m > 0] = tex[m > 0]
            elif k in ("storage", "stair"):
                img[m > 0] = (214, 214, 214)
            else:
                img[m > 0] = floor_img[m > 0]
        elif col is not None:
            img[m > 0] = flip(col)

    # ---- furniture (under the walls)
    avoid = None
    door_geoms = []
    for d in doors:
        for p in _parts(d):
            ax = _rect_axes(p)
            if ax:
                door_geoms.append(Point(ax[0]).buffer(ax[2] * 1.05))
    if door_geoms:
        avoid = unary_union(door_geoms)
    furn_rooms = [(k, r) for k, r in rooms if k != "balcony"]
    place_furniture(img, furn_rooms, avoid, ppm, wall_px, flip(pal["furn"]), 1 if wall_px < 14 else 2, rng, st["furniture"])
    if PLACED:   # furniture is not labelled in homes: the loss must not call it floor
        tmp = np.zeros_like(mask)
        fill_mask(tmp, unary_union(PLACED), 1)
        mask[(tmp > 0) & (mask == 4)] = IGNORE

    # ---- balcony railing
    for k, r in rooms:
        if k == "balcony" and st["balcony_rail"]:
            poly_pts(img, list(r.exterior.coords), flip(pal["thin"]), 1)
            inner_rail = r.buffer(-wall_px * 0.35)
            if inner_rail.geom_type == "Polygon" and not inner_rail.is_empty:
                poly_pts(img, list(inner_rail.exterior.coords), flip(pal["thin"]), 1)

    # ---- walls
    wm = poly_binary((H, W), walls)
    ws = st["wall_style"]
    if ws in ("solid", "coloured"):
        img[wm > 0] = flip(pal["wall"])
        if ws == "solid" and rng.random() < 0.15:
            cs, _ = cv2.findContours(wm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            for c in cs:
                poly_pts(img, c[:, 0, :], flip(pal["wall_line"]), 1)
    else:
        xx = np.arange(W)[None, :]
        yy = np.arange(H)[:, None]
        if ws == "outline_white":
            fillc = flip(pal["open"]) if rng.random() < 0.7 else flip((235, 235, 235))
            img[wm > 0] = fillc
        elif ws == "outline_hatch":
            sp = rng.randint(5, 11)
            hat = (((xx + yy) % sp) < 1) & (wm > 0)
            img[wm > 0] = flip(pal["open"])
            img[hat] = flip(pal["hatch"])
        elif ws == "outline_cross":
            sp = rng.randint(6, 11)
            hat = ((((xx + yy) % sp) < 1) | (((xx - yy) % sp) < 1)) & (wm > 0)
            img[wm > 0] = flip(pal["open"])
            img[hat] = flip(pal["hatch"])
        elif ws == "outline_poche":
            g = rng.choice([150, 170, 190, 120])
            img[wm > 0] = (g, g, g)
        elif ws == "thin_lines":
            img[wm > 0] = flip(pal["open"])
        cs, _ = cv2.findContours(wm, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        olw = 1 if ws == "thin_lines" else lw
        for c in cs:
            if len(c) >= 3:
                poly_pts(img, c[:, 0, :], flip(pal["wall_line"]), olw)

    # ---- openings
    dlw = 1 if wall_px < 14 else 2
    for d in doors:
        for p in _parts(d):
            draw_door(img, p, st["door_style"], flip(pal["door"]), dlw, flip(pal["open"]), rng)
    if windows is not None:
        for p in _parts(windows):
            draw_window(img, p, st["window_style"], flip(pal["window"]), dlw, flip(pal["open"]), rng)

    # ---- text, dimensions, frame
    tl = TextLayer()
    tcol = pal["text"]
    base_size = int(np.clip(0.27 * ppm, 10, 36))
    if st["room_names"] or st["size_labels"]:
        for k, r in rooms:
            if r.area < (1.6 * ppm) ** 2:
                continue
            rp = r.representative_point()
            bx0, by0, bx1, by1 = r.bounds
            size = int(np.clip(min(base_size, (bx1 - bx0) / 7), 9, 38))
            ly = rp.y
            if st["room_names"]:
                nm = rng.choice(NAMES[k])
                est = len(nm) * size * 0.55
                while est > (bx1 - bx0) * 0.9 and size > 8:
                    size -= 1
                    est = len(nm) * size * 0.55
                tl.add(nm, rp.x, ly, size, tcol, st["font"])
                ly += size * 1.25
            if st["size_labels"] and k != "balcony":
                txt = fmt_size((bx1 - bx0) / ppm, (by1 - by0) / ppm, st["size_mode"], rng)
                tl.add(txt, rp.x, ly, max(8, int(size * 0.9)), tcol, st["font"])
    if st["chains"] and len(rooms) >= 2:
        draw_chains(img, tl, [(k, r) for k, r in rooms if k != "balcony"] or rooms, lay["bbox"], ppm, st, pal, rng)
    if st["frame"]:
        m = rng.randint(8, 24)
        cv2.rectangle(img, (m, m), (W - m, H - m), flip(pal["text"]), 2)
        cv2.rectangle(img, (m + 5, m + 5), (W - m - 5, H - m - 5), flip(pal["text"]), 1)
        if st["title_block"]:
            bw_, bh_ = int(W * 0.24), int(H * 0.07)
            x0_, y0_ = W - m - 5 - bw_, H - m - 5 - bh_
            cv2.rectangle(img, (x0_, y0_), (W - m - 5, H - m - 5), flip(pal["text"]), 1)
            cv2.line(img, (x0_, y0_ + bh_ // 2), (W - m - 5, y0_ + bh_ // 2), flip(pal["text"]), 1)
            tl.add(rng.choice(["FLOOR PLAN", "GROUND FLOOR", "PLAN - LEVEL 1", "Floor Plan"]), x0_ + bw_ / 2, y0_ + bh_ * .25, max(10, int(bh_ * .3)), tcol, st["font"])
            tl.add(rng.choice(["SCALE 1:100", "1:50", "SCALE 1:75", "A-101"]), x0_ + bw_ / 2, y0_ + bh_ * .75, max(9, int(bh_ * .26)), tcol, st["font"])
    if st["north"]:
        cx, cy, r = W - 70, 70, 26
        circle(img, (cx, cy), r, flip(pal["text"]), 1)
        fill_pts(img, [(cx, cy - r), (cx - 9, cy + r * .6), (cx + 9, cy + r * .6)], flip(pal["text"]))
        tl.add("N", cx, cy - r - 12, 16, tcol, st["font"])
    if st["scale_bar"]:
        x0_, y_ = 60, H - 55
        for i in range(4):
            cv2.rectangle(img, (int(x0_ + i * ppm), y_), (int(x0_ + (i + 1) * ppm), y_ + 6), flip(pal["text"]), -1 if i % 2 == 0 else 1)
            tl.add(str(i), x0_ + i * ppm, y_ - 12, 12, tcol, st["font"])
        tl.add("m", x0_ + 4 * ppm + 8, y_ - 12, 12, tcol, st["font"])
    img = tl.draw_on(img)

    meta = dict(plan_id=int(plan.get("id", -1)), style={k: v for k, v in st.items() if k != "font"},
                font=os.path.basename(st["font"]), px_per_m=round(float(ppm), 3),
                wall_px=round(float(wall_px), 2), size=[W, H])
    return img, mask, meta


# ------------------------------------------------------------------ damage
def degrade(img, mask, rng, np_rng):
    H, W = mask.shape
    bg = tuple(int(v) for v in img[2, 2])
    ops = []
    # geometry (image + mask together)
    if rng.random() < 0.4:
        ang = rng.uniform(-4, 4)
        Mx = cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0)
        img = cv2.warpAffine(img, Mx, (W, H), flags=cv2.INTER_LINEAR, borderValue=bg)
        mask = cv2.warpAffine(mask, Mx, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
        ops.append(f"rot{ang:.1f}")
    if rng.random() < 0.14:
        d = rng.uniform(0.01, 0.06)
        src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        dst = src + np.float32([[rng.uniform(-d, d) * W, rng.uniform(-d, d) * H] for _ in range(4)])
        P = cv2.getPerspectiveTransform(src, dst)
        img = cv2.warpPerspective(img, P, (W, H), flags=cv2.INTER_LINEAR, borderValue=bg)
        mask = cv2.warpPerspective(mask, P, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
        ops.append("persp")
    if rng.random() < 0.12:
        pad = int(max(W, H) * rng.uniform(0.03, 0.1))
        col = rng.choice([(0, 0, 0), (20, 20, 20), (110, 110, 110), (235, 235, 235)])
        img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=col)
        mask = cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
        ops.append("border")
    # resolution loss
    if rng.random() < 0.45:
        f = rng.uniform(0.35, 0.85)
        h, w = img.shape[:2]
        small = cv2.resize(img, (max(8, int(w * f)), max(8, int(h * f))), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC if rng.random() < .5 else cv2.INTER_LINEAR)
        ops.append(f"lowres{f:.2f}")
    if rng.random() < 0.3:
        s = rng.uniform(0.4, 1.6)
        img = cv2.GaussianBlur(img, (0, 0), s)
        ops.append(f"blur{s:.1f}")
    f = img.astype(np.float32)
    if rng.random() < 0.28:
        k = rng.uniform(0.7, 0.95)
        f = 255 - (255 - f) * k if rng.random() < .5 else f * k + (1 - k) * 128
        ops.append("lowcontrast")
    if rng.random() < 0.25:
        tint = np.array([rng.uniform(.88, 1.0), rng.uniform(.92, 1.0), rng.uniform(.95, 1.0)])
        f = f * tint[None, None, :]
        ops.append("tint")
    if rng.random() < 0.25:
        h, w = f.shape[:2]
        gx = np.linspace(rng.uniform(.8, 1), rng.uniform(.9, 1.05), w)[None, :, None]
        gy = np.linspace(rng.uniform(.85, 1), rng.uniform(.9, 1.05), h)[:, None, None]
        f = f * gx * gy
        ops.append("shade")
    if rng.random() < 0.32:
        sg = rng.uniform(2, 11)
        f = f + np_rng.normal(0, sg, f.shape).astype(np.float32)
        ops.append(f"noise{sg:.0f}")
    if rng.random() < 0.1:
        n = int(f.shape[0] * f.shape[1] * rng.uniform(1e-4, 8e-4))
        ys = np_rng.integers(0, f.shape[0], n)
        xs = np_rng.integers(0, f.shape[1], n)
        f[ys, xs] = rng.choice([0, 255])
        ops.append("specks")
    img = np.clip(f, 0, 255).astype(np.uint8)
    return img, mask, ops
