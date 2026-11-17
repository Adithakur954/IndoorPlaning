"""Receiver grid for coverage planning: cell centres per floor, which cells are
walkable (inside a room or the building boundary), their room, area weight and
threshold. Pure NumPy; the layout matches Sionna's planar radio map exactly."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

COMMON_AREA = -1   # inside the boundary but not in a room
OUTSIDE = -2       # not walkable


@dataclass
class FloorGrid:
    floor_id: str
    name: str
    elevation_m: float
    nx: int
    ny: int
    cell: float
    xs: np.ndarray        # scene x of the columns
    ys: np.ndarray        # scene y of the rows (plan z = -y)
    height_m: float       # absolute receiver height (scene z)
    center: list[float]
    size: list[float]
    offset: int = 0       # start of this floor in the flattened vector

    @property
    def cells(self) -> int:
        return self.nx * self.ny


def build_grids(config: dict, cell: float, floor_ids=None, receiver_height_m=None) -> list[FloorGrid]:
    grids, offset = [], 0
    for floor in config["floors"]:
        plane = floor.get("radioMapPlane")
        if not plane or (floor_ids and floor["id"] not in floor_ids):
            continue
        nx = math.ceil(plane["size"][0] / cell - 1e-9)
        ny = math.ceil(plane["size"][1] / cell - 1e-9)
        cx, cy = plane["center"][0], plane["center"][1]
        height = (
            floor["elevationM"] + receiver_height_m
            if receiver_height_m is not None else plane["heightM"]
        )
        grids.append(FloorGrid(
            floor_id=floor["id"], name=floor["name"], elevation_m=floor["elevationM"],
            nx=nx, ny=ny, cell=cell,
            xs=cx - nx * cell / 2 + cell * (np.arange(nx) + 0.5),
            ys=cy - ny * cell / 2 + cell * (np.arange(ny) + 0.5),
            height_m=height, center=[cx, cy], size=list(plane["size"]), offset=offset,
        ))
        offset += nx * ny
    return grids


def points_in_polygon(px: np.ndarray, pz: np.ndarray, polygon: list[dict]) -> np.ndarray:
    """Even-odd rule, vectorised. polygon is [{x, z}, ...]."""
    inside = np.zeros(px.shape, dtype=bool)
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, zi, xj, zj = polygon[i]["x"], polygon[i]["z"], polygon[j]["x"], polygon[j]["z"]
        crosses = (zi > pz) != (zj > pz)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_at = (xj - xi) * (pz - zi) / (zj - zi) + xi
        inside ^= crosses & (px < x_at)
        j = i
    return inside


@dataclass
class Targets:
    """Flattened per-cell data across all floors (length N)."""
    floor_idx: np.ndarray     # index into the grids list
    room_idx: np.ndarray      # index into room_ids, COMMON_AREA or OUTSIDE
    weight: np.ndarray        # area (m^2) x room weight; 0 when not a target
    threshold: np.ndarray     # dBm
    plan_x: np.ndarray
    plan_z: np.ndarray
    room_ids: list[str]
    room_names: list[str]

    @property
    def n(self) -> int:
        return len(self.weight)


def classify(
    config: dict,
    grids: list[FloorGrid],
    default_threshold_dbm: float,
    overrides: dict | None = None,
    include_common_area: bool = True,
) -> Targets:
    overrides = overrides or {}
    rooms = config.get("rooms", [])
    room_ids = [r["id"] for r in rooms]
    room_names = [r["name"] for r in rooms]
    parts = {k: [] for k in ("floor_idx", "room_idx", "weight", "threshold", "px", "pz")}
    for gi, g in enumerate(grids):
        px = np.broadcast_to(g.xs[None, :], (g.ny, g.nx)).ravel()
        pz = np.broadcast_to(-g.ys[:, None], (g.ny, g.nx)).ravel()
        room_idx = np.full(px.shape, OUTSIDE, dtype=np.int32)
        in_boundary = np.zeros(px.shape, dtype=bool)
        for b in config.get("boundaries", []):
            if b["floorId"] == g.floor_id:
                in_boundary |= points_in_polygon(px, pz, b["points"])
        room_idx[in_boundary] = COMMON_AREA
        for ri, room in enumerate(rooms):
            if room["floorId"] != g.floor_id:
                continue
            hit = points_in_polygon(px, pz, room["points"]) & (
                (room_idx == OUTSIDE) | (room_idx == COMMON_AREA)
            )
            room_idx[hit] = ri
        weight = np.full(px.shape, g.cell ** 2, dtype=np.float64)
        threshold = np.full(px.shape, default_threshold_dbm, dtype=np.float32)
        weight[room_idx == OUTSIDE] = 0.0
        if not include_common_area:
            weight[room_idx == COMMON_AREA] = 0.0
        for ri, room in enumerate(rooms):
            o = overrides.get(room["id"])
            if not o:
                continue
            m = room_idx == ri
            if o.get("include") is False:
                weight[m] = 0.0
            else:
                weight[m] *= float(o.get("weight", 1.0))
            if o.get("thresholdDbm") is not None:
                threshold[m] = float(o["thresholdDbm"])
        parts["floor_idx"].append(np.full(px.shape, gi, dtype=np.int32))
        parts["room_idx"].append(room_idx)
        parts["weight"].append(weight)
        parts["threshold"].append(threshold)
        parts["px"].append(px)
        parts["pz"].append(pz)
    cat = {k: np.concatenate(v) for k, v in parts.items()}
    return Targets(
        floor_idx=cat["floor_idx"], room_idx=cat["room_idx"], weight=cat["weight"],
        threshold=cat["threshold"], plan_x=cat["px"], plan_z=cat["pz"],
        room_ids=room_ids, room_names=room_names,
    )
