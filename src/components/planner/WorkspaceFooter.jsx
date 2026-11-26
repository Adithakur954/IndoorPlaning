import React, { useId } from "react";
import { formatArea } from "../../utils/measurementUnits.jsx";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

const clamp = (v) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
// the slider is linear in percent: 25% .. 400%
const toPercent = (z) => Math.round(z * 100);

function FooterToggle({ label, value, options, onChange, disabled = false }) {
  const name = useId();
  return (
    <div className="wf-toggle" role="radiogroup" aria-label={label}
      style={{ "--toggle-count": options.length, "--toggle-index": Math.max(0, options.findIndex(([id]) => id === value)) }}>
      <span className="wf-toggle-thumb" aria-hidden="true" />
      {options.map(([id, text]) => (
        <label key={id} className="wf-toggle-option">
          <input type="radio" name={name} value={id} checked={value === id}
            disabled={disabled} onChange={() => onChange(id)} />
          <span>{text}</span>
        </label>
      ))}
    </div>
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
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  isStatic = true,
  onStaticChange,
}) {
  return (
    <footer className="workspace-footer">
      <div className="wf-group wf-info">
        <span className={`wf-dot ${saveState === "Save failed" ? "error" : ""}`} />
        <span className="wf-save">{saveState}</span>
        {floorName && <span className="wf-floor">{floorName}</span>}
      </div>
      <div className="wf-group wf-stats">
        <span>
          <strong>{rooms}</strong> Rooms
        </span>
        <span>
          <strong>{formatArea(area, unit)}</strong>
        </span>
        <span>
          <strong>{sources}</strong> Sources
        </span>
      </div>
      <div className="wf-group wf-controls">
        {onUndo && (
          <div className="wf-group wf-history">
            <button type="button" className="wf-icon" onClick={onUndo} disabled={!canUndo}
              aria-label="Undo" title="Undo (Ctrl+Z)">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
                stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
            <button type="button" className="wf-icon" onClick={onRedo} disabled={!canRedo}
              aria-label="Redo" title="Redo (Ctrl+Y)">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
                stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
              </svg>
            </button>
          </div>
        )}
        <FooterToggle label="Plan view" value={view} onChange={onViewChange}
          options={[["2d", "2D"], ["3d", "3D"]]} />
        {onStaticChange && (
          <label className="wf-check" title="Locks dragging whole rooms and the boundary. Edges and vertices can still be reshaped.">
            <input type="checkbox" checked={isStatic}
              onChange={(e) => onStaticChange(e.target.checked)} />
            <span>Static</span>
          </label>
        )}
        {onShowMeasurementsChange && (
          <label className="wf-check" title="Show the length of every room, boundary and wall edge">
            <input type="checkbox" checked={showMeasurements}
              onChange={(e) => onShowMeasurementsChange(e.target.checked)} />
            <span>Show measurements</span>
          </label>
        )}
        {outputBand && outputBands.length > 0 && (
          <div className="wf-group wf-band">
            <span className="wf-control-label">Wi-Fi</span>
            <FooterToggle label="Wi-Fi output frequency" value={outputBand}
              options={outputBands.map((band) => [band, `${band} GHz`])}
              onChange={onBandChange} disabled={bandBusy} />
          </div>
        )}
      </div>
      <div className="wf-group wf-slider" title="Zoom (the mouse wheel on the plan does the same)">
        <button
          type="button"
          className="wf-icon"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => onZoom(clamp(zoom / 1.1))}
        >
          −
        </button>
        <input
          type="range"
          min={toPercent(ZOOM_MIN)}
          max={toPercent(ZOOM_MAX)}
          step="5"
          value={toPercent(zoom)}
          aria-label="Zoom"
          onChange={(e) => onZoom(clamp(Number(e.target.value) / 100))}
        />
        <button
          type="button"
          className="wf-icon"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => onZoom(clamp(zoom * 1.1))}
        >
          +
        </button>
        <button
          type="button"
          className="wf-percent"
          title="Reset to 100%"
          onClick={() => onZoom(1)}
        >
          {toPercent(zoom)}%
        </button>
      </div>
    </footer>
  );
}
