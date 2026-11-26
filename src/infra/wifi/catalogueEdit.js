// The project's own equipment catalogue: the defaults with the user's changes on top.
//
// A user edits a part's values (from the manufacturer's datasheet) or adds a part.
// Only the changes are stored (plan.cabling.catalogue); the defaults stay in the
// code. A part whose values were entered by the user is no longer "illustrative":
// its source says who set it, so a report can tell real data from placeholders.
import { DEFAULT_WIFI_CATALOGUE } from "./catalogue.js";

export const USER_SOURCE = "entered by the user";
const ILLUSTRATIVE = /illustrative/i;

// Groups whose parts can be edited, and the values each must have to work.
export const EDITABLE_GROUPS = {
  accessPoints: { label: "Access points", required: ["portPowerW", "poeType"] },
  switches: { label: "Switches", required: ["poePorts", "poeBudgetW", "maxPortPowerW"] },
  cables: { label: "Ethernet cables", required: ["boxM", "dcResistanceOhmPer100m"] },
  passive: { label: "Passive parts", required: [] },
  fibre: { label: "Fibre and rack parts", required: [] },
};

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// Defaults plus overrides. Overrides can change fields of a default part or add a whole part.
export function mergeCatalogue(overrides = {}, base = DEFAULT_WIFI_CATALOGUE) {
  const out = structuredClone(base);
  for (const [group, parts] of Object.entries(overrides || {})) {
    if (!isObject(parts) || !isObject(out[group])) continue;
    for (const [id, fields] of Object.entries(parts)) {
      if (!isObject(fields)) continue;
      out[group][id] = { ...(out[group][id] || {}), ...structuredClone(fields), id: out[group][id]?.id ?? fields.id ?? id };
    }
  }
  return out;
}

// A new overrides object with one field of one part changed. Changing a value marks the
// part as entered by the user (its source no longer says "illustrative").
export function setPartField(overrides, group, id, field, value) {
  const next = structuredClone(overrides || {});
  next[group] ||= {};
  next[group][id] = { ...(next[group][id] || {}), [field]: value };
  if (field !== "source" && !("source" in next[group][id])) next[group][id].source = USER_SOURCE;
  return next;
}

// A new part, copied from an existing one. The id must be new.
export function addPart(overrides, group, fromId, newId, base = DEFAULT_WIFI_CATALOGUE) {
  const merged = mergeCatalogue(overrides, base);
  if (!merged[group]?.[fromId]) throw new Error(`there is no ${group} part "${fromId}" to copy`);
  if (merged[group][newId]) throw new Error(`a part with the id "${newId}" already exists`);
  const next = structuredClone(overrides || {});
  next[group] ||= {};
  next[group][newId] = { ...structuredClone(merged[group][fromId]), id: newId, name: `${merged[group][fromId].name} (copy)`, source: USER_SOURCE };
  return next;
}

// A new overrides object without one part's changes (a default part goes back to its default).
export function resetPart(overrides, group, id) {
  const next = structuredClone(overrides || {});
  if (next[group]) delete next[group][id];
  if (next[group] && !Object.keys(next[group]).length) delete next[group];
  return next;
}

// Problems that would make the catalogue unusable. Empty means it is fine.
export function validateCatalogue(catalogue) {
  const problems = [];
  for (const [group, spec] of Object.entries(EDITABLE_GROUPS)) {
    for (const [id, part] of Object.entries(catalogue[group] || {})) {
      if (!part.name) problems.push(`${group}/${id}: it has no name`);
      for (const field of spec.required)
        if (part[field] === undefined || part[field] === null || part[field] === "")
          problems.push(`${group}/${id}: "${field}" is missing`);
      for (const [field, value] of Object.entries(part))
        if (typeof value === "number" && !Number.isFinite(value)) problems.push(`${group}/${id}: "${field}" is not a number`);
    }
  }
  if (!Object.keys(catalogue.switches || {}).length) problems.push("there must be at least one switch");
  if (!Object.keys(catalogue.accessPoints || {}).length) problems.push("there must be at least one access point");
  return problems;
}

// Import from JSON text: only known groups, only the parts given. Throws a message a person can read.
export function parseCatalogueJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  if (!isObject(data)) throw new Error("the file must hold an object of groups (accessPoints, switches, cables, ...)");
  const overrides = {};
  for (const [group, parts] of Object.entries(data)) {
    if (!(group in EDITABLE_GROUPS)) continue;
    if (!isObject(parts)) throw new Error(`"${group}" must be an object of parts`);
    for (const [id, fields] of Object.entries(parts)) {
      if (!isObject(fields)) throw new Error(`${group}/${id} must be an object`);
      overrides[group] ||= {};
      overrides[group][id] = { ...fields, source: fields.source && !ILLUSTRATIVE.test(fields.source) ? fields.source : USER_SOURCE };
    }
  }
  if (!Object.keys(overrides).length) throw new Error("the file has no access points, switches, cables or parts");
  const problems = validateCatalogue(mergeCatalogue(overrides));
  if (problems.length) throw new Error(`the catalogue would not work: ${problems.slice(0, 3).join("; ")}`);
  return overrides;
}

// The whole merged catalogue as JSON text, to share or keep.
export const catalogueToJson = (overrides) =>
  JSON.stringify(mergeCatalogue(overrides), null, 2);

// How much of a design's bill of quantities rests on real data.
export function sourceSummary(boq) {
  const illustrative = boq.filter((l) => ILLUSTRATIVE.test(l.source || "")).length;
  return { lines: boq.length, illustrative, real: boq.length - illustrative };
}
