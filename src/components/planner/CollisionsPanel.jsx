import React, { useMemo, useState } from "react";
import { materialLabels } from "../../config/materialColors.js";
import { findWallCollisions } from "../../utils/wallMerge.js";

const names = (owners) =>
  [...new Set(owners.map((o) => o.name || o.type))].join(" and ");

// Walls of the current floor that collide, each with the action that merges
// them into one wall. Hovering a row marks the place on the plan.
export default function CollisionsPanel({
  plan,
  floorId,
  onMergeWall,
  onSnapWalls,
  onFocus,
}) {
  const [picked, setPicked] = useState({});
  const rooms = plan.rooms,
    boundaries = plan.boundaries,
    doors = plan.doors,
    windows = plan.windows,
    wallTypes = plan.wallTypes,
    thickness = plan.wallThickness;
  const walls = useMemo(
    () =>
      findWallCollisions(plan, floorId).filter(
        // a shared wall only needs a decision when its two sides disagree
        (c) => c.kind === "close" || c.materials.length > 1,
      ),
    [rooms, boundaries, doors, windows, wallTypes, thickness, floorId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!walls.length) return null;
  const focus = (c) => ({
    onMouseEnter: () => onFocus?.(c),
    onMouseLeave: () => onFocus?.(null),
  });
  return (
    <section className="collisions-panel">
      <strong>Collisions</strong>
      {walls.map((c) => (
        <div key={c.id} className="collision-row" {...focus(c)}>
          {c.kind === "shared" ? (
            <>
              <span>
                Wall shared by {names(c.owners)} ({c.length.toFixed(1)} m) has
                different materials: {c.materials.join(", ")}.
              </span>
              <div className="button-row">
                <select
                  aria-label="Material of the merged wall"
                  value={picked[c.id] || c.material}
                  onChange={(e) =>
                    setPicked((p) => ({ ...p, [c.id]: e.target.value }))
                  }
                >
                  {Object.entries(materialLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onMergeWall(c, picked[c.id] || c.material)}
                >
                  Merge into one wall
                </button>
              </div>
            </>
          ) : (
            <>
              <span>
                Walls of {names(c.owners)} overlap ({c.length.toFixed(1)} m, only{" "}
                {(c.gap * 100).toFixed(0)} cm apart).
              </span>
              <div className="button-row">
                <button type="button" onClick={() => onSnapWalls(c)}>
                  Merge into one wall
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
