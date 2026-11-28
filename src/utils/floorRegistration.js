import { pointsOf } from "./geometry.js";

const sides = ["north", "east", "south", "west"];
const rounding = (n) => Math.round(n * 1e6) / 1e6;

function axisTransform(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 2 ||
      pairs.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => !Number.isFinite(v)))) {
    throw new Error("Provide at least two finite control points per axis.");
  }
  const points = pairs.toSorted(([a], [b]) => a - b);
  if (points.some(([from, to], i) => i && (from <= points[i - 1][0] || to <= points[i - 1][1]))) {
    throw new Error("Control points must preserve the order of both axes.");
  }
  return (value) => {
    const end = points.findIndex(([from], i) => i > 0 && value <= from);
    const i = end < 0 ? points.length - 1 : end;
    const [a, a1] = points[i - 1];
    const [b, b1] = points[i];
    return a1 + ((value - a) * (b1 - a1)) / (b - a);
  };
}

const identity = [[0, 0], [1, 1]];

function registerImageAxis(size, offset, profile, controls, move) {
  const oldProfile = profile || identity;
  const inverse = axisTransform(oldProfile.map(([u, v]) => [v, u]));
  const end = offset + size;
  const nextOffset = move(offset);
  const nextSize = move(end) - nextOffset;
  const breaks = new Set([
    ...oldProfile.map(([, v]) => v),
    ...controls.map(([v]) => (v - offset) / size).filter((v) => v > 0 && v < 1),
  ]);
  const registration = [...breaks].sort((a, b) => a - b).map((v) => [
    inverse(v),
    (move(offset + v * size) - nextOffset) / nextSize,
  ]);
  return { size: nextSize, offset: nextOffset, registration };
}

function registerImage(image, x, z, moveX, moveZ) {
  if (image.rotationDeg || !(image.widthM > 0 && image.heightM > 0)) {
    throw new Error("Axis control points require an unrotated, scaled floor image.");
  }
  const across = registerImageAxis(image.widthM, image.offsetX || 0, image.registration?.x, x, moveX);
  const depth = registerImageAxis(image.heightM, image.offsetZ || 0, image.registration?.z, z, moveZ);
  return {
    ...image,
    offsetX: across.offset, widthM: across.size,
    offsetZ: depth.offset, heightM: depth.size,
    registration: { x: across.registration, z: depth.registration },
  };
}

function openingEdge(opening, room, wall) {
  if (wall) return [{ x: wall.x1, z: wall.z1 }, { x: wall.x2, z: wall.z2 }];
  if (!room || room.shape === "circle") return null;
  const i = room.shape === "polygon" ? opening.edgeIndex : sides.indexOf(opening.wallSide);
  const points = pointsOf(room);
  if (!Number.isInteger(i) || i < 0 || i >= points.length) return null;
  const edge = [points[i], points[(i + 1) % points.length]];
  return room.shape !== "polygon" && (i === 2 || i === 3) ? edge.reverse() : edge;
}

function registerOpening(opening, edge, move) {
  if (!edge) return opening;
  const [a, b] = edge;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length === 0) return opening;
  const c = move(a), d = move(b);
  const nextLength = Math.hypot(d.x - c.x, d.z - c.z);
  if (nextLength === 0) return opening;
  const project = (metres) => {
    const ratio = Math.min(1, Math.max(0, metres / length));
    const p = move({ x: a.x + ratio * (b.x - a.x), z: a.z + ratio * (b.z - a.z) });
    return ((p.x - c.x) * (d.x - c.x) + (p.z - c.z) * (d.z - c.z)) / nextLength;
  };
  const start = project(opening.offset || 0);
  const end = project((opening.offset || 0) + (opening.width || 1));
  return end > start ? { ...opening, offset: rounding(start), width: rounding(end - start) } : opening;
}

// Control points are [current, reference] in metres. Keep surveyed objects
// already on the reference grid fixed. IDs and specified cable lengths persist.
export function registerFloorDrawing(plan, floorId, { x, z, fixedIds = [] }) {
  if (!plan.floors.some((floor) => floor.id === floorId)) throw new Error("The selected floor does not exist.");
  const image = plan.images?.[floorId];
  if (!image) throw new Error("The selected floor has no registered drawing.");
  const moveX = axisTransform(x), moveZ = axisTransform(z);
  const fixed = new Set(fixedIds);
  const affected = (item) => item.floorId === floorId && !fixed.has(item.id);
  const move = (item) => ({ ...item, x: rounding(moveX(item.x)), z: rounding(moveZ(item.z)) });
  const apply = (items, transform) => (items || []).map((item) => affected(item) ? transform(item) : item);
  const extent = (obj, points) => {
    const xs = points.map((p) => p.x), zs = points.map((p) => p.z);
    const x = Math.min(...xs), z = Math.min(...zs);
    return { ...obj, x, z, width: rounding(Math.max(...xs) - x), depth: rounding(Math.max(...zs) - z) };
  };
  const rooms = apply(plan.rooms, (room) => {
    const points = pointsOf(room).map(move);
    const placed = extent(room, points);
    if (room.shape !== "polygon" && room.shape !== "circle") return placed;
    return { ...placed, shape: "polygon", polygonPoints: points };
  });
  const sourceFloors = new Map((plan.sources || []).map((s) => [s.id, s.floorId]));
  const roomById = new Map((plan.rooms || []).map((r) => [r.id, r]));
  const wallById = new Map((plan.interiorWalls || []).map((w) => [w.id, w]));
  const opening = (item) =>
    fixed.has(item.roomId) || fixed.has(item.wallId) ? item :
      registerOpening(item, openingEdge(item, roomById.get(item.roomId), wallById.get(item.wallId)), move);
  return {
    ...plan,
    images: { ...plan.images, [floorId]: registerImage(image, x, z, moveX, moveZ) },
    rooms,
    boundaries: apply(plan.boundaries, (b) => ({ ...b, points: pointsOf({ shape: "polygon", polygonPoints: b.points }).map(move) })),
    interiorWalls: apply(plan.interiorWalls, (w) => ({
      ...w, x1: rounding(moveX(w.x1)), x2: rounding(moveX(w.x2)),
      z1: rounding(moveZ(w.z1)), z2: rounding(moveZ(w.z2)),
    })),
    furniture: apply(plan.furniture, (item) => extent(item, pointsOf(item).map(move))),
    doors: apply(plan.doors, opening),
    windows: apply(plan.windows, opening),
    sources: apply(plan.sources, move),
    cellular: plan.cellular && {
      ...plan.cellular,
      cables: (plan.cellular.cables || []).map((c) => c.points?.length ? {
        ...c,
        points: c.points.map((point) =>
          (point.floorId ?? sourceFloors.get(c.from)) === floorId ? move(point) : point),
      } : c),
    },
  };
}

export function floorImageTiles(image) {
  const x = image.registration?.x || identity;
  const z = image.registration?.z || identity;
  return x.slice(1).flatMap(([right, x1], i) => z.slice(1).map(([bottom, z1], j) => {
    const [left, x0] = x[i], [top, z0] = z[j];
    return {
      x: (image.offsetX || 0) + x0 * image.widthM,
      z: (image.offsetZ || 0) + z0 * image.heightM,
      width: (x1 - x0) * image.widthM,
      height: (z1 - z0) * image.heightM,
      viewBox: `${left} ${top} ${right - left} ${bottom - top}`,
    };
  }));
}
