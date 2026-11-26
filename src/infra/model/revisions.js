// Changing the infrastructure model. Every change goes through applyChanges,
// which returns a NEW model and appends one entry to the audit trail: who,
// when, what, and the values before and after. Nothing is edited in place and
// the trail is never rewritten, so any design can be traced back and any
// change can be undone by a new change.
import { COLLECTIONS, VERIFICATION_KEYS } from "./schema.js";

const clone = (value) => structuredClone(value);

function collectionOf(model, name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection "${name}"`);
  return model[name];
}

// changes:
//   { op: "add", collection, entity }
//   { op: "update", collection, id, patch }
//   { op: "remove", collection, id }
//   { op: "verify", key, value }
export function applyChanges(
  model,
  changes,
  { by = "unknown", summary = "", now = () => new Date().toISOString() } = {},
) {
  if (!Array.isArray(changes) || changes.length === 0)
    throw new Error("a change set needs at least one change");
  const next = clone(model);
  const recorded = [];

  for (const change of changes) {
    if (change.op === "verify") {
      if (!VERIFICATION_KEYS.includes(change.key))
        throw new Error(`unknown verification "${change.key}"`);
      recorded.push({
        op: "verify",
        key: change.key,
        before: next.verification[change.key],
        after: Boolean(change.value),
      });
      next.verification[change.key] = Boolean(change.value);
      continue;
    }
    const list = collectionOf(next, change.collection);
    if (change.op === "add") {
      if (!change.entity?.id) throw new Error("an added entity needs an id");
      if (COLLECTIONS.some((c) => next[c].some((e) => e.id === change.entity.id)))
        throw new Error(`id "${change.entity.id}" already exists`);
      list.push(clone(change.entity));
      recorded.push({ op: "add", collection: change.collection, id: change.entity.id, before: null, after: clone(change.entity) });
    } else if (change.op === "update") {
      const index = list.findIndex((e) => e.id === change.id);
      if (index < 0) throw new Error(`no ${change.collection} entry "${change.id}"`);
      if ("id" in (change.patch || {}) && change.patch.id !== change.id)
        throw new Error("an id cannot be changed");
      const before = clone(list[index]);
      const updated = { ...list[index], ...clone(change.patch) };
      // an undefined value in a patch removes the field (used by undo)
      for (const key of Object.keys(updated)) if (updated[key] === undefined) delete updated[key];
      list[index] = updated;
      recorded.push({ op: "update", collection: change.collection, id: change.id, before, after: clone(list[index]) });
    } else if (change.op === "remove") {
      const index = list.findIndex((e) => e.id === change.id);
      if (index < 0) throw new Error(`no ${change.collection} entry "${change.id}"`);
      const [removed] = list.splice(index, 1);
      recorded.push({ op: "remove", collection: change.collection, id: change.id, before: clone(removed), after: null });
    } else {
      throw new Error(`unknown change "${change.op}"`);
    }
  }

  next.revision = model.revision + 1;
  next.revisions.push({
    revision: next.revision,
    at: now(),
    by,
    summary,
    changes: recorded,
  });
  return next;
}

// The changes that undo a recorded revision, in reverse order.
export function inverseChanges(revision) {
  return [...revision.changes].reverse().map((c) => {
    if (c.op === "add") return { op: "remove", collection: c.collection, id: c.id };
    if (c.op === "remove") return { op: "add", collection: c.collection, entity: c.before };
    if (c.op === "verify") return { op: "verify", key: c.key, value: c.before };
    // restore every field the update touched, including fields it added
    const patch = {};
    for (const key of new Set([...Object.keys(c.before), ...Object.keys(c.after)]))
      patch[key] = c.before[key];
    return { op: "update", collection: c.collection, id: c.id, patch, restore: true };
  });
}

// Undo a past revision as a NEW revision (the trail stays linear and complete).
export function undoRevision(model, revisionNumber, meta = {}) {
  const target = model.revisions.find((r) => r.revision === revisionNumber);
  if (!target) throw new Error(`no revision ${revisionNumber}`);
  const changes = inverseChanges(target).map(({ restore, ...c }) => c);
  return applyChanges(model, changes, {
    ...meta,
    summary: meta.summary || `Undo revision ${revisionNumber}${target.summary ? `: ${target.summary}` : ""}`,
  });
}
