import React, { useState } from "react";
import { downloadBlob } from "../../utils/sceneExport.js";
import {
  EDITABLE_GROUPS,
  addPart,
  catalogueToJson,
  mergeCatalogue,
  parseCatalogueJson,
  resetPart,
  setPartField,
} from "../../infra/wifi/catalogueEdit.js";

// Edit the project's equipment catalogue: change a part's values (from the
// datasheet), add a part, put a part back to its default, import or export JSON.
// Only the changes are stored in the project.
export default function CatalogueEditor({ overrides, onChange }) {
  const merged = mergeCatalogue(overrides);
  const [group, setGroup] = useState("switches");
  const [partId, setPartId] = useState("");
  const [message, setMessage] = useState("");
  const parts = Object.values(merged[group] || {});
  const part = merged[group]?.[partId] || parts[0];
  const edited = Boolean(overrides?.[group]?.[part?.id]);

  const change = (field, raw) => {
    const current = part[field];
    const value = typeof current === "number" ? Number(raw) : raw;
    if (typeof current === "number" && !Number.isFinite(value)) return;
    onChange(setPartField(overrides, group, part.id, field, value), `Catalogue: ${part.name}, ${field}`);
  };
  const fields = part ? Object.entries(part).filter(([k, v]) => k !== "id" && (typeof v === "number" || typeof v === "string")) : [];

  return (
    <details>
      <summary>Equipment catalogue (datasheet values)</summary>
      <small className="hint">
        The values are placeholders until you enter the real ones. Change a part
        from its datasheet; a part you change is marked as entered by you.
      </small>
      <label className="field">
        <span>Group</span>
        <select value={group} onChange={(e) => { setGroup(e.target.value); setPartId(""); }}>
          {Object.entries(EDITABLE_GROUPS).map(([id, g]) => <option key={id} value={id}>{g.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Part</span>
        <select value={part?.id || ""} onChange={(e) => setPartId(e.target.value)}>
          {parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {part && fields.map(([key, value]) => (
        <label key={key} className="field">
          <span>{key}</span>
          <input type={typeof value === "number" ? "number" : "text"} step="any" value={value}
            onChange={(e) => change(key, e.target.value)} />
        </label>
      ))}
      <div className="button-row">
        <button type="button" onClick={() => {
          const id = window.prompt("Id of the new part (letters, numbers, dashes)", `${part.id}-2`);
          if (!id) return;
          try { onChange(addPart(overrides, group, part.id, id.trim()), `Catalogue: added ${id.trim()}`); setPartId(id.trim()); setMessage(""); }
          catch (e) { setMessage(e.message); }
        }}>Add a copy as a new part</button>
        <button type="button" disabled={!edited} onClick={() => onChange(resetPart(overrides, group, part.id), `Catalogue: reset ${part.name}`)}>
          Back to default
        </button>
      </div>
      <div className="button-row">
        <button type="button" onClick={() => downloadBlob(new Blob([catalogueToJson(overrides)], { type: "application/json" }), "wifi-catalogue.json")}>
          Export catalogue (JSON)
        </button>
        <label className="button">
          Import catalogue (JSON)
          <input type="file" accept="application/json,.json" style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const imported = parseCatalogueJson(await file.text());
                // imported parts are layered on what is already changed
                const next = { ...overrides };
                for (const [g, ps] of Object.entries(imported)) next[g] = { ...(next[g] || {}), ...ps };
                onChange(next, "Catalogue: imported from a file");
                setMessage("Catalogue imported.");
              } catch (err) {
                setMessage(err.message);
              }
            }} />
        </label>
      </div>
      {message && <small className="hint">{message}</small>}
    </details>
  );
}
