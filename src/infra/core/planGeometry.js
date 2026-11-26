// Turns a plan floor into the inputs the router needs. Uses the same wall model
// as the 3D view and the ray-tracing export, so doors and walls agree everywhere.
import { buildWalls } from "../../utils/wallGraph.js";
import { bbox, boundaryAreas, inside } from "../../utils/geometry.js";
import { floorNoGo, floorPowerRoutes, floorTrays, pointInPolygon, resolveWallPolicy, wallKey, withDefaults } from "./pathway.js";

const withColumns = (pathway) => withDefaults(pathway).columnsBlock;

// A wall minus its doors. Cable can pass a door gap; windows stay solid.
export function solidPieces(wall) {
  const length = wall.length ?? Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z);
  if (!(length > 0)) return [];
  const gaps = (wall.openings || [])
    .filter((o) => o.kind === "door")
    .map((o) => [Math.max(0, o.start), Math.min(length, o.end)])
    .sort((p, q) => p[0] - q[0]);
  const at = (t) => ({
    x: wall.a.x + ((wall.b.x - wall.a.x) * t) / length,
    z: wall.a.z + ((wall.b.z - wall.a.z) * t) / length,
  });
  // the rooms this wall separates (the building outline is not a room)
  const owners = (wall.owners || []).filter((o) => o.type === "room").map((o) => o.id);
  const pieces = [];
  let cursor = 0;
  for (const [from, to] of gaps) {
    if (from > cursor) pieces.push({ a: at(cursor), b: at(from), owners });
    cursor = Math.max(cursor, to);
  }
  if (cursor < length) pieces.push({ a: at(cursor), b: at(length), owners });
  return pieces;
}

// pathway: ceiling and wall settings (see pathway.js). Each wall piece gets a
// policy: "permitted", "penalty" (an estimate) or "blocked".
export function floorRoutingInput(plan, floorId, pathway = {}) {
  const rooms = (plan.rooms || []).filter((r) => r.floorId === floorId);
  const outlines = boundaryAreas(plan, floorId);
  const shapes = outlines.length ? outlines : rooms;
  if (!shapes.length) return null;

  const walls = buildWalls(
    { doors: [], windows: [], interiorWalls: [], boundaries: [], ...plan },
    floorId,
  ).flatMap(solidPieces);
  for (const w of (plan.interiorWalls || []).filter((x) => x.floorId === floorId)) {
    if ([w.x1, w.z1, w.x2, w.z2].every(Number.isFinite))
      walls.push({ a: { x: +w.x1, z: +w.z1 }, b: { x: +w.x2, z: +w.z2 }, owners: [] });
  }
  for (const wall of walls) {
    wall.key = wallKey(floorId, wall.a, wall.b);
    Object.assign(wall, resolveWallPolicy(wall, pathway));
  }

  const boxes = shapes.map(bbox);
  const margin = 0; // cells start at the building edge, so grid lines match the plan
  const bounds = {
    minX: Math.min(...boxes.map((b) => b.minX)) - margin,
    maxX: Math.max(...boxes.map((b) => b.maxX)) + margin,
    minZ: Math.min(...boxes.map((b) => b.minZ)) - margin,
    maxZ: Math.max(...boxes.map((b) => b.maxZ)) + margin,
  };
  const heights = rooms.map((r) => Number(r.height)).filter((h) => h > 0);
  // columns stop a cable run: the cells they occupy (and a hand's breadth around) are closed
  const columns = withColumns(pathway)
    ? (plan.furniture || [])
        .filter((f) => f.floorId === floorId && /column|pillar/i.test(f.kind || ""))
        .map((f) => ({ x0: +f.x - 0.15, z0: +f.z - 0.15, x1: +f.x + (+f.width || 0.3) + 0.15, z1: +f.z + (+f.depth || 0.3) + 0.15 }))
    : [];
  const trays = floorTrays(pathway, floorId);
  const noGo = floorNoGo(pathway, floorId).map((a) => a.polygon);
  return {
    walls,
    bounds,
    // inside the building and outside every no-go area
    footprint: (x, z) =>
      shapes.some((s) => inside(x, z, s)) &&
      !noGo.some((poly) => pointInPolygon(x, z, poly)) &&
      !columns.some((c) => x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1),
    columns,
    trays,
    noGo,
    powerRoutes: floorPowerRoutes(pathway, floorId),
    ceilingM: heights.length ? Math.max(...heights) : 3,
  };
}
