import React, { useEffect, useState } from "react";
import { materialLabels } from "../../config/materialColors.js";
import { metresToUnit, unitToMetres, useMeasurementUnit } from "../../utils/measurementUnits.jsx";
import {
  MATERIAL_NAMES,
  defaultLossDb,
  ituProperties,
} from "../../utils/materialModel.js";

const REFERENCE = { "2.4 GHz": 2437, "5 GHz": 5180, "6 GHz": 6175 };

// Number box that keeps what is being typed ("0." or "0.0" on the way to 0.05)
// and only passes on values that are valid.
function NumberInput({ value, onCommit, min, step = "0.01" }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => setText(String(value ?? "")), [value]);
  return (
    <input
      type="number"
      step={step}
      min={min}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n >= min)
          onCommit(n);
      }}
      onBlur={() => setText(String(value ?? ""))}
    />
  );
}

// Manual wall-material settings. Empty fields keep the ITU-R P.2040 defaults.
export default function MaterialsEditor({ plan, mutate }) {
  const [reference, setReference] = useState("5 GHz");
  const unit = useMeasurementUnit();
  const freq = REFERENCE[reference];
  const wallT = Number(plan.wallThickness) || 0.2;
  const overrides = plan.materialOverrides || {};

  const set = (material, changes) =>
    mutate((p) => {
      const next = { ...(p.materialOverrides || {}) };
      const merged = { ...(next[material] || {}), ...changes };
      for (const k of Object.keys(merged))
        if (merged[k] === "" || merged[k] === null) delete merged[k];
      if (Object.keys(merged).length) next[material] = merged;
      else delete next[material];
      return { ...p, materialOverrides: next };
    });

  return (
    <section className="materials-editor">
      <h4>Wall materials</h4>
      <p className="panel-note">
        Leave a field empty to keep the default (ITU-R P.2040).{" "}
        <strong>Loss</strong> is what a wall of that material takes off the
        signal, for one pass at right angles, at the AP's frequency. Walls only
        lose signal; they cannot add gain.
      </p>
      <label className="field">
        <span>Show defaults for</span>
        <select
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        >
          {Object.keys(REFERENCE).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Default wall thickness ({unit})</span>
        <NumberInput
          min={metresToUnit(0.01, unit)}
          value={metresToUnit(plan.wallThickness ?? 0.2, unit)}
          onCommit={(v) => mutate((p) => ({ ...p, wallThickness: unitToMetres(v, unit) }))}
        />
      </label>
      {MATERIAL_NAMES.map((m) => {
        const o = overrides[m] || {};
        const thickness = o.thicknessM ?? wallT;
        const fallback = defaultLossDb(m, thickness, freq);
        const { epsR, sigma } = ituProperties(m, freq);
        const edited = Object.keys(o).length > 0;
        return (
          <div key={m} className={`material-row ${edited ? "edited" : ""}`}>
            <div className="material-head">
              <strong>{materialLabels[m]}</strong>
              <small>
                default{" "}
                {Number.isFinite(fallback)
                  ? `${fallback.toFixed(1)} dB`
                  : "blocks all signal"}{" "}
                at {metresToUnit(thickness, unit)} {unit}
              </small>
              {edited && (
                <button
                  type="button"
                  onClick={() =>
                    set(
                      m,
                      Object.fromEntries(Object.keys(o).map((k) => [k, ""])),
                    )
                  }
                >
                  Reset
                </button>
              )}
            </div>
            <div className="material-fields">
              <label>
                <span>Thickness ({unit})</span>
                <input
                  type="number"
                  step={metresToUnit(0.01, unit)}
                  min={metresToUnit(0.001, unit)}
                  placeholder={String(metresToUnit(wallT, unit))}
                  value={o.thicknessM == null || o.thicknessM === "" ? "" : metresToUnit(o.thicknessM, unit)}
                  onChange={(e) => set(m, { thicknessM: e.target.value === "" ? "" : unitToMetres(e.target.value, unit) })}
                />
              </label>
              <label>
                <span>Loss (dB)</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  placeholder={
                    Number.isFinite(fallback) ? fallback.toFixed(1) : "–"
                  }
                  value={o.lossDb ?? ""}
                  onChange={(e) => set(m, { lossDb: e.target.value })}
                />
              </label>
            </div>
            <details>
              <summary>Electrical properties</summary>
              <div className="material-fields">
                <label>
                  <span>Permittivity</span>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    placeholder={epsR.toFixed(2)}
                    value={o.permittivity ?? ""}
                    onChange={(e) => set(m, { permittivity: e.target.value })}
                  />
                </label>
                <label>
                  <span>Conductivity (S/m)</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder={
                      sigma < 1e3 ? sigma.toPrecision(3) : "very high"
                    }
                    value={o.conductivity ?? ""}
                    onChange={(e) => set(m, { conductivity: e.target.value })}
                  />
                </label>
              </div>
              <small className="hint">
                Entering both replaces the loss value above.
              </small>
            </details>
          </div>
        );
      })}
    </section>
  );
}
