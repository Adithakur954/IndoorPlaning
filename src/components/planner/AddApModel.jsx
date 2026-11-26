import React, { useState } from "react";
import Field from "../ui/Field.jsx";
import { BANDS } from "../../config/apProfiles.js";
import {
  CHANNEL_WIDTHS,
  blankModel,
  blankRadio,
  csvTemplate,
  jsonTemplate,
  normalizeModel,
  parseModelFile,
  validateModel,
} from "../../config/apProfileImport.js";
import { downloadBlob } from "../../utils/sceneExport.js";

const download = (text, name, type) =>
  downloadBlob(new Blob([text], { type }), name);

// "Add new model" from the Model dropdown: type the datasheet values in, or
// import them from a JSON / CSV file.
export default function AddApModel({ onAdd, onCancel, existingNames = [] }) {
  const [mode, setMode] = useState("manual");
  return (
    <div className="add-ap-model">
      <div className="add-ap-model-head">
        <strong>Add a new AP model</strong>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="segmented" role="tablist" aria-label="How to add the model">
        {[
          ["manual", "Manual entry"],
          ["import", "Import from file"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={mode === id ? "active" : ""}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "manual" ? (
        <ManualEntry onAdd={onAdd} existingNames={existingNames} />
      ) : (
        <ImportFile onAdd={onAdd} existingNames={existingNames} />
      )}
    </div>
  );
}

function ManualEntry({ onAdd, existingNames }) {
  const [m, setM] = useState(blankModel);
  const [tried, setTried] = useState(false);
  const errors = validateModel(m);
  const set = (changes) => setM((x) => ({ ...x, ...changes }));
  const setRadio = (band, changes) =>
    setM((x) => ({
      ...x,
      bands: { ...x.bands, [band]: { ...x.bands[band], ...changes } },
    }));
  const toggleBand = (band) =>
    setM((x) => {
      const bands = { ...x.bands };
      if (bands[band]) delete bands[band];
      else bands[band] = blankRadio(band);
      return { ...x, bands };
    });
  const duplicate = existingNames.includes(m.name.trim());
  return (
    <form
      className="add-ap-model-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!errors.length) onAdd([normalizeModel(m)]);
      }}
    >
      <div className="inspector-fields">
        <Field label="Name" value={m.name} onChange={(v) => set({ name: v })} />
        <Field label="Model / part no." value={m.model} onChange={(v) => set({ model: v })} />
        <Field
          label="Antenna"
          value={m.antenna}
          options={["omni", "directional", "sector"]}
          onChange={(v) => set({ antenna: v })}
        />
      </div>
      <div className="segmented" role="group" aria-label="Radios">
        {BANDS.map((b) => (
          <button
            key={b}
            type="button"
            className={m.bands[b] ? "active" : ""}
            aria-pressed={Boolean(m.bands[b])}
            onClick={() => toggleBand(b)}
          >
            {m.bands[b] ? "✓ " : "+ "}
            {b} GHz
          </button>
        ))}
      </div>
      {BANDS.filter((b) => m.bands[b]).map((b) => (
        <fieldset key={b} className="add-ap-band">
          <legend>{b} GHz radio</legend>
          <div className="add-ap-band-grid">
            <Field
              label="Tx power (dBm)"
              type="number"
              value={m.bands[b].txPowerDbm}
              onChange={(v) => setRadio(b, { txPowerDbm: v })}
            />
            <Field
              label="Max Tx (dBm, optional)"
              type="number"
              value={m.bands[b].maxTxPowerDbm ?? ""}
              onChange={(v) => setRadio(b, { maxTxPowerDbm: v })}
            />
            <Field
              label="Antenna gain (dBi)"
              type="number"
              value={m.bands[b].gainDbi}
              onChange={(v) => setRadio(b, { gainDbi: v })}
            />
            <Field
              label="Channel"
              type="number"
              step="1"
              value={m.bands[b].channel}
              onChange={(v) => setRadio(b, { channel: v })}
            />
            <Field
              label="Width (MHz)"
              value={String(m.bands[b].widthMHz)}
              options={CHANNEL_WIDTHS.map(String)}
              onChange={(v) => setRadio(b, { widthMHz: Number(v) })}
            />
          </div>
        </fieldset>
      ))}
      <Field label="Note (optional)" value={m.note} onChange={(v) => set({ note: v })} />
      {duplicate && (
        <small className="warn">A model with this name already exists; both will be kept.</small>
      )}
      {tried &&
        errors.map((e) => (
          <small key={e} className="warn">
            ⚠ {e}
          </small>
        ))}
      <div className="button-row">
        <button type="submit" className="primary">
          Add model
        </button>
      </div>
    </form>
  );
}

function ImportFile({ onAdd, existingNames }) {
  const [result, setResult] = useState(null);
  const read = async (file) => {
    if (!file) return;
    const text = await file.text();
    setResult({ fileName: file.name, ...parseModelFile(text, file.name) });
  };
  const good = result?.models.filter((m) => m.model) || [];
  return (
    <div className="add-ap-model-form">
      <p className="hint add-ap-hint">
        <b>JSON</b>: one model or a list, each with <code>name</code>, <code>model</code>,{" "}
        <code>antenna</code> and <code>bands</code> (2.4 / 5 / 6, each with{" "}
        <code>txPowerDbm</code>, <code>maxTxPowerDbm</code>, <code>gainDbi</code>,{" "}
        <code>channel</code>, <code>widthMHz</code>).
        <br />
        <b>CSV</b>: one row per model and band with the columns{" "}
        <code>name, model, antenna, note, band, txPowerDbm, maxTxPowerDbm, gainDbi, channel, widthMHz</code>
        . Rows with the same name make one model.
      </p>
      <div className="button-row">
        <button
          type="button"
          onClick={() => download(jsonTemplate(), "ap-model-template.json", "application/json")}
        >
          JSON template
        </button>
        <button
          type="button"
          onClick={() => download(csvTemplate(), "ap-model-template.csv", "text/csv")}
        >
          CSV template
        </button>
      </div>
      <label className="field">
        <span>Model file (.json or .csv)</span>
        <input
          type="file"
          accept=".json,.csv,.txt,application/json,text/csv"
          onChange={(e) => {
            read(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {result?.error && (
        <small className="warn">
          ⚠ Could not read {result.fileName}: {result.error}
        </small>
      )}
      {result && !result.error && (
        <ul className="add-ap-preview">
          {result.models.map((m, i) => (
            <li key={i} className={m.model ? "ok" : "bad"}>
              <strong>{m.raw.name || `Model ${i + 1}`}</strong>
              {m.model ? (
                <span>
                  {" "}
                  · {Object.keys(m.model.bands).map((b) => `${b} GHz`).join(", ")}
                  {existingNames.includes(m.model.name) ? " · name already exists" : ""}
                </span>
              ) : (
                m.errors.map((e) => (
                  <small key={e} className="warn">
                    ⚠ {e}
                  </small>
                ))
              )}
            </li>
          ))}
          {!result.models.length && <li className="bad">No models found in the file.</li>}
        </ul>
      )}
      {result && !result.error && result.models.length > 0 && (
        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={!good.length}
            onClick={() => onAdd(good.map((m) => m.model))}
          >
            {good.length === result.models.length
              ? `Add ${good.length} model${good.length === 1 ? "" : "s"}`
              : `Add the ${good.length} valid of ${result.models.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
