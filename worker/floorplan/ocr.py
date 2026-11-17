"""Text on the drawing: room labels and dimension text (RapidOCR, local, free)."""
from __future__ import annotations

import logging
import re

import numpy as np

_ENGINE = None

_NUMBER = r"\d{1,3}(?:[.,]\d{1,3})?|\d{3,6}"
_DIM = re.compile(rf"^\s*({_NUMBER})\s*(mm|cm|m)?\s*$", re.IGNORECASE)
_FEET = re.compile(r"^\s*(\d+)\s*['’]\s*-?\s*(\d+(?:\.\d+)?)?\s*[\"”]?\s*$")


def _engine():
    global _ENGINE
    if _ENGINE is None:
        logging.getLogger("RapidOCR").setLevel(logging.ERROR)
        from rapidocr import RapidOCR

        _ENGINE = RapidOCR()
    return _ENGINE


def parse_dimension(text: str) -> tuple[float, str] | None:
    """(metres, how sure) for text such as '5.20 m', '4200', '12\\'-6\"'."""
    m = _FEET.match(text)
    if m:
        feet, inches = float(m.group(1)), float(m.group(2) or 0)
        return (feet * 12 + inches) * 0.0254, "feet-inches"
    m = _DIM.match(text.replace(" ", ""))
    if not m:
        return None
    value = float(m.group(1).replace(",", "."))
    unit = (m.group(2) or "").lower()
    if unit == "mm":
        return value / 1000, "mm"
    if unit == "cm":
        return value / 100, "cm"
    if unit == "m":
        return value, "m"
    # no unit: whole numbers of 3+ digits are almost always millimetres
    if value >= 300 and float(value).is_integer():
        return value / 1000, "assumed mm"
    if value < 100:
        return value, "assumed m"
    return None


def read_text(gray: np.ndarray, min_score: float = 0.5) -> list[dict]:
    """Recognised text with positions in pixels of `gray`."""
    try:
        result = _engine()(gray)
    except Exception as error:  # OCR is optional: the walls do not depend on it
        return [{"kind": "error", "text": str(error)}]
    if result is None or result.boxes is None:
        return []
    out: list[dict] = []
    for box, text, score in zip(result.boxes, result.txts, result.scores):
        score = float(score)
        text = str(text).strip()
        if not text or score < min_score:
            continue
        pts = np.asarray(box, dtype=float)
        x, y = float(pts[:, 0].mean()), float(pts[:, 1].mean())
        h = float(pts[:, 1].max() - pts[:, 1].min())
        w = float(pts[:, 0].max() - pts[:, 0].min())
        entry = {"text": text, "x": x, "y": y, "width": w, "height": h, "score": score,
                 "box": pts.tolist(), "kind": "other"}
        dim = parse_dimension(text)
        letters = sum(c.isalpha() for c in text)
        if dim and letters <= 2:
            entry.update(kind="dimension", metres=dim[0], how=dim[1])
        elif letters >= 3:
            entry["kind"] = "label"
        out.append(entry)
    return out
