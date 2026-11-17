// Turns a floor-plan reconstruction (worker/floorplan result, metres) into the
// objects of this planner: rooms, doors, windows, partition walls, columns.
//
// Everything keeps its detection confidence so the review step can send the
// user to the uncertain parts first. Nothing here invents a dimension: the
// result must already be in metres (a scale was given).
import { uid } from "../models/plan.js";

const SIDES = ["north", "east", "south", "west"];
const round = (v, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;
const DEFAULT_HEIGHT_M = 3;
const REVIEW_BELOW = 0.7;

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    len2 = dx * dx + dz * dz;
  const t = len2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

const xz = ([x, z]) => ({ x, z });

// 4 corners of an upright rectangle (any start corner / direction) -> true
function asRectangle(points, tol = 0.03) {
  if (points.length !== 4) return null;
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minZ = Math.min(...zs),
    maxZ = Math.max(...zs);
  const upright = points.every(
    (p) =>
      (Math.abs(p.x - minX) <= tol || Math.abs(p.x - maxX) <= tol) &&
      (Math.abs(p.z - minZ) <= tol || Math.abs(p.z - maxZ) <= tol),
  );
  return upright ? { x: minX, z: minZ, width: maxX - minX, depth: maxZ - minZ } : null;
}

// the corners of a rectangle in the planner's order: TL, TR, BR, BL
const rectCorners = (r) => [
  { x: r.x, z: r.z },
  { x: r.x + r.width, z: r.z },
  { x: r.x + r.width, z: r.z + r.depth },
  { x: r.x, z: r.z + r.depth },
];

export function reconstructionToPlan(result, floorId, options = {}) {
  const { height = DEFAULT_HEIGHT_M, material = "drywall" } = options;
  if (!result?.scale?.pxPerM)
    throw new Error("Set the scale first: a known length is needed for metres.");
  const warnings = [...(result.warnings || [])];

  // ---- rooms ---------------------------------------------------------------
  const rooms = (result.rooms || [])
    .filter((r) => r.polygonM?.length >= 3)
    .map((r, i) => {
      const points = r.polygonM.map(xz).map((p) => ({ x: round(p.x), z: round(p.z) }));
      const rect = asRectangle(points);
      const base = {
        id: uid(),
        floorId,
        name: r.label || `Room ${i + 1}`,
        height,
        material,
        confidence: r.confidence,
        needsReview: r.confidence < REVIEW_BELOW,
        reviewNotes: r.notes || [],
        detectedId: r.id,
      };
      if (rect)
        return {
          ...base,
          shape: "rectangle",
          x: round(rect.x),
          z: round(rect.z),
          width: round(rect.width),
          depth: round(rect.depth),
        };
      const xs = points.map((p) => p.x),
        zs = points.map((p) => p.z);
      return {
        ...base,
        shape: "polygon",
        x: Math.min(...xs),
        z: Math.min(...zs),
        width: round(Math.max(...xs) - Math.min(...xs)),
        depth: round(Math.max(...zs) - Math.min(...zs)),
        polygonPoints: points,
      };
    });

  // ---- the whole floor ------------------------------------------------------
  // An open-plan office has no closed room: only small enclosures are found. When the closed rooms cover
  // little of the area inside the outermost walls, that area itself is added as one room ("Floor"),
  // so the open office exists in the editor and the enclosures sit inside it.
  {
    const wallsM = (result.walls || []).filter(
      (w) => w.aM && w.bM && Math.hypot(w.bM[0] - w.aM[0], w.bM[1] - w.aM[1]) >= 3,
    );
    if (wallsM.length >= 3) {
      const xs = wallsM.flatMap((w) => [w.aM[0], w.bM[0]]);
      const zs = wallsM.flatMap((w) => [w.aM[1], w.bM[1]]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const area = (x1 - x0) * (z1 - z0);
      const covered = rooms.reduce((sum, r) => sum + r.width * r.depth, 0);
      if (area > 4 && covered / area < 0.6)
        rooms.unshift({
          id: uid(),
          floorId,
          name: "Floor",
          height,
          material,
          confidence: 0.6,
          needsReview: true,
          reviewNotes: ["the open floor: its outline is taken from the outermost walls, check it"],
          detectedId: null,
          shape: "rectangle",
          x: round(x0),
          z: round(z0),
          width: round(x1 - x0),
          depth: round(z1 - z0),
        });
    }
  }

  // ---- edges of every room, to place openings on ---------------------------
  const edges = [];
  for (const room of rooms) {
    const pts = room.shape === "rectangle" ? rectCorners(room) : room.polygonPoints;
    pts.forEach((a, i) =>
      edges.push({ room, index: i, a, b: pts[(i + 1) % pts.length] }),
    );
  }
  const thickness = (() => {
    const t = (result.walls || []).map((w) => w.thicknessM).filter(Boolean).sort((a, b) => a - b);
    return t.length ? t[Math.floor(t.length / 2)] : 0.2;
  })();
  const reach = Math.max(0.25, thickness);

  const doors = [];
  const windows = [];
  let unplaced = 0;
  for (const o of result.openings || []) {
    if (!o.startM || !o.endM) continue;
    const s = xz(o.startM),
      e = xz(o.endM);
    const mid = { x: (s.x + e.x) / 2, z: (s.z + e.z) / 2 };
    const dir = Math.atan2(e.z - s.z, e.x - s.x);
    // the closest room edge that runs the same way
    let best = null;
    for (const edge of edges) {
      const ang = Math.atan2(edge.b.z - edge.a.z, edge.b.x - edge.a.x);
      const parallel = Math.abs(Math.sin(ang - dir)) < 0.2;
      const d = distanceToSegment(mid, edge.a, edge.b);
      if (parallel && d <= reach && (!best || d < best.d)) best = { edge, d };
    }
    if (!best) {
      unplaced += 1;
      continue;
    }
    const { edge } = best;
    const length = Math.hypot(edge.b.x - edge.a.x, edge.b.z - edge.a.z);
    const ux = (edge.b.x - edge.a.x) / length,
      uz = (edge.b.z - edge.a.z) / length;
    const t0 = Math.min((s.x - edge.a.x) * ux + (s.z - edge.a.z) * uz, (e.x - edge.a.x) * ux + (e.z - edge.a.z) * uz);
    const width = Math.min(o.widthM || Math.hypot(e.x - s.x, e.z - s.z), length);
    const along = Math.max(0, Math.min(t0, length - width));
    const item = {
      id: uid(),
      floorId: edge.room.floorId,
      roomId: edge.room.id,
      width: round(width),
      confidence: o.confidence,
      needsReview: o.confidence < REVIEW_BELOW || o.kind === "opening",
      detectedKind: o.kind,
    };
    if (edge.room.shape === "rectangle") {
      // offsets run from the left (north/south) or the top (east/west)
      const side = SIDES[edge.index];
      const offset =
        side === "north" || side === "south"
          ? Math.min(s.x, e.x) - edge.room.x
          : Math.min(s.z, e.z) - edge.room.z;
      item.wallSide = side;
      item.offset = round(Math.max(0, offset));
    } else {
      item.edgeIndex = edge.index;
      item.offset = round(along);
    }
    if (o.kind === "window") windows.push({ ...item, height: 1.2, sillHeight: 1.0 });
    else doors.push({ ...item, height: 2.1 });
  }
  if (unplaced)
    warnings.push(
      `${unplaced} opening(s) lie on walls that are not part of a closed room and were not added.`,
    );

  // ---- partitions that are not part of a room ------------------------------
  // Loose wall pieces that were read with low confidence are usually furniture
  // edges: they are not added (they would block the signal in the simulation).
  // (Only pieces joined to the outer walls count: a loose piece in the middle of a
  // floor is almost always a desk edge or a symbol.)
  const looseWalls = (result.walls || []).filter((w) => w.role === "free" && w.aM && w.bM);
  const freeWalls = looseWalls.filter((w) => w.anchored !== false);
  const unanchored = looseWalls.length - freeWalls.length;
  if (unanchored)
    warnings.push(
      `${unanchored} loose wall piece(s) not joined to any outer wall were not added (likely furniture).`,
    );
  const skippedWalls = freeWalls.filter((w) => w.confidence < REVIEW_BELOW).length;
  if (skippedWalls)
    warnings.push(
      `${skippedWalls} uncertain loose wall piece(s) were not added (likely furniture); see the detection overlay.`,
    );
  const interiorWalls = freeWalls
    .filter((w) => w.confidence >= REVIEW_BELOW)
    .map((w, i) => ({
      id: uid(),
      floorId,
      name: `Wall ${i + 1}`,
      x1: round(w.aM[0]),
      z1: round(w.aM[1]),
      x2: round(w.bM[0]),
      z2: round(w.bM[1]),
      material,
      height,
      confidence: w.confidence,
      needsReview: w.confidence < REVIEW_BELOW,
    }));

  // ---- columns: obstructions, kept as named boxes --------------------------
  const furniture = (result.columns || [])
    .filter((c) => c.sizeM)
    .map((c, i) => ({
      id: uid(),
      floorId,
      name: `Column ${i + 1}`,
      kind: "column",
      x: round(c.xM - c.width / result.scale.pxPerM / 2),
      z: round(c.yM - c.height / result.scale.pxPerM / 2),
      width: round(c.width / result.scale.pxPerM),
      depth: round(c.height / result.scale.pxPerM),
      height,
    }));

  // ---- furniture read by the model: boxes sized from the drawing's scale ----
  const HEIGHT_M = { desk: 0.75, chair: 0.9, table: 0.75, sofa: 0.8, plant: 0.8, pod: 2.2, storage: 1.8 };
  const NAME = { desk: "Desk", chair: "Chair", table: "Table", sofa: "Sofa", plant: "Plant", pod: "Phone booth", storage: "Storage" };
  const counts = {};
  const detectedFurniture = (result.furniture || [])
    .filter((f) => f.widthM && f.depthM && f.xM != null && f.yM != null)
    .map((f) => {
      counts[f.kind] = (counts[f.kind] || 0) + 1;
      return {
        id: uid(),
        floorId,
        name: `${NAME[f.kind] || f.kind} ${counts[f.kind]}`,
        kind: f.kind,
        x: round(f.xM - f.widthM / 2),
        z: round(f.yM - f.depthM / 2),
        width: round(f.widthM),
        depth: round(f.depthM),
        height: HEIGHT_M[f.kind] ?? 0.8,
        origin: "detected",
      };
    });
  furniture.push(...detectedFurniture);

  // Wi-Fi markers the model found on the drawing: suggested access point positions (metres)
  const apMarkers = (result.markers || [])
    .filter((m) => m.xM != null && m.yM != null)
    .map((m) => ({ x: round(m.xM), z: round(m.yM) }));

  const review = {
    rooms: rooms.filter((r) => r.needsReview).length,
    openings: [...doors, ...windows].filter((o) => o.needsReview).length,
    walls: interiorWalls.filter((w) => w.needsReview).length,
  };
  return {
    rooms,
    doors,
    windows,
    interiorWalls,
    furniture,
    furnitureCounts: counts,
    apMarkers,
    wallThickness: round(Math.min(0.5, Math.max(0.05, thickness)), 2),
    image: {
      widthM: result.scale.widthM,
      heightM: result.scale.heightM,
    },
    review,
    warnings,
    assumptions: result.assumptions || [],
  };
}

// Puts the converted objects into a plan. `replace` clears this floor first.
export function applyReconstruction(plan, converted, floorId, { replace = true, image, accessPoints = [] } = {}) {
  const keep = (list) => (replace ? list.filter((x) => x.floorId !== floorId) : list);
  const next = {
    ...plan,
    rooms: [...keep(plan.rooms), ...converted.rooms],
    doors: [...keep(plan.doors), ...converted.doors],
    windows: [...keep(plan.windows), ...converted.windows],
    interiorWalls: [...keep(plan.interiorWalls), ...converted.interiorWalls],
    furniture: [...keep(plan.furniture), ...converted.furniture],
    wallThickness: converted.wallThickness,
  };
  if (accessPoints.length || replace)
    next.sources = [
      // an earlier import's detected APs on this floor are replaced; the APs you placed stay
      ...plan.sources.filter((s) => !(replace && s.floorId === floorId && s.origin === "detected")),
      ...accessPoints,
    ];
  if (replace) {
    const gone = new Set(
      plan.rooms.filter((r) => r.floorId === floorId).map((r) => r.id),
    );
    next.wallTypes = Object.fromEntries(
      Object.entries(plan.wallTypes || {}).filter(([k]) => !gone.has(k.split(":")[0])),
    );
  }
  if (image) next.images = { ...plan.images, [floorId]: image };
  return next;
}
