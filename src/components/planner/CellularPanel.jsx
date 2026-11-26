// Cellular (IBS/DAS) panel of the editor: carriers, sectors, antenna models,
// the selected antenna and the RSRP / SINR prediction. Everything here edits
// plan.cellular and the cellular antennas only; Wi-Fi APs, the Wi-Fi prediction
// and the optimiser are never touched.
import React, { useRef, useState } from "react";
import Field from "../ui/Field.jsx";
import { timeLabel } from "../../utils/savedResults.js";
import {
  BANDS,
  TECHNOLOGIES,
  bandCentreMHz,
  bandwidthsFor,
  carrierLabel,
  carrierProblems,
  subcarrierSpacingsFor,
} from "../../infra/cellular/bands.js";
import { bandEntry, bandProblems, patternFileFor } from "../../infra/cellular/antennaPattern.js";
import { parseCatalogue, withPatternFile } from "../../infra/cellular/catalogueImport.js";
import {
  antennaModels,
  cellularAntennas,
  cellularOf,
  newCarrier,
  newSector,
} from "../../infra/cellular/model.js";

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");

// Up to four colour-band edges typed as "-105, -95, -85, -75"; applied when the box loses focus.
function EdgesField({ label, edges, onChange }) {
  const [text, setText] = useState(null);
  const apply = () => {
    const next = String(text ?? "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (text !== null && next.length >= 1 && next.length <= 4 && next.every(Number.isFinite))
      onChange([...next].sort((a, b) => a - b));
    setText(null);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={text ?? edges.join(", ")}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  );
}

// parts "editor": the prediction and the selected antenna (Editor > Cellular);
// parts "network": carriers, sectors, antenna models and settings (Network & RF),
// as Wi-Fi keeps its AP profile in Network & RF and its prediction in the editor.
export default function CellularPanel({ plan, mutate, cellular, floorId, selectedSource, setTool, setTab, parts = "editor" }) {
  const editor = parts === "editor";
  const network = parts === "network";
  const c = cellularOf(plan);
  const models = antennaModels(plan);
  const carrier = c.carriers.find((x) => x.id === cellular.carrierId) || null;
  const [catalogueNote, setCatalogueNote] = useState(null);
  const catalogueInput = useRef(null);
  const patternInput = useRef(null);
  const [patternTarget, setPatternTarget] = useState(null);

  const setCellular = (fn) =>
    mutate((p) => {
      const cur = cellularOf(p);
      return { ...p, cellular: fn(cur) };
    });
  const patchCarrier = (id, patch) =>
    setCellular((cur) => ({ ...cur, carriers: cur.carriers.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const patchSettings = (patch) => setCellular((cur) => ({ ...cur, settings: { ...cur.settings, ...patch } }));
  const patchAntenna = (patch) =>
    mutate((p) => ({ ...p, sources: p.sources.map((s) => (s.id === selectedSource.id ? { ...s, ...patch } : s)) }));

  if (cellular.licensed === false)
    return (
      <div className="inspector-fields">
        <p className="hint">
          The cellular (IBS/DAS) module is not included in your license. Wi-Fi planning is not affected.
        </p>
      </div>
    );

  const antennasHere = cellularAntennas(plan, floorId);
  const allAntennas = cellularAntennas(plan);
  const selected = selectedSource?.kind === "cellular" ? selectedSource : null;
  const selectedModel = selected ? models[selected.antennaModelId] : null;
  const stats = cellular.hasResult ? cellular.statsFor(floorId) : null;
  const unit = cellular.metric === "sinr" ? "dB" : "dBm";

  const addCatalogue = (text, name) => {
    const { antennas, errors } = parseCatalogue(text);
    if (errors.length) {
      setCatalogueNote({ error: `${name} was not imported: ${errors.slice(0, 4).join("; ")}` });
      return;
    }
    setCellular((cur) => ({ ...cur, catalogue: { antennas: { ...cur.catalogue.antennas, ...antennas } } }));
    setCatalogueNote({ ok: `${Object.keys(antennas).length} antenna models imported from ${name}.` });
  };
  const importCatalogue = async (file) => addCatalogue(await file.text(), file.name);
  const toNetwork = setTab && (
    <button type="button" className="link-button" onClick={() => setTab("network")}>
      Network &amp; RF
    </button>
  );
  const attachPattern = async (file) => {
    const id = patternTarget;
    if (!id) return;
    try {
      const entry = withPatternFile(models[id], await file.text(), file.name);
      setCellular((cur) => ({ ...cur, catalogue: { antennas: { ...cur.catalogue.antennas, [id]: entry } } }));
      setCatalogueNote({ ok: `${file.name} attached to ${entry.name}.` });
    } catch (e) {
      setCatalogueNote({ error: e.message });
    }
  };

  return (
    <div className="cellular-panel">
      {editor && (<>
      {/* ---------- prediction ---------- */}
      <section className="inspector-section">
        <h4>Prediction</h4>
        {!c.carriers.length ? (
          <p className="hint">
            Add a carrier (operator, band, frequency and bandwidth) in {toNetwork || "Network & RF"} to run a prediction.
          </p>
        ) : (
          <div className="inspector-fields">
            <Field
              label="Carrier"
              value={cellular.carrierId || ""}
              options={c.carriers.map((x) => x.id)}
              optionLabels={Object.fromEntries(c.carriers.map((x) => [x.id, carrierLabel(x)]))}
              onChange={cellular.setCarrierId}
            />
            <Field
              label="Map"
              value={cellular.metric}
              options={["rsrp", "sinr"]}
              optionLabels={{ rsrp: "RSRP (dBm)", sinr: "SINR (dB)" }}
              onChange={cellular.setMetric}
            />
          </div>
        )}
        {cellular.problems.length > 0 && (
          <ul className="warn-list">
            {cellular.problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <label className="check">
          <input type="checkbox" checked={cellular.fresh} onChange={(e) => cellular.setFresh(e.target.checked)} />
          Run again even if a saved result exists
        </label>
        <button
          className="primary"
          type="button"
          onClick={cellular.runPrediction}
          disabled={cellular.busy || !carrier || cellular.problems.length > 0}
        >
          {cellular.busy ? `${cellular.run.phase}…` : "Run cellular prediction"}
        </button>
        {cellular.run?.error && <p className="error">{cellular.run.error}</p>}
        {cellular.note && <p className="warn">{cellular.note}</p>}
        {cellular.run?.notes?.map((n) => (
          <p className="hint" key={n}>
            {n}
          </p>
        ))}
        {cellular.hasResult && (
          <>
            <div className="button-row">
              <button type="button" onClick={() => cellular.setShow(!cellular.show)}>
                {cellular.show ? "Hide map" : "Show map"}
              </button>
              <button type="button" onClick={cellular.deleteResults} title="Forget every cellular result of this project">
                Clear results
              </button>
            </div>
            {cellular.stale && (
              <p className="warn">The plan or the antennas changed since this run: the map is out of date. Run it again.</p>
            )}
            <p className="hint">
              {carrier ? carrierLabel(carrier) : ""} · run {timeLabel(cellular.finishedAt)}
              {cellular.result?.backend?.device ? ` · ${cellular.result.backend.device.toUpperCase()}` : ""}
            </p>
            {stats ? (
              <table className="mini-table">
                <tbody>
                  <tr>
                    <th>This floor</th>
                    <td>{stats.cells} cells</td>
                  </tr>
                  <tr>
                    <th>
                      At or above {cellular.threshold} {unit}
                    </th>
                    <td>{fmt(stats.coveredPct)} %</td>
                  </tr>
                  <tr>
                    <th>Median</th>
                    <td>
                      {fmt(stats.median)} {unit}
                    </td>
                  </tr>
                  <tr>
                    <th>Lowest / highest</th>
                    <td>
                      {fmt(stats.min)} / {fmt(stats.max)} {unit}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="hint">No result for this floor (no rooms, or the floor was not in the run).</p>
            )}
            <details>
              <summary>How it is calculated</summary>
              <ul className="hint">
                {(cellular.result?.assumptions || []).map((a) => (
                  <li key={a}>{a}</li>
                ))}
                {Object.values(cellular.result?.patterns || {}).map((p) => (
                  <li key={`${p.model}${p.source}`}>
                    {p.model}: {p.source}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      {/* ---------- antennas ---------- */}
      <section className="inspector-section">
        <h4>Antennas</h4>
        <p className="hint">
          {antennasHere.length} on this floor, {allAntennas.length} in the building.
        </p>
        <button type="button" onClick={() => setTool("cellular")}>
          Place antenna
        </button>
        {selected ? (
          <div className="inspector-fields">
            <Field label="Name" value={selected.name} onChange={(v) => patchAntenna({ name: v })} />
            <Field
              label="Antenna model"
              value={selected.antennaModelId || ""}
              options={Object.keys(models)}
              optionLabels={Object.fromEntries(Object.values(models).map((m) => [m.id, m.name]))}
              onChange={(v) => patchAntenna({ antennaModelId: v })}
            />
            <Field
              label="Sector"
              value={selected.sectorId || c.sectors[0].id}
              options={c.sectors.map((s) => s.id)}
              optionLabels={Object.fromEntries(c.sectors.map((s) => [s.id, s.name]))}
              onChange={(v) => patchAntenna({ sectorId: v })}
            />
            <Field
              label="Power at the antenna port (dBm)"
              type="number"
              value={selected.inputPowerDbm ?? ""}
              onChange={(v) => patchAntenna({ inputPowerDbm: Number(v) })}
            />
            <Field
              label="Mounting height (m)"
              type="number"
              value={selected.heightM ?? ""}
              onChange={(v) => patchAntenna({ heightM: Number(v) })}
            />
            {selectedModel?.type !== "omni" && (
              <Field
                label="Mounting"
                value={selected.mount || "wall"}
                options={["wall", "ceiling"]}
                optionLabels={{ wall: "Wall (faces the azimuth)", ceiling: "Ceiling (faces down)" }}
                onChange={(v) => patchAntenna({ mount: v })}
              />
            )}
            {selectedModel?.type !== "omni" && (selected.mount || "wall") === "wall" && (
              <Field
                label="Azimuth (deg)"
                type="number"
                value={selected.azimuthDeg ?? 0}
                onChange={(v) => patchAntenna({ azimuthDeg: Number(v) })}
              />
            )}
            <Field
              label="Downtilt (deg)"
              type="number"
              value={selected.downtiltDeg ?? 0}
              onChange={(v) => patchAntenna({ downtiltDeg: Number(v) })}
            />
            {carrier && selectedModel && (
              <p className={bandProblems(selectedModel, carrier.freqMHz).length ? "warn" : "hint"}>
                {bandProblems(selectedModel, carrier.freqMHz)[0] ||
                  (patternFileFor(selectedModel, carrier.freqMHz)
                    ? `At ${carrier.freqMHz} MHz: measured pattern ${patternFileFor(selectedModel, carrier.freqMHz).file}.`
                    : `At ${carrier.freqMHz} MHz: ${bandEntry(selectedModel, carrier.freqMHz).gainDbi} dBi from the datasheet; EIRP ${fmt(
                        Number(selected.inputPowerDbm) + bandEntry(selectedModel, carrier.freqMHz).gainDbi,
                      )} dBm.`)}
              </p>
            )}
          </div>
        ) : (
          <p className="hint">Select an antenna on the plan to edit it.</p>
        )}
      </section>
      <p className="hint">Carriers, sectors, antenna models and prediction settings: {toNetwork || "Network & RF"}.</p>
      </>)}
      {network && (<>

      {/* ---------- carriers ---------- */}
      <section className="inspector-section">
        <h4>Carriers</h4>
        <p className="hint">One per operator and band. Each sector sends it as its own cell.</p>
        {c.carriers.map((x) => {
          const problems = carrierProblems(x);
          const bands = Object.keys(BANDS[x.technology] || {});
          return (
            <details key={x.id} open={x.id === cellular.carrierId}>
              <summary>{carrierLabel(x)}</summary>
              <div className="inspector-fields">
                <Field label="Operator" value={x.operator || ""} onChange={(v) => patchCarrier(x.id, { operator: v })} />
                <Field label="Name" value={x.name || ""} onChange={(v) => patchCarrier(x.id, { name: v })} />
                <Field
                  label="Technology"
                  value={x.technology}
                  options={TECHNOLOGIES}
                  onChange={(v) => {
                    const band = Object.keys(BANDS[v])[0];
                    patchCarrier(x.id, {
                      technology: v,
                      band,
                      freqMHz: bandCentreMHz(v, band),
                      scsKHz: v === "LTE" ? 15 : 30,
                      bandwidthMHz: 20,
                    });
                  }}
                />
                <Field
                  label="Band"
                  value={x.band || ""}
                  options={bands}
                  optionLabels={Object.fromEntries(bands.map((b) => [b, `${b} (${BANDS[x.technology][b].name})`]))}
                  onChange={(v) => patchCarrier(x.id, { band: v, freqMHz: bandCentreMHz(x.technology, v) })}
                />
                <Field
                  label="Downlink frequency (MHz)"
                  type="number"
                  value={x.freqMHz}
                  onChange={(v) => patchCarrier(x.id, { freqMHz: Number(v) })}
                />
                {x.technology === "NR" && (
                  <Field
                    label="Subcarrier spacing (kHz)"
                    value={String(x.scsKHz || 30)}
                    options={subcarrierSpacingsFor("NR").map(String)}
                    onChange={(v) => patchCarrier(x.id, { scsKHz: Number(v) })}
                  />
                )}
                <Field
                  label="Bandwidth (MHz)"
                  value={String(x.bandwidthMHz)}
                  options={bandwidthsFor(x.technology, x.scsKHz || 30).map(String)}
                  onChange={(v) => patchCarrier(x.id, { bandwidthMHz: Number(v) })}
                />
              </div>
              {c.sectors.length > 1 && (
                <fieldset className="checks">
                  <legend>Sent by</legend>
                  {c.sectors.map((s) => {
                    const on = !Array.isArray(x.sectorIds) || x.sectorIds.includes(s.id);
                    return (
                      <label key={s.id} className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const now = Array.isArray(x.sectorIds) ? x.sectorIds : c.sectors.map((y) => y.id);
                            const next = e.target.checked ? [...now, s.id] : now.filter((id) => id !== s.id);
                            patchCarrier(x.id, { sectorIds: next.length === c.sectors.length ? null : next });
                          }}
                        />
                        {s.name}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {problems.length > 0 && <p className="warn">{problems.join(" ")}</p>}
              <button
                type="button"
                className="danger"
                onClick={() => setCellular((cur) => ({ ...cur, carriers: cur.carriers.filter((y) => y.id !== x.id) }))}
              >
                Remove carrier
              </button>
            </details>
          );
        })}
        <div className="button-row">
          <button type="button" onClick={() => setCellular((cur) => ({ ...cur, carriers: [...cur.carriers, newCarrier("LTE", "B3")] }))}>
            Add LTE carrier
          </button>
          <button type="button" onClick={() => setCellular((cur) => ({ ...cur, carriers: [...cur.carriers, newCarrier("NR", "n78")] }))}>
            Add NR carrier
          </button>
        </div>
      </section>

      {/* ---------- sectors ---------- */}
      <section className="inspector-section">
        <h4>Sectors</h4>
        {c.sectors.map((s) => (
          <div className="inline-row" key={s.id}>
            <Field
              label={`${allAntennas.filter((a) => (a.sectorId || c.sectors[0].id) === s.id).length} antennas`}
              value={s.name}
              onChange={(v) =>
                setCellular((cur) => ({ ...cur, sectors: cur.sectors.map((y) => (y.id === s.id ? { ...y, name: v } : y)) }))
              }
            />
            {c.sectors.length > 1 && (
              <button
                type="button"
                className="danger"
                title="Remove; its antennas move to the first remaining sector"
                onClick={() =>
                  mutate((p) => {
                    const cur = cellularOf(p);
                    const left = cur.sectors.filter((y) => y.id !== s.id);
                    return {
                      ...p,
                      cellular: {
                        ...cur,
                        sectors: left,
                        carriers: cur.carriers.map((x) =>
                          Array.isArray(x.sectorIds) ? { ...x, sectorIds: x.sectorIds.filter((id) => id !== s.id) } : x,
                        ),
                      },
                      sources: p.sources.map((a) =>
                        a.kind === "cellular" && a.sectorId === s.id ? { ...a, sectorId: left[0].id } : a,
                      ),
                    };
                  })
                }
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setCellular((cur) => ({ ...cur, sectors: [...cur.sectors, newSector(cur.sectors)] }))}>
          Add sector
        </button>
      </section>

      {/* ---------- antenna models ---------- */}
      <section className="inspector-section">
        <h4>Antenna models</h4>
        <p className="hint">
          Built in from the supplied datasheets: one pattern per antenna, with a row for each band (700/900, 1800-2600
          incl. 2300, 3500 MHz). The prediction uses the row of the carrier's frequency. A measured pattern file (.msi)
          can be attached to a model and wins near its frequency.
        </p>
        <input
          ref={catalogueInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) importCatalogue(e.target.files[0]);
            e.target.value = "";
          }}
        />
        <input
          ref={patternInput}
          type="file"
          accept=".msi,.txt,.pln"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) attachPattern(e.target.files[0]);
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => catalogueInput.current?.click()}>
          Import another vendor's catalogue…
        </button>
        {catalogueNote?.error && <p className="error">{catalogueNote.error}</p>}
        {catalogueNote?.ok && <p className="hint">{catalogueNote.ok}</p>}
        {Object.values(models).map((m) => {
          const imported = Boolean(c.catalogue.antennas[m.id]);
          return (
            <details key={m.id}>
              <summary>
                {m.name} {imported ? "(imported)" : m.builtIn ? "" : "(generic placeholder)"}
              </summary>
              <p className="hint">
                {m.type}
                {m.vendor ? ` · ${m.vendor}` : ""}
                {m.model ? ` ${m.model}` : ""} · {m.source}
              </p>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>MHz</th>
                    <th>dBi</th>
                    <th>H°</th>
                    <th>V°</th>
                    <th>F/B</th>
                  </tr>
                </thead>
                <tbody>
                  {(m.bands || []).map((b) => (
                    <tr key={`${b.fromMHz}-${b.toMHz}`}>
                      <td>
                        {b.fromMHz}-{b.toMHz}
                      </td>
                      <td>{b.gainDbi}</td>
                      <td>{b.hBeamwidthDeg}</td>
                      <td>{b.vBeamwidthDeg}</td>
                      <td>{b.frontToBackDb ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(m.patternFiles || []).length > 0 && (
                <p className="hint">Pattern files: {m.patternFiles.map((p) => `${p.file} (${p.freqMHz} MHz)`).join(", ")}</p>
              )}
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => {
                    setPatternTarget(m.id);
                    patternInput.current?.click();
                  }}
                >
                  Attach pattern file…
                </button>
                {!builtIn && (
                  <button
                    type="button"
                    className="danger"
                    disabled={allAntennas.some((a) => a.antennaModelId === m.id)}
                    title={allAntennas.some((a) => a.antennaModelId === m.id) ? "Antennas use this model" : "Remove from the project"}
                    onClick={() =>
                      setCellular((cur) => {
                        const { [m.id]: _gone, ...rest } = cur.catalogue.antennas; // eslint-disable-line no-unused-vars
                        return { ...cur, catalogue: { antennas: rest } };
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            </details>
          );
        })}
      </section>

      {/* ---------- settings ---------- */}
      <details className="inspector-section">
        <summary>Prediction settings</summary>
        <div className="inspector-fields">
          {[
            ["resolutionM", "Grid step (m)"],
            ["receiverHeightM", "Handset height (m)"],
            ["maxDepth", "Ray depth"],
            ["samplesPerTx", "Rays per antenna"],
            ["ueNoiseFigureDb", "Handset noise figure (dB)"],
            ["rsrpTargetDbm", "RSRP target (dBm)"],
            ["sinrTargetDb", "SINR target (dB)"],
            ["defaultAntennaPowerDbm", "New antenna port power (dBm)"],
          ].map(([key, label]) => (
            <Field key={key} label={label} type="number" value={c.settings[key]} onChange={(v) => patchSettings({ [key]: Number(v) })} />
          ))}
          <EdgesField
            label="RSRP colour edges (dBm, low to high)"
            edges={c.settings.rsrpEdgesDbm}
            onChange={(edges) => patchSettings({ rsrpEdgesDbm: edges })}
          />
          <EdgesField
            label="SINR colour edges (dB, low to high)"
            edges={c.settings.sinrEdgesDb}
            onChange={(edges) => patchSettings({ sinrEdgesDb: edges })}
          />
          <label className="check">
            <input type="checkbox" checked={c.settings.diffraction} onChange={(e) => patchSettings({ diffraction: e.target.checked })} />
            Diffraction (slower)
          </label>
          <Field
            label="New antenna height (m)"
            type="number"
            value={plan.rf?.newCellHeightM ?? 3}
            onChange={(v) => mutate((p) => ({ ...p, rf: { ...p.rf, newCellHeightM: Number(v) } }))}
          />
        </div>
      </details>
      </>)}
    </div>
  );
}
