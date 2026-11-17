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
from .perimeter import find_frame, find_perimeter, perimeter_walls
from .rooms import build_rooms, drop_isolated_fragments, drop_small_networks, label_rooms, room_wall_support, topology_report
from .walls import (
    double_line_mask,
    drop_small_components,
    estimate_thickness,
    extend_free_ends,
    extract_columns,
    extract_segments,
    merge_collinear,
    snap_junctions,
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


def reconstruct(image_path: str | Path, out_dir: str | Path, *, scale: dict | None = None,
                options: dict | None = None) -> dict:
    opts = {"max_side": 4000, "deskew": True, "ocr": True, "wall_thickness_px": None,
            "wall_style": "auto", "min_room_m2": 1.0, "door_min_m": 0.55, "door_max_m": 2.6,
            "page": 0, "pdf_dpi": 200, "text_suppression": True, "colour_mode": "auto"}
    opts.update(options or {})
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meter = _Meter()
    warnings: list[str] = []

    # The overall size printed on the drawing ("31.60 m" on a dimension line) gives the scale. When the horizontal
    # and the vertical printed size disagree by 3-30 % the picture is stretched: the aspect is corrected first.
    aspect_y = 1.0
    if opts["ocr"] and opts.get("printed_scale", True):
        from . import printed_scale as _ps
        from .ocr import read_text as _read
        from .preprocess import load_image as _load, normalise_size as _norm

        raw, _pages = _load(image_path, page=opts["page"], pdf_dpi=opts["pdf_dpi"])
        small, _f = _norm(raw, opts["max_side"])
        pre = _ps.estimate(small, [t for t in _read(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)) if t["kind"] != "error"])
        if pre.get("stretched"):
            aspect_y = float(pre["aspect"])
            warnings.append(f"the picture is stretched: the printed sizes imply {pre['xPxPerM']:.1f} px/m across but "
                            f"{pre['yPxPerM']:.1f} px/m down; its height was corrected by x{aspect_y:.3f}")
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
    mask = wall_mask(solid_ink, thickness)
    for col in (layers.columns if labels is None else []):   # coloured wall piers keep the wall continuous
        x0, y0 = int(col["x"] - col["width"] / 2), int(col["y"] - col["height"] / 2)
        cv2.rectangle(mask, (x0, y0), (x0 + int(col["width"]), y0 + int(col["height"])), 255, -1)
    shape_columns, mask = extract_columns(mask, thickness, 1.3 * working_px_per_m)
    columns = layers.columns if use_colour else shape_columns   # colour-coded: only the marked piers
    if labels is not None:
        columns = model_struct["columns"]
    style = "solid"
    walls = extract_segments(mask, thickness, min_len)
    if use_colour:
        # a wall component must not be a filled block (furniture, desk tops)
        walls = [w_ for w_ in walls if w_.thickness <= 2.6 * thickness]
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
                walls = walls + [w_ for w_ in dwalls if w_.thickness <= 2.6 * thickness]
                style = "solid + double-line"
                mask = cv2.bitwise_or(mask, dmask2)
            elif opts["wall_style"] == "double" or double_len > 2.0 * max(solid_len, 1.0):
                mask, walls, style, thickness, columns = dmask2, dwalls, "double-line", dthick, dcols
                min_len = dmin
                warnings.append("walls look like double lines; the gap between the two lines was filled")
    meter.mark("wall mask and segments")

    virtual_lines: list[tuple[str, float]] = []
    found: dict[str, dict] = {}
    envelope: tuple[float, float, float, float] | None = None
    if use_colour and opts.get("perimeter", True):
        frame = find_frame(prepared.gray)
        found = find_perimeter(layers.symbol, thickness, frame)
        edge_walls, edge_notes = perimeter_walls(found, frame, (w, h), thickness)
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
    min_gap = 0.3 * working_px_per_m
    max_gap = opts["door_max_m"] * working_px_per_m
    walls = merge_collinear(walls, thickness, min_gap_px=min_gap, max_gap_px=max_gap,
                            evidence=layers.symbol if use_colour else None,
                            bridge_max_px=4.0 * working_px_per_m)
    walls = snap_junctions(walls, tol=max(1.5 * thickness, 4.0))
    if use_colour:
        discs = [(m["x"], m["y"], max(m["width"], m["height"]) / 2 * 2.8) for m in layers.markers]
        if extend_free_ends(walls, thickness, max_extend=1.7 * working_px_per_m,
                            evidence=layers.symbol, discs=discs):
            walls = snap_junctions(walls, tol=max(1.5 * thickness, 4.0))
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
                  "needsInput": px_per_m is None, "auto": auto_scale,
                  "widthM": round(w / px_per_m, 3) if px_per_m else None,
                  "heightM": round(h / px_per_m, 3) if px_per_m else None},
        "wallThickness": {"px": round(thickness, 2), "m": round(thickness / px_per_m, 4) if px_per_m else None,
                          "otherCandidatesPx": other_thicknesses, "style": style},
        "walls": wall_json, "openings": opening_json, "rooms": room_json,
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
