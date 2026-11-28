// A new floor copied from an existing one: its rooms, walls, doors, windows,
// furniture and building outline, its antennas / access points and DAS parts
// (with the cables between them) and its floor picture, as chosen. Every copy
// gets a new id and its links (a door's room or wall, a wall type's room, a
// cable's two ends) point to the copies. Measured logs are not copied.

export const DUPLICATE_PARTS = [
  // [option, what it copies]
  ["building", "Rooms, walls, doors, windows, furniture and the building outline"],
  ["components", "Antennas, access points and DAS parts (with the cables between them)"],
  ["image", "The floor picture"],
];

const BUILDING_KEYS = ["rooms", "interiorWalls", "doors", "windows", "furniture", "boundaries"];

export function duplicateFloor(plan, sourceFloorId, { id, name, elevation, building = true, components = true, image = true }, newId) {
  const source = plan.floors.find((f) => f.id === sourceFloorId);
  if (!source) throw new Error("The floor to copy is not in the plan.");
  const ids = new Map(); // old id -> new id
  const fresh = (oldId) => {
    if (!ids.has(oldId)) ids.set(oldId, newId());
    return ids.get(oldId);
  };
  const next = { ...plan };
  const copyList = (key) => {
    const list = Array.isArray(plan[key]) ? plan[key] : [];
    const copies = list.filter((x) => x.floorId === sourceFloorId).map((x) => ({ ...x, id: fresh(x.id), floorId: id }));
    return copies.length ? [...list, ...copies] : list;
  };

  if (building) for (const key of BUILDING_KEYS) if (Array.isArray(plan[key])) next[key] = copyList(key);
  if (components) next.sources = copyList("sources");

  // the links of the copies point to the copies
  const relink = (x) => {
    const out = { ...x };
    for (const k of ["roomId", "wallId"]) if (out[k] && ids.has(out[k])) out[k] = ids.get(out[k]);
    return out;
  };
  if (building) {
    for (const key of ["doors", "windows"]) if (Array.isArray(next[key])) next[key] = next[key].map((x) => (x.floorId === id ? relink(x) : x));
    // wall types are kept per room wall: "<roomId>:<wall>"
    const extra = {};
    for (const [k, v] of Object.entries(plan.wallTypes || {})) {
      const [roomId, ...rest] = k.split(":");
      if (ids.has(roomId)) extra[[ids.get(roomId), ...rest].join(":")] = v;
    }
    if (Object.keys(extra).length) next.wallTypes = { ...(plan.wallTypes || {}), ...extra };
  }
  if (components) {
    const cables = Array.isArray(plan.cellular?.cables) ? plan.cellular.cables : [];
    const copies = cables
      .filter((c) => ids.has(c.from) && ids.has(c.to))
      .map((c) => ({
        ...c,
        id: newId(),
        from: ids.get(c.from),
        to: ids.get(c.to),
        ...(c.points ? { points: c.points.map((p) => (p.floorId === sourceFloorId ? { ...p, floorId: id } : p)) } : {}),
      }));
    if (copies.length) next.cellular = { ...plan.cellular, cables: [...cables, ...copies] };
  }
  if (image && plan.images?.[sourceFloorId]) next.images = { ...plan.images, [id]: { ...plan.images[sourceFloorId] } };

  next.floors = [...plan.floors, { ...source, id, name, elevation }];
  return next;
}
