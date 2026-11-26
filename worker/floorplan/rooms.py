"""Rooms from the wall graph, plus topology checks."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

from .walls import Wall


@dataclass
class Room:
    polygon: list[tuple[float, float]]
    area_px: float
    confidence: float
    label: str | None = None
    notes: list[str] = field(default_factory=list)


def wall_lines(walls: list[Wall]) -> list[LineString]:
    return [LineString([w.a, w.b]) for w in walls if w.length > 1e-6]


def build_rooms(walls: list[Wall], min_area_px: float, thickness: float,
                image_size: tuple[int, int]) -> tuple[list[Room], Polygon | None]:
    """Closed faces of the wall centre-lines. Door and window gaps are inside
    continuous wall lines, so a room stays closed through its openings."""
    lines = wall_lines(walls)
    if not lines:
        return [], None
    noded = unary_union(lines)
    faces = list(polygonize(noded))
    width, height = image_size
    rooms: list[Room] = []
    for face in faces:
        if face.area < min_area_px or not face.is_valid:
            continue
        simple = face.simplify(max(1.0, 0.25 * thickness), preserve_topology=True)
        if not isinstance(simple, Polygon) or simple.is_empty:
            continue
        coords = [(float(x), float(y)) for x, y in simple.exterior.coords[:-1]]
        notes: list[str] = []
        confidence = 0.9
        x0, y0, x1, y1 = simple.bounds
        if x0 < 2 or y0 < 2 or x1 > width - 2 or y1 > height - 2:
            confidence -= 0.3
            notes.append("touches the image border (drawing may be cut off)")
        rect_fill = simple.area / max(simple.minimum_rotated_rectangle.area, 1.0)
        if rect_fill < 0.5:
            confidence -= 0.2
            notes.append("irregular outline")
        rooms.append(Room(coords, float(simple.area), max(0.1, confidence), notes=notes))
    outline = unary_union([Polygon(r.polygon) for r in rooms]) if rooms else None
    if outline is not None and outline.geom_type == "MultiPolygon":
        outline = max(outline.geoms, key=lambda g: g.area)
    return rooms, outline


def room_wall_support(room: Room, walls: list[Wall], tol: float) -> float:
    """Fraction of the room boundary lying on a detected wall (1 = closed)."""
    ring = LineString(room.polygon + [room.polygon[0]])
    union = unary_union([LineString([w.a, w.b]).buffer(tol) for w in walls])
    return float(ring.intersection(union).length / max(ring.length, 1e-6))


def label_rooms(rooms: list[Room], texts: list[dict]) -> None:
    """Puts a recognised text inside the room that contains its centre. A room
    holding many different texts (a whole floor with seat counts and notes) gets
    no name: the text is not its name."""
    for room in rooms:
        poly = Polygon(room.polygon)
        inside = [t for t in texts
                  if t.get("kind") == "label" and poly.contains(Point(t["x"], t["y"]))]
        if 0 < len(inside) <= 2:
            best = max(inside, key=lambda t: t["height"] * len(t["text"]))
            room.label = best["text"]


def topology_report(walls: list[Wall], rooms: list[Room], tol: float) -> dict:
    """Dangling wall ends, unclosed rooms and invalid polygons."""
    ends: list[tuple[int, int, tuple[float, float]]] = []
    for i, w in enumerate(walls):
        ends.append((i, 0, w.a))
        ends.append((i, 1, w.b))
    dangling: list[dict] = []
    for i, end, p in ends:
        joined = False
        for j, other in enumerate(walls):
            if i == j:
                continue
            d = LineString([other.a, other.b]).distance(Point(p))
            if d <= tol:
                joined = True
                break
        if not joined:
            dangling.append({"wall": i, "end": "ab"[end], "x": p[0], "y": p[1]})
    invalid = [i for i, r in enumerate(rooms) if not Polygon(r.polygon).is_valid]
    overlaps: list[list[int]] = []
    polys = [Polygon(r.polygon) for r in rooms]
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            if polys[i].intersection(polys[j]).area > 0.05 * min(polys[i].area, polys[j].area):
                overlaps.append([i, j])
    return {"danglingEnds": dangling, "invalidRooms": invalid, "overlappingRooms": overlaps,
            "wallCount": len(walls), "roomCount": len(rooms)}


def drop_isolated_fragments(walls: list[Wall], tol: float, max_len: float) -> tuple[list[Wall], int]:
    """Short pieces joined to nothing at either end (a column edge, a symbol)
    are not walls. Returns (walls kept, number dropped)."""
    keep: list[Wall] = []
    dropped = 0
    lines = [LineString([w.a, w.b]) for w in walls]
    for i, w in enumerate(walls):
        if w.length <= max_len:
            joined = any(
                j != i and (lines[j].distance(Point(w.a)) <= tol or lines[j].distance(Point(w.b)) <= tol)
                for j in range(len(walls)))
            if not joined:
                dropped += 1
                continue
        keep.append(w)
    return keep, dropped


def main_network_bounds(walls: list[Wall], tol: float,
                        min_share: float = 0.05) -> tuple[float, float, float, float] | None:
    """Bounding box (x0, x1, y0, y1) of the building's walls: the connected wall
    network with the most wall length, plus every other network that holds at
    least `min_share` of that length and overlaps its box. Title blocks, legends
    and the sheet frame are separate, smaller networks and are left out."""
    n = len(walls)
    if n == 0:
        return None
    lines = [LineString([w.a, w.b]) for w in walls]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if lines[i].distance(lines[j]) <= tol:
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    def box(idx):
        xs = [c for i in idx for c in (walls[i].a[0], walls[i].b[0])]
        ys = [c for i in idx for c in (walls[i].a[1], walls[i].b[1])]
        return min(xs), max(xs), min(ys), max(ys)

    total = {g: sum(walls[i].length for i in idx) for g, idx in groups.items()}
    main = max(total, key=total.get)
    x0, x1, y0, y1 = box(groups[main])
    for g, idx in groups.items():
        if g == main or total[g] < min_share * total[main]:
            continue
        bx0, bx1, by0, by1 = box(idx)
        if bx1 >= x0 and bx0 <= x1 and by1 >= y0 and by0 <= y1:
            x0, x1, y0, y1 = min(x0, bx0), max(x1, bx1), min(y0, by0), max(y1, by1)
    return x0, x1, y0, y1


def drop_small_networks(walls: list[Wall], tol: float, min_total_len: float,
                        anchored: set[int] | None = None) -> tuple[list[Wall], int]:
    """Walls form connected networks. A network that adds up to less than
    `min_total_len` and is not attached to an outer wall (`anchored`) is
    furniture or a symbol, not part of the building."""
    n = len(walls)
    lines = [LineString([w.a, w.b]) for w in walls]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if lines[i].distance(lines[j]) <= tol:
                parent[find(i)] = find(j)
    total: dict[int, float] = {}
    attached: set[int] = set()
    for i, w in enumerate(walls):
        total[find(i)] = total.get(find(i), 0.0) + w.length
        if anchored and i in anchored:
            attached.add(find(i))
    keep = [w for i, w in enumerate(walls)
            if total[find(i)] >= min_total_len or find(i) in attached]
    return keep, n - len(keep)
