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
export function overlapWarnings(rooms) {
  const out = [];
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const a = bbox(rooms[i]),
        b = bbox(rooms[j]);
      const loX = Math.max(a.minX, b.minX),
        hiX = Math.min(a.maxX, b.maxX),
        loZ = Math.max(a.minZ, b.minZ),
        hiZ = Math.min(a.maxZ, b.maxZ);
      if (hiX <= loX || hiZ <= loZ) continue;
      let hit = false;
      for (let u = 0; u < 7 && !hit; u++)
        for (let v = 0; v < 7; v++) {
          const x = loX + ((u + 0.5) * (hiX - loX)) / 7,
            z = loZ + ((v + 0.5) * (hiZ - loZ)) / 7;
          if (inside(x, z, rooms[i]) && inside(x, z, rooms[j])) {
            hit = true;
            break;
          }
        }
      if (hit) out.push(`${rooms[i].name} overlaps ${rooms[j].name}`);
    }
  return out;
}
export function roomWalls(r) {
  const p = pointsOf(r);
  return p.map((a, i) => ({
    a,
    b: p[(i + 1) % p.length],
    roomId: r.id,
    material: r.material || "drywall",
    side: r.shape === "rectangle" ? ["north", "east", "south", "west"][i] : "",
  }));
}
const cross = (a, b, c) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
export function intersection(a, b, c, d) {
  return (
    cross(a, b, c) * cross(a, b, d) < -1e-7 &&
    cross(c, d, a) * cross(c, d, b) < -1e-7
  );
}
export function wallsBetween(
  a,
  b,
  rooms,
  interiorWalls,
  doors,
  wallTypes = {},
) {
  const walls = rooms.flatMap(roomWalls).concat(
    interiorWalls.map((w) => ({
      a: { x: +w.x1, z: +w.z1 },
      b: { x: +w.x2, z: +w.z2 },
      material: w.material || "drywall",
      roomId: w.roomId,
      side: "",
    })),
  );
  const unique = new Set();
  return walls
    .filter((w) => {
      if (!intersection(a, b, w.a, w.b)) return false;
      const key = [w.a, w.b]
        .map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)
        .sort()
        .join("|");
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    })
    .map((w) => {
      const material = wallTypes[`${w.roomId}:${w.side}`] || w.material;
      const door = doors.some(
        (d) =>
          d.roomId === w.roomId &&
          d.wallSide === w.side &&
          segmentNear(a, b, w, d),
      );
      return { material, door };
    });
}
function segmentNear(a, b, w, d) {
  const length = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z),
    t = Math.max(0, Math.min(1, Number(d.offset) / length)),
    mid = { x: w.a.x + (w.b.x - w.a.x) * t, z: w.a.z + (w.b.z - w.a.z) * t };
  const c1 = cross(a, b, w.a),
    c2 = cross(a, b, w.b);
  const f = c1 / (c1 - c2);
  const at = { x: w.a.x + (w.b.x - w.a.x) * f, z: w.a.z + (w.b.z - w.a.z) * f };
  return Math.hypot(mid.x - at.x, mid.z - at.z) < Number(d.width || 1) / 2;
}
export const materialLoss = {
  drywall: 5,
  wood: 4,
  glass: 3,
  brick: 10,
  concrete: 16,
  metal: 25,
};
