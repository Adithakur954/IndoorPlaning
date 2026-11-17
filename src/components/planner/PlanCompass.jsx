import React from "react";
import { isValidAlignment } from "../../utils/geographicAlignment.js";

// Which way each edge of the 2D plan faces. The edge labels follow the plan's
// own sides (the same N/E/S/W as the door and window wall sides). When the plan
// is aligned to the map, an arrow also shows where real-world north lies.
export function trueNorthScreenDeg(alignment) {
  if (!isValidAlignment(alignment)) return null;
  // at rotation 0 north is the top of the plan; a positive rotation turns the
  // plan counter-clockwise towards north, so north moves clockwise on screen
  const deg = Number(alignment.rotationDeg);
  return ((deg % 360) + 360) % 360;
}

export default function PlanCompass({ alignment }) {
  const north = trueNorthScreenDeg(alignment);
  return (
    <>
      <span className="edge-label edge-n">N</span>
      <span className="edge-label edge-s">S</span>
      <span className="edge-label edge-w">W</span>
      <span className="edge-label edge-e">E</span>
      <div
        className="plan-compass"
        title={
          north == null
            ? "Edge letters are the plan's sides. Align the plan on the map (Geo alignment) to show true north."
            : `True north is ${Math.round(north)}° clockwise from the top of the plan`
        }
      >
        {north != null && (
          <svg viewBox="-20 -20 40 40" width="40" height="40" aria-hidden="true">
            <circle r="18" fill="#fff" stroke="#9fb3ad" />
            <g transform={`rotate(${north})`}>
              <path d="M0 -14 L5 4 L0 1 L-5 4 Z" fill="#dc2626" />
            </g>
          </svg>
        )}
        <small>
          {north == null
            ? "N = top of plan"
            : `True N ${Math.round(north)}° from top`}
        </small>
      </div>
    </>
  );
}
