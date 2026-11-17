import React from "react";
import { LEGEND_SECTIONS } from "./MapLegend.jsx";
import { LAYERS } from "../../config/layers.js";

const toolLabels = {
  select: "Select",
  rectangle: "Rectangle",
  circle: "Circle",
  polygon: "Polygon",
  boundary: "Boundary",
  wall: "Wall",
  door: "Door",
  window: "Window",
  furniture: "Furniture",
  cellular: "Cellular",
  wifi: "Wi-Fi",
};

export default function EditorMenu({ active, onOpen }) {
  return (
    <button
      className="editor-menu-trigger"
      type="button"
      aria-pressed={active}
      onClick={onOpen}
    >
      More tools
    </button>
  );
}

export function EditorQuickTools({ tool, setTool }) {
  const tools = [
    ["select", "↖", "Cursor"],
    ["rectangle", "▭", "Rectangle"],
    ["polygon", "⬠", "Polygon"],
    ["boundary", "⬡", "Boundary"],
  ];

  return (
    <div className="editor-quick-tools" role="toolbar" aria-label="Drawing tools">
      {tools.map(([value, icon, label]) => (
        <button
          key={value}
          type="button"
          className={tool === value ? "active" : ""}
          aria-pressed={tool === value}
          aria-label={label}
          title={label}
          onClick={() => setTool(value)}
        >
          <span aria-hidden="true">{icon}</span>
          <span className="editor-tool-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function EditorToolOptions({
  tool,
  setTool,
  snap,
  setSnap,
}) {
  return (
    <>
      <div className="popover-label">DRAW TOOLS</div>
      <div className="editor-tool-grid">
        {Object.entries(toolLabels).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tool === value ? "active" : ""}
            aria-pressed={tool === value}
            onClick={() => setTool(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="popover-controls">
        <label className="check popover-snap">
          <input
            type="checkbox"
            checked={snap}
            onChange={(event) => setSnap(event.target.checked)}
          />
          Snap 0.5 m
        </label>
      </div>
    </>
  );
}

export function PredictionMenu({ active, onOpen }) {
  return (
    <button
      className="prediction-menu-trigger"
      type="button"
      aria-pressed={active}
      onClick={onOpen}
    >
      Prediction
    </button>
  );
}

export function OptimizeMenu({ active, onOpen }) {
  return (
    <button
      className="optimize-menu-trigger"
      type="button"
      aria-pressed={active}
      onClick={onOpen}
    >
      Optimise APs
    </button>
  );
}

export function DownloadImageButton({ onDownload, busy }) {
  return (
    <button
      className="download-image-trigger icon-button"
      type="button"
      disabled={busy}
      aria-label="Download image"
      title="Download the plot as it looks now (PNG)"
      onClick={onDownload}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </button>
  );
}

// Header menu: which parts of the map legend are shown (KPI by default; several
// can be shown together).
export function LegendMenu({ sections, onChange }) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const toggle = (id) =>
    onChange(
      sections.includes(id)
        ? sections.filter((x) => x !== id)
        : LEGEND_SECTIONS.map((x) => x.id).filter(
            (x) => x === id || sections.includes(x),
          ),
    );
  return (
    <div className="legend-menu" ref={box}>
      <button
        type="button"
        className="legend-menu-trigger"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        Legend{sections.length ? ` (${sections.length})` : " (off)"}
      </button>
      {open && (
        <div className="legend-menu-popover" role="menu">
          <div className="popover-label">SHOW IN LEGEND</div>
          {LEGEND_SECTIONS.map((section) => (
            <label key={section.id} className="legend-menu-item">
              <input
                type="checkbox"
                checked={sections.includes(section.id)}
                onChange={() => toggle(section.id)}
              />
              {section.label}
            </label>
          ))}
          <div className="button-row">
            <button type="button" onClick={() => onChange(["kpi"])}>
              KPI only
            </button>
            <button
              type="button"
              onClick={() => onChange(LEGEND_SECTIONS.map((x) => x.id))}
            >
              All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Header menu: what is drawn on the workspace. Layers that belong to the plan
// (rooms, walls, ...) and the data overlays (heatmap, logs, names) in one place.
export function ShowMenu({ hiddenLayers, onHiddenLayers, overlays, onManageLogs, logCount = 0 }) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const toggleLayer = (id) =>
    onHiddenLayers(
      hiddenLayers.includes(id)
        ? hiddenLayers.filter((x) => x !== id)
        : [...hiddenLayers, id],
    );
  const hiddenCount =
    hiddenLayers.length + overlays.filter((o) => !o.checked).length;
  return (
    <div className="legend-menu" ref={box}>
      <button
        type="button"
        className="legend-menu-trigger"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        Show{hiddenCount ? ` (${hiddenCount} off)` : ""}
      </button>
      {open && (
        <div className="legend-menu-popover show-popover" role="menu">
          <div className="popover-label">PLAN</div>
          {LAYERS.map((layer) => (
            <label key={layer.id} className="legend-menu-item">
              <input
                type="checkbox"
                checked={!hiddenLayers.includes(layer.id)}
                onChange={() => toggleLayer(layer.id)}
              />
              {layer.label}
            </label>
          ))}
          <div className="popover-label">DATA AND NAMES</div>
          {overlays.map((o) => (
            <label key={o.id} className="legend-menu-item">
              <input
                type="checkbox"
                checked={o.checked}
                onChange={(e) => o.onChange(e.target.checked)}
              />
              {o.label}
            </label>
          ))}
          {onManageLogs && (
            <div className="button-row">
              <button
                type="button"
                disabled={!logCount}
                title="Choose which imported logs to remove from this project"
                onClick={() => {
                  setOpen(false);
                  onManageLogs();
                }}
              >
                Remove imported logs… ({logCount})
              </button>
            </div>
          )}
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                onHiddenLayers([]);
                overlays.forEach((o) => o.onChange(o.defaultOn));
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
