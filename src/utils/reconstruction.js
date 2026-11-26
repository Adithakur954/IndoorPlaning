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
// Typical wall thickness by material (m), used when the picture is too coarse to measure a wall's real width
// (a drawn line on a small picture of a big building is far wider than the wall). Heavy concrete: 0.3 m.
export const TYPICAL_THICKNESS_M = { concrete: 0.25, brick: 0.2, drywall: 0.12, wood: 0.05, glass: 0.012, metal: 0.005 };
const HEAVY_CONCRETE_M = 0.3;
// a picture whose pixel is at most this many metres shows a wall's real width
const FINE_PIXEL_M = 0.03;

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

const segDistance = (w, v) =>
  Math.min(
    distanceToSegment(xz(w.aM), xz(v.aM), xz(v.bM)),
    distanceToSegment(xz(w.bM), xz(v.aM), xz(v.bM)),
    distanceToSegment(xz(v.aM), xz(w.aM), xz(w.bM)),
    distanceToSegment(xz(v.bM), xz(w.aM), xz(w.bM)),
  );

// The box of the building's walls: the connected network of walls (ends within `tol` metres,
// a door gap) with the most wall length, grown by every other network that overlaps it.
// Exported for tests.
export function buildingBox(wallsM, tol = 2.6) {
  if (wallsM.length < 3) return null;
  const parent = wallsM.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < wallsM.length; i += 1)
    for (let j = i + 1; j < wallsM.length; j += 1)
      if (segDistance(wallsM[i], wallsM[j]) <= tol) parent[find(i)] = find(j);
  const groups = new Map();
  wallsM.forEach((w, i) => {
    const g = find(i);
    const len = Math.hypot(w.bM[0] - w.aM[0], w.bM[1] - w.aM[1]);
    const cur = groups.get(g) || { len: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    cur.len += len;
    cur.x0 = Math.min(cur.x0, w.aM[0], w.bM[0]);
    cur.x1 = Math.max(cur.x1, w.aM[0], w.bM[0]);
    cur.z0 = Math.min(cur.z0, w.aM[1], w.bM[1]);
    cur.z1 = Math.max(cur.z1, w.aM[1], w.bM[1]);
    groups.set(g, cur);
  });
  const list = [...groups.values()].sort((a, b) => b.len - a.len);
  const box = { ...list[0] };
  let grown = true;
  while (grown) {
    grown = false;
    for (const g of list.slice(1)) {
      if (g.used) continue;
      if (g.x1 >= box.x0 && g.x0 <= box.x1 && g.z1 >= box.z0 && g.z0 <= box.z1) {
        box.x0 = Math.min(box.x0, g.x0);
        box.x1 = Math.max(box.x1, g.x1);
        box.z0 = Math.min(box.z0, g.z0);
        box.z1 = Math.max(box.z1, g.z1);
        g.used = true;
        grown = true;
      }
    }
  }
  return { x0: box.x0, x1: box.x1, z0: box.z0, z1: box.z1 };
}

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
  // so the open office exists in the editor and the enclosures sit inside it. Its outline is the
  // building's own walls (the main connected wall network), never the whole sheet: title blocks,
  // legends and the sheet frame are separate pieces and stay out.
  {
    const wallsM = (result.walls || []).filter(
      (w) => w.aM && w.bM && Math.hypot(w.bM[0] - w.aM[0], w.bM[1] - w.aM[1]) >= 3,
    );
    const box = buildingBox(wallsM);
    if (box) {
      const { x0, x1, z0, z1 } = box;
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

  // ---- wall materials read from the drawing's legend ------------------------
  // The worker gives each wall the material whose legend colour it is drawn in ("Concrete [Heavy]" = cyan...).
  // A room side takes the material of the legend walls running along it (when they cover at least half of it):
  // per side for a rectangle room, the majority for a polygon room.
  const legendWalls = (result.walls || []).filter((w) => w.material && w.aM && w.bM);
  const sideTol = Math.max(0.3, 3 / result.scale.pxPerM);
  const materialAlong = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6 || !legendWalls.length) return null;
    const ux = (b.x - a.x) / len,
      uz = (b.z - a.z) / len;
    const off = (q) => Math.abs(-uz * (q.x - a.x) + ux * (q.z - a.z));
    const byMaterial = {};
    for (const w of legendWalls) {
      const p = xz(w.aM),
        q = xz(w.bM);
      if (off(p) > sideTol || off(q) > sideTol) continue;
      const t1 = (p.x - a.x) * ux + (p.z - a.z) * uz,
        t2 = (q.x - a.x) * ux + (q.z - a.z) * uz;
      const overlap = Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (overlap > 0) byMaterial[w.material] = (byMaterial[w.material] || 0) + overlap;
    }
    const best = Object.entries(byMaterial).sort((x, y) => y[1] - x[1])[0];
    return best && best[1] >= 0.5 * len ? best[0] : null;
  };
  const wallTypes = {};
  for (const room of rooms) {
    const pts = room.shape === "rectangle" ? rectCorners(room) : room.polygonPoints;
    const sides = pts.map((a, i) => {
      const b = pts[(i + 1) % pts.length];
      return { m: materialAlong(a, b), len: Math.hypot(b.x - a.x, b.z - a.z) };
    });
    if (room.shape === "rectangle") {
      sides.forEach(({ m }, i) => {
        if (m && m !== room.material) wallTypes[`${room.id}:${SIDES[i]}`] = m;
      });
    } else {
      const perimeter = sides.reduce((t, x) => t + x.len, 0);
      const byMaterial = {};
      for (const { m, len } of sides) if (m) byMaterial[m] = (byMaterial[m] || 0) + len;
      const best = Object.entries(byMaterial).sort((x, y) => y[1] - x[1])[0];
      if (best && best[1] >= 0.5 * perimeter) room.material = best[0];
    }
  }

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
  // Every wall the detection shows is added: a wall that does not close a room (a gap at a
  // join, a partition that stops in the open) is still a wall. Uncertain ones, and pieces not
  // joined to the rest of the building, are marked for review instead of being dropped. Only
  // marks too small or too faint to be a wall are left out (a symbol, a desk edge, a stray line).
  const MIN_WALL_M = 0.5;
  const MIN_LOOSE_M = 1.5; // a piece joined to nothing must be at least this long
  const MIN_CONFIDENCE = 0.3;
  const lengthM = (w) => Math.hypot(w.bM[0] - w.aM[0], w.bM[1] - w.aM[1]);
  const looseWalls = (result.walls || []).filter((w) => w.role === "free" && w.aM && w.bM);
  const kept = looseWalls.filter(
    (w) =>
      lengthM(w) >= MIN_WALL_M &&
      w.confidence >= MIN_CONFIDENCE &&
      (w.anchored !== false || lengthM(w) >= MIN_LOOSE_M),
  );
  const left = looseWalls.length - kept.length;
  if (left)
    warnings.push(
      `${left} tiny or very faint mark(s) were not added as walls (under ${MIN_LOOSE_M} m and joined to nothing, or under ${MIN_WALL_M} m); see the detection overlay.`,
    );
  const interiorWalls = kept.map((w, i) => {
    const loose = w.anchored === false;
    return {
      id: uid(),
      floorId,
      name: `Wall ${i + 1}`,
      x1: round(w.aM[0]),
      z1: round(w.aM[1]),
      x2: round(w.bM[0]),
      z2: round(w.bM[1]),
      material: w.material || material,
      height,
      confidence: w.confidence,
      needsReview: w.confidence < REVIEW_BELOW || loose,
      reviewNotes: [
        ...(w.notes || []),
        ...(w.materialLabel ? [`material from the drawing's legend: ${w.materialLabel}`] : []),
        ...(loose ? ["not joined to the rest of the building: check it is a wall"] : []),
      ],
    };
  });

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

  // ---- wall thickness ---------------------------------------------------------
  // A fine picture (a pixel of at most 3 cm, or walls drawn as two lines whose gap IS the wall) shows the real
  // width: the measured one is used. A coarse picture only shows how thick the line was drawn, so the typical
  // thickness of the material is used instead and you are told to check it. Materials read from the legend get
  // their own thickness the same way.
  const mPerPx = 1 / result.scale.pxPerM;
  const fine = mPerPx <= FINE_PIXEL_M || /double/.test(result.wallThickness?.style || "");
  const median = (list) => {
    const t = list.filter((v) => v > 0).sort((a, b) => a - b);
    return t.length ? t[Math.floor(t.length / 2)] : null;
  };
  const clampT = (v) => round(Math.min(0.6, Math.max(0.05, v)), 3);
  const materialThickness = {};
  const legendMaterials = [...new Set(legendWalls.map((w) => w.material))];
  let wallThickness, thicknessNote;
  if (fine) {
    wallThickness = clampT(median((result.walls || []).map((w) => w.thicknessM)) ?? TYPICAL_THICKNESS_M[material]);
    thicknessNote = `Wall thickness ${wallThickness} m, measured on the drawing (1 px = ${round(mPerPx * 100, 1)} cm).`;
    for (const m of legendMaterials) {
      const t = median(legendWalls.filter((w) => w.material === m).map((w) => w.thicknessM));
      if (t) materialThickness[m] = clampT(t);
    }
  } else {
    wallThickness = TYPICAL_THICKNESS_M[material] ?? 0.12;
    thicknessNote =
      `Wall thickness ${wallThickness} m is the typical value for ${material}: the picture is too coarse to measure it ` +
      `(1 px = ${round(mPerPx * 100, 1)} cm, so a drawn line looks far thicker than the wall). Set the real thickness in the floor properties.`;
    for (const m of legendMaterials) {
      const heavy = legendWalls.some((w) => w.material === m && /heavy/i.test(w.materialLabel || ""));
      materialThickness[m] = m === "concrete" && heavy ? HEAVY_CONCRETE_M : TYPICAL_THICKNESS_M[m];
    }
  }
  warnings.push(thicknessNote);
  if (legendMaterials.length)
    warnings.push(
      `Materials from the drawing's legend: ${legendMaterials.map((m) => `${m} ${materialThickness[m]} m`).join(", ")}. ` +
        "Walls in colours the legend does not list keep the default; check them.",
    );

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
    wallThickness,
    thicknessNote,
    materialThickness,
    wallTypes,
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
  // the materials found in the legend get their thickness, unless you have already set one
  const mt = converted.materialThickness || {};
  if (Object.keys(mt).length) {
    const overrides = { ...(plan.materialOverrides || {}) };
    for (const [m, t] of Object.entries(mt))
      if (overrides[m]?.thicknessM == null || overrides[m]?.thicknessM === "") overrides[m] = { ...(overrides[m] || {}), thicknessM: t };
    next.materialOverrides = overrides;
  }
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
  if (converted.wallTypes && Object.keys(converted.wallTypes).length)
    next.wallTypes = { ...(next.wallTypes || plan.wallTypes || {}), ...converted.wallTypes };
  if (image) next.images = { ...plan.images, [floorId]: image };
  return next;
}
