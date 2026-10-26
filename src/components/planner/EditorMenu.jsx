import React from "react";

const toolLabels = {
  select: "Select",
  rectangle: "Rectangle",
  circle: "Circle",
  polygon: "Polygon",
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
  view,
  setView,
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
        <label className="popover-field">
          <span>View</span>
          <select
            value={view}
            onChange={(event) => setView(event.target.value)}
          >
            <option value="2d">2D</option>
            <option value="3d">3D</option>
            <option value="split">Split</option>
          </select>
        </label>
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
