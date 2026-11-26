// Infrastructure model: the physical things a cabling design depends on that
// the floor plan does not hold. Shared by every system type (Wi-Fi, cellular,
// fibre). It contains no Wi-Fi or cellular rules.
//
// Every entity has a status. "estimated" means the tool or a guess put it
// there; "confirmed" means a person checked it against the building. A design
// built on estimated entities is a preliminary design.

export const SCHEMA_VERSION = 1;

export const STATUSES = ["estimated", "confirmed"];
export const SOURCES = ["tool", "user", "import"];

// MDF: main distribution room. IDF: floor (intermediate) distribution room.
export const ROOM_KINDS = ["mdf", "idf"];
export const PATHWAY_KINDS = ["tray", "conduit", "ladder"];

// What a person can mark as checked against the building.
export const VERIFICATION_KEYS = ["dimensions", "pathways", "equipment"];

// Every collection of entities the model holds.
export const COLLECTIONS = ["equipmentRooms", "risers", "pathways", "restrictedAreas"];

export const DEFAULTS = {
  rackUnits: 42, // usable rack units (U) in an equipment room
  fillLimit: 0.4, // 40 % of a tray or riser cross-section (common planning limit)
};

export const emptyInfrastructure = () => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  revisions: [], // audit trail, one entry per change set, never edited
  equipmentRooms: [], // { id, name, kind, floorId, x, z, rackUnits, status, source }
  risers: [], // { id, name, x, z, floorIds[], areaMm2, fillLimit, fireRated, status, source }
  pathways: [], // { id, name, kind, floorId, points[{x,z}], widthMm, depthMm, fillLimit, status, source }
  restrictedAreas: [], // { id, name, floorId, polygon[{x,z}], reason, status, source }
  // Set by a person after checking the building; they gate "validated" and
  // "construction-ready" (see confidenceOf).
  verification: { dimensions: false, pathways: false, equipment: false },
});

// Entity builders: fill the defaults, keep what is given. They do not validate;
// validateInfrastructure does.
export const makeEquipmentRoom = (o) => ({
  rackUnits: DEFAULTS.rackUnits,
  status: "estimated",
  source: "user",
  ...o,
});
export const makeRiser = (o) => ({
  fillLimit: DEFAULTS.fillLimit,
  fireRated: false,
  status: "estimated",
  source: "user",
  ...o,
});
export const makePathway = (o) => ({
  kind: "tray",
  fillLimit: DEFAULTS.fillLimit,
  status: "estimated",
  source: "user",
  ...o,
});
export const makeRestrictedArea = (o) => ({
  status: "estimated",
  source: "user",
  ...o,
});
