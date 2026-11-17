"""Measures a reconstruction against a verified reference.

Reference format (metres, same origin and axes as the image: x right, y down):
  {"walls": [{"a": [x, y], "b": [x, y], "thickness": m}],
   "openings": [{"kind": "door|window", "mid": [x, y], "width": m}],
   "rooms": [{"label": str, "polygon": [[x, y], ...]}],
   "pxPerM": float}

The scores are separate structural measurements. None of them is "overall
architectural accuracy"; read them together with the failure list.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union


def _lines(items, key_a="a", key_b="b"):
    return [LineString([tuple(i[key_a]), tuple(i[key_b])]) for i in items]


def wall_scores(pred_walls, true_walls, tol_m: float) -> dict:
    pred = [LineString([tuple(w["aM"]), tuple(w["bM"])]) for w in pred_walls if w.get("aM")]
    truth = _lines(true_walls)
    pred_len = sum(l.length for l in pred) or 1e-9
    true_len = sum(l.length for l in truth) or 1e-9
    true_zone = unary_union([l.buffer(tol_m) for l in truth])
    pred_zone = unary_union([l.buffer(tol_m) for l in pred]) if pred else Polygon()
    matched_pred = sum(l.intersection(true_zone).length for l in pred)
    matched_true = sum(l.intersection(pred_zone).length for l in truth)
    # centre-line deviation: mean distance of points along the predicted lines
    # that fall near a true wall
    deviations = []
    true_union = unary_union(truth)
    for l in pred:
        n = max(2, int(l.length / 0.25))
        for i in range(n + 1):
            p = l.interpolate(i / n, normalized=True)
            d = true_union.distance(p)
            if d <= 2 * tol_m:
                deviations.append(d)
    return {
        "precision": matched_pred / pred_len,
        "recall": matched_true / true_len,
        "meanCentrelineDeviationM": sum(deviations) / len(deviations) if deviations else None,
        "predictedLengthM": pred_len, "referenceLengthM": true_len,
    }


def room_scores(pred_rooms, true_rooms, iou_min: float = 0.5) -> dict:
    preds = [(r, Polygon(r["polygonM"])) for r in pred_rooms if r.get("polygonM")]
    truths = [(r, Polygon(r["polygon"])) for r in true_rooms]
    used: set[int] = set()
    ious: list[float] = []
    matches = 0
    for _, tpoly in truths:
        best, best_i = 0.0, -1
        for i, (_, ppoly) in enumerate(preds):
            if i in used or not ppoly.is_valid or not tpoly.is_valid:
                continue
            union = ppoly.union(tpoly).area
            iou = ppoly.intersection(tpoly).area / union if union else 0.0
            if iou > best:
                best, best_i = iou, i
        ious.append(best)
        if best >= iou_min and best_i >= 0:
            matches += 1
            used.add(best_i)
    return {
        "meanIoU": sum(ious) / len(ious) if ious else 0.0,
        "precision": matches / len(preds) if preds else 0.0,
        "recall": matches / len(truths) if truths else 0.0,
        "matched": matches, "predicted": len(preds), "reference": len(truths),
    }


def opening_scores(pred_openings, true_openings, tol_m: float = 0.5) -> dict:
    preds = []
    for o in pred_openings:
        if o.get("startM") and o.get("endM"):
            mid = ((o["startM"][0] + o["endM"][0]) / 2, (o["startM"][1] + o["endM"][1]) / 2)
            preds.append((o, mid))
    used: set[int] = set()
    found = kind_ok = 0
    width_err: list[float] = []
    for t in true_openings:
        tm = tuple(t["mid"])
        best, best_i = tol_m, -1
        for i, (_, mid) in enumerate(preds):
            if i in used:
                continue
            d = math.hypot(mid[0] - tm[0], mid[1] - tm[1])
            if d <= best:
                best, best_i = d, i
        if best_i >= 0:
            used.add(best_i)
            found += 1
            p = preds[best_i][0]
            if p["kind"] == t["kind"]:
                kind_ok += 1
            if p.get("widthM"):
                width_err.append(abs(p["widthM"] - t["width"]))
    return {
        "precision": found / len(preds) if preds else 0.0,
        "recall": found / len(true_openings) if true_openings else 0.0,
        "kindAccuracyOfFound": kind_ok / found if found else 0.0,
        "meanWidthErrorM": sum(width_err) / len(width_err) if width_err else None,
        "matched": found, "predicted": len(preds), "reference": len(true_openings),
    }


def evaluate(result: dict, truth: dict, tol_m: float = 0.25) -> dict:
    scale_err = None
    if result["scale"]["pxPerM"] and truth.get("pxPerM"):
        scale_err = abs(result["scale"]["pxPerM"] - truth["pxPerM"]) / truth["pxPerM"]
    topo = result["topology"]
    rooms = result["rooms"]
    return {
        "walls": wall_scores(result["walls"], truth["walls"], tol_m),
        "rooms": room_scores(rooms, truth["rooms"]),
        "openings": opening_scores(result["openings"], truth["openings"]),
        "topology": {
            "danglingEnds": len(topo["danglingEnds"]),
            "invalidRooms": len(topo["invalidRooms"]),
            "overlappingRooms": len(topo["overlappingRooms"]),
            "validRoomFraction": 1 - len(topo["invalidRooms"]) / max(len(rooms), 1),
        },
        "scaleRelativeError": scale_err,
        "tolerancesM": {"wall": tol_m, "opening": 0.5, "roomIoU": 0.5},
    }


def evaluate_files(result_json: str | Path, truth_json: str | Path, tol_m: float = 0.25) -> dict:
    return evaluate(json.loads(Path(result_json).read_text(encoding="utf-8")),
                    json.loads(Path(truth_json).read_text(encoding="utf-8")), tol_m)
