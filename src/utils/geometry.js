export const pointsOf = (r) =>
  r.shape === "polygon" && r.polygonPoints?.length >= 3
    ? r.polygonPoints.map((p) => ({
        x: Number(p.x ?? p[0]),
        z: Number(p.z ?? p[1]),
      }))
    : r.shape === "circle"
      ? Array.from({ length: 48 }, (_, i) => ({
          x:
            Number(r.x) +
            Number(r.width) / 2 +
            Number(r.radius || r.width / 2) * Math.cos((i * Math.PI) / 24),
          z:
            Number(r.z) +
            Number(r.depth) / 2 +
            Number(r.radius || r.width / 2) * Math.sin((i * Math.PI) / 24),
        }))
      : [
          { x: +r.x, z: +r.z },
          { x: +r.x + +r.width, z: +r.z },
          { x: +r.x + +r.width, z: +r.z + +r.depth },
          { x: +r.x, z: +r.z + +r.depth },
        ];
export function resizePolygonPoints(vertices, count) {
  const points = vertices.map((point) => ({
    x: Number(point.x ?? point[0]),
    z: Number(point.z ?? point[1]),
  }));
  const targetCount = Math.max(3, Math.min(64, Math.round(Number(count) || 3)));
  if (points.length < 3) return points;
  const segments = points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    return { start, end, length: Math.hypot(end.x - start.x, end.z - start.z) };
  });
  const perimeter = segments.reduce(
    (total, segment) => total + segment.length,
    0,
  );
  if (!perimeter) return points.slice(0, targetCount);
  return Array.from({ length: targetCount }, (_, index) => {
    let remaining = (index * perimeter) / targetCount;
    const segment =
      segments.find((candidate) => {
        if (remaining <= candidate.length) return true;
        remaining -= candidate.length;
        return false;
      }) || segments.at(-1);
    const ratio = segment.length ? remaining / segment.length : 0;
    return {
      x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
      z: segment.start.z + (segment.end.z - segment.start.z) * ratio,
    };
  });
}
export function areaOf(r) {
  const pts = pointsOf(r);
  return (
    Math.abs(
      pts.reduce(
        (sum, p, i) =>
          sum +
          p.x * pts[(i + 1) % pts.length].z -
          pts[(i + 1) % pts.length].x * p.z,
        0,
      ),
    ) / 2
  );
}
export function inside(x, z, r) {
  const p = pointsOf(r);
  let yes = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if (
      p[i].z > z !== p[j].z > z &&
      x < ((p[j].x - p[i].x) * (z - p[i].z)) / (p[j].z - p[i].z) + p[i].x
    )
      yes = !yes;
  return yes;
}
export function bbox(r) {
  const p = pointsOf(r);
  return {
    minX: Math.min(...p.map((x) => x.x)),
    maxX: Math.max(...p.map((x) => x.x)),
    minZ: Math.min(...p.map((x) => x.z)),
    maxZ: Math.max(...p.map((x) => x.z)),
  };
}
const TOUCH_TOLERANCE = 0.03; // metres: rooms closer than this share a wall

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    len2 = dx * dx + dz * dz;
  const t = len2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

// Is every corner of `inner` inside `outer` or on its wall?
export function isNestedIn(inner, outer) {
  const o = pointsOf(outer);
  return pointsOf(inner).every(
    (p) =>
      inside(p.x, p.z, outer) ||
      o.some(
        (a, i) =>
          distanceToSegment(p, a, o[(i + 1) % o.length]) <= TOUCH_TOLERANCE,
      ),
  );
}

const areasOverlap = (ra, rb) => {
  const a = bbox(ra),
    b = bbox(rb);
  const loX = Math.max(a.minX, b.minX),
    hiX = Math.min(a.maxX, b.maxX),
    loZ = Math.max(a.minZ, b.minZ),
    hiZ = Math.min(a.maxZ, b.maxZ);
  // touching or sharing a wall is not an overlap
  if (hiX - loX <= TOUCH_TOLERANCE || hiZ - loZ <= TOUCH_TOLERANCE)
    return false;
  const n = 9;
  for (let u = 0; u < n; u++)
    for (let v = 0; v < n; v++) {
      const x = loX + ((u + 0.5) * (hiX - loX)) / n,
        z = loZ + ((v + 0.5) * (hiZ - loZ)) / n;
      if (inside(x, z, ra) && inside(x, z, rb)) return true;
    }
  return false;
};

// Pairs [inner, outer] where one room lies completely inside another (for
// example the building shell drawn as a room with the rooms in it).
export function nestedRooms(rooms) {
  const pairs = [];
  for (let i = 0; i < rooms.length; i++)
    for (let j = 0; j < rooms.length; j++) {
      if (i === j || !areasOverlap(rooms[i], rooms[j])) continue;
      if (!isNestedIn(rooms[i], rooms[j])) continue;
      // identical rooms are a real overlap, not nesting
      if (isNestedIn(rooms[j], rooms[i]) && j < i) continue;
      if (isNestedIn(rooms[j], rooms[i])) continue;
      pairs.push([rooms[i], rooms[j]]);
    }
  return pairs;
}

// Rooms that really overlap (partly, or identical). Rooms that only touch or
// share a wall, and rooms nested inside another, are not reported.
export function overlapWarnings(rooms) {
  const out = [];
  const nested = nestedRooms(rooms);
  const isPair = (a, b) =>
    nested.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      if (isPair(rooms[i], rooms[j])) continue;
      if (areasOverlap(rooms[i], rooms[j]))
        out.push(`${rooms[i].name} overlaps ${rooms[j].name}`);
    }
  return out;
}

export const nestedRoomNotes = (rooms) =>
  nestedRooms(rooms).map(
    ([inner, outer]) => `${inner.name} is inside ${outer.name}`,
  );
// Building outlines of a floor as room-like areas (polygons), so room helpers
// such as inside() and pointsOf() work on them.
export const boundaryAreas = (plan, floorId) =>
  (plan.boundaries || [])
    .filter((b) => b.floorId === floorId)
    .map((b) => ({
      id: b.id,
      floorId: b.floorId,
      name: b.name,
      shape: "polygon",
      polygonPoints: b.points,
      height: b.height,
      material: b.material,
    }));

// What sits inside a room on its floor: furniture and sources by their centre,
// interior walls by their middle, and rooms nested inside it. Doors and windows
// belong to a room by id, so they follow it without being listed here.
export function roomContents(plan, room) {
  const same = (x) => x.floorId === room.floorId;
  return {
    furniture: plan.furniture
      .filter(
        (f) =>
          same(f) &&
          inside(+f.x + (+f.width || 0) / 2, +f.z + (+f.depth || 0) / 2, room),
      )
      .map((f) => f.id),
    sources: plan.sources
      .filter((s) => same(s) && inside(+s.x, +s.z, room))
      .map((s) => s.id),
    walls: plan.interiorWalls
      .filter((w) => same(w) && inside((+w.x1 + +w.x2) / 2, (+w.z1 + +w.z2) / 2, room))
      .map((w) => w.id),
    rooms: plan.rooms
      .filter((r) => r.id !== room.id && same(r) && isNestedIn(r, room))
      .map((r) => r.id),
  };
}

const movePolygon = (r, dx, dz) =>
  r.shape === "polygon"
    ? {
        ...r,
        x: +r.x + dx,
        z: +r.z + dz,
        polygonPoints: pointsOf(r).map((p) => ({ x: p.x + dx, z: p.z + dz })),
      }
    : { ...r, x: +r.x + dx, z: +r.z + dz };

// The plan with everything inside `room` shifted by (dx, dz). The room itself
// is not moved here.
export function shiftRoomContents(plan, room, dx, dz) {
  const c = roomContents(plan, room);
  const ids = (list) => new Set(list);
  const f = ids(c.furniture),
    s = ids(c.sources),
    w = ids(c.walls),
    r = ids(c.rooms);
  // DAS cable bends between parts that move with the room move too
  const cables = plan.cellular?.cables;
  const cellular =
    Array.isArray(cables) && cables.some((x) => x.points?.length && s.has(x.from) && s.has(x.to))
      ? {
          ...plan.cellular,
          cables: cables.map((x) =>
            x.points?.length && s.has(x.from) && s.has(x.to)
              ? { ...x, points: x.points.map((p) => ({ ...p, x: +p.x + dx, z: +p.z + dz })) }
              : x,
          ),
        }
      : plan.cellular;
  return {
    ...plan,
    ...(cellular ? { cellular } : {}),
    furniture: plan.furniture.map((x) =>
      f.has(x.id) ? { ...x, x: +x.x + dx, z: +x.z + dz } : x,
    ),
    sources: plan.sources.map((x) =>
      s.has(x.id) ? { ...x, x: +x.x + dx, z: +x.z + dz } : x,
    ),
    interiorWalls: plan.interiorWalls.map((x) =>
      w.has(x.id)
        ? { ...x, x1: +x.x1 + dx, x2: +x.x2 + dx, z1: +x.z1 + dz, z2: +x.z2 + dz }
        : x,
    ),
    rooms: plan.rooms.map((x) => (r.has(x.id) ? movePolygon(x, dx, dz) : x)),
  };
}

// Length label data for every edge of a shape: the edge midpoint, a text angle
// that never reads upside down, and the unit normal pointing into the shape
// (for an open polyline such as a wall: the left side).
export function edgeMeasures(points, closed = true) {
  const pts = points.map((p) => ({ x: Number(p.x), z: Number(p.z) }));
  const n = pts.length;
  if (n < 2) return [];
  let twiceArea = 0;
  if (closed)
    for (let i = 0; i < n; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n];
      twiceArea += a.x * b.z - b.x * a.z;
    }
  const inside = closed && twiceArea < 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i],
      b = pts[(i + 1) % n],
      dx = b.x - a.x,
      dz = b.z - a.z,
      length = Math.hypot(dx, dz);
    if (!(length > 1e-6)) continue;
    let angleDeg = (Math.atan2(dz, dx) * 180) / Math.PI;
    if (angleDeg > 90) angleDeg -= 180;
    else if (angleDeg <= -90) angleDeg += 180;
    out.push({
      index: i,
      a,
      b,
      length,
      mid: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
      angleDeg,
      inward: { x: (-dz / length) * inside, z: (dx / length) * inside },
    });
  }
  return out;
}

// "4.50 m" below 10 m, "12.3 m" above
export const formatMetres = (m) =>
  `${Number(m).toFixed(Math.abs(m) < 10 ? 2 : 1)} m`;
