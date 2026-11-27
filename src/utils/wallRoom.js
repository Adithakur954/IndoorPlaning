// Turns walls drawn one by one into a room: starting from one wall, follow the
// walls joined end to end (ends closer than `tolerance` count as joined) and use
// their corners as the room outline. A closed loop gives the room as drawn; an
// open chain (e.g. three sides of a box) is closed with a straight side.

const num = (v) => Number(v) || 0;

// returns { points, wallIds, closed } or { error }
export function roomOutlineFromWalls(walls, startId, tolerance = 0.3) {
  const start = walls.find((w) => w.id === startId);
  if (!start) return { error: "Select a wall first." };
  const ends = (w) => [
    { x: num(w.x1), z: num(w.z1) },
    { x: num(w.x2), z: num(w.z2) },
  ];
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) <= tolerance;
  // the other wall (not used yet) with an end at point p; null at a dead end or
  // where three or more walls meet (the way on is not clear)
  const used = new Set([start.id]);
  const next = (p) => {
    const found = walls.filter((w) => !used.has(w.id) && ends(w).some((e) => near(e, p)));
    return found.length === 1 ? found[0] : null;
  };
  // walk forward from the start wall's second end, then backward from its first
  const [a, b] = ends(start);
  const forward = [b];
  let tip = b;
  let closed = false;
  for (let w = next(tip); w; w = next(tip)) {
    used.add(w.id);
    const [p, q] = ends(w);
    tip = near(p, tip) ? q : p;
    if (near(tip, a)) {
      closed = true;
      break;
    }
    forward.push(tip);
  }
  const backward = [];
  if (!closed) {
    tip = a;
    for (let w = next(tip); w; w = next(tip)) {
      used.add(w.id);
      const [p, q] = ends(w);
      tip = near(p, tip) ? q : p;
      backward.unshift(tip);
    }
  }
  const points = [...backward, a, ...forward];
  // corners that are not corners (straight-through joints) are dropped
  const outline = points.filter((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length];
    const nextP = points[(i + 1) % points.length];
    const cross = (p.x - prev.x) * (nextP.z - p.z) - (p.z - prev.z) * (nextP.x - p.x);
    return Math.abs(cross) > 1e-6;
  });
  if (outline.length < 3)
    return {
      error:
        used.size < 2
          ? "This wall is not joined to other walls. Draw the walls so their ends meet."
          : "These walls do not enclose an area.",
    };
  const twice = outline.reduce((s, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return s + p.x * q.z - q.x * p.z;
  }, 0);
  if (Math.abs(twice) / 2 < 0.25) return { error: "These walls enclose almost no area." };
  return { points: outline, wallIds: [...used], closed };
}

// Breaks one wall into two at `at` metres from its first end (x1, z1). Both
// pieces keep every other property of the wall; the first keeps its id.
// returns [first, second] or { error }
export function splitWall(wall, at, newId) {
  const x1 = num(wall.x1),
    z1 = num(wall.z1),
    x2 = num(wall.x2),
    z2 = num(wall.z2);
  const length = Math.hypot(x2 - x1, z2 - z1);
  const d = num(at);
  const minPiece = 0.05;
  if (!(length > 2 * minPiece)) return { error: "This wall is too short to break." };
  if (!(d >= minPiece && d <= length - minPiece))
    return { error: "Choose a break point inside the wall." };
  const t = d / length;
  const mx = x1 + (x2 - x1) * t,
    mz = z1 + (z2 - z1) * t;
  return [
    { ...wall, x1, z1, x2: mx, z2: mz },
    { ...wall, id: newId, x1: mx, z1: mz, x2, z2 },
  ];
}

// The reverse of a room made from walls: one loose wall per side of a
// rectangle or polygon room. Rectangle sides keep their own material
// (wallTypes "<roomId>:north" ...), other sides use the room material.
const RECT_SIDES = ["north", "east", "south", "west"];
export function wallsFromRoom(room, wallTypes = {}, makeId) {
  if (room.shape === "circle") return { error: "A round room cannot be split into walls." };
  const polygon = room.shape === "polygon" && room.polygonPoints?.length >= 3;
  const points = polygon
    ? room.polygonPoints.map((p) => ({ x: num(p.x ?? p[0]), z: num(p.z ?? p[1]) }))
    : [
        { x: num(room.x), z: num(room.z) },
        { x: num(room.x) + num(room.width), z: num(room.z) },
        { x: num(room.x) + num(room.width), z: num(room.z) + num(room.depth) },
        { x: num(room.x), z: num(room.z) + num(room.depth) },
      ];
  const base = room.material || "drywall";
  return points
    .map((a, i) => {
      const b = points[(i + 1) % points.length];
      const side = polygon ? null : RECT_SIDES[i];
      return {
        id: makeId(),
        floorId: room.floorId,
        name: side ? `${room.name || "Room"} ${side} wall` : `${room.name || "Room"} wall ${i + 1}`,
        x1: a.x,
        z1: a.z,
        x2: b.x,
        z2: b.z,
        material: (side && wallTypes[`${room.id}:${side}`]) || base,
        ...(room.height ? { height: num(room.height) } : {}),
      };
    })
    .filter((w) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1) > 1e-6);
}

// Distance along a wall (from x1, z1) of the point on it nearest to p.
export function distanceAlongWall(wall, p) {
  const x1 = num(wall.x1),
    z1 = num(wall.z1),
    dx = num(wall.x2) - x1,
    dz = num(wall.z2) - z1;
  const length = Math.hypot(dx, dz);
  if (!length) return 0;
  const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.z - z1) * dz) / (length * length)));
  return t * length;
}

// ---- doors and windows when rooms and walls change into each other ----------
// A door or window sits either on a room wall (roomId + wallSide on a
// rectangle, roomId + edgeIndex on a polygon, `offset` from the side's left or
// top end) or on a loose wall (wallId, `offset` from the wall's x1, z1).

const roomCorners = (room) =>
  room.shape === "polygon" && room.polygonPoints?.length >= 3
    ? room.polygonPoints.map((p) => ({ x: num(p.x ?? p[0]), z: num(p.z ?? p[1]) }))
    : [
        { x: num(room.x), z: num(room.z) },
        { x: num(room.x) + num(room.width), z: num(room.z) },
        { x: num(room.x) + num(room.width), z: num(room.z) + num(room.depth) },
        { x: num(room.x), z: num(room.z) + num(room.depth) },
      ];
const isRect = (room) => !(room.shape === "polygon" && room.polygonPoints?.length >= 3);
// south and west offsets run against the edge direction (see wallPieces.js)
const reversed = (side) => side === "south" || side === "west";
const withoutPlace = ({ roomId, wallSide, edgeIndex, wallId, ...rest }) => rest;

// Openings of `room` move onto the loose walls made from its sides.
export function openingsOntoWalls(room, walls, items) {
  const pts = roomCorners(room);
  const rect = isRect(room);
  return items.map((o) => {
    if (o.roomId !== room.id) return o;
    const i = rect ? RECT_SIDES.indexOf(o.wallSide) : Number(o.edgeIndex);
    if (!(i >= 0 && i < pts.length)) return o;
    const a = pts[i],
      b = pts[(i + 1) % pts.length],
      length = Math.hypot(b.x - a.x, b.z - a.z);
    const wall = walls.find(
      (w) =>
        Math.hypot(w.x1 - a.x, w.z1 - a.z) < 1e-6 && Math.hypot(w.x2 - b.x, w.z2 - b.z) < 1e-6,
    );
    if (!wall) return o;
    const offset = num(o.offset),
      width = num(o.width);
    const start = rect && reversed(o.wallSide) ? length - offset - width : offset;
    return { ...withoutPlace(o), wallId: wall.id, offset: Math.max(0, start) };
  });
}

// Openings on loose walls that became `room` move onto the room side they lie on.
export function openingsOntoRoom(room, walls, items) {
  const pts = roomCorners(room);
  const rect = isRect(room);
  const byId = new Map(walls.map((w) => [w.id, w]));
  const project = (a, b, p) => {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      len2 = dx * dx + dz * dz || 1,
      t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    const q = { x: a.x + dx * t, z: a.z + dz * t };
    return { along: t * Math.sqrt(len2), gap: Math.hypot(p.x - q.x, p.z - q.z) };
  };
  return items.map((o) => {
    const w = byId.get(o.wallId);
    if (!w) return o;
    const length = Math.hypot(w.x2 - w.x1, w.z2 - w.z1) || 1;
    const at = (d) => ({
      x: num(w.x1) + ((w.x2 - w.x1) * d) / length,
      z: num(w.z1) + ((w.z2 - w.z1) * d) / length,
    });
    const s = at(num(o.offset)),
      e = at(num(o.offset) + num(o.width));
    let best = null;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const ps = project(a, b, s),
        pe = project(a, b, e);
      const gap = Math.max(ps.gap, pe.gap);
      if (!best || gap < best.gap)
        best = { i, gap, start: Math.min(ps.along, pe.along), length: Math.hypot(b.x - a.x, b.z - a.z) };
    });
    if (!best) return o;
    const width = num(o.width);
    const place = rect
      ? {
          wallSide: RECT_SIDES[best.i],
          offset: Math.max(0, reversed(RECT_SIDES[best.i]) ? best.length - best.start - width : best.start),
        }
      : { edgeIndex: best.i, offset: Math.max(0, best.start) };
    return { ...withoutPlace(o), roomId: room.id, ...place };
  });
}

// Openings on a wall broken at `at` metres: those past the cut move to the
// second piece. A cut through a door or window is refused.
export function openingsAfterBreak(items, wallId, newId, at) {
  const cut = num(at);
  for (const o of items)
    if (o.wallId === wallId && cut > num(o.offset) + 1e-6 && cut < num(o.offset) + num(o.width) - 1e-6)
      return { error: "That point is inside a door or window. Pick a point beside it." };
  return {
    items: items.map((o) =>
      o.wallId === wallId && num(o.offset) >= cut - 1e-6
        ? { ...o, wallId: newId, offset: num(o.offset) - cut }
        : o,
    ),
  };
}

// ---- merging two loose walls into one ---------------------------------------
// Walls that continue the selected wall in a straight line: parallel (within
// about 3 degrees), on the same line (within `tolerance`) and touching or
// nearly touching end to end, or overlapping.
export function mergeableWalls(walls, wallId, tolerance = 0.3) {
  const a = walls.find((w) => w.id === wallId);
  if (!a) return [];
  const ax = num(a.x2) - num(a.x1),
    az = num(a.z2) - num(a.z1),
    la = Math.hypot(ax, az);
  if (!la) return [];
  const ux = ax / la,
    uz = az / la;
  // position along a's line, and distance off it
  const along = (p) => (p.x - num(a.x1)) * ux + (p.z - num(a.z1)) * uz;
  const off = (p) => Math.abs(-(p.x - num(a.x1)) * uz + (p.z - num(a.z1)) * ux);
  return walls.filter((b) => {
    if (b.id === a.id || b.floorId !== a.floorId) return false;
    const bx = num(b.x2) - num(b.x1),
      bz = num(b.z2) - num(b.z1),
      lb = Math.hypot(bx, bz);
    if (!lb) return false;
    if (Math.abs(ux * bz / lb - uz * bx / lb) > 0.05) return false; // not parallel
    const p1 = { x: num(b.x1), z: num(b.z1) },
      p2 = { x: num(b.x2), z: num(b.z2) };
    if (off(p1) > tolerance || off(p2) > tolerance) return false; // not on the same line
    const lo = Math.min(along(p1), along(p2)),
      hi = Math.max(along(p1), along(p2));
    return lo <= la + tolerance && hi >= -tolerance; // touching, nearly, or overlapping
  });
}

// One wall from `a` and `b` (see mergeableWalls): it runs along a's line from
// the furthest end of either to the other, keeps a's id, name and material and
// the taller height. Doors and windows of both stay where they are.
export function mergeTwoWalls(a, b, items = []) {
  const x1 = num(a.x1),
    z1 = num(a.z1),
    dx = num(a.x2) - x1,
    dz = num(a.z2) - z1,
    la = Math.hypot(dx, dz);
  const ux = dx / la,
    uz = dz / la;
  const along = (p) => (p.x - x1) * ux + (p.z - z1) * uz;
  const ts = [0, la, along({ x: num(b.x1), z: num(b.z1) }), along({ x: num(b.x2), z: num(b.z2) })];
  const lo = Math.min(...ts),
    hi = Math.max(...ts);
  const heights = [a.height, b.height].map(Number).filter((h) => h > 0);
  const wall = {
    ...a,
    x1: x1 + ux * lo,
    z1: z1 + uz * lo,
    x2: x1 + ux * hi,
    z2: z1 + uz * hi,
    ...(heights.length ? { height: Math.max(...heights) } : {}),
  };
  const moved = items.map((o) => {
    if (o.wallId !== a.id && o.wallId !== b.id) return o;
    const w = o.wallId === a.id ? a : b;
    const wl = Math.hypot(num(w.x2) - num(w.x1), num(w.z2) - num(w.z1)) || 1;
    const at = (d) => ({
      x: num(w.x1) + ((num(w.x2) - num(w.x1)) * d) / wl,
      z: num(w.z1) + ((num(w.z2) - num(w.z1)) * d) / wl,
    });
    const s = along(at(num(o.offset))) - lo,
      e = along(at(num(o.offset) + num(o.width))) - lo;
    return { ...o, wallId: a.id, offset: Math.max(0, Math.min(s, e)) };
  });
  return { wall, items: moved };
}
