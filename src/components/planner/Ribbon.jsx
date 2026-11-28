// The editor's ribbon: tabs across the top (Home, Draw, Network, Prediction,
// View, Export), each showing buttons in labelled groups. It can be collapsed
// to its tab row to give the plan more room (the ^ button, or double-click a
// tab); the choice is remembered.
import React, { useEffect, useState } from "react";
import { LAYERS } from "../../config/layers.js";
import { LegendMenu } from "./EditorMenu.jsx";

const ICON_PATHS = {
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  select: "M5 3l14 8-6 1.6L10 19z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  props: "M4 5h16v14H4zM8 9h8M8 13h5",
  rect: "M4 6h16v12H4z",
  polygon: "M12 3l8 6-3 11H7L4 9z",
  circle: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
  boundary: "M3 3h18v18H3zM7 7h10v10H7z",
  wall: "M4 20 20 4M3 18l3 3M18 3l3 3",
  door: "M6 21V4h9v17M15 21h4M12 13h.01",
  window: "M4 4h16v16H4zM12 4v16M4 12h16",
  furniture: "M4 10h16v5H4zM6 15v4M18 15v4M6 10V7h12v3",
  wifi: "M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01",
  antenna: "M12 10v11M8 21h8M9 4a4 4 0 0 0 0 6M15 4a4 4 0 0 1 0 6M6 2a8 8 0 0 0 0 10M18 2a8 8 0 0 1 0 10",
  source: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h2",
  splitter: "M3 12h7M10 12l8-6M10 12l8 6M18 6h3M18 18h3",
  coupler: "M3 12h18M12 12v7M9 19h6",
  combiner: "M3 6l8 6-8 6M11 12h10",
  riser: "M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5",
  cable: "M4 18c4 0 4-12 8-12s4 12 8 12",
  prediction: "M3 12h3l3-8 4 16 3-8h5",
  optimise: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8",
  view2d: "M4 4h16v16H4zM4 12h16M12 4v16",
  view3d: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5",
  split: "M4 4h16v16H4zM12 4v16",
  zoomIn: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6",
  zoomOut: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  image: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21",
  report: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6",
  compare: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 18v-4M12 18v-7M15 18v-5",
  chevronUp: "m6 15 6-6 6 6",
  chevronDown: "m6 9 6 6 6-6",
};
export function Icon({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// A big button: icon above its label (the main actions of a group).
function Big({ icon, label, active, disabled, title, onClick }) {
  return (
    <button
      type="button"
      className={`ribbon-big${active ? " active" : ""}`}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      disabled={disabled}
      title={title || label}
      onClick={onClick}
    >
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
}
// A small button: icon beside its label, stacked three to a column.
function Small({ icon, label, active, disabled, title, onClick }) {
  return (
    <button
      type="button"
      className={`ribbon-small${active ? " active" : ""}`}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      disabled={disabled}
      title={title || label}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={16} />}
      <span>{label}</span>
    </button>
  );
}
function Check({ label, checked, onChange, title }) {
  return (
    <label className="ribbon-check" title={title || label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
// Opacity of the prediction image: a percentage typed in, or changed 5% at a time with − / +.
const OPACITY_MIN = 10;
const OPACITY_MAX = 100;
const OPACITY_STEP = 5;
function OpacityStepper({ value, onChange }) {
  const pct = Math.round(value * 100);
  const set = (next) => {
    const n = Math.round(Number(next));
    if (!Number.isFinite(n)) return;
    onChange(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n)) / 100);
  };
  return (
    <div className="ribbon-stepper" title="Opacity of the prediction image">
      <span>Opacity</span>
      <div className="ribbon-stepper-box">
        <button type="button" aria-label="Less opaque" disabled={pct <= OPACITY_MIN} onClick={() => set(pct - OPACITY_STEP)}>
          −
        </button>
        <input
          type="number"
          aria-label="Opacity, percent"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          value={pct}
          onChange={(e) => e.target.value !== "" && set(e.target.value)}
        />
        <em>%</em>
        <button type="button" aria-label="More opaque" disabled={pct >= OPACITY_MAX} onClick={() => set(pct + OPACITY_STEP)}>
          +
        </button>
      </div>
    </div>
  );
}

function Group({ label, children, stack = false }) {
  return (
    <div className="ribbon-group" role="group" aria-label={label}>
      {/* the group name is for screen readers only: no caption under the buttons */}
      <div className={`ribbon-group-body${stack ? " stack" : ""}`}>{children}</div>
    </div>
  );
}

const TABS = [
  ["home", "Home"],
  ["draw", "Draw"],
  ["network", "Network"],
  ["prediction", "Prediction"],
  ["view", "View"],
  ["export", "Export"],
];

export default function Ribbon(props) {
  const {
    workspace = "wifi",
    tool,
    setTool,
    snap,
    setSnap,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    hasSelection,
    onDelete,
    panelMode,
    openPanel,
    isStatic,
    onStaticChange,
    showMeasurements,
    onShowMeasurementsChange,
    view,
    setView,
    zoom,
    setZoom,
    hiddenLayers,
    setHiddenLayers,
    overlays,
    heatmapOpacity,
    setHeatmapOpacity,
    legendSections,
    setLegendSections,
    onDownloadImage,
    imageBusy,
    onReport,
    reportBusy,
    onCompare,
    compareBusy,
  } = props;
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem("ribbon.tab") || "home";
    } catch {
      return "home";
    }
  });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("ribbon.collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ribbon.tab", tab);
      localStorage.setItem("ribbon.collapsed", collapsed ? "1" : "0");
    } catch {
      /* storage unavailable: nothing to remember */
    }
  }, [tab, collapsed]);
  // a collapsed ribbon opens over the plan while a tab is picked, then folds away again
  const [peek, setPeek] = useState(false);
  const open = !collapsed || peek;
  const pick = (id) => {
    setTab(id);
    if (collapsed) setPeek(true);
  };
  const toolBtn = (id, icon, label, title) => (
    <Big
      icon={icon}
      label={label}
      title={title}
      active={tool === id}
      onClick={() => {
        setTool(id);
        setPeek(false);
      }}
    />
  );
  const overlay = (id) => overlays.find((o) => o.id === id);
  const toggleLayer = (id, on) =>
    setHiddenLayers(on ? hiddenLayers.filter((x) => x !== id) : [...hiddenLayers, id]);
  const cellular = workspace === "cellular";

  return (
    <div className={`ribbon${open ? "" : " collapsed"}${peek ? " peek" : ""}`} onMouseLeave={() => setPeek(false)}>
      <div className="ribbon-tabs" role="tablist" aria-label="Editor">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id && open ? "active" : ""}
            onClick={() => pick(id)}
            onDoubleClick={() => {
              setCollapsed((c) => !c);
              setPeek(false);
            }}
          >
            {label}
          </button>
        ))}
        <span className="ribbon-tabs-fill" />
        <button
          type="button"
          className="ribbon-collapse"
          title={collapsed ? "Keep the ribbon open" : "Collapse the ribbon (more room for the plan)"}
          aria-label={collapsed ? "Keep the ribbon open" : "Collapse the ribbon"}
          onClick={() => {
            setCollapsed((c) => !c);
            setPeek(false);
          }}
        >
          <Icon name={collapsed ? "chevronDown" : "chevronUp"} size={16} />
        </button>
      </div>
      {open && (
        <div className="ribbon-panel" role="tabpanel">
          {tab === "home" && (
            <>
              <Group label="History">
                <Big icon="undo" label="Undo" disabled={!canUndo} title="Undo (Ctrl+Z)" onClick={onUndo} />
                <Big icon="redo" label="Redo" disabled={!canRedo} title="Redo (Ctrl+Y)" onClick={onRedo} />
              </Group>
              <Group label="Selection">
                {toolBtn("select", "select", "Select", "Select and move items (Esc)")}
                <Big icon="trash" label="Delete" disabled={!hasSelection} title="Delete the selected item (Delete key)" onClick={onDelete} />
                <Big
                  icon="props"
                  label="Properties"
                  active={panelMode === "selection"}
                  title="Show the properties of the selected item"
                  onClick={() => openPanel("selection")}
                />
              </Group>
              <Group label="Plan" stack>
                <Check label="Static (rooms do not move)" checked={isStatic} onChange={onStaticChange} />
                <Check label="Snap to 0.5 m" checked={snap} onChange={setSnap} />
                <Check label="Show measurements" checked={showMeasurements} onChange={onShowMeasurementsChange} />
              </Group>
              <Group label="Rooms">
                {toolBtn("rectangle", "rect", "Rectangle", "Draw a rectangle room: press and drag")}
                {toolBtn("polygon", "polygon", "Polygon", "Draw a room corner by corner")}
                {toolBtn("boundary", "boundary", "Boundary", "Draw the building outline")}
              </Group>
            </>
          )}
          {tab === "draw" && (
            <>
              <Group label="Rooms">
                {toolBtn("rectangle", "rect", "Rectangle", "Draw a rectangle room: press and drag")}
                {toolBtn("polygon", "polygon", "Polygon", "Draw a room corner by corner")}
                {toolBtn("circle", "circle", "Circle room")}
              </Group>
              <Group label="Building">
                {toolBtn("boundary", "boundary", "Boundary", "Draw the building outline")}
                {toolBtn("wall", "wall", "Wall", "Draw a wall: click its start, then its end")}
              </Group>
              <Group label="Openings">
                {toolBtn("door", "door", "Door", "Click on a wall to add a door")}
                {toolBtn("window", "window", "Window", "Click on a wall to add a window")}
              </Group>
              <Group label="Contents">{toolBtn("furniture", "furniture", "Furniture")}</Group>
              <Group label="Options" stack>
                <Check label="Snap to 0.5 m" checked={snap} onChange={setSnap} />
                <Check label="Show measurements" checked={showMeasurements} onChange={onShowMeasurementsChange} />
              </Group>
            </>
          )}
          {tab === "network" && (
            <>
              {cellular ? (
                <>
                  <Group label="Antennas">{toolBtn("cellular", "antenna", "Antenna", "Click on the plan to place an antenna")}</Group>
                  <Group label="DAS parts">
                    {toolBtn("dassource", "source", "Source", "Source (BTS / repeater)")}
                    {toolBtn("splitter", "splitter", "Splitter")}
                    {toolBtn("coupler", "coupler", "Coupler")}
                    {toolBtn("combiner", "combiner", "Combiner")}
                    {toolBtn("riser", "riser", "Shaft", "Shaft (riser): takes the feeder from the BTS or a part and carries it to another floor")}
                  </Group>
                  <Group label="Cables">{toolBtn("dascable", "cable", "Cable", "Join parts and antennas with a cable")}</Group>
                  <Group label="Settings">
                    <Big
                      icon="props"
                      label="Antenna setup"
                      active={panelMode === "cellular"}
                      title="Antenna models, bands and power"
                      onClick={() => openPanel("cellular")}
                    />
                  </Group>
                </>
              ) : (
                <Group label="Access points">{toolBtn("wifi", "wifi", "Wi-Fi AP", "Click on the plan to place an access point")}</Group>
              )}
            </>
          )}
          {tab === "prediction" && (
            <>
              <Group label="Run">
                {cellular ? (
                  <Big icon="prediction" label="Prediction" active={panelMode === "cellular"} onClick={() => openPanel("cellular")} />
                ) : (
                  <>
                    <Big icon="prediction" label="Prediction" active={panelMode === "prediction"} onClick={() => openPanel("prediction")} />
                    <Big icon="optimise" label="Optimise APs" active={panelMode === "optimize"} onClick={() => openPanel("optimize")} />
                  </>
                )}
              </Group>
              <Group label="Map" stack>
                {overlay("heatmap") && (
                  <Check label={overlay("heatmap").label} checked={overlay("heatmap").checked} onChange={overlay("heatmap").onChange} />
                )}
                <OpacityStepper value={heatmapOpacity} onChange={setHeatmapOpacity} />
              </Group>
              <Group label="Legend">
                <LegendMenu sections={legendSections} onChange={setLegendSections} />
              </Group>
            </>
          )}
          {tab === "view" && (
            <>
              <Group label="View">
                <Big icon="view2d" label="2D" active={view === "2d"} onClick={() => setView("2d")} />
                <Big icon="view3d" label="3D" active={view === "3d"} onClick={() => setView("3d")} />
                <Big icon="split" label="Side by side" active={view === "split"} onClick={() => setView("split")} />
              </Group>
              <Group label="Zoom">
                <Big icon="zoomOut" label="Out" onClick={() => setZoom(Math.max(0.25, zoom / 1.2))} />
                <Big icon="zoomIn" label="In" onClick={() => setZoom(Math.min(4, zoom * 1.2))} />
                <Big icon="fit" label={`${Math.round(zoom * 100)}%`} title="Back to 100%" onClick={() => setZoom(1)} />
              </Group>
              <Group label="Plan layers" stack>
                <div className="ribbon-checks">
                  {LAYERS.map((layer) => (
                    <Check
                      key={layer.id}
                      label={layer.id === "sources" ? (cellular ? "Antennas and DAS" : "Wi-Fi APs") : layer.label.replace(" (not detected)", "")}
                      checked={!hiddenLayers.includes(layer.id)}
                      onChange={(on) => toggleLayer(layer.id, on)}
                    />
                  ))}
                </div>
              </Group>
              <Group label="Names and data" stack>
                <div className="ribbon-checks">
                  {overlays
                    .filter((o) => o.id !== "heatmap")
                    .map((o) => (
                      <Check key={o.id} label={o.label} checked={o.checked} onChange={o.onChange} />
                    ))}
                </div>
              </Group>
            </>
          )}
          {tab === "export" && (
            <>
              <Group label="Picture">
                <Big icon="image" label={imageBusy ? "Saving…" : "Plan image"} disabled={imageBusy} title="Download the plot as it looks now (PNG)" onClick={onDownloadImage} />
              </Group>
              {!cellular && (
                <Group label="Reports">
                  <Big
                    icon="report"
                    label={reportBusy ? "Building…" : "Word report"}
                    disabled={reportBusy}
                    title="Each AP's prediction, the combined prediction, optimised APs and the APs needed for full coverage (.docx)"
                    onClick={onReport}
                  />
                  <Big
                    icon="compare"
                    label={compareBusy ? "Building…" : "2.4 vs 5 GHz"}
                    disabled={compareBusy || reportBusy}
                    title="The 2.4 GHz vs 5 GHz comparison report (.docx)"
                    onClick={onCompare}
                  />
                </Group>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
