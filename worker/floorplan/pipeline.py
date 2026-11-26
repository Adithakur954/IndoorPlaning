"""End-to-end reconstruction: image -> walls, openings, rooms (+ overlay)."""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import cv2
import numpy as np

from . import __version__
from . import scale_auto
from .colour import analyse as analyse_colour
from .colour import remove_markers
from .openings import classify_gaps, classify_gaps_labels
from .overlay import draw_mask_preview, draw_overlay
from .preprocess import prepare
from . import vector
from .perimeter import find_frame, find_perimeter, perimeter_walls
from .rooms import (build_rooms, drop_isolated_fragments, drop_small_networks, label_rooms, main_network_bounds,
                    room_wall_support, topology_report)
from .walls import (
    close_corners,
    double_line_mask,
    drop_small_components,
    estimate_thickness,
    extend_free_ends,
    extract_columns,
    extract_segments,
    merge_collinear,
    snap_junctions,
    thin_line_walls,
    wall_mask,
)

ASSUMED_WALL_M = 0.2   # only used to size thresholds when no scale is known


class _Meter:
    """Timings and peak RAM per stage."""

    def __init__(self) -> None:
        import psutil

        self.proc = psutil.Process()
        self.t0 = time.perf_counter()
        self.last = self.t0
        self.stages: dict[str, float] = {}
        self.peak_mb = self.proc.memory_info().rss / 1e6

    def mark(self, name: str) -> None:
        now = time.perf_counter()
        self.stages[name] = round(now - self.last, 3)
        self.last = now
        self.peak_mb = max(self.peak_mb, self.proc.memory_info().rss / 1e6)

    def summary(self) -> dict:
        return {"stagesSeconds": self.stages,
                "totalSeconds": round(time.perf_counter() - self.t0, 3),
                "peakRamMB": round(self.peak_mb, 1),
                "peakVramMB": 0.0,
                "device": "cpu"}


_FURNITURE_BGR = {"desk": (0, 190, 255), "chair": (230, 120, 20), "table": (0, 140, 255), "sofa": (180, 105, 255),
                  "plant": (60, 180, 75), "pod": (170, 170, 60), "storage": (130, 130, 130)}


def _draw_furniture(img, items: list[dict]) -> None:
    """Outline every detected piece of furniture on the overlay picture."""
    for f in items:
        p0 = (int(f["left"]), int(f["top"]))
        p1 = (int(f["left"] + f["widthPx"]), int(f["top"] + f["depthPx"]))
        cv2.rectangle(img, p0, p1, _FURNITURE_BGR.get(f["kind"], (0, 0, 0)), 2)


def _px_per_m(scale: dict | None, prepared, processed_width: int) -> tuple[float | None, str, float]:
    """(pixels per metre in the processed image, source, confidence)."""
    if not scale:
        return None, "unknown", 0.0
    if scale.get("pxPerM"):
        # given for the ORIGINAL image; the working image may have been resized
        return float(scale["pxPerM"]) * prepared.scale_to_original, "user", 1.0
    if scale.get("lengthM") and scale.get("pointA") and scale.get("pointB"):
        (ax, ay), (bx, by) = scale["pointA"], scale["pointB"]
        dist = math.hypot(bx - ax, by - ay) * prepared.scale_to_original
        if dist > 5 and float(scale["lengthM"]) > 0:
            return dist / float(scale["lengthM"]), "user (two points)", 1.0
    if scale.get("imageWidthM") and float(scale["imageWidthM"]) > 0:
        return processed_width / float(scale["imageWidthM"]), "user (image width)", 0.8
    return None, "unknown", 0.0


def _coverage(mask: np.ndarray, wall, gaps_abs: list[tuple[float, float]]) -> float:
    """Share of the wall centre-line (outside gaps) that lies on dark pixels."""
    n = max(10, int(wall.length / 2))
    hits = total = 0
    for i in range(n):
        t = (i + 0.5) / n
        x = wall.a[0] + (wall.b[0] - wall.a[0]) * t
        y = wall.a[1] + (wall.b[1] - wall.a[1]) * t
        along = x if wall.orientation == "h" else y
        if any(g0 <= along <= g1 for g0, g1 in gaps_abs):
            continue
        total += 1
        xi, yi = int(round(x)), int(round(y))
        if 0 <= yi < mask.shape[0] and 0 <= xi < mask.shape[1] and mask[
                max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2].any():
            hits += 1
    return hits / total if total else 0.0


def _wall_lengths(result: dict) -> tuple[float, float]:
    """(total, closed) wall length in px; closed = on the outline of a room."""
    length = lambda w_: math.hypot(w_["b"][0] - w_["a"][0], w_["b"][1] - w_["a"][1])
    total = sum(length(w_) for w_ in result["walls"])
    closed = sum(length(w_) for w_ in result["walls"] if w_["role"] in ("exterior", "interior"))
    return total, closed


def _quality(result: dict, reference_px: float | None = None) -> float:
    """How well a reading holds together: the wall length that bounds a closed room,
    as a share of `reference_px` (the longest reading of the same drawing, so that
    finding more of the building counts, not only finding a tidy outline), minus a
    penalty for loose wall ends. Used to choose between readings of one drawing."""
    walls = result["walls"]
    if not walls:
        return -1.0
    total, closed = _wall_lengths(result)
    dangling = len(result["topology"]["danglingEnds"]) / (2 * len(walls))
    return closed / max(reference_px or total, 1.0) - 0.5 * dangling


def _fidelity(result: dict, model_wall: np.ndarray, skeleton: np.ndarray, tol: int) -> tuple[float, float, float]:
    """How well a reading's walls match what the learned model sees as wall (precision, recall, F1).
    Precision: share of the reading's wall length that lies on model wall pixels (a classical reading that draws
    walls along desk rows, conveyors or cable runs loses here). Recall: share of the model's wall centre-line that
    the reading covers (a reading that drops walls loses here). Virtual walls (closing lines) are not judged."""
    h, w = model_wall.shape
    near_wall = cv2.dilate(model_wall.astype(np.uint8), np.ones((2 * tol + 1, 2 * tol + 1), np.uint8)) > 0
    drawn = np.zeros((h, w), np.uint8)
    hits = total = 0.0
    for wl in result["walls"]:
        if wl.get("role") == "virtual":
            continue
        (x0, y0), (x1, y1) = wl["a"], wl["b"]
        n = max(2, int(math.hypot(x1 - x0, y1 - y0)))
        for i in range(n + 1):
            t = i / n
            xi, yi = int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t))
            if 0 <= yi < h and 0 <= xi < w:
                total += 1
                hits += near_wall[yi, xi]
        cv2.line(drawn, (int(round(x0)), int(round(y0))), (int(round(x1)), int(round(y1))), 255, 2 * tol + 1)
    precision = hits / total if total else 0.0
    sk = int(skeleton.sum())
    recall = float((skeleton & (drawn > 0)).sum()) / sk if sk else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    return precision, recall, f1


def reconstruct(image_path: str | Path, out_dir: str | Path, *, scale: dict | None = None,
                options: dict | None = None) -> dict:
    """Image -> walls, openings, rooms. With engine "auto" (the default) and the
    learned model installed, the drawing is read both by the model and by the
    classical method, and the reading whose walls join into rooms best is kept:
    neither wins on every kind of drawing."""
    opts = dict(options or {})
    engine = opts.get("engine", "auto")
    if engine != "auto":
        return _reconstruct(image_path, out_dir, scale=scale, options=opts)
    from . import model as net

    import shutil

    out = Path(out_dir)
    runs: dict[str, dict] = {}
    # thin lines: some plans draw every wall as a thin line, others draw furniture and
    # dimension lines thin and walls thick; the reading that closes rooms best decides
    # (on a tie the first wins: the classical reading is the one the tests pin down)
    variants = {"classical": {"engine": "classical"}, "model": {"engine": "model"},
                "thin lines": {"engine": "classical", "thin_lines": True}}
    if not net.available():
        variants.pop("model")
    for name, extra in variants.items():
        sub = out / f"_{name.replace(' ', '_')}"
        try:
            runs[name] = _reconstruct(image_path, sub, scale=scale, options={**opts, **extra})
        except Exception as error:   # one reading failing must not block the import
            runs[name] = {"error": str(error)}
    ok = {k: r for k, r in runs.items() if "error" not in r}
    if not ok:
        raise RuntimeError(next(iter(runs.values()))["error"])
    reference = max(_wall_lengths(r)[0] for r in ok.values())
    closure = {k: _quality(r, reference) for k, r in ok.items()}
    # With the learned model installed, each reading is also checked against what the model sees as wall: closing
    # rooms is not enough when the walls are drawn along desk rows or conveyors (room count alone favours that).
    fidelity: dict[str, tuple[float, float, float]] = {}
    if "model" in ok:
        try:
            deskewed = cv2.imread(str(out / "_model" / "deskewed.png"))
            if deskewed is not None:
                labels, _ = net.segment(deskewed)
                model_wall = (labels == net.WALL) | (labels == net.COLUMN)
                from skimage.morphology import skeletonize
                skeleton = skeletonize(model_wall)
                tol = max(2, int(round(min(deskewed.shape[:2]) / 400)))
                for k, r in ok.items():
                    f_ = deskewed.shape[1] / max(r["image"]["widthPx"], 1)
                    scaled = {**r, "walls": [{**w_, "a": [w_["a"][0] * f_, w_["a"][1] * f_],
                                              "b": [w_["b"][0] * f_, w_["b"][1] * f_]} for w_ in r["walls"]]}
                    fidelity[k] = _fidelity(scaled, model_wall, skeleton, tol)
        except Exception as error:   # the check must never block an import
            fidelity = {}
            ok[next(iter(ok))].setdefault("warnings", []).append(f"wall check against the model skipped ({error})")
    if fidelity:
        # 60 %: the walls are where the drawing has walls (F1 against the model); 40 %: they close into rooms
        scores = {k: round(float(0.6 * fidelity[k][2] + 0.4 * closure[k]), 3) for k in ok}
    else:
        scores = {k: round(float(closure[k]), 3) for k in ok}
    best = max(scores, key=scores.get)
    # reading thin lines can also turn furniture edges into walls: it must win clearly
    THIN_MARGIN = 0.15
    if best == "thin lines" and len(scores) > 1:
        runner_up = max((k for k in scores if k != best), key=scores.get)
        if scores[best] - scores[runner_up] < THIN_MARGIN:
            best = runner_up
    for f in (out / f"_{best.replace(' ', '_')}").iterdir():
        shutil.copy2(f, out / f.name)
    for name in runs:
        shutil.rmtree(out / f"_{name.replace(' ', '_')}", ignore_errors=True)
    result = ok[best]
    result["engineChoice"] = {
        "used": best, "scores": scores,
        "closure": {k: round(v, 3) for k, v in closure.items()},
        "fidelity": {k: {"precision": round(float(p), 3), "recall": round(float(rc), 3), "f1": round(float(f), 3)} for k, (p, rc, f) in fidelity.items()},
        "why": ("the reading whose walls best match the walls the learned model sees (60 %) and close into rooms "
                "(40 %)") if fidelity else ("the reading whose walls close into rooms best (share of wall length on a "
                                            "room outline, minus loose ends)"),
    }
    if len(scores) > 1:
        others = ", ".join(f"{k} {v:.2f}" for k, v in scores.items() if k != best)
        result["warnings"].append(f"read with the {best} method: its walls matched the drawing and closed into rooms best "
                                  f"({scores[best]:.2f}; {others})")
    (out / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def _reconstruct(image_path: str | Path, out_dir: str | Path, *, scale: dict | None = None,
                 options: dict | None = None) -> dict:
    opts = {"max_side": 4000, "deskew": True, "ocr": True, "wall_thickness_px": None,
            "wall_style": "auto", "min_room_m2": 1.0, "door_min_m": 0.55, "door_max_m": 2.6,
            "page": 0, "pdf_dpi": 200, "text_suppression": True, "colour_mode": "auto"}
    opts.update(options or {})
    if "max_side" not in (options or {}) and opts.get("engine") in ("model", "hybrid"):
        opts["max_side"] = 8000   # the model reads large drawings in full-resolution tiles: keep the detail
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meter = _Meter()
    warnings: list[str] = []

    # The overall size printed on the drawing ("31.60 m" on a dimension line) gives the scale. When the horizontal
    # and the vertical printed size disagree by 3-30 % the picture is stretched: the aspect is corrected first.
    from . import printed_scale as _ps

    aspect_y = 1.0
    printed_lines: list[dict] = []      # sizes printed on the drawing with their lines, in ORIGINAL picture pixels
    printed_xy: dict = {}
    # Two known lengths given (A-B across, C-D up-down): the scale across and the scale up-down, each from the
    # user. A stretched picture is then corrected exactly; nothing is assumed.
    two = _ps.two_length_scale(scale)
    stretch_pct = None
    if scale and scale.get("pointC") and scale.get("heightM") and two is None:
        warnings.append("the second length (C-D) was not used: it must run in another direction than A-B "
                        "(one across, one up-down)")
    if opts["ocr"] and opts.get("printed_scale", True):
        from .ocr import read_text as _read
        from .preprocess import load_image as _load, normalise_size as _norm

        raw, _pages = _load(image_path, page=opts["page"], pdf_dpi=opts["pdf_dpi"])
        small, _f = _norm(raw, opts["max_side"])
        pre = _ps.estimate(small, [t for t in _read(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)) if t["kind"] != "error"])
        for fnd in pre.get("found", []):
            printed_lines.append({"text": fnd["text"], "metres": fnd["metres"], "horizontal": fnd["horizontal"],
                                  "a": [round(fnd["a"][0] / _f, 1), round(fnd["a"][1] / _f, 1)],
                                  "b": [round(fnd["b"][0] / _f, 1), round(fnd["b"][1] / _f, 1)]})
        printed_xy = {k: (round(pre[k] / _f, 3) if pre.get(k) else None) for k in ("xPxPerM", "yPxPerM")}
        if pre.get("stretched") and two is None and not (scale or {}).get("notStretched"):
            aspect_y = float(pre["aspect"])
            warnings.append(f"the picture is stretched: the printed sizes imply {pre['xPxPerM']:.1f} px/m across but "
                            f"{pre['yPxPerM']:.1f} px/m down; its height was corrected by x{aspect_y:.3f}")
    if two is not None:
        kx, ky = two
        stretch_pct = round(100 * abs(kx / ky - 1), 2)
        if stretch_pct > 1.0:
            aspect_y = kx / ky
            warnings.append(f"your two lengths show the picture is stretched by {stretch_pct:.1f} % "
                            f"({kx:.2f} px/m across, {ky:.2f} px/m up-down): its height was corrected")
    if aspect_y != 1.0 and scale and scale.get("pointA") and scale.get("pointB"):
        # the picture is made square before anything else: the vertical coordinate of the clicked points follows it
        scale = {**scale, "pointA": [scale["pointA"][0], scale["pointA"][1] * aspect_y],
                 "pointB": [scale["pointB"][0], scale["pointB"][1] * aspect_y]}
    prepared, colour = prepare(image_path, max_side=opts["max_side"], deskew=opts["deskew"],
                               page=opts["page"], pdf_dpi=opts["pdf_dpi"], aspect_y=aspect_y)
    h, w = prepared.gray.shape
    meter.mark("load and preprocess")
    if prepared.page_count > 1:
        warnings.append(f"the PDF has {prepared.page_count} pages; page {opts['page'] + 1} was used")

    texts: list[dict] = []
    if opts["ocr"]:
        from .ocr import read_text

        texts = read_text(prepared.gray)
        texts = [t for t in texts if t["kind"] != "error"] or []
    meter.mark("ocr")

    layers = analyse_colour(colour)
    # learned segmentation (ONNX) when available; the colour / ink heuristics remain as the fallback
    labels = None
    model_meta: dict | None = None
    model_struct: dict | None = None
    if opts.get("engine", "auto") != "classical":
        from . import model as net

        if net.available():
            try:
                labels, model_meta = net.segment(colour)
                model_struct = net.structure(labels)
                model_meta.update(net.info())
            except Exception as error:   # a model problem must never block an import
                labels = None
                warnings.append(f"the learned model failed ({error}); the classical method was used")
        elif opts.get("engine") == "model":
            raise RuntimeError("engine 'model' requested but the model file or onnxruntime is missing")
    meter.mark("segmentation model")
    # "hybrid": the classical reading of the drawing, plus the network's wall pixels added to its mask; the
    # network's door/window pixels still classify the gaps. "model": the network alone decides the mask.
    hybrid = opts.get("engine") == "hybrid" and labels is not None
    labels_for_gaps = labels
    hybrid_ink = model_struct["ink"] if hybrid else None
    if hybrid:
        labels = None
    use_colour = labels is None and opts["colour_mode"] != "off" and layers.coloured
    if labels is not None:
        ink = model_struct["ink"].copy()
        line_ink = ink
    elif use_colour:
        # walls are neutral dark greys; planters, columns, door arcs, dimension
        # lines and AP markers are coloured and must not become walls
        line_ink = remove_markers(layers.neutral, layers.markers)   # keeps 1-px outlines
        ink = cv2.morphologyEx(line_ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        warnings.append("colour-coded drawing: walls were read from the neutral dark lines only")
    else:
        ink = prepared.ink.copy()
        line_ink = ink
    if hybrid_ink is not None:
        ink = cv2.bitwise_or(ink, hybrid_ink)
        line_ink = ink if line_ink is ink else cv2.bitwise_or(line_ink, hybrid_ink)
    if opts["text_suppression"]:
        for t in texts:
            if t["kind"] in ("label", "dimension") and t["score"] >= 0.6:
                pts = np.array(t["box"], dtype=np.int32)
                cv2.fillPoly(ink, [pts], 0)
                if line_ink is not ink:
                    cv2.fillPoly(line_ink, [pts], 0)

    px_per_m, scale_source, scale_conf = _px_per_m(scale, prepared, w)
    if two is not None and px_per_m:
        scale_source = "user (two lengths: across and up-down)"
    printed: dict | None = None
    if px_per_m is None and texts and opts.get("printed_scale", True):
        from . import printed_scale as _ps

        printed = _ps.estimate(colour, texts)
        if printed.get("pxPerM"):
            px_per_m = float(printed["pxPerM"])
            scale_source = "printed dimensions: " + " and ".join(f"{f['text']}" for f in printed["found"])
            scale_conf = float(printed["confidence"])
            if scale_conf < 0.9:
                warnings.append("the scale comes from one printed size only: confirm it against a known length")
        elif printed.get("found"):
            warnings.append("the printed sizes disagree with each other: confirm the scale with one known length")
    auto_scale: dict | None = None
    if px_per_m is None and opts["ocr"] and opts.get("auto_scale", True):
        # no scale given: look for labelled boxes ("3'8\" X 3'8\"") that agree
        from .ocr import read_text

        # only when the drawing prints sizes at all, and then only a few boxes
        more = scale_auto.box_texts(colour, read_text) if scale_auto.size_labels(texts) else []
        auto_scale = scale_auto.estimate(colour, [t for t in (texts + more) if t["kind"] != "error"])
        if auto_scale.get("pxPerM"):
            px_per_m = float(auto_scale["pxPerM"])
            scale_source = f"automatic: {auto_scale['votes']} size labels agree (+-{auto_scale['spreadPct']}%)"
            scale_conf = float(auto_scale["confidence"])
            warnings.append("the scale was found automatically from labelled boxes; confirm it against one known length")
        else:
            warnings.append("the scale could not be found automatically (not enough readable size labels): give one known length")
    if px_per_m is None and opts.get("fallback_scale"):
        # last resort before asking: the size of the picture given in the Excel (FloorMeta image_width_m / image_height_m)
        fb, fb_source, fb_conf = _px_per_m(opts["fallback_scale"], prepared, w)
        if fb:
            px_per_m, scale_source, scale_conf = fb, "from your Excel (FloorMeta image size)", 0.8
            warnings.append("no printed size was found: the scale comes from the image size in your Excel; check it")
    long_px = 2.5 * px_per_m if px_per_m else 0.12 * max(w, h)
    # text, digits and chair circles must not be mistaken for wall strokes
    ink_clean = drop_small_components(ink, max(0.012 * max(w, h), 12))
    thickness, other_thicknesses = estimate_thickness(ink_clean, long_px)
    if opts["wall_thickness_px"]:
        thickness = float(opts["wall_thickness_px"])
    working_px_per_m = px_per_m
    if working_px_per_m is None:
        working_px_per_m = thickness / ASSUMED_WALL_M
        warnings.append("no scale: thresholds assume a 0.2 m wall; give a known length for metric output")

    min_len = max(int(round(3 * thickness)), int(0.4 * working_px_per_m), 8)
    solid_ink = ink
    if use_colour:
        # hatched wall bands: close the gaps between the hatch lines
        solid_ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE,
                                     cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    # The model's wall pixels are walls whatever their width: a thin partition next to a heavy outer wall is kept
    # (the thickness opening below is for the classical reading, where thin ink is furniture or text).
    vectorise = labels is not None and opts.get("vectorise", "skeleton") == "skeleton"
    mask = ink.copy() if vectorise else wall_mask(solid_ink, thickness)
    for col in (layers.columns if labels is None else []):   # coloured wall piers keep the wall continuous
        x0, y0 = int(col["x"] - col["width"] / 2), int(col["y"] - col["height"] / 2)
        cv2.rectangle(mask, (x0, y0), (x0 + int(col["width"]), y0 + int(col["height"])), 255, -1)
    shape_columns, mask = extract_columns(mask, thickness, 1.3 * working_px_per_m)
    columns = layers.columns if use_colour else shape_columns   # colour-coded: only the marked piers
    if labels is not None:
        columns = model_struct["columns"]
    style = "solid"
    if vectorise:
        # centre-lines of any angle: slanted and curved walls (an octagonal hall, a slanted wing) are kept
        walls = vector.skeleton_segments(mask, thickness, min_len)
    else:
        walls = extract_segments(mask, thickness, min_len)
    # A wall component must not be a filled block (furniture, desk tops). The limit follows the
    # thickest wall thickness found on the drawing, not only the thinnest: a plan with thin
    # partitions and heavy black walls (4.5 px and 14.5 px) would otherwise lose every heavy wall.
    block_limit = max(2.6 * thickness, 1.5 * max(other_thicknesses or [0.0]))
    if use_colour:
        walls = [w_ for w_ in walls if w_.thickness <= block_limit]
    solid_len = sum(w_.length for w_ in walls)
    if labels is None and opts["wall_style"] in ("double", "auto"):   # a learned mask is already solid
        dmask, dthick = double_line_mask(drop_small_components(line_ink, max(0.012 * max(w, h), 12)),
                                         max(min_len, int(0.6 * working_px_per_m)))
        if dthick:
            dmin = max(int(round(3 * dthick)), int(0.4 * working_px_per_m), 8)
            dcols, dmask2 = extract_columns(dmask, dthick, 1.3 * working_px_per_m)
            dwalls = extract_segments(dmask2, dthick, dmin)
            double_len = sum(w_.length for w_ in dwalls)
            if use_colour and dwalls:
                # hatched outlines are walls too: both kinds are kept and merged
                walls = walls + [w_ for w_ in dwalls if w_.thickness <= block_limit]
                style = "solid + double-line"
                mask = cv2.bitwise_or(mask, dmask2)
            elif opts["wall_style"] == "double" or double_len > 2.0 * max(solid_len, 1.0):
                mask, walls, style, thickness, columns = dmask2, dwalls, "double-line", dthick, dcols
                min_len = dmin
                warnings.append("walls look like double lines; the gap between the two lines was filled")
    if labels is not None:
        # the network also paints blobs (a symbol, a filled block) as wall: a "wall" far
        # thicker than any wall thickness found on the drawing is not one
        # ... but a thick wall band (a heavy outer wall, a thick black room outline) is long for its thickness;
        # only a compact one (a symbol, a filled block) is dropped. Dropping every thick piece lost whole walls.
        limit = 2.6 * max([thickness] + list(other_thicknesses or []))
        blobs = [w_ for w_ in walls if w_.thickness > limit and w_.length < 3.0 * w_.thickness]
        if blobs:
            walls = [w_ for w_ in walls if not (w_.thickness > limit and w_.length < 3.0 * w_.thickness)]
            warnings.append(f"{len(blobs)} compact blob(s) far thicker than a wall were not read as walls")

    # Walls drawn as single thin lines. The thick-stroke reading (and the network) drop
    # them, yet in many plans every partition is a thin line: every long straight line
    # that is not hatching, a stair, a dimension line or the sheet frame is a wall.
    thin_src = (remove_markers(layers.neutral, layers.markers) if layers.coloured else prepared.ink).copy()
    thin_found = 0
    if opts.get("thin_lines", False):
        label_boxes = [np.array(t["box"]) for t in texts if t["kind"] == "label" and t["score"] >= 0.6]
        dim_boxes = [np.array(t["box"]) for t in texts if t["kind"] == "dimension" and t["score"] >= 0.6]
        thin = thin_line_walls(thin_src, max(int(round(2.0 * working_px_per_m)), 20),
                               max(0.8 * thickness, 4.0), exclude_boxes=label_boxes + dim_boxes,
                               dimension_boxes=dim_boxes)
        drawn = np.zeros_like(mask)
        for w_ in walls:
            cv2.line(drawn, (int(w_.a[0]), int(w_.a[1])), (int(w_.b[0]), int(w_.b[1])), 255,
                     max(1, int(round(w_.thickness))) + int(2 * thickness))
        for w_ in thin:
            probe = np.zeros_like(mask)
            cv2.line(probe, (int(w_.a[0]), int(w_.a[1])), (int(w_.b[0]), int(w_.b[1])), 255, 1)
            on = probe > 0
            if on.sum() and (drawn[on] > 0).mean() >= 0.7:
                continue          # already read as a wall
            walls.append(w_)
            cv2.line(mask, (int(w_.a[0]), int(w_.a[1])), (int(w_.b[0]), int(w_.b[1])), 255, 3)
            thin_found += 1
        if thin_found:
            warnings.append(f"{thin_found} wall(s) drawn as thin lines were read: check them against the drawing")
    meter.mark("wall mask and segments")

    virtual_lines: list[tuple[str, float]] = []
    found: dict[str, dict] = {}
    envelope: tuple[float, float, float, float] | None = None
    if use_colour and opts.get("perimeter", True):
        frame = find_frame(prepared.gray)
        found = find_perimeter(layers.symbol, thickness, frame)
        # where a side has no thick outer band, close the outline along the building's own
        # walls (the largest connected wall network), not the sheet edge
        # (pieces are not merged yet: a door-sized gap still joins them into one network)
        content = main_network_bounds([w_ for w_ in walls if w_.length >= 0.8 * working_px_per_m],
                                      tol=max(1.5 * thickness, 4.0, opts["door_max_m"] * working_px_per_m))
        edge_walls, edge_notes = perimeter_walls(found, frame, (w, h), thickness, content=content)
        walls = walls + edge_walls
        warnings += edge_notes
        virtual_lines = [(ew.orientation, ew.a[1] if ew.orientation == "h" else ew.a[0])
                         for ew in edge_walls if getattr(ew, "virtual", False)]
        xs_ = [c for ew in edge_walls for c in (ew.a[0], ew.b[0])]
        ys_ = [c for ew in edge_walls for c in (ew.a[1], ew.b[1])]
        envelope = (min(xs_), max(xs_), min(ys_), max(ys_))
    if envelope is not None:
        # drawing that continues outside the outer walls (stairs, a neighbour) is not this floor
        x0e, x1e, y0e, y1e = envelope
        pad = 1.5 * thickness
        clipped: list[Wall] = []
        for wl in walls:
            if wl.orientation == "h":
                if not (y0e - pad <= wl.a[1] <= y1e + pad):
                    continue
                lo, hi = max(min(wl.a[0], wl.b[0]), x0e), min(max(wl.a[0], wl.b[0]), x1e)
                if hi - lo < thickness:
                    continue
                wl.a, wl.b = (lo, wl.a[1]), (hi, wl.a[1])
            elif wl.orientation == "v":
                if not (x0e - pad <= wl.a[0] <= x1e + pad):
                    continue
                lo, hi = max(min(wl.a[1], wl.b[1]), y0e), min(max(wl.a[1], wl.b[1]), y1e)
                if hi - lo < thickness:
                    continue
                wl.a, wl.b = (wl.a[0], lo), (wl.a[0], hi)
            clipped.append(wl)
        walls = clipped
    # The learned model's labels (also for the classical readings, when the model is installed) say where the
    # building is and where furniture, stairs and hatched voids are: walls outside the building or on such clutter
    # (a desk row, a conveyor, stair treads, the road outside) are dropped.
    check_labels = labels_for_gaps
    if check_labels is None and opts.get("model_check", True):
        from . import model as net

        if net.available():
            try:
                check_labels, _ = net.segment(colour)
            except Exception as error:   # never block an import
                warnings.append(f"the wall check against the learned model was skipped ({error})")
    sealed = None
    building = None
    if check_labels is not None:
        from . import model as net

        building = vector.building_mask(check_labels, thickness, net.GEOMETRY_CLASSES)
        walls, n_out, n_clutter = vector.drop_false_walls(walls, check_labels, building, thickness,
                                                          net.GEOMETRY_CLASSES)
        if n_out:
            warnings.append(f"{n_out} line(s) outside the building were not read as walls")
        if n_clutter:
            warnings.append(f"{n_clutter} line(s) on furniture, stairs or hatching were not read as walls")
        # wall, door and window pixels: the evidence that a wall continues across a gap
        sealed = cv2.dilate(np.isin(check_labels, net.GEOMETRY_CLASSES["wall"] + net.GEOMETRY_CLASSES["opening"])
                            .astype(np.uint8), np.ones((3, 3), np.uint8))
    min_gap = 0.3 * working_px_per_m
    max_gap = opts["door_max_m"] * working_px_per_m
    walls = merge_collinear(walls, thickness, min_gap_px=min_gap, max_gap_px=max_gap,
                            evidence=layers.symbol if use_colour else None,
                            bridge_max_px=4.0 * working_px_per_m)
    walls = snap_junctions(walls, tol=max(1.5 * thickness, 4.0))
    # Close the gaps the reading left at joins, for every engine: an end that stops just
    # short of another wall is carried on to it (always when the gap is under 0.6 m;
    # up to 1.7 m when drawn strokes or a marker cover the gap), and an open L corner is
    # closed. Without this, a single gap leaves a room unclosed and it is lost.
    discs = [(m["x"], m["y"], max(m["width"], m["height"]) / 2 * 2.8) for m in layers.markers] if use_colour else []
    moved = extend_free_ends(walls, thickness, max_extend=1.7 * working_px_per_m,
                             evidence=layers.symbol if use_colour else thin_src, discs=discs,
                             free_px=0.6 * working_px_per_m)
    moved += close_corners(walls, tol=max(1.5 * thickness, 4.0), max_gap=1.0 * working_px_per_m)
    if moved:
        walls = snap_junctions(walls, tol=max(1.5 * thickness, 4.0))
    # the same for slanted and curved walls and for ends that do not line up: a free end is carried along its own
    # direction onto the wall it points at, and two ends facing each other across a door or a break are joined
    join_tol = max(1.5 * thickness, 4.0)
    ev = sealed if sealed is not None else (layers.symbol if use_colour else thin_src)
    moved2, bridged = vector.connect_ends(walls, tol=join_tol, max_extend=1.7 * working_px_per_m,
                                          free_px=0.6 * working_px_per_m, max_bridge=max_gap, evidence=ev)
    if moved2 or bridged:
        walls = snap_junctions(walls, tol=join_tol)
    if bridged:
        warnings.append(f"{len(bridged)} gap(s) between wall ends were closed (doors or breaks in the drawn wall)")
    if vectorise and vector.snap_to_main_angles(walls):
        vector.weld(walls, tol=join_tol)
    if vectorise:
        # short pieces of a curve or a stub between two walls stay; a short piece with a free end does not
        walls = vector.drop_short_dangling(walls, min_len, join_tol)
    else:
        walls = [w_ for w_ in walls if w_.length >= min_len]
    walls, dropped = drop_isolated_fragments(walls, tol=1.5 * thickness, max_len=1.2 * working_px_per_m)
    if use_colour:
        # on a furniture-heavy plan, small unconnected scraps are not the building
        perimeter_lines = [("h", c) for c in (found.get("top", {}).get("pos"), found.get("bottom", {}).get("pos")) if c is not None] +                           [("v", c) for c in (found.get("left", {}).get("pos"), found.get("right", {}).get("pos")) if c is not None]
        anchored = {i for i, wl in enumerate(walls) for o, c in perimeter_lines
                    if wl.orientation == o and abs((wl.a[1] if o == "h" else wl.a[0]) - c) <= 2.5}
        walls, small = drop_small_networks(walls, tol=1.5 * thickness,
                                           min_total_len=8.0 * working_px_per_m, anchored=anchored)
        dropped += small
    if dropped:
        warnings.append(f"{dropped} short isolated mark(s) were ignored (columns, symbols), not treated as walls")
    for wall in walls:
        wall.virtual = any(  # type: ignore[attr-defined]
            wall.orientation == o and abs((wall.a[1] if o == "h" else wall.a[0]) - c) <= 2.5
            for o, c in virtual_lines)
        if wall.virtual:  # type: ignore[attr-defined]
            wall.confidence = 0.3
            wall.notes.append("drawing edge: the plan is cut off here (virtual wall, check it)")
    # a wall drawn twice (the drawn wall and an overlay line along it, or both faces of a thick wall read
    # separately) becomes one wall
    n_dup = vector.merge_parallel_duplicates(walls, max_gap=max(1.6 * thickness, 0.25 * working_px_per_m))
    if n_dup:
        warnings.append(f"{n_dup} wall(s) drawn twice side by side (a wall and a line along it) were merged into one")
    # ends that stop a pixel short of a wall leave the room open: make them meet exactly
    vector.weld(walls, tol=join_tol)
    walls = [w_ for w_ in walls if w_.length >= 1.0]
    meter.mark("merge and snap")

    if labels_for_gaps is not None:
        openings = classify_gaps_labels(walls, labels_for_gaps, prepared.ink_symbol, thickness,
                                        opts["door_min_m"] * working_px_per_m, max_gap)
    else:
        openings = classify_gaps(walls, prepared.ink_symbol, thickness,
                                 opts["door_min_m"] * working_px_per_m, max_gap)
    for wi, wall in enumerate(walls):
        gaps = [g for g in wall.gaps]
        cov = _coverage(mask, wall, gaps)
        if getattr(wall, "virtual", False):
            continue
        wall.confidence = max(0.05, min(1.0, 0.25 + 0.75 * cov)) if wall.orientation != "d" else 0.5 * cov
        if cov < 0.6:
            wall.notes.append(f"only {cov:.0%} of the line is on a drawn wall")
    meter.mark("openings")

    rooms, outline = build_rooms(walls, opts["min_room_m2"] * working_px_per_m ** 2,
                                 thickness, (w, h))
    # A room must be a real indoor space: not outside the building (road marks, the site), not a sliver between
    # two parallel lines (a wall drawn twice, an overlay line), not a copy of another room.
    from shapely.geometry import Polygon as _Poly

    kept_rooms, dropped_rooms = [], {"outside": 0, "sliver": 0, "duplicate": 0}
    min_width_px = 0.6 * working_px_per_m
    for room in sorted(rooms, key=lambda r_: -r_.area_px):
        poly = _Poly(room.polygon)
        if building is not None and poly.area < 20.0 * working_px_per_m ** 2:
            # only a SMALL room outside the building's footprint is dropped (a road mark read as a room); a real
            # room is never removed because the model's footprint missed it
            c = poly.representative_point()
            cy, cx = int(round(c.y)), int(round(c.x))
            if not (0 <= cy < building.shape[0] and 0 <= cx < building.shape[1] and building[cy, cx]):
                dropped_rooms["outside"] += 1
                continue
        rect = poly.minimum_rotated_rectangle
        xs, ys = rect.exterior.coords.xy
        sides = sorted(math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(4))
        if sides[0] < min_width_px:
            dropped_rooms["sliver"] += 1
            continue
        if any(poly.intersection(_Poly(k.polygon)).area > 0.8 * poly.area for k in kept_rooms):
            dropped_rooms["duplicate"] += 1
            continue
        kept_rooms.append(room)
    if sum(dropped_rooms.values()):
        rooms = kept_rooms
        warnings.append("not read as rooms: " + ", ".join(f"{n} {k}" for k, n in dropped_rooms.items() if n)
                        + " (outside the building, narrower than 0.6 m, or a copy of another room)")
    topo = topology_report(walls, rooms, tol=1.2 * thickness)
    for room in rooms:
        support = room_wall_support(room, walls, 1.2 * thickness)
        room.confidence = max(0.05, room.confidence * (0.5 + 0.5 * support))
        if support < 0.9:
            room.notes.append(f"{1 - support:.0%} of its outline is not on a detected wall")
    label_rooms(rooms, texts)
    # walls free at an end lose a little confidence (broken line or a stub)
    dangling_walls = {d["wall"] for d in topo["danglingEnds"]}
    for i in dangling_walls:
        walls[i].confidence = max(0.05, walls[i].confidence - 0.2)
        walls[i].notes.append("a free end: not joined to another wall")
    at_border = [d for d in topo["danglingEnds"]
                 if d["x"] < 4 or d["y"] < 4 or d["x"] > w - 4 or d["y"] > h - 4]
    for d in at_border:
        walls[d["wall"]].confidence = min(walls[d["wall"]].confidence, 0.6)
        walls[d["wall"]].notes.append("reaches the image edge: the drawing may continue")
    if at_border:
        warnings.append(f"{len(at_border)} wall end(s) reach the image edge: the drawing may continue beyond it")
    meter.mark("rooms and topology")

    # ---- how good is this import: picture detail, and how much of the drawing's walls became walls ----------
    quality: dict = {}
    if px_per_m:
        original_ppm = px_per_m / max(prepared.scale_to_original, 1e-9)
        quality["originalPxPerM"] = round(original_ppm, 2)
        quality["cmPerPixel"] = round(100 / original_ppm, 1)
        if original_ppm < 20:
            quality["resolutionOk"] = False
            longest_m = max(prepared.original_size) / original_ppm
            warnings.append(
                f"the picture is coarse: 1 pixel = {100 / original_ppm:.0f} cm, so thin walls and small gaps can be "
                f"missed. For a reliable import ask for the same drawing as a PNG of at least "
                f"{int(round(longest_m * 20, -2))} px on its long side (20 px per metre)")
        else:
            quality["resolutionOk"] = True
    if check_labels is not None:
        # the model's wall centre-lines that the final walls cover (within a few pixels)
        from skimage.morphology import skeletonize as _skel
        from . import model as net

        model_wall = (check_labels == net.WALL) | (check_labels == net.COLUMN)
        sk = _skel(model_wall)
        if building is not None:
            # judged inside the building: the model's lines on the road or the site are rightly not walls
            r_ = int(round(3 * thickness)) + 3
            sk &= cv2.dilate(building.astype(np.uint8), np.ones((2 * r_ + 1, 2 * r_ + 1), np.uint8)) > 0
        drawn = np.zeros(model_wall.shape, np.uint8)
        tol = max(2, int(round(0.6 * thickness)))
        for wl in walls:
            cv2.line(drawn, (int(round(wl.a[0])), int(round(wl.a[1]))), (int(round(wl.b[0])), int(round(wl.b[1]))),
                     255, 2 * tol + 1)
        if sk.sum():
            covered = 100.0 * float((sk & (drawn > 0)).sum()) / float(sk.sum())
            quality["modelWallsCoveredPct"] = round(covered, 1)
            if covered < 85:
                warnings.append(f"only {covered:.0f} % of the walls the model sees in the drawing became walls: check "
                                f"the walls against the picture")

    # wall roles: boundary of the building outline, or a partition/free wall
    from shapely.geometry import LineString

    roles = []
    for wall in walls:
        line = LineString([wall.a, wall.b])
        if getattr(wall, "virtual", False):
            roles.append("virtual")
        elif outline is not None and line.distance(outline.exterior) <= 1.2 * thickness and \
                line.intersection(outline.exterior.buffer(1.2 * thickness)).length > 0.6 * line.length:
            roles.append("exterior")
        elif any(LineString(r.polygon + [r.polygon[0]]).distance(line.interpolate(0.5, normalized=True)) <= 1.2 * thickness
                 for r in rooms):
            roles.append("interior")
        else:
            roles.append("free")

    # a wall is "anchored" when it belongs to a network that reaches an outer wall
    from shapely.geometry import LineString as _L
    wall_lines_ = [_L([x.a, x.b]) for x in walls]
    parent = list(range(len(walls)))

    def _find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            if wall_lines_[i].distance(wall_lines_[j]) <= 1.5 * thickness:
                parent[_find(i)] = _find(j)
    outer = {_find(i) for i, role in enumerate(roles) if role in ("exterior", "virtual")}
    anchored_ = [(_find(i) in outer) for i in range(len(walls))]

    furniture_found: list[dict] = []
    if labels_for_gaps is not None and opts.get("furniture", True):
        from . import model as net

        furniture_found = net.furniture(labels_for_gaps, px_per_m)
    overlay = draw_overlay(colour, walls, openings, rooms, topo["danglingEnds"], texts)
    _draw_furniture(overlay, furniture_found)
    cv2.imwrite(str(out / "overlay.png"), overlay)
    cv2.imwrite(str(out / "walls_mask.png"), draw_mask_preview(mask))
    cv2.imwrite(str(out / "deskewed.png"), colour)
    if labels_for_gaps is not None:
        from . import model as net

        cv2.imwrite(str(out / "model_overlay.png"), net.overlay(colour, labels_for_gaps))
    meter.mark("overlay")

    def to_m(p):
        return [round(p[0] / px_per_m, 4), round(p[1] / px_per_m, 4)] if px_per_m else None

    # wall materials from the drawing's own legend (a colour swatch beside "Concrete [Heavy]" etc.)
    from .legend import read_legend, wall_materials

    legend = read_legend(colour, texts) if texts else []
    mats = wall_materials(colour, walls, legend)
    if legend:
        found = sum(m is not None for m in mats)
        warnings.append(f"materials legend read ({', '.join(e['label'] for e in legend)}): {found} of {len(walls)} "
                        f"wall(s) took their material from it; check them")
    wall_json = []
    for i, wall in enumerate(walls):
        wall_json.append({
            "id": f"w{i}", "a": [round(wall.a[0], 2), round(wall.a[1], 2)],
            "b": [round(wall.b[0], 2), round(wall.b[1], 2)],
            "thicknessPx": round(wall.thickness, 2),
            "thicknessM": round(wall.thickness / px_per_m, 4) if px_per_m else None,
            "orientation": wall.orientation, "role": roles[i], "anchored": anchored_[i],
            "confidence": round(wall.confidence, 3), "notes": wall.notes,
            "aM": to_m(wall.a), "bM": to_m(wall.b),
            "material": mats[i]["material"] if mats[i] else None,
            "materialLabel": mats[i]["label"] if mats[i] else None,
        })
    opening_json = []
    for j, op in enumerate(openings):
        opening_json.append({
            "id": f"o{j}", "wall": f"w{op.wall_index}", "kind": op.kind,
            "start": [round(op.start[0], 2), round(op.start[1], 2)],
            "end": [round(op.end[0], 2), round(op.end[1], 2)],
            "widthPx": round(op.width, 2),
            "widthM": round(op.width / px_per_m, 3) if px_per_m else None,
            "confidence": round(op.confidence, 3), "swing": op.swing, "hinge": op.hinge,
            "startM": to_m(op.start), "endM": to_m(op.end),
        })
    room_json = []
    for k, room in enumerate(rooms):
        room_json.append({
            "id": f"r{k}", "polygon": [[round(x, 2), round(y, 2)] for x, y in room.polygon],
            "polygonM": [to_m(p) for p in room.polygon] if px_per_m else None,
            "areaPx": round(room.area_px, 1),
            "areaM2": round(room.area_px / px_per_m ** 2, 2) if px_per_m else None,
            "label": room.label, "confidence": round(room.confidence, 3), "notes": room.notes,
        })
    uncertain = sorted(
        [{"type": "wall", "id": w_["id"], "confidence": w_["confidence"]} for w_ in wall_json if w_["confidence"] < 0.7]
        + [{"type": "room", "id": r_["id"], "confidence": r_["confidence"]} for r_ in room_json if r_["confidence"] < 0.7]
        + [{"type": "opening", "id": o_["id"], "confidence": o_["confidence"]} for o_ in opening_json if o_["confidence"] < 0.7],
        key=lambda u: u["confidence"])
    result = {
        "version": __version__,
        "image": {"widthPx": w, "heightPx": h, "originalWidthPx": prepared.original_size[0],
                  "originalHeightPx": prepared.original_size[1],
                  "resizeFactor": round(prepared.scale_to_original, 5),
                  "deskewDeg": round(prepared.deskew_deg, 3), "pages": prepared.page_count},
        "scale": {"pxPerM": px_per_m, "source": scale_source, "confidence": scale_conf, "printed": printed,
                  "aspectCorrection": round(aspect_y, 4),
                  # the sizes printed on the drawing and their lines (original picture pixels): the import's scale
                  # step places A-B and C-D on them for the user to check
                  "printedLines": printed_lines, "printedPxPerM": printed_xy,
                  "twoLengths": ({"xPxPerM": round(two[0], 4), "yPxPerM": round(two[1], 4), "stretchPct": stretch_pct}
                                 if two else None),
                  # the user checked the scale both ways: two lengths, or one length and "the picture is not
                  # stretched". Only then are the metres trusted for the editor.
                  "confirmed": bool(two) or bool(px_per_m and (scale or {}).get("notStretched")
                                                 and scale_source.startswith("user")),
                  "needsInput": px_per_m is None, "auto": auto_scale,
                  "widthM": round(w / px_per_m, 3) if px_per_m else None,
                  "heightM": round(h / px_per_m, 3) if px_per_m else None},
        "wallThickness": {"px": round(thickness, 2), "m": round(thickness / px_per_m, 4) if px_per_m else None,
                          "otherCandidatesPx": other_thicknesses, "style": style},
        "walls": wall_json, "openings": opening_json, "rooms": room_json,
        "legend": legend,
        "markers": [{"x": round(m["x"], 1), "y": round(m["y"], 1),
                     "xM": round(m["x"] / px_per_m, 3) if px_per_m else None,
                     "yM": round(m["y"] / px_per_m, 3) if px_per_m else None}
                    for m in (model_struct["markers"] if labels is not None else layers.markers)],
        "engine": "hybrid" if hybrid else ("model" if labels is not None else "classical"),
        "model": model_meta,
        "furniture": furniture_found,
        "columns": [{**c, "xM": round(c["x"] / px_per_m, 3) if px_per_m else None,
                     "yM": round(c["y"] / px_per_m, 3) if px_per_m else None,
                     "sizeM": round(max(c["width"], c["height"]) / px_per_m, 3) if px_per_m else None}
                    for c in columns],
        "texts": [{k: v for k, v in t.items() if k != "box"} for t in texts],
        "quality": quality,
        "uncertain": uncertain, "topology": topo, "warnings": warnings,
        "assumptions": [
            "wall material is not visible in a drawing: every wall is assumed to be drywall until you set it",
            "storey height is not in the drawing: the editor default is used until you set it",
            "doors and windows are read from gaps in the wall lines; 'opening' means the type is unclear",
        ],
        "files": {"overlay": "overlay.png", "mask": "walls_mask.png", "deskewed": "deskewed.png",
                  **({"modelOverlay": "model_overlay.png"} if labels_for_gaps is not None else {})},
        "metrics": meter.summary(),
    }
    (out / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
