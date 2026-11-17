// Walls and rooms that collide, and the actions that merge them.
//
// * "shared": two rooms (or a room and the building boundary) already lie on
//   the same line. The wall model counts that stretch once; merging lets you
//   choose its one material (it removes the "different materials" conflict).
// * "close": the walls of two shapes are parallel and closer than a wall is
//   thick, so they overlap each other. Merging snaps the smaller shape's wall
//   onto the other one, leaving one wall.
import { areaOf, bbox, boundaryAreas, pointsOf } from "./geometry.js";
import { buildWalls } from "./wallGraph.js";

const SIDES = ["north", "east", "south", "west"];
const LINE_TOLERANCE = 0.03; // the wall model already merges walls this close
const MIN_OVERLAP = 0.3; // metres of wall that must face each other
const EPS = 1e-9;
const round = (v) => Math.round(v * 1e6) / 1e6 + 0;

const isRect = (r) => !r.shape || r.shape === "rectangle";

const shapesOf = (plan, floorId) => [
  ...boundaryAreas(plan, floorId).map((b) => ({ ...b, type: "boundary" })),
  ...plan.rooms
    .filter((r) => r.floorId === floorId && r.shape !== "circle")
    .map((r) => ({ ...r, type: "room" })),
];

function segmentsOf(plan, floorId) {
  const out = [];
  for (const shape of shapesOf(plan, floorId)) {
    const pts = pointsOf(shape);
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.05) return;
      out.push({
        owner: { type: shape.type, id: shape.id, name: shape.name },
        a,
        b,
        index: i,
        side: shape.type === "room" && isRect(shape) ? SIDES[i] : "",
        length,
        ux: (b.x - a.x) / length,
        uz: (b.z - a.z) / length,
      });
    });
  }
  return out;
}

// Walls the model already counts once, but that belong to two shapes.
function sharedCollisions(plan, floorId) {
  return buildWalls(plan, floorId)
    .filter((w) => w.length >= 0.2 && new Set(w.owners.map((o) => o.id)).size > 1)
    .map((w, i) => ({
      id: `shared-${i}`,
      kind: "shared",
      owners: w.owners,
      length: w.length,
      material: w.material,
      materials: w.materialConflict || [w.material],
      a: w.a,
      b: w.b,
    }));
}

// Parallel walls of two shapes that sit closer than a wall is thick.
function closeCollisions(plan, floorId) {
  const maxGap = Math.max(Number(plan.wallThickness) || 0.2, 0.1);
  const segs = segmentsOf(plan, floorId);
  const out = [];
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i],
        t = segs[j];
      if (s.owner.id === t.owner.id) continue;
      if (Math.abs(s.ux * t.uz - s.uz * t.ux) > 1e-3) continue;
      const gap = Math.abs(-s.uz * (t.a.x - s.a.x) + s.ux * (t.a.z - s.a.z));
      if (gap <= LINE_TOLERANCE || gap > maxGap) continue;
      const along = (p) => (p.x - s.a.x) * s.ux + (p.z - s.a.z) * s.uz;
      const lo = Math.max(0, Math.min(along(t.a), along(t.b))),
        hi = Math.min(s.length, Math.max(along(t.a), along(t.b)));
      if (hi - lo < MIN_OVERLAP) continue;
      out.push({
        id: `close-${s.owner.id}-${s.index}-${t.owner.id}-${t.index}`,
        kind: "close",
        floorId,
        gap,
        length: hi - lo,
        owners: [s.owner, t.owner],
        a: { x: s.a.x + s.ux * lo, z: s.a.z + s.uz * lo },
        b: { x: s.a.x + s.ux * hi, z: s.a.z + s.uz * hi },
        segments: [
          { owner: s.owner, index: s.index, side: s.side, a: s.a, b: s.b },
          { owner: t.owner, index: t.index, side: t.side, a: t.a, b: t.b },
        ],
      });
    }
  return out;
}

export const findWallCollisions = (plan, floorId) => [
  ...sharedCollisions(plan, floorId),
  ...closeCollisions(plan, floorId),
];

// ---- merging walls ---------------------------------------------------------

// One material for a shared wall: every owner's side gets it.
export function mergeSharedWall(plan, collision, material) {
  const wallTypes = { ...(plan.wallTypes || {}) };
  const roomIds = new Set(),
    boundaryIds = new Set();
  for (const owner of collision.owners) {
    if (owner.type === "boundary") boundaryIds.add(owner.id);
    else if (owner.side) wallTypes[`${owner.id}:${owner.side}`] = material;
    else roomIds.add(owner.id); // polygon rooms have one material for all walls
  }
  return {
    ...plan,
    wallTypes,
    rooms: plan.rooms.map((r) => (roomIds.has(r.id) ? { ...r, material } : r)),
    boundaries: (plan.boundaries || []).map((b) =>
      boundaryIds.has(b.id) ? { ...b, material } : b,
    ),
  };
}

const areaOfOwner = (plan, owner) =>
  owner.type === "boundary"
    ? areaOf({
        shape: "polygon",
        polygonPoints: plan.boundaries.find((b) => b.id === owner.id).points,
      })
    : areaOf(plan.rooms.find((r) => r.id === owner.id));

// Snaps the wall of the smaller shape (never the building boundary) onto the
// other wall, so the two become one wall.
export function snapCollidingWalls(plan, collision) {
  const [first, second] = collision.segments;
  let moving, fixed;
  if (first.owner.type === "boundary") [moving, fixed] = [second, first];
  else if (second.owner.type === "boundary") [moving, fixed] = [first, second];
  else
    [moving, fixed] =
      areaOfOwner(plan, first.owner) <= areaOfOwner(plan, second.owner)
        ? [first, second]
        : [second, first];
  const fl = Math.hypot(fixed.b.x - fixed.a.x, fixed.b.z - fixed.a.z);
  const ux = (fixed.b.x - fixed.a.x) / fl,
    uz = (fixed.b.z - fixed.a.z) / fl;
  // the fixed wall's line, read at a position of the moving wall
  const zAt = (x) => fixed.a.z + (uz / (ux || EPS)) * (x - fixed.a.x);
  const xAt = (z) => fixed.a.x + (ux / (uz || EPS)) * (z - fixed.a.z);

  if (moving.owner.type === "room" && moving.side) {
    const room = plan.rooms.find((r) => r.id === moving.owner.id);
    const b = bbox(room);
    const midX = (b.minX + b.maxX) / 2,
      midZ = (b.minZ + b.maxZ) / 2;
    const next = { ...room };
    if (moving.side === "north") {
      next.z = zAt(midX);
      next.depth = b.maxZ - next.z;
    } else if (moving.side === "south") {
      next.depth = zAt(midX) - b.minZ;
    } else if (moving.side === "west") {
      next.x = xAt(midZ);
      next.width = b.maxX - next.x;
    } else {
      next.width = xAt(midZ) - b.minX;
    }
    for (const key of ["x", "z", "width", "depth"]) next[key] = round(next[key]);
    return {
      ...plan,
      rooms: plan.rooms.map((r) => (r.id === room.id ? next : r)),
    };
  }

  // polygons and the boundary: move the wall's two corners onto the line
  const boundary = (plan.boundaries || []).find((x) => x.id === moving.owner.id);
  const room = plan.rooms.find((r) => r.id === moving.owner.id);
  const points = boundary ? boundary.points : pointsOf(room);
  const corners = new Set([moving.index, (moving.index + 1) % points.length]);
  const shift = (p) => {
    const d = ux * (p.z - fixed.a.z) - uz * (p.x - fixed.a.x); // signed distance
    return { x: round(p.x + uz * d), z: round(p.z - ux * d) };
  };
  const next = points.map((p, i) => (corners.has(i) ? shift(p) : p));
  if (boundary)
    return {
      ...plan,
      boundaries: plan.boundaries.map((x) =>
        x.id === boundary.id ? { ...x, points: next } : x,
      ),
    };
  const xs = next.map((p) => p.x),
    zs = next.map((p) => p.z);
  return {
    ...plan,
    rooms: plan.rooms.map((r) =>
      r.id === room.id
        ? {
            ...r,
            shape: "polygon",
            polygonPoints: next,
            x: Math.min(...xs),
            z: Math.min(...zs),
            width: round(Math.max(...xs) - Math.min(...xs)),
            depth: round(Math.max(...zs) - Math.min(...zs)),
          }
        : r,
    ),
  };
}

// Material of one side of a room. A wall shared with another room (or the
// building boundary) is one wall, so the other side(s) of it change too;
// otherwise the neighbour's old material could still decide the wall.
export function setSideMaterial(plan, roomId, side, material) {
  const room = plan.rooms.find((r) => r.id === roomId);
  let next = {
    ...plan,
    wallTypes: { ...(plan.wallTypes || {}), [`${roomId}:${side}`]: material },
  };
  if (!room) return next;
  for (const wall of buildWalls(plan, room.floorId))
    if (wall.owners.some((o) => o.id === roomId && o.side === side))
      next = mergeSharedWall(next, { owners: wall.owners }, material);
  return next;
}

// Names of the shapes that share a side of a room (empty when it is alone).
export function sideSharedWith(plan, roomId, side) {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return [];
  const names = new Set();
  for (const wall of buildWalls(plan, room.floorId))
    if (wall.owners.some((o) => o.id === roomId && o.side === side))
      for (const o of wall.owners)
        if (o.id !== roomId) names.add(o.name || o.type);
  return [...names];
}
