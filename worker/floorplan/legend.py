"""Wall materials from the drawing's own legend.

Many plans (RF survey exports, CAD sheets) carry a materials legend: a colour swatch next to a name, such as a cyan
bar for "Concrete [Heavy]" and a grey line for "Concrete [Light]", and the walls are drawn in those colours. The
legend is read from the drawing every time (the text reader gives the names, the swatch beside each name gives its
colour); then each wall takes the material whose colour it is drawn in. Nothing is fixed per drawing: a plan with no
legend, or walls in a colour the legend does not list, keeps the default material and is left for the user to set.
"""
from __future__ import annotations

import re

import cv2
import numpy as np

# words in a legend entry -> material key of the editor (drywall, wood, glass, brick, concrete, metal)
_KEYWORDS = [
    (r"\b(light(weight)?|aac|block|hollow)\b.*\bconcrete\b|\bconcrete\b.*\b(light(weight)?|block|aac|hollow)\b", "brick"),
    (r"\b(concrete|rcc|reinforced|cement)\b", "concrete"),
    (r"\b(brick|masonry|blockwork|block)\b", "brick"),
    (r"\b(drywall|dry wall|plasterboard|gypsum|partition|stud)\b", "drywall"),
    (r"\b(glass|glazing|glazed|curtain wall)\b", "glass"),
    (r"\b(wood|wooden|timber|plywood)\b", "wood"),
    (r"\b(metal|steel|sheet|aluminium|aluminum)\b", "metal"),
]


def _material_of(text: str) -> str | None:
    t = text.lower().replace("[", " ").replace("]", " ").replace("(", " ").replace(")", " ")
    for pattern, key in _KEYWORDS:
        if re.search(pattern, t):
            return key
    return None


def _swatch_colour(colour: np.ndarray, box: np.ndarray) -> np.ndarray | None:
    """Colour (BGR) of the swatch left of a legend name: the strongest non-white colour in a strip a few text
    heights wide, on the text's rows. None when the strip is empty or only holds black text."""
    x0, y0 = np.floor(box.min(0)).astype(int)
    x1, y1 = np.ceil(box.max(0)).astype(int)
    h = max(6, y1 - y0)
    H, W = colour.shape[:2]
    sx0, sx1 = max(0, x0 - int(4.5 * h)), max(0, x0 - 2)
    # the text's own rows only (the swatch of the entry above or below must not bleed in)
    sy0, sy1 = max(0, y0 + h // 6), min(H, y1 - h // 6)
    if sx1 - sx0 < 4 or sy1 <= sy0:
        return None
    strip = colour[sy0:sy1, sx0:sx1].reshape(-1, 3).astype(np.float32)
    gray = strip.mean(axis=1)
    sel = strip[(gray < 235) & (gray > 25)]     # not paper, not black text or border
    if len(sel) < 6:
        return None
    hsv = cv2.cvtColor(sel.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2HSV).reshape(-1, 3)
    sat = hsv[:, 1] > 60
    pick = sel[sat] if sat.sum() >= 6 else sel   # a coloured swatch wins over grey anti-aliasing
    return np.median(pick, axis=0)


def read_legend(colour: np.ndarray, texts: list[dict]) -> list[dict]:
    """[{"label", "material", "bgr"}] for each legend name with a swatch beside it (one per distinct colour)."""
    out: list[dict] = []
    for t in texts:
        if t.get("kind") == "error" or not t.get("text"):
            continue
        key = _material_of(t["text"])
        if key is None:
            continue
        bgr = _swatch_colour(colour, np.asarray(t["box"], float))
        if bgr is None:
            continue
        if any(np.linalg.norm(bgr - np.asarray(e["bgr"])) < 30 for e in out):
            continue          # the same swatch listed twice (a legend repeated on the sheet)
        out.append({"label": t["text"], "material": key, "bgr": [round(float(v), 1) for v in bgr]})
    return out


def wall_materials(colour: np.ndarray, walls: list, legend: list[dict], tol: float = 45.0) -> list[dict | None]:
    """For each wall (a, b, thickness in the colour image's pixels) the legend entry whose colour covers the most
    of it (at least 30 % of the inked pixels along the wall), else None."""
    if not legend:
        return [None] * len(walls)
    H, W = colour.shape[:2]
    cols = np.array([e["bgr"] for e in legend], np.float32)
    out: list[dict | None] = []
    for w in walls:
        (x0, y0), (x1, y1) = w.a, w.b
        n = max(4, int(np.hypot(x1 - x0, y1 - y0) / 2))
        # the cross-section reaches a few pixels past the stroke: a coloured line drawn alongside the wall (an RF
        # export marks the wall's material with a thin line next to the drawn wall) belongs to it
        half = max(1, int(round(w.thickness / 2))) + 4
        dx, dy = x1 - x0, y1 - y0
        ln = max(np.hypot(dx, dy), 1e-6)
        nx, ny = -dy / ln, dx / ln
        pix = []
        for k in range(n + 1):
            t = k / n
            for o in range(-half, half + 1):
                x = min(W - 1, max(0, int(round(x0 + dx * t + nx * o))))
                y = min(H - 1, max(0, int(round(y0 + dy * t + ny * o))))
                pix.append(colour[y, x])
        if not pix:
            out.append(None)
            continue
        # per position along the wall: does its cross-section show the legend colour? A saturated colour (cyan,
        # red) cannot come from anything else; a grey one could be the soft edge of a black line, so a grey
        # match counts only where the cross-section has nothing much darker than that grey.
        sec = np.asarray(pix, np.float32).reshape(n + 1, 2 * half + 1, 3)
        # a thin coloured line in a JPEG is paler than its solid swatch: coloured entries match by hue (and some
        # saturation), grey ones by value
        sec_hsv = cv2.cvtColor(sec.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
        cover = []
        for c, e in zip(cols, legend):
            grey = float(c.max() - c.min()) < 30
            if grey:
                near = np.linalg.norm(sec - c[None, None, :], axis=2) < 25
            else:
                ch = cv2.cvtColor(c.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2HSV)[0, 0].astype(np.float32)
                dh = np.abs(sec_hsv[..., 0] - ch[0])
                dh = np.minimum(dh, 180 - dh)
                near = (dh <= 10) & (sec_hsv[..., 1] >= 50) & (sec_hsv[..., 2] >= 80)
            hit = near.any(axis=1)
            if grey:
                hit &= sec.mean(axis=2).min(axis=1) > float(c.mean()) - 60
            cover.append(float(hit.mean()))
        k = int(np.argmax(cover))
        out.append(legend[k] if cover[k] >= 0.4 else None)
    return out
