"""Learned floor-plan segmentation (U-Net, ONNX) used in place of the colour/ink heuristics.

The network labels every pixel: 0 background, 1 wall, 2 door, 3 window, 4 floor, 5 column, 6 AP marker (a Wi-Fi
symbol) and, from run5 on, 7 desk, 8 chair, 9 table, 10 sofa, 11 plant, 12 pod/booth, 13 storage, and from run6 on
14 stairs and 15 void (hatched / filled areas that are not wall: shafts, risers, open to sky). Run4 had 7 classes;
the file in use is chosen by MODEL_NAME below, and the wall/door/window/column/AP stage works with all of them (stairs
and voids are never wall ink). Run6 was trained on the dataset_v6 mix (hard cases: dense CAD and RF exports, low
resolution, hatched voids, overlays) with a connectivity loss; see train/README.md. It was trained from scratch on synthetic plans (see train/ and train/LICENSES.md) and runs on the CPU
through onnxruntime, so the worker needs no PyTorch. Everything after the mask (wall lines, openings, rooms,
scale) is the existing geometry code.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import cv2
import numpy as np

# To go back to the previous model, set this to "floorplan_unet_run5.onnx" (or set FLOORPLAN_MODEL).
MODEL_NAME = "floorplan_unet_run6.onnx"
MODEL_PATH = Path(os.environ.get("FLOORPLAN_MODEL", Path(__file__).resolve().parents[1] / "models" / MODEL_NAME))
CLASSES = ["background", "wall", "door", "window", "floor", "column", "ap",
           "desk", "chair", "table", "sofa", "plant", "pod", "storage", "stairs", "void"]
WALL, DOOR, WINDOW, FLOOR, COLUMN, AP = 1, 2, 3, 4, 5, 6
DESK, CHAIR, TABLE, SOFA, PLANT, POD, STORAGE = 7, 8, 9, 10, 11, 12, 13
STAIRS, VOID = 14, 15
MODEL_MAX_SIDE = 2400      # the network was trained on images up to this size; larger ones are scaled down

_session = None


def available() -> bool:
    if not MODEL_PATH.exists():
        return False
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def _get_session():
    global _session
    if _session is None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, (os.cpu_count() or 4) - 2)
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
        _session = ort.InferenceSession(str(MODEL_PATH), options, providers=providers)
    return _session


def _classes_in_model() -> int:
    return int(_get_session().get_outputs()[0].shape[1])


def info() -> dict:
    return {"name": MODEL_PATH.name, "classes": CLASSES[: _classes_in_model()], "sizeMB": round(MODEL_PATH.stat().st_size / 1e6, 1)}


TILE = 1536               # drawings larger than MODEL_MAX_SIDE are read at full resolution in tiles of this size
TILE_OVERLAP = 160         # each tile keeps only its centre; the overlap hides the tile edges
_cache: list[tuple[bytes, np.ndarray, dict]] = []   # the last few label maps (Auto reads one drawing several times)


def _run(img: np.ndarray) -> np.ndarray:
    ih, iw = img.shape[:2]
    ph, pw = (-ih) % 32, (-iw) % 32
    if ph or pw:
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
    x = (img.astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]   # BGR, as in training
    logits = _get_session().run(None, {"image": np.ascontiguousarray(x)})[0]
    return logits[0].argmax(0).astype(np.uint8)[:ih, :iw]


def _tiled(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    out = np.zeros((h, w), np.uint8)
    step = TILE - 2 * TILE_OVERLAP
    for y0 in range(0, max(1, h - 2 * TILE_OVERLAP), step):
        for x0 in range(0, max(1, w - 2 * TILE_OVERLAP), step):
            ty, tx = max(0, min(y0, h - TILE)), max(0, min(x0, w - TILE))
            lab = _run(bgr[ty:ty + TILE, tx:tx + TILE])
            # keep the tile's centre (its outer TILE_OVERLAP pixels only where the picture ends)
            ky0 = 0 if ty == 0 else TILE_OVERLAP
            kx0 = 0 if tx == 0 else TILE_OVERLAP
            ky1 = lab.shape[0] if ty + lab.shape[0] >= h else lab.shape[0] - TILE_OVERLAP
            kx1 = lab.shape[1] if tx + lab.shape[1] >= w else lab.shape[1] - TILE_OVERLAP
            out[ty + ky0:ty + ky1, tx + kx0:tx + kx1] = lab[ky0:ky1, kx0:kx1]
    return out


def segment(bgr: np.ndarray, *, tiles: bool | None = None) -> tuple[np.ndarray, dict]:
    """Label map (uint8, same height and width as `bgr`) and timing info. `bgr` is the OpenCV colour image.

    A drawing larger than MODEL_MAX_SIDE is read at full resolution in overlapping tiles (thin walls and door
    gaps survive; set FLOORPLAN_TILES=0 or tiles=False to scale it down instead, which is faster)."""
    import hashlib

    t0 = time.perf_counter()
    h, w = bgr.shape[:2]
    if tiles is None:
        tiles = os.environ.get("FLOORPLAN_TILES", "1") != "0"
    key = hashlib.blake2b(np.ascontiguousarray(bgr).tobytes(), digest_size=16).digest() + bytes([tiles]) + str(MODEL_PATH).encode()
    for k, lab, meta in _cache:
        if k == key:
            return lab.copy(), {**meta, "cached": True}
    if max(h, w) > MODEL_MAX_SIDE and tiles:
        labels = _tiled(bgr)
        meta = {"inputSize": [w, h], "scaledBy": 1.0, "tiles": True}
    else:
        f = min(1.0, MODEL_MAX_SIDE / max(h, w))
        img = bgr if f >= 1.0 else cv2.resize(bgr, (max(8, round(w * f)), max(8, round(h * f))), interpolation=cv2.INTER_AREA)
        labels = _run(img)
        if f < 1.0:
            labels = cv2.resize(labels, (w, h), interpolation=cv2.INTER_NEAREST)
        meta = {"inputSize": [img.shape[1], img.shape[0]], "scaledBy": round(f, 4)}
    meta["seconds"] = round(time.perf_counter() - t0, 3)
    _cache.append((key, labels.copy(), meta))
    del _cache[:-3]
    return labels, meta


# classes the geometry stage uses to judge walls (vector.building_mask / drop_false_walls)
GEOMETRY_CLASSES = {
    "inside": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    "wall": [1, 5],
    "opening": [2, 3],
    "clutter": [7, 8, 9, 10, 11, 12, 13, 14, 15],
}


def blobs(mask: np.ndarray, min_area: float) -> list[dict]:
    """Connected regions of a boolean/0-1 mask as {x, y, width, height, area} (x, y = centre)."""
    n, _, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area >= min_area:
            out.append({"x": float(cent[i][0]), "y": float(cent[i][1]), "width": float(stats[i, cv2.CC_STAT_WIDTH]),
                        "height": float(stats[i, cv2.CC_STAT_HEIGHT]), "area": area,
                        "left": int(stats[i, cv2.CC_STAT_LEFT]), "top": int(stats[i, cv2.CC_STAT_TOP])})
    return out


def bridge_markers(wall: np.ndarray, ap_blobs: list[dict], reach: int = 6) -> np.ndarray:
    """A Wi-Fi marker drawn on a wall hides the wall under it. Where wall pixels continue on both sides of a
    marker (left/right or above/below), the covered stretch is filled so the wall stays one line."""
    out = wall.copy()
    h, w = wall.shape
    for b in ap_blobs:
        x0, y0 = b["left"], b["top"]
        x1, y1 = x0 + int(b["width"]), y0 + int(b["height"])
        # horizontal wall: rows with wall just left and just right of the marker
        lo, hi = max(0, x0 - reach), min(w, x1 + reach)
        left = wall[y0:y1, lo:x0].any(axis=1) if x0 > lo else np.zeros(y1 - y0, bool)
        right = wall[y0:y1, x1:hi].any(axis=1) if hi > x1 else np.zeros(y1 - y0, bool)
        rows = left & right
        if rows.any():
            out[y0:y1, x0:x1][rows] = True
        # vertical wall: columns with wall just above and just below
        lo, hi = max(0, y0 - reach), min(h, y1 + reach)
        up = wall[lo:y0, x0:x1].any(axis=0) if y0 > lo else np.zeros(x1 - x0, bool)
        down = wall[y1:hi, x0:x1].any(axis=0) if hi > y1 else np.zeros(x1 - x0, bool)
        cols = up & down
        if cols.any():
            out[y0:y1, x0:x1][:, cols] = True
    return out


def structure(labels: np.ndarray) -> dict:
    """What the geometry stage needs from a label map: wall ink, AP markers, columns."""
    h, w = labels.shape
    min_blob = max(30.0, 1e-4 * h * w)
    markers = blobs(labels == AP, min_blob)
    wall = (labels == WALL) | (labels == COLUMN)
    ink = bridge_markers(wall, markers)
    columns = blobs(labels == COLUMN, min_blob)
    return {"ink": (ink.astype(np.uint8) * 255), "markers": markers, "columns": columns}


PALETTE_BGR = {WALL: (60, 60, 220), DOOR: (60, 190, 60), WINDOW: (220, 140, 40), FLOOR: (150, 235, 240),
               COLUMN: (200, 60, 170), AP: (0, 140, 255),
               DESK: (0, 215, 255), CHAIR: (230, 120, 20), TABLE: (0, 165, 255), SOFA: (180, 105, 255),
               PLANT: (60, 180, 75), POD: (170, 170, 60), STORAGE: (120, 120, 120),
               STAIRS: (220, 60, 180), VOID: (130, 130, 255)}


def overlay(bgr: np.ndarray, labels: np.ndarray, alpha: float = 0.5) -> np.ndarray:
    colour = np.zeros_like(bgr)
    for cls, bgr_c in PALETTE_BGR.items():
        colour[labels == cls] = bgr_c
    shown = (labels != 0)[..., None]
    return np.where(shown, cv2.addWeighted(bgr, 1 - alpha, colour, alpha, 0), bgr)


FURNITURE_CLASSES = {DESK: "desk", CHAIR: "chair", TABLE: "table", SOFA: "sofa", PLANT: "plant", POD: "pod",
                     STORAGE: "storage"}
# Default sizes used only to reject impossible blobs (m); the real size comes from the drawing's scale.
_MIN_SIDE_M = {"desk": 0.35, "chair": 0.2, "table": 0.4, "sofa": 0.4, "plant": 0.15, "pod": 0.7, "storage": 0.3}
_MAX_AREA_M2 = {"desk": 14.0, "chair": 1.2, "table": 14.0, "sofa": 8.0, "plant": 3.0, "pod": 8.0, "storage": 8.0}


def furniture(labels: np.ndarray, px_per_m: float | None) -> list[dict]:
    """Furniture objects read from the label map: one box per connected region of a furniture class.

    Boxes are the tightest rotated rectangle, kept as an axis-aligned box when the region is not clearly
    turned. Touching chairs that merged into one region are split along their long side by the typical
    (median) chair area. Without a scale the boxes stay in pixels and `widthM`/`depthM` are None."""
    out: list[dict] = []
    h, w = labels.shape
    for cls, kind in FURNITURE_CLASSES.items():
        mask = (labels == cls).astype(np.uint8)
        if not mask.any():
            continue
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, comp, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        areas = [int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n)]
        if not areas:
            continue
        min_px = max(12, int(1.2e-5 * h * w))
        typical = float(np.median([a for a in areas if a >= min_px] or [1]))
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < min_px:
                continue
            pts = np.column_stack(np.where(comp == i))[:, ::-1].astype(np.float32)
            (cx, cy), (rw, rh), angle = cv2.minAreaRect(pts)
            if rw < rh:
                rw, rh, angle = rh, rw, angle + 90
            turned = 12 < (angle % 90) < 78
            if turned:
                x, y = float(pts[:, 0].min()), float(pts[:, 1].min())
                bw, bh = float(pts[:, 0].max() - x + 1), float(pts[:, 1].max() - y + 1)
                cx, cy = x + bw / 2, y + bh / 2
                rw, rh = max(bw, bh), min(bw, bh)
                horizontal = bw >= bh
            else:
                horizontal = abs(angle % 180) < 45 or abs(angle % 180) > 135
                bw, bh = (rw, rh) if horizontal else (rh, rw)
                x, y = cx - bw / 2, cy - bh / 2
            pieces = 1
            if kind == "chair" and typical > 0 and area > 1.8 * typical and rh > 0:
                pieces = min(12, max(1, round(area / typical)))
            for k in range(pieces):
                if pieces == 1:
                    px, py, pw, ph = x, y, bw, bh
                elif horizontal:
                    pw = bw / pieces
                    px, py, ph = x + k * pw, y, bh
                else:
                    ph = bh / pieces
                    px, py, pw = x, y + k * ph, bw
                item = {"kind": kind, "x": round(px + pw / 2, 1), "y": round(py + ph / 2, 1),
                        "left": round(px, 1), "top": round(py, 1), "widthPx": round(pw, 1),
                        "depthPx": round(ph, 1), "areaPx": int(area / pieces)}
                if px_per_m:
                    wm, dm = pw / px_per_m, ph / px_per_m
                    if min(wm, dm) < _MIN_SIDE_M[kind] * 0.5 or wm * dm > _MAX_AREA_M2[kind]:
                        continue
                    item.update({"widthM": round(wm, 3), "depthM": round(dm, 3),
                                 "xM": round((px + pw / 2) / px_per_m, 3), "yM": round((py + ph / 2) / px_per_m, 3)})
                out.append(item)
    return out
