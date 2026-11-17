"""Visual overlay of what was detected, drawn over the (deskewed) drawing."""
from __future__ import annotations

import cv2
import numpy as np

CONF_COLOURS = {"high": (60, 160, 40), "mid": (0, 150, 255), "low": (40, 40, 220)}  # BGR
OPENING_COLOURS = {"door": (200, 90, 20), "window": (200, 190, 20), "opening": (200, 40, 200)}


def _band(c: float) -> str:
    return "high" if c >= 0.75 else "mid" if c >= 0.5 else "low"


def draw_overlay(image_bgr: np.ndarray, walls, openings, rooms, dangling, texts=None) -> np.ndarray:
    base = image_bgr.copy()
    base = cv2.addWeighted(base, 0.55, np.full_like(base, 255), 0.45, 0)
    layer = base.copy()
    palette = [(220, 200, 160), (190, 220, 170), (170, 200, 230), (200, 180, 220), (160, 220, 220)]
    for i, room in enumerate(rooms):
        pts = np.array(room.polygon, dtype=np.int32)
        cv2.fillPoly(layer, [pts], palette[i % len(palette)])
    base = cv2.addWeighted(layer, 0.45, base, 0.55, 0)
    for wall in walls:
        colour = CONF_COLOURS[_band(wall.confidence)]
        thick = max(2, int(round(wall.thickness)))
        cv2.line(base, (int(wall.a[0]), int(wall.a[1])), (int(wall.b[0]), int(wall.b[1])),
                 colour, thick, cv2.LINE_AA)
    for op in openings:
        colour = OPENING_COLOURS[op.kind]
        cv2.line(base, (int(op.start[0]), int(op.start[1])), (int(op.end[0]), int(op.end[1])),
                 colour, max(3, int(op.width * 0.15)), cv2.LINE_AA)
    for room in rooms:
        pts = np.array(room.polygon, dtype=np.int32)
        cv2.polylines(base, [pts], True, (90, 90, 90), 1, cv2.LINE_AA)
        if room.label:
            c = pts.mean(axis=0).astype(int)
            cv2.putText(base, room.label[:24], (int(c[0]) - 40, int(c[1])),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (30, 30, 30), 2, cv2.LINE_AA)
    for d in dangling:
        cv2.circle(base, (int(d["x"]), int(d["y"])), 7, (0, 0, 255), 2, cv2.LINE_AA)
    return base


def draw_mask_preview(mask: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(255 - mask, cv2.COLOR_GRAY2BGR)
