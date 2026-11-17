"""Loading, size normalisation, deskew and ink extraction."""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Prepared:
    gray: np.ndarray          # uint8, deskewed, size-normalised
    ink: np.ndarray           # uint8 0/255, dark pixels without 1-px speckle
    ink_fine: np.ndarray      # uint8 0/255, all dark pixels
    ink_symbol: np.ndarray    # uint8 0/255, lighter threshold: thin, faint symbols (door arcs, glazing)
    scale_to_original: float  # pixels of `gray` per pixel of the input image
    deskew_deg: float         # rotation applied (degrees, counter-clockwise)
    original_size: tuple[int, int]  # (width, height) of the input
    page_count: int = 1


def load_image(path: str | Path, page: int = 0, pdf_dpi: int = 200) -> tuple[np.ndarray, int]:
    """Returns (BGR image, number of pages). PDFs are rendered with pypdfium2."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext == ".pdf":
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        count = len(pdf)
        bitmap = pdf[min(page, count - 1)].render(scale=pdf_dpi / 72.0)
        rgb = np.asarray(bitmap.to_pil().convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), count
    # PIL handles EXIF rotation and odd formats; OpenCV then takes over
    from PIL import Image, ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR), 1


def normalise_size(img: np.ndarray, max_side: int = 4000, min_side: int = 1500) -> tuple[np.ndarray, float]:
    """Brings the drawing to a workable size. Large drawings are shrunk; small
    ones (under 1500 px) are enlarged up to 3x so a thin partition is still several pixels wide.
    Returns (image, factor of the working image to the input)."""
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest > max_side:
        factor = max_side / longest
        return cv2.resize(img, (round(w * factor), round(h * factor)), interpolation=cv2.INTER_AREA), factor
    if longest < min_side:
        factor = min(3.0, 2400 / longest)
        return cv2.resize(img, (round(w * factor), round(h * factor)), interpolation=cv2.INTER_CUBIC), factor
    return img, 1.0


def _ink(gray: np.ndarray) -> np.ndarray:
    """Dark strokes on a light background (Otsu, then a local check for plans
    with uneven lighting or a coloured background)."""
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    otsu, ink = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    # Otsu on a mostly white page can pick a high cut: keep only clearly dark
    cut = min(otsu, 170)
    _, ink = cv2.threshold(blur, cut, 255, cv2.THRESH_BINARY_INV)
    if ink.mean() > 127:  # light strokes on a dark page: invert
        ink = cv2.bitwise_not(ink)
    return ink


def estimate_skew_deg(gray: np.ndarray) -> float:
    """Dominant line angle modulo 90 degrees, from long straight lines."""
    edges = cv2.Canny(gray, 60, 160)
    h, w = gray.shape
    lines = cv2.HoughLinesP(
        edges, 1, math.pi / 720, threshold=80,
        minLineLength=int(0.08 * min(h, w)), maxLineGap=8,
    )
    if lines is None:
        return 0.0
    angles, weights = [], []
    for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
        length = math.hypot(x2 - x1, y2 - y1)
        a = math.degrees(math.atan2(y2 - y1, x2 - x1))
        a = (a + 45) % 90 - 45  # into [-45, 45)
        angles.append(a)
        weights.append(length)
    angles, weights = np.array(angles), np.array(weights)
    # weighted median
    order = np.argsort(angles)
    cum = np.cumsum(weights[order])
    return float(angles[order][np.searchsorted(cum, cum[-1] / 2)])


def rotate_keep(img: np.ndarray, deg: float, fill: int) -> np.ndarray:
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=fill)


def prepare(path: str | Path, *, max_side: int = 4000, deskew: bool = True,
            page: int = 0, pdf_dpi: int = 200, aspect_y: float = 1.0) -> tuple[Prepared, np.ndarray]:
    """Returns (Prepared, colour image after deskew/resize for overlays)."""
    img, pages = load_image(path, page=page, pdf_dpi=pdf_dpi)
    original_size = (img.shape[1], img.shape[0])
    if abs(aspect_y - 1.0) > 0.005:   # a stretched picture: make its pixels square (see printed_scale)
        img = cv2.resize(img, (img.shape[1], max(8, round(img.shape[0] * aspect_y))),
                         interpolation=cv2.INTER_AREA if aspect_y < 1 else cv2.INTER_CUBIC)
    img, factor = normalise_size(img, max_side)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # contrast: stretch so faint plans still threshold sensibly
    lo, hi = np.percentile(gray, (1, 99))
    if hi - lo > 20:
        gray = np.clip((gray.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    angle = 0.0
    if deskew:
        angle = estimate_skew_deg(gray)
        if abs(angle) >= 0.25:
            gray = rotate_keep(gray, angle, 255)
            img = rotate_keep(img, angle, 255)
        else:
            angle = 0.0
    ink_fine = _ink(gray)
    _, ink_symbol = cv2.threshold(cv2.GaussianBlur(gray, (3, 3), 0), 205, 255, cv2.THRESH_BINARY_INV)
    # speckle: single-pixel noise (thin 1-px symbols stay in ink_fine)
    ink = cv2.morphologyEx(ink_fine, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return Prepared(gray=gray, ink=ink, ink_fine=ink_fine, ink_symbol=ink_symbol, scale_to_original=factor, deskew_deg=angle,
                    original_size=original_size, page_count=pages), img
