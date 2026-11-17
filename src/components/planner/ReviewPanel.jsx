import React from "react";
import { validateBuilding } from "../../utils/buildingValidation.js";

const pct = (c) => (c == null ? "" : `${Math.round(c * 100)}%`);

// Items read from a drawing that the detector was unsure about, least certain
// first. Confirming one clears its mark.
export function reviewItems(plan, floorId) {
  const on = (x) => x.floorId === floorId && x.needsReview;
  return [
    ...plan.rooms.filter(on).map((x) => ({
      type: "room",
      id: x.id,
      title: x.name,
      confidence: x.confidence,
      notes: x.reviewNotes || [],
    })),
    ...plan.doors.filter(on).map((x) => ({
      type: "door",
      id: x.id,
      title: x.detectedKind === "opening" ? "Opening (door or window?)" : "Door",
      confidence: x.confidence,
      notes: [],
    })),
    ...plan.windows.filter(on).map((x) => ({
      type: "window",
      id: x.id,
      title: "Window",
      confidence: x.confidence,
      notes: [],
    })),
    ...plan.interiorWalls.filter(on).map((x) => ({
      type: "wall",
      id: x.id,
      title: x.name || "Wall",
      confidence: x.confidence,
      notes: [],
    })),
  ].sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
}

export default function ReviewPanel({ plan, floorId, onSelect, onConfirm }) {
  const items = reviewItems(plan, floorId);
  const checks = validateBuilding(plan, floorId);
  const problems = [...checks.errors, ...checks.warnings];
  if (!items.length && !problems.length) return null;
  return (
    <>
      {problems.length > 0 && (
        <section className="review-panel">
          <strong>Geometry checks ({problems.length})</strong>
          {checks.errors.map((e) => (
            <small key={e} className="warn">
              ✖ {e}
            </small>
          ))}
          {checks.warnings.map((w) => (
            <small key={w}>⚠ {w}</small>
          ))}
        </section>
      )}
      {items.length > 0 && (
    <section className="review-panel">
      <strong>To review ({items.length})</strong>
      <small>
        Read from the drawing with low confidence. Fix or confirm each one; the
        least certain come first.
      </small>
      {items.map((item) => (
        <div key={`${item.type}-${item.id}`} className="review-item">
          <button type="button" onClick={() => onSelect({ type: item.type, id: item.id })}>
            {item.title} <em>{pct(item.confidence)}</em>
          </button>
          <button type="button" title="This is correct" onClick={() => onConfirm(item)}>
            ✓
          </button>
          {item.notes.map((n) => (
            <small key={n}>{n}</small>
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() => items.forEach(onConfirm)}
        title="Mark everything listed here as checked"
      >
        Confirm all
      </button>
    </section>
      )}
    </>
  );
}
