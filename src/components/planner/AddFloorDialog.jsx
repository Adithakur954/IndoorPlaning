// Add a floor: an empty one, or a copy of an existing floor with the parts chosen
// (rooms and walls, antennas and DAS parts with their cables, the floor picture).
import React, { useEffect, useMemo, useState } from "react";
import { DUPLICATE_PARTS } from "../../utils/duplicateFloor.js";

export default function AddFloorDialog({ plan, currentFloorId, onAdd, onClose }) {
  const floors = plan.floors;
  const top = useMemo(() => Math.max(...floors.map((f) => Number(f.elevation) || 0)), [floors]);
  // the usual height between floors: the step between the two highest, else 3.2 m
  const step = useMemo(() => {
    const e = [...new Set(floors.map((f) => Number(f.elevation) || 0))].sort((a, b) => b - a);
    return e.length > 1 && e[0] - e[1] > 0 ? +(e[0] - e[1]).toFixed(2) : 3.2;
  }, [floors]);
  const [mode, setMode] = useState("empty");
  const [from, setFrom] = useState(currentFloorId || floors[0]?.id);
  const [name, setName] = useState(`Level ${floors.length + 1}`);
  const [elevation, setElevation] = useState(+(top + step).toFixed(2));
  const [parts, setParts] = useState({ building: true, components: true, image: true });
  const source = floors.find((f) => f.id === from);
  // what the copy would bring
  const count = (key) => (plan[key] || []).filter((x) => x.floorId === from).length;
  const summary = {
    building: count("rooms") + count("interiorWalls") + count("doors") + count("windows") + count("furniture"),
    components: count("sources"),
    image: plan.images?.[from] ? 1 : 0,
  };
  useEffect(() => {
    const key = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  useEffect(() => {
    if (mode === "copy" && source) setName(`${source.name} (copy)`);
    if (mode === "empty") setName(`Level ${floors.length + 1}`);
  }, [mode, from]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ name: name.trim(), elevation: Number(elevation) || 0, copyFrom: mode === "copy" ? from : null, ...parts });
  };

  return (
    <div className="das-import-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="add-floor-dialog" role="dialog" aria-modal="true" aria-label="Add floor" onSubmit={submit}>
        <header>
          <strong>Add floor</strong>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="add-floor-body">
          <div className="add-floor-modes" role="radiogroup" aria-label="New floor">
            <label className={mode === "empty" ? "active" : ""}>
              <input type="radio" name="mode" checked={mode === "empty"} onChange={() => setMode("empty")} />
              <span>
                <strong>Empty floor</strong>
                <small>Start from nothing, then import a floor plan or draw.</small>
              </span>
            </label>
            <label className={mode === "copy" ? "active" : ""}>
              <input type="radio" name="mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
              <span>
                <strong>Duplicate a floor</strong>
                <small>Copy its rooms, walls and components to the new floor.</small>
              </span>
            </label>
          </div>
          {mode === "copy" && (
            <div className="add-floor-copy">
              <label className="add-floor-field">
                Copy from
                <select value={from} onChange={(e) => setFrom(e.target.value)}>
                  {floors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              {DUPLICATE_PARTS.map(([id, label]) => (
                <label key={id} className="add-floor-check">
                  <input type="checkbox" checked={parts[id]} onChange={(e) => setParts((p) => ({ ...p, [id]: e.target.checked }))} />
                  <span>{label}</span>
                  <small>{id === "image" ? (summary.image ? "yes" : "none") : summary[id]}</small>
                </label>
              ))}
            </div>
          )}
          <div className="add-floor-row">
            <label className="add-floor-field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label className="add-floor-field">
              Elevation, m
              <input type="number" step="0.1" value={elevation} onChange={(e) => setElevation(e.target.value)} />
            </label>
          </div>
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {mode === "copy" ? "Duplicate floor" : "Add floor"}
          </button>
        </footer>
      </form>
    </div>
  );
}
