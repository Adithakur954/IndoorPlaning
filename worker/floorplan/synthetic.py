"""A drawn-by-code commercial office plan with known geometry.

It is NOT a substitute for real drawings. It exists so the pipeline and the
evaluation can be tested automatically: it has furniture, chairs, dimension
lines, text labels, door swings, window glazing lines, columns and (optionally)
skew and noise. Every wall, opening and room has a known true position.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

PX_PER_M = 40.0


def _walls():
    ext, par = 0.3, 0.15
    W = []   # (ax, ay, bx, by, thickness, [gaps along], kind)
    # exterior (centre-lines), with window gaps
    W.append((3, 3, 43, 3, ext, [(7.25, 8.75, "window"), (17.25, 18.75, "window"),
                                 (27.25, 28.75, "window"), (37.25, 38.75, "window")]))
    W.append((3, 27, 43, 27, ext, [(9.25, 10.75, "window"), (19.25, 20.75, "window")]))
    W.append((3, 3, 3, 27, ext, [(19.25, 20.75, "window")]))
    W.append((43, 3, 43, 27, ext, [(8.25, 9.75, "window")]))
    # corridor walls (doors into the offices / open office / meeting room)
    W.append((3, 12, 43, 12, par, [(7.5, 8.5, "door"), (17.5, 18.5, "door"),
                                   (27.5, 28.5, "door"), (37.5, 38.5, "door")]))
    W.append((3, 15, 43, 15, par, [(13.5, 14.5, "door"), (33.5, 34.5, "door")]))
    # office partitions
    for x in (13, 23, 33):
        W.append((x, 3, x, 12, par, []))
    # meeting rooms
    W.append((28, 15, 28, 27, par, [(20.0, 21.0, "door")]))
    W.append((28, 21, 43, 21, par, [(30.0, 31.0, "door")]))
    W.append((36, 21, 36, 27, par, []))
    return W


def _rooms():
    r = []
    for i, (x0, x1) in enumerate([(3, 13), (13, 23), (23, 33), (33, 43)]):
        r.append((f"OFFICE {i + 1}", [(x0, 3), (x1, 3), (x1, 12), (x0, 12)]))
    r.append(("CORRIDOR", [(3, 12), (43, 12), (43, 15), (3, 15)]))
    r.append(("OPEN OFFICE", [(3, 15), (28, 15), (28, 27), (3, 27)]))
    r.append(("MEETING A", [(28, 15), (43, 15), (43, 21), (28, 21)]))
    r.append(("MEETING B", [(28, 21), (36, 21), (36, 27), (28, 27)]))
    r.append(("STORE", [(36, 21), (43, 21), (43, 27), (36, 27)]))
    return r


def make_office(skew_deg: float = 0.0, noise: float = 0.0, furniture: bool = True,
                seed: int = 7, double_lines: bool = False) -> tuple[np.ndarray, dict]:
    rng = np.random.default_rng(seed)
    s = PX_PER_M
    width, height = int(46 * s), int(30 * s)
    img = np.full((height, width, 3), 255, np.uint8)
    P = lambda v: int(round(v * s))  # noqa: E731
    truth_walls, truth_openings = [], []

    for ax, ay, bx, by, t, gaps in _walls():
        horizontal = ay == by
        half = t / 2
        # solid pieces between the gaps
        cuts = [(0.0, 0.0)]
        along0 = ax if horizontal else ay
        along1 = bx if horizontal else by
        pieces, cursor = [], along0
        for g0, g1, _ in sorted(gaps):
            pieces.append((cursor, g0))
            cursor = g1
        pieces.append((cursor, along1))
        for p0, p1 in pieces:
            if p1 - p0 <= 0:
                continue
            if double_lines:   # two thin parallel lines, white between them
                if horizontal:
                    for yy in (ay - half, ay + half):
                        cv2.line(img, (P(p0), P(yy)), (P(p1), P(yy)), (0, 0, 0), 2)
                else:
                    for xx in (ax - half, ax + half):
                        cv2.line(img, (P(xx), P(p0)), (P(xx), P(p1)), (0, 0, 0), 2)
            elif horizontal:
                cv2.rectangle(img, (P(p0), P(ay - half)), (P(p1), P(ay + half)), (0, 0, 0), -1)
            else:
                cv2.rectangle(img, (P(ax - half), P(p0)), (P(ax + half), P(p1)), (0, 0, 0), -1)
        truth_walls.append({"a": [ax, ay], "b": [bx, by], "thickness": t})
        for g0, g1, kind in gaps:
            mid = (g0 + g1) / 2
            if horizontal:
                truth_openings.append({"kind": kind, "mid": [mid, ay], "width": g1 - g0})
            else:
                truth_openings.append({"kind": kind, "mid": [ax, mid], "width": g1 - g0})
            r = g1 - g0
            if kind == "window":   # three thin glazing lines across the gap
                for off in (-half * 0.8, 0.0, half * 0.8):
                    if horizontal:
                        cv2.line(img, (P(g0), P(ay + off)), (P(g1), P(ay + off)), (0, 0, 0), 1)
                    else:
                        cv2.line(img, (P(ax + off), P(g0)), (P(ax + off), P(g1)), (0, 0, 0), 1)
            else:                  # door leaf and swing arc, hinge at the start
                if horizontal:
                    sign = 1 if ay < 15 else -1
                    cv2.line(img, (P(g0), P(ay)), (P(g0), P(ay + sign * r)), (0, 0, 0), 1)
                    cv2.ellipse(img, (P(g0), P(ay)), (P(r), P(r)), 0, 0 if sign > 0 else -90,
                                90 if sign > 0 else 0, (0, 0, 0), 1)
                else:
                    cv2.line(img, (P(ax), P(g0)), (P(ax + r), P(g0)), (0, 0, 0), 1)
                    cv2.ellipse(img, (P(ax), P(g0)), (P(r), P(r)), 0, 0, 90, (0, 0, 0), 1)

    # columns (small filled squares) in the open office
    for cx in (8, 16, 24):
        cv2.rectangle(img, (P(cx - 0.2), P(21 - 0.2)), (P(cx + 0.2), P(21 + 0.2)), (0, 0, 0), -1)

    if furniture:
        for row in range(3):
            for col in range(6):
                x0, y0 = 4.5 + col * 3.8, 16.2 + row * 3.2
                cv2.rectangle(img, (P(x0), P(y0)), (P(x0 + 1.6), P(y0 + 0.8)), (60, 60, 60), 2)
                cv2.circle(img, (P(x0 + 0.8), P(y0 + 1.15)), P(0.25), (60, 60, 60), 2)
        for x0 in (4, 14, 24, 34):
            cv2.rectangle(img, (P(x0 + 0.8), P(4.2)), (P(x0 + 2.6), P(5.2)), (60, 60, 60), 2)
            cv2.rectangle(img, (P(x0 + 5.5), P(8.0)), (P(x0 + 6.5), P(10.4)), (60, 60, 60), 2)
        cv2.rectangle(img, (P(31), P(16.5)), (P(40), P(19.5)), (60, 60, 60), 2)  # meeting table

    # dimension line along the top with ticks and text
    cv2.line(img, (P(3), P(1.5)), (P(43), P(1.5)), (0, 0, 0), 1)
    for x in (3, 43):
        cv2.line(img, (P(x), P(1.2)), (P(x), P(1.8)), (0, 0, 0), 1)
    cv2.putText(img, "40.00 m", (P(21), P(1.3)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    cv2.line(img, (P(45), P(3)), (P(45), P(27)), (0, 0, 0), 1)
    cv2.putText(img, "24.00 m", (P(44.2), P(15)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    for name, poly in _rooms():
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        cv2.putText(img, name, (P(cx) - 60, P(cy) + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

    if noise:
        img = np.clip(img.astype(np.float32) + rng.normal(0, noise * 255, img.shape), 0, 255).astype(np.uint8)
        img = cv2.GaussianBlur(img, (3, 3), 0)
    if skew_deg:
        m = cv2.getRotationMatrix2D((width / 2, height / 2), skew_deg, 1.0)
        img = cv2.warpAffine(img, m, (width, height), borderValue=(255, 255, 255))

    truth = {
        "pxPerM": s,
        "walls": truth_walls,
        "openings": truth_openings,
        "rooms": [{"label": n, "polygon": [list(p) for p in poly]} for n, poly in _rooms()],
        "imageWidthM": width / s,
    }
    return img, truth
