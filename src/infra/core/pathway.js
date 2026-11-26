// Physical pathway rules for cable routing: what the ceiling allows, and which
// walls a cable may pass.
//
// The floor plan cannot say whether there is a false ceiling with a continuous
// void, whether a partition reaches the slab, or where a wall has an opening.
// Those facts come from the user. Until they are given, the answer is "unknown"
// and a route that depends on it is only an estimate.
//
// settings (stored in plan.cabling.pathway):
//   ceiling:       { type, voidAccess, partitionToSlab }   project default
//   roomOverrides: { [roomId]: { type?, voidAccess?, partitionToSlab? } }
//   wallOverrides: { [wallKey]: one of WALL_MARKS }
//
// A cable may pass a wall piece when
//   - it is marked as an opening or an approved sleeve, or
//   - every room it separates has an accessible ceiling void (false or open
//     ceiling) and its partition stops below the slab.
// It may not pass when it is marked not permitted, fire-rated or structural, or
// when a room it separates has no accessible void (solid ceiling, restricted or
// no access) or its partition reaches the slab. If a needed fact is unknown, the
// crossing is allowed as an ESTIMATE (a routing cost, flagged for confirmation).

export const CEILING_TYPES = ["unknown", "false", "open", "solid"];
export const VOID_ACCESS = ["unknown", "accessible", "restricted", "none"];
export const SLAB = ["unknown", "no", "yes"]; // do partitions reach the structural slab?

// What a person can say about one wall piece.
export const WALL_MARKS = ["opening", "sleeve", "fire-stopped", "not-permitted", "fire-rated", "structural"];
export const WALL_MARK_LABELS = {
  opening: "Existing opening / penetration",
  sleeve: "Approved sleeve",
  "fire-stopped": "Fire-rated wall: approved fire-stopped sleeve",
  "not-permitted": "Not permitted",
  "fire-rated": "Fire-rated (not permitted)",
  structural: "Structural (not permitted)",
};
const ALLOWED_MARKS = new Set(["opening", "sleeve", "fire-stopped"]);

export const DEFAULT_PATHWAY = {
  ceiling: { type: "unknown", voidAccess: "unknown", partitionToSlab: "unknown" },
  roomOverrides: {},
  wallOverrides: {},
  trays: [], // { id, name, floorId, points: [{x,z}], kind: "new" | "existing", status }
  noGo: [], // { id, name, floorId, polygon: [{x,z}], reason }
  // A person's edit of one AP's route: points it must pass, and whether they approved it.
  powerRoutes: [], // { id, name, floorId, points: [{x,z}] } power cabling that data cable must keep away from
  routeEdits: {}, // { [apId]: { waypoints: [{x,z}], confirmed: boolean } }
  columnsBlock: true, // columns on the plan stop a cable run (the void is blocked there)
  // Checks a person has made against the building; they decide the report's status.
  verification: { dimensions: false, pathways: false, equipment: false },
};

export const withDefaults = (p = {}) => ({
  ceiling: { ...DEFAULT_PATHWAY.ceiling, ...(p.ceiling || {}) },
  roomOverrides: p.roomOverrides || {},
  wallOverrides: p.wallOverrides || {},
  trays: p.trays || [],
  noGo: p.noGo || [],
  powerRoutes: p.powerRoutes || [],
  routeEdits: p.routeEdits || {},
  columnsBlock: p.columnsBlock !== false,
  verification: { ...DEFAULT_PATHWAY.verification, ...(p.verification || {}) },
});

export const floorTrays = (pathway, floorId) =>
  withDefaults(pathway).trays.filter((t) => t.floorId === floorId && (t.points || []).length >= 2);
export const floorPowerRoutes = (pathway, floorId) =>
  withDefaults(pathway).powerRoutes.filter((t) => t.floorId === floorId && (t.points || []).length >= 2);
export const floorNoGo = (pathway, floorId) =>
  withDefaults(pathway).noGo.filter((a) => a.floorId === floorId && (a.polygon || []).length >= 3);

// Ray casting: is the point inside the polygon [{x, z}]?
export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// A stable key for a wall piece, whichever way round its ends are listed.
export function wallKey(floorId, a, b) {
  const p = (q) => `${q.x.toFixed(2)},${q.z.toFixed(2)}`;
  const [lo, hi] = [p(a), p(b)].sort();
  return `${floorId}|${lo}|${hi}`;
}

// The ceiling facts that apply in one room: project default plus its overrides.
export function roomCeiling(pathway, roomId) {
  const s = withDefaults(pathway);
  return { ...s.ceiling, ...(s.roomOverrides[roomId] || {}) };
}

// "ok" | "no" | "unknown": can a cable pass over a partition of this room?
function overPartition(c) {
  if (c.type === "solid" || c.voidAccess === "restricted" || c.voidAccess === "none") return "no";
  if (c.partitionToSlab === "yes") return "no";
  if (c.type === "unknown" || c.voidAccess === "unknown" || c.partitionToSlab === "unknown") return "unknown";
  return c.type === "false" || c.type === "open" ? "ok" : "unknown";
}

// piece: { key, owners: [roomId...] } (boundary owners are left out by the caller)
// Returns { policy: "permitted" (over the partition, accessible ceiling void) | "penetration"
// (an opening or sleeve) | "penalty" (estimate) | "blocked", reason }.
export function resolveWallPolicy(piece, pathway) {
  const s = withDefaults(pathway);
  const mark = s.wallOverrides[piece.key];
  if (mark) {
    return ALLOWED_MARKS.has(mark)
      ? { policy: "penetration", reason: WALL_MARK_LABELS[mark] }
      : { policy: "blocked", reason: WALL_MARK_LABELS[mark] || "marked as not permitted" };
  }
  const rooms = piece.owners?.length ? piece.owners : [null]; // an interior wall with no room: project default
  const verdicts = rooms.map((id) => overPartition(id ? roomCeiling(s, id) : s.ceiling));
  if (verdicts.includes("no")) return { policy: "blocked", reason: "no accessible ceiling void over this partition" };
  if (verdicts.includes("unknown")) return { policy: "penalty", reason: "ceiling access unknown" };
  return { policy: "permitted", reason: "accessible ceiling void over the partition" };
}

// Have the ceiling facts been given? Routes are "stated" only then.
export const pathwayStated = (pathway) => {
  const c = withDefaults(pathway).ceiling;
  return c.type !== "unknown" && c.voidAccess !== "unknown";
};
