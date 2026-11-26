// Undo, redo and an audit trail for the cabling settings (racks, risers, pathways,
// rules, catalogue). Pure functions: the panel keeps the stacks.
const KEYS = ["racks", "risers", "rules", "catalogue", "fieldTest"];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What changed between two states, as a short readable list.
export function describeChange(before, after) {
  const changes = [];
  for (const key of KEYS) if (!same(before?.[key], after?.[key])) changes.push(key);
  const pb = before?.pathway || {};
  const pa = after?.pathway || {};
  for (const key of new Set([...Object.keys(pb), ...Object.keys(pa)]))
    if (!same(pb[key], pa[key])) changes.push(`pathway.${key}`);
  return changes;
}

export function auditEntry(before, after, { summary, now = () => new Date().toISOString(), by = "user" } = {}) {
  const changed = describeChange(before, after);
  if (!changed.length) return null;
  return { at: now(), by, summary: summary || `Changed ${changed.join(", ")}`, changed };
}

// The state after a change, with the entry added to its trail. Returns the same state
// when nothing changed.
export function recordChange(before, after, meta = {}) {
  const entry = auditEntry(before, after, meta);
  if (!entry) return before;
  return { ...after, auditLog: [...(before.auditLog || []), entry] };
}

const strip = (state) => {
  const { auditLog, ...rest } = state;
  return rest;
};

export const emptyHistory = () => ({ past: [], future: [] });

// A new history after a change (the earlier state can be undone; redo is cleared).
export function pushHistory(history, before, limit = 50) {
  return { past: [...history.past, strip(before)].slice(-limit), future: [] };
}

// Undo: the earlier state comes back, but the trail keeps growing (it is never rewritten).
export function undo(history, current, meta = {}) {
  if (!history.past.length) return null;
  const previous = history.past[history.past.length - 1];
  const entry = { at: (meta.now || (() => new Date().toISOString()))(), by: meta.by || "user", summary: "Undo", changed: describeChange(current, previous) };
  return {
    state: { ...previous, auditLog: [...(current.auditLog || []), entry] },
    history: { past: history.past.slice(0, -1), future: [...history.future, strip(current)] },
  };
}

export function redo(history, current, meta = {}) {
  if (!history.future.length) return null;
  const next = history.future[history.future.length - 1];
  const entry = { at: (meta.now || (() => new Date().toISOString()))(), by: meta.by || "user", summary: "Redo", changed: describeChange(current, next) };
  return {
    state: { ...next, auditLog: [...(current.auditLog || []), entry] },
    history: { past: [...history.past, strip(current)], future: history.future.slice(0, -1) },
  };
}
