// Checks an infrastructure model against the plan. Returns a list of problems;
// it never throws and never changes anything.
import { floorRoutingInput } from "../core/planGeometry.js";
import {
  COLLECTIONS,
  PATHWAY_KINDS,
  ROOM_KINDS,
  SCHEMA_VERSION,
  SOURCES,
  STATUSES,
} from "./schema.js";

const finite = (...v) => v.every((n) => Number.isFinite(n));
const isPoint = (p) => p && finite(p.x, p.z);

export function validateInfrastructure(model, plan) {
  const out = [];
  const problem = (severity, collection, entity, message) =>
    out.push({ severity, collection, id: entity?.id ?? null, message });

  if (!model || typeof model !== "object") {
    problem("error", "model", null, "the infrastructure model is missing");
    return out;
  }
  if (model.schemaVersion !== SCHEMA_VERSION)
    problem("error", "model", null, `unsupported schema version ${model.schemaVersion} (this build reads ${SCHEMA_VERSION})`);
  const last = model.revisions?.[model.revisions.length - 1];
  if ((model.revision ?? 0) !== (last?.revision ?? 0))
    problem("error", "model", null, "the revision number does not match the audit trail");

  const floorIds = new Set((plan?.floors || []).map((f) => f.id));
  const footprints = new Map();
  const insideBuilding = (floorId, x, z) => {
    if (!footprints.has(floorId)) {
      const input = floorRoutingInput(plan, floorId);
      footprints.set(floorId, input ? input.footprint : null);
    }
    const f = footprints.get(floorId);
    return f ? f(x, z) : true; // a floor with no outline cannot be checked
  };

  const seen = new Map();
  for (const collection of COLLECTIONS) {
    for (const e of model[collection] || []) {
      if (!e.id) problem("error", collection, e, "an entity has no id");
      else if (seen.has(e.id))
        problem("error", collection, e, `id "${e.id}" is used twice (also in ${seen.get(e.id)})`);
      else seen.set(e.id, collection);
      if (!STATUSES.includes(e.status))
        problem("error", collection, e, `status must be one of ${STATUSES.join(", ")}`);
      if (!SOURCES.includes(e.source))
        problem("error", collection, e, `source must be one of ${SOURCES.join(", ")}`);
    }
  }

  const rooms = model.equipmentRooms || [];
  for (const r of rooms) {
    if (!ROOM_KINDS.includes(r.kind))
      problem("error", "equipmentRooms", r, `kind must be one of ${ROOM_KINDS.join(", ")}`);
    if (!floorIds.has(r.floorId))
      problem("error", "equipmentRooms", r, `floor "${r.floorId}" does not exist`);
    else if (!finite(r.x, r.z))
      problem("error", "equipmentRooms", r, "the position is not a number");
    else if (!insideBuilding(r.floorId, r.x, r.z))
      problem("error", "equipmentRooms", r, "the position is outside the building");
    if (!Number.isInteger(r.rackUnits) || r.rackUnits < 1)
      problem("error", "equipmentRooms", r, "rackUnits must be a whole number of 1 or more");
  }
  if (rooms.some((r) => r.kind === "idf") && !rooms.some((r) => r.kind === "mdf"))
    problem("error", "equipmentRooms", null, "there are floor rooms (IDF) but no main room (MDF)");

  for (const r of model.risers || []) {
    if (!Array.isArray(r.floorIds) || r.floorIds.length < 2)
      problem("error", "risers", r, "a riser must join at least two floors");
    else {
      for (const id of r.floorIds)
        if (!floorIds.has(id)) problem("error", "risers", r, `floor "${id}" does not exist`);
      if (new Set(r.floorIds).size !== r.floorIds.length)
        problem("error", "risers", r, "a floor is listed twice");
    }
    if (!finite(r.x, r.z)) problem("error", "risers", r, "the position is not a number");
    else
      for (const id of r.floorIds || [])
        if (floorIds.has(id) && !insideBuilding(id, r.x, r.z))
          problem("error", "risers", r, `the shaft is outside the building on floor "${id}"`);
    if (!(r.areaMm2 > 0)) problem("error", "risers", r, "areaMm2 must be above 0");
    if (!(r.fillLimit > 0 && r.fillLimit <= 1))
      problem("error", "risers", r, "fillLimit must be above 0 and at most 1");
  }

  for (const p of model.pathways || []) {
    if (!PATHWAY_KINDS.includes(p.kind))
      problem("error", "pathways", p, `kind must be one of ${PATHWAY_KINDS.join(", ")}`);
    if (!floorIds.has(p.floorId))
      problem("error", "pathways", p, `floor "${p.floorId}" does not exist`);
    if (!Array.isArray(p.points) || p.points.length < 2 || !p.points.every(isPoint))
      problem("error", "pathways", p, "a pathway needs at least two points with numeric x and z");
    else if (floorIds.has(p.floorId) && p.points.some((q) => !insideBuilding(p.floorId, q.x, q.z)))
      problem("warning", "pathways", p, "part of the pathway is outside the building outline");
    if (!(p.widthMm > 0) || !(p.depthMm > 0))
      problem("error", "pathways", p, "widthMm and depthMm must be above 0");
    if (!(p.fillLimit > 0 && p.fillLimit <= 1))
      problem("error", "pathways", p, "fillLimit must be above 0 and at most 1");
  }

  for (const a of model.restrictedAreas || []) {
    if (!floorIds.has(a.floorId))
      problem("error", "restrictedAreas", a, `floor "${a.floorId}" does not exist`);
    if (!Array.isArray(a.polygon) || a.polygon.length < 3 || !a.polygon.every(isPoint))
      problem("error", "restrictedAreas", a, "a restricted area needs at least three points");
  }
  return out;
}

// How far the design can be trusted, from the status of what it rests on.
//   preliminary        anything estimated, or checks not yet made
//   validated          everything confirmed, dimensions and pathways verified
//   construction-ready also the equipment is verified
export function confidenceOf(model) {
  const estimated = COLLECTIONS.flatMap((c) =>
    (model[c] || []).filter((e) => e.status !== "confirmed").map((e) => ({ collection: c, id: e.id })),
  );
  const v = model.verification || {};
  const reasons = [];
  if (estimated.length)
    reasons.push(`${estimated.length} item(s) are estimated, not confirmed`);
  if (!v.dimensions) reasons.push("plan dimensions are not verified");
  if (!v.pathways) reasons.push("cable pathways are not verified on site");
  if (!v.equipment) reasons.push("equipment and parts are not verified");
  let level = "preliminary";
  if (!estimated.length && v.dimensions && v.pathways) level = v.equipment ? "construction-ready" : "validated";
  return { level, reasons, estimated };
}
