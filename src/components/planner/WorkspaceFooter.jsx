// The editor's status bar (a thin strip like a word processor's): what the plan
// holds on the left; quick switches, the view and the zoom on the right.
import React from "react";
import { formatArea } from "../../utils/measurementUnits.jsx";
import { Icon } from "./Ribbon.jsx";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

const clamp = (v) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
const toPercent = (z) => Math.round(z * 100);
// the slider runs 0 .. 100 with 100% zoom in the middle (like a word
// processor's): the left half zooms out to 25%, the right half in to 400%,
// each evenly in log scale (25% -> 50% -> 100% -> 200% -> 400%)
const toSlider = (z) => 50 + (50 * Math.log2(clamp(z))) / 2;
const fromSlider = (v) => clamp(2 ** (((Number(v) - 50) / 50) * 2));

// a switch shown as a small text button, highlighted while on
function StatusToggle({ label, on, title, onChange }) {
  return (
    <button
      type="button"
      className={`sb-item sb-toggle${on ? " on" : ""}`}
      aria-pressed={on}
      title={title}
      onClick={() => onChange(!on)}
    >
      <span className="sb-tick" aria-hidden="true">{on ? "✓" : ""}</span>
      {label}
    </button>
  );
}

export default function WorkspaceFooter({
  zoom,
  onZoom,
  floorName,
  rooms,
  area,
  unit = "m",
  sources,
  saveState,
  view,
  onViewChange,
  outputBand,
  outputBands = [],
  onBandChange,
  bandBusy = false,
  showMeasurements = false,
  onShowMeasurementsChange,
  isStatic = true,
  onStaticChange,
  sourcesLabel = "Sources",
}) {
  const failed = saveState === "Save failed";
  return (
    <footer className="statusbar">
      <div className="sb-side">
        <span className={`sb-item sb-save${failed ? " error" : ""}`} title="Changes are saved automatically">
          <span className="sb-dot" aria-hidden="true" />
          {saveState}
        </span>
        {floorName && <span className="sb-item" title="Floor shown">{floorName}</span>}
        <span className="sb-item sb-stat">{rooms} rooms</span>
        <span className="sb-item sb-stat">{formatArea(area, unit)}</span>
        <span className="sb-item sb-stat">
          {sources} {sourcesLabel.toLowerCase()}
        </span>
        {outputBand && outputBands.length > 0 && (
          <span className="sb-item sb-band" role="group" aria-label="Wi-Fi output frequency">
            Wi-Fi
            {outputBands.map((band) => (
              <button
                key={band}
                type="button"
                className={band === outputBand ? "on" : ""}
                aria-pressed={band === outputBand}
                disabled={bandBusy}
                onClick={() => onBandChange(band)}
              >
                {band} GHz
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="sb-side sb-right">
        {onStaticChange && (
          <StatusToggle
            label="Static"
            on={isStatic}
            onChange={onStaticChange}
            title="Locks dragging whole rooms and the boundary. Edges and corners can still be reshaped."
          />
        )}
        {onShowMeasurementsChange && (
          <StatusToggle
            label="Measurements"
            on={showMeasurements}
            onChange={onShowMeasurementsChange}
            title="Show the length of every room, boundary and wall edge"
          />
        )}
        <span className="sb-views" role="group" aria-label="Plan view">
          {[
            ["2d", "view2d", "2D plan"],
            ["3d", "view3d", "3D view"],
            ["split", "split", "2D and 3D side by side"],
          ].map(([id, icon, title]) => (
            <button
              key={id}
              type="button"
              className={view === id ? "on" : ""}
              aria-pressed={view === id}
              aria-label={title}
              title={title}
              onClick={() => onViewChange(id)}
            >
              <Icon name={icon} size={15} />
            </button>
          ))}
        </span>
        <span className="sb-zoom" title="Zoom (the mouse wheel on the plan does the same)">
          <button type="button" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => onZoom(clamp(zoom / 1.1))}>
            −
          </button>
          <span className="sb-zoom-track">
            <input
              type="range"
              min="0"
              max="100"
              step="0.5"
              value={toSlider(zoom)}
              aria-label="Zoom"
              aria-valuetext={`${toPercent(zoom)}%`}
              onChange={(e) => {
                // a small pull towards the middle mark makes 100% easy to hit
                const v = Number(e.target.value);
                onZoom(Math.abs(v - 50) < 2 ? 1 : fromSlider(v));
              }}
            />
          </span>
          <button type="button" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => onZoom(clamp(zoom * 1.1))}>
            +
          </button>
          <button type="button" className="sb-percent" title="Back to 100%" onClick={() => onZoom(1)}>
            {toPercent(zoom)}%
          </button>
        </span>
      </div>
    </footer>
  );
}
