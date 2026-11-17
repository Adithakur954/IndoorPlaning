"""Scale from the overall size printed on a drawing ("31.60 m (Length)" on a dimension line).

For every printed size the dimension line next to it is found (same colour as the text, running along it) and
measured in pixels; metres per pixel is then the printed value divided by that length. The horizontal and the
vertical line each give an independent estimate: when they agree the scale is trusted, when they disagree the
result is returned with a low confidence and the app asks for a known length instead.
"""
from __future__ import annotations

import cv2
import numpy as np

MIN_METRES = 3.0          # a printed overall size, not a door width
AGREE_PCT = 3.0


def _text_colour(colour: np.ndarray, box: np.ndarray) -> np.ndarray | None:
    """Dominant ink colour of a text box (BGR), None when the text is plain grey/black."""
    x0, y0 = np.floor(box.min(0)).astype(int)
    x1, y1 = np.ceil(box.max(0)).astype(int)
    crop = colour[max(0, y0):y1, max(0, x0):x1]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    sel = (hsv[:, 1] > 90) & (hsv[:, 2] > 40)
    if sel.sum() < 12:
        return None
    return np.median(crop.reshape(-1, 3)[sel], axis=0)


def _longest_run(line: np.ndarray, max_gap: int = 3) -> tuple[int, int] | None:
    """(start, end) of the longest run of True values, bridging gaps of up to `max_gap`."""
    idx = np.flatnonzero(line)
    if idx.size == 0:
        return None
    best = (int(idx[0]), int(idx[0]))
    start = prev = int(idx[0])
    for i in idx[1:]:
        i = int(i)
        if i - prev > max_gap + 1:
            if prev - start > best[1] - best[0]:
                best = (start, prev)
            start = i
        prev = i
    if prev - start > best[1] - best[0]:
        best = (start, prev)
    return best


def _measure(colour: np.ndarray, text: dict, ink_bgr: np.ndarray, horizontal: bool) -> dict | None:
    box = np.asarray(text["box"], float)
    w, h = box[:, 0].max() - box[:, 0].min(), box[:, 1].max() - box[:, 1].min()
    dist = np.linalg.norm(colour.astype(np.float32) - ink_bgr.astype(np.float32), axis=2)
    mask = dist < 70
    H, W = mask.shape
    reach = int(min(w, h)) * 3 + 8      # a dimension line sits within a few text heights of its text
    bridge = int(max(w, h)) + 24        # the text often sits ON the line and interrupts it
    cx, cy = float(box[:, 0].mean()), float(box[:, 1].mean())
    best = None
    if horizontal:
        for y in range(max(0, int(cy - reach)), min(H, int(cy + reach) + 1)):
            run = _longest_run(mask[y], bridge)
            if run and (best is None or run[1] - run[0] > best["length"]):
                best = {"length": run[1] - run[0], "a": (run[0], y), "b": (run[1], y)}
    else:
        for x in range(max(0, int(cx - reach)), min(W, int(cx + reach) + 1)):
            run = _longest_run(mask[:, x], bridge)
            if run and (best is None or run[1] - run[0] > best["length"]):
                best = {"length": run[1] - run[0], "a": (x, run[0]), "b": (x, run[1])}
    if best is None or best["length"] < 0.15 * (W if horizontal else H):
        return None
    best["horizontal"] = horizontal
    return best


def estimate(colour: np.ndarray, texts: list[dict]) -> dict:
    """{"pxPerM", "confidence", "votes", "spreadPct", "found": [...]} or {"pxPerM": None, ...}."""
    found = []
    for t in texts:
        if t.get("kind") != "dimension" or t.get("how") != "m" or float(t.get("metres", 0)) < MIN_METRES:
            continue
        ink = _text_colour(colour, np.asarray(t["box"], float))
        if ink is None:
            continue
        # the OCR does not always report the turn of vertical text: try both directions, keep the longer line
        lines = [m for m in (_measure(colour, t, ink, True), _measure(colour, t, ink, False)) if m]
        if not lines:
            continue
        line = max(lines, key=lambda m: m["length"])
        found.append({"text": t["text"], "metres": float(t["metres"]), "linePx": float(line["length"]),
                      "pxPerM": line["length"] / float(t["metres"]), "horizontal": line["horizontal"],
                      "a": line["a"], "b": line["b"]})
    if not found:
        return {"pxPerM": None, "confidence": 0.0, "votes": 0, "found": []}
    hx = [f["pxPerM"] for f in found if f["horizontal"]]
    vy = [f["pxPerM"] for f in found if not f["horizontal"]]
    x = float(np.median(hx)) if hx else None
    y = float(np.median(vy)) if vy else None
    out = {"xPxPerM": x, "yPxPerM": y, "found": found, "votes": len(found), "stretched": False, "aspect": 1.0}
    if x and y:
        ratio = x / y                      # < 1: vertical pixels are denser than horizontal ones
        spread = 100 * abs(ratio - 1)
        out["spreadPct"] = round(spread, 2)
        if spread <= AGREE_PCT:
            out.update(pxPerM=float(np.median(hx + vy)), confidence=0.95)
        elif spread <= 30:
            # both lines are clean but disagree: the picture itself is stretched (resized without keeping its
            # proportions). The vertical axis is rescaled by `aspect` and the scale is read again afterwards.
            out.update(pxPerM=None, candidate=x, confidence=0.8, stretched=True, aspect=ratio)
        else:
            out.update(pxPerM=None, candidate=x, confidence=0.2)
    else:
        out.update(pxPerM=x or y, confidence=0.7, spreadPct=0.0)
    return out
