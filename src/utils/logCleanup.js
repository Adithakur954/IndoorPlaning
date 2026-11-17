// Choosing what to remove from the imported measurement logs.
import { geographicToLocal } from "./geographicAlignment.js";
import { inside, boundaryAreas } from "./geometry.js";

export const UNKNOWN_SOURCE = "Earlier import (file name not recorded)";
export const sessionSource = (id) => `Session ${id}`;
export const logSource = (log) => log.source || UNKNOWN_SOURCE;

// Where a log sits on the plan (after alignment for GPS logs), or null.
export function logPosition(plan, log) {
  const p =
    log.lat !== undefined
      ? geographicToLocal(log, plan.alignment)
      : { x: log.x, z: log.z };
  if (!p) return null;
  const x = Number(p.x),
    z = Number(p.z);
  return p.x === null || p.z === null || p.x === "" || p.z === "" || !Number.isFinite(x) || !Number.isFinite(z)
    ? null
    : { x, z };
}

// One row per file / session the logs came from.
export function logSources(plan) {
  const map = new Map();
  for (const log of plan.logs || []) {
    const key = logSource(log);
    const row = map.get(key) || { source: key, count: 0, floors: new Set() };
    row.count += 1;
    row.floors.add(log.floorId);
    map.set(key, row);
  }
  return [...map.values()].map((r) => ({ ...r, floors: [...r.floors] }));
}

const areasOfFloor = (plan, floorId) => [
  ...plan.rooms.filter((r) => r.floorId === floorId),
  ...boundaryAreas(plan, floorId),
];

// Predicates: true means "this log would be removed".
export const hasNoPosition = (plan) => (log) => logPosition(plan, log) === null;

export const isOutsideBuilding = (plan) => {
  const cache = new Map();
  return (log) => {
    const at = logPosition(plan, log);
    if (!at) return false; // handled by "no position"
    if (!cache.has(log.floorId)) cache.set(log.floorId, areasOfFloor(plan, log.floorId));
    const areas = cache.get(log.floorId);
    if (!areas.length) return false; // nothing drawn to compare with
    return !areas.some((area) => inside(at.x, at.z, area));
  };
};

export const isKpiOutOfRange = (kpi, min, max) => (log) => {
  const value = log[kpi];
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return (min !== null && n < min) || (max !== null && n > max);
};

export const isFromSource = (source) => (log) => logSource(log) === source;
export const isOnFloor = (floorId) => (log) => log.floorId === floorId;

export const countLogs = (plan, predicate) =>
  (plan.logs || []).filter(predicate).length;

// The plan without the logs that match. Session ids whose logs are all gone
// are forgotten too.
export function removeLogs(plan, predicate) {
  const logs = (plan.logs || []).filter((log) => !predicate(log));
  const remaining = new Set(logs.map(logSource));
  const had = new Set((plan.logs || []).map(logSource));
  const sessionIds = (plan.sessionIds || []).filter((id) => {
    const label = sessionSource(id);
    return !had.has(label) || remaining.has(label);
  });
  return { ...plan, logs, sessionIds };
}
