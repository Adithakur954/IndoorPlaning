import React, { useId } from "react";

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
  sources,
  saveState,
  view,
  onViewChange,
  outputBand,
  outputBands = [],
  onBandChange,
  bandBusy = false,
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
          <strong>{area.toFixed(1)}</strong> m²
        </span>
        <span>
          <strong>{sources}</strong> Sources
        </span>
      </div>
      <div className="wf-group wf-controls">
        <FooterToggle label="Plan view" value={view} onChange={onViewChange}
          options={[["2d", "2D"], ["3d", "3D"]]} />
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
