// Where a project's infrastructure model comes from.
//
// New projects store it in plan.infra. Projects made with the first cabling
// screen only have plan.cabling (racks and risers); those are converted on the
// fly, without changing the saved plan.
import { SCHEMA_VERSION, emptyInfrastructure, makeEquipmentRoom, makeRiser } from "./schema.js";

// Converts the first-version cabling data. A single rack is the main room
// (MDF); with several racks they are floor rooms (IDF) and a missing MDF is
// reported by validateInfrastructure instead of being invented here.
export function fromLegacyCabling(plan) {
  const model = emptyInfrastructure();
  const cabling = plan.cabling || {};
  const racks = cabling.racks || [];
  const floorIds = (plan.floors || []).map((f) => f.id);
  model.equipmentRooms = racks.map((r) =>
    makeEquipmentRoom({
      id: r.id,
      name: r.name || "Rack",
      kind: racks.length === 1 ? "mdf" : "idf",
      floorId: r.floorId,
      x: r.x,
      z: r.z,
      // a rack the user placed or confirmed is a decision; a suggestion is not
      status: r.suggested ? "estimated" : "confirmed",
      source: r.suggested ? "tool" : "user",
      ...(Number.isInteger(r.rackUnits) ? { rackUnits: r.rackUnits } : {}),
    }),
  );
  model.risers = (cabling.risers || []).map((r) =>
    makeRiser({
      id: r.id,
      name: r.name || "Riser",
      x: r.x,
      z: r.z,
      floorIds: r.floorIds || floorIds,
      // the cross-section was never recorded; 0 makes the missing value visible
      areaMm2: Number(r.areaMm2) || 0,
    }),
  );
  return model;
}

export function infrastructureOf(plan) {
  if (plan?.infra?.schemaVersion === SCHEMA_VERSION) return plan.infra;
  return fromLegacyCabling(plan || {});
}
