// Checks that a floor of the plan is a coherent building before it is used for
// ray tracing: valid room outlines, no duplicates, openings that fit their wall,
// rooms that lie on the drawing. Returns plain sentences.
import { areaOf, bbox, pointsOf } from "./geometry.js";

const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const crosses = (a, b, c, d) =>
  cross(a, b, c) * cross(a, b, d) < -1e-9 && cross(c, d, a) * cross(c, d, b) < -1e-9;

function selfIntersects(points) {
  const n = points.length;
  for (let i = 0; i < n; i += 1)
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]))
        return true;
    }
  return false;
}

export function validateBuilding(plan, floorId) {
  const errors = [];
  const warnings = [];
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const doors = plan.doors.filter((d) => d.floorId === floorId);
  const windows = plan.windows.filter((w) => w.floorId === floorId);

  rooms.forEach((room, i) => {
    const pts = pointsOf(room);
    if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z)))
      errors.push(`${room.name}: has a corner without a valid position.`);
    else if (selfIntersects(pts))
      errors.push(`${room.name}: its outline crosses itself.`);
    if (areaOf(room) < 0.5) warnings.push(`${room.name}: is smaller than 0.5 m².`);
    if (!(Number(room.height) > 0)) errors.push(`${room.name}: has no height.`);
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = bbox(room),
        b = bbox(rooms[j]);
      const same =
        Math.abs(a.minX - b.minX) < 0.01 &&
        Math.abs(a.maxX - b.maxX) < 0.01 &&
        Math.abs(a.minZ - b.minZ) < 0.01 &&
        Math.abs(a.maxZ - b.maxZ) < 0.01 &&
        Math.abs(areaOf(room) - areaOf(rooms[j])) < 0.05;
      if (same)
        errors.push(`${room.name} and ${rooms[j].name} are the same room drawn twice.`);
    }
  });

  const edgeLength = (room, openingItem) => {
    const pts = pointsOf(room);
    if (room.shape === "rectangle") {
      const b = bbox(room);
      return openingItem.wallSide === "north" || openingItem.wallSide === "south"
        ? b.maxX - b.minX
        : b.maxZ - b.minZ;
    }
    const i = Number(openingItem.edgeIndex);
    if (!Number.isInteger(i)) return null;
    const a = pts[i % pts.length],
      c = pts[(i + 1) % pts.length];
    return Math.hypot(c.x - a.x, c.z - a.z);
  };
  const seen = new Map();
  for (const [kind, list] of [["door", doors], ["window", windows]])
    for (const item of list) {
      const room = rooms.find((r) => r.id === item.roomId);
      if (!room) {
        errors.push(`A ${kind} belongs to a room that no longer exists.`);
        continue;
      }
      const length = edgeLength(room, item);
      const start = Number(item.offset || 0),
        width = Number(item.width || 0);
      if (length == null) {
        errors.push(`A ${kind} in ${room.name} is not on any wall.`);
        continue;
      }
      if (!(width > 0.2)) warnings.push(`A ${kind} in ${room.name} is narrower than 0.2 m.`);
      if (start < -0.01 || start + width > length + 0.01)
        errors.push(`A ${kind} in ${room.name} runs past the end of its wall.`);
      if (Number(item.height) > Number(room.height))
        warnings.push(`A ${kind} in ${room.name} is taller than the room.`);
      const key = `${room.id}|${item.wallSide ?? item.edgeIndex}`;
      const others = seen.get(key) || [];
      for (const o of others)
        if (start < o.start + o.width && o.start < start + width)
          errors.push(`Two openings overlap on a wall of ${room.name}.`);
      seen.set(key, [...others, { start, width }]);
    }

  const walls = plan.interiorWalls.filter((w) => w.floorId === floorId);
  walls.forEach((w, i) => {
    if (Math.hypot(w.x2 - w.x1, w.z2 - w.z1) < 0.05)
      errors.push(`${w.name || "A wall"} has almost no length.`);
    for (let j = i + 1; j < walls.length; j += 1) {
      const o = walls[j];
      const same =
        (Math.hypot(w.x1 - o.x1, w.z1 - o.z1) < 0.02 && Math.hypot(w.x2 - o.x2, w.z2 - o.z2) < 0.02) ||
        (Math.hypot(w.x1 - o.x2, w.z1 - o.z2) < 0.02 && Math.hypot(w.x2 - o.x1, w.z2 - o.z1) < 0.02);
      if (same) errors.push(`${w.name || "A wall"} is drawn twice.`);
    }
  });

  const image = plan.images?.[floorId];
  if (image && rooms.length) {
    const margin = 1;
    const outside = rooms.filter((r) => {
      const b = bbox(r);
      return (
        b.minX < -margin ||
        b.minZ < -margin ||
        b.maxX > image.widthM + margin ||
        b.maxZ > image.heightM + margin
      );
    });
    if (outside.length)
      warnings.push(
        `${outside.length} room(s) lie outside the floor image: the drawing and the rooms may be misaligned.`,
      );
  }
  return { errors, warnings };
}
