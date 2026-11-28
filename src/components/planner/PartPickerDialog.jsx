// "Select part" window of the DAS tools (splitter, coupler, combiner, riser,
// cable): the models on the left (import, manufacturer, search, list,
// description, a drawing), the chosen model's datasheet values on the right.
// OK uses that model; every value shown comes from the catalogue.
//
// Import reads a CSV or Excel file in one of two formats (see partImport.js):
// the parts table (all part types, sorted by its `type` column) or the cable
// table. The file's header says which, so any window can import either.
import React, { useEffect, useRef, useState } from "react";
import { DEFAULT_CATALOGUE } from "../../infra/cellular/engine/catalogue.js";
import { couplerTapLossDb, couplerThroughLossDb, lossAtFrequency, splitterLossDb } from "../../infra/cellular/engine/passive.js";
import { connectorOf, dasCatalogue } from "../../infra/cellular/das.js";
import { cellularOf } from "../../infra/cellular/model.js";
import {
  GROUP_OF,
  addImportedParts,
  cableTemplateCsv,
  parseCsv,
  partTemplateCsv,
  partsFromRows,
} from "../../infra/cellular/partImport.js";
import { downloadBlob } from "../../utils/sceneExport.js";

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const manufacturerOf = (part) => {
  if (part.manufacturer) return part.manufacturer;
  const m = /^(.+?) (CELLFLEX )?datasheet/i.exec(part.source || "") || /^([A-Z][\w.-]+) /.exec(part.model || "");
  if (/^Frog Cellsat/i.test(part.source || "")) return "Frog Cellsat";
  return m ? m[1].replace(/ [\w/"]+$/, "") : part.source?.startsWith("illustrative") ? "Generic (illustrative)" : "Built in";
};
const bandOf = (part) => {
  if (part.freqMinMHz && part.freqMaxMHz) return `${part.freqMinMHz} – ${part.freqMaxMHz} MHz`;
  if (part.lossDbPer100m?.length) {
    const f = part.lossDbPer100m.map((x) => x.freqMHz);
    return `${Math.min(...f)} – ${Math.max(...f)} MHz`;
  }
  const m = /(\d{3,4})\s*-\s*(\d{3,4})\s*MHz/.exec(part.source || "");
  return m ? `${m[1]} – ${m[2]} MHz` : null;
};
// ports a part has: inputs on the left, outputs on the right
const portsOf = (type, part) => {
  if (type === "splitter") return { ins: ["In"], outs: Array.from({ length: part.ways }, (_, i) => `Out ${i + 1}`) };
  if (type === "coupler") return { ins: ["In"], outs: ["Through", "Tap"] };
  if (type === "riser") return { ins: ["From floor"], outs: ["To floor"] };
  if (type === "cable") return { ins: ["End A"], outs: ["End B"] };
  const m = /(\d)x(\d)/.exec(part.name || "");
  const n = part.inputs || (m ? Number(m[1]) : 1),
    k = part.outputs || (m ? Number(m[2]) : 1);
  return {
    ins: Array.from({ length: n }, (_, i) => `In ${i + 1}`),
    outs: Array.from({ length: k }, (_, i) => (k > 1 ? `Out ${i + 1}` : "Out")),
  };
};

// tool -> what the window shows; `option`: the key in the DAS tool options
export const PART_TYPES = {
  splitter: { type: "splitter", label: "Splitter", option: "splitter" },
  coupler: { type: "coupler", label: "Coupler", option: "coupler" },
  combiner: { type: "combiner", label: "Combiner", option: "combiner", only: (p) => Boolean(p.model) || p.imported },
  riser: { type: "riser", label: "Shaft (riser)", option: "riser" },
  dascable: { type: "cable", label: "Cable", option: "cable" },
};
const AUTO_CABLE = {
  id: "auto",
  name: "Auto",
  model: "Auto",
  auto: true,
  description: '1/2" superflex on a floor; 7/8" low-loss feeder in the shaft (risers) and between floors.',
};
const BANDS_MHZ = [700, 900, 1800, 2100, 2600, 3500];

// the rows of the Properties table, in sections
function propertiesOf(type, part, carrierMHz) {
  if (part.auto)
    return [["Cable", [["Choice", "Per cable, by where it runs"], ["On a floor", DEFAULT_CATALOGUE.cables["1/2"].name], ["Shaft and between floors", DEFAULT_CATALOGUE.cables["7/8"].name]]]];
  const rf = [];
  if (type === "splitter") {
    rf.push(["Outputs", `${part.ways}`]);
    rf.push(["Loss per output", `${fmt(splitterLossDb(part))} dB`]);
    rf.push(["  of which the even split", `${fmt(10 * Math.log10(part.ways))} dB`]);
    rf.push(["  of which the part's own loss", `${fmt(part.excessLossDb)} dB`]);
  }
  if (type === "coupler") {
    rf.push(["Coupling (tap output)", `${fmt(couplerTapLossDb(part))} dB`]);
    rf.push(["Through output loss", `${fmt(couplerThroughLossDb(part))} dB`]);
  }
  if (type === "combiner" || type === "riser") rf.push(["Insertion loss", `${fmt(part.lossDb)} dB`]);
  if (type === "cable") {
    const bands = [...new Set([...(carrierMHz ? [carrierMHz] : []), ...BANDS_MHZ])].sort((a, b) => a - b);
    for (const f of bands) {
      let loss = null;
      try {
        loss = lossAtFrequency(part.lossDbPer100m, f);
      } catch {
        /* outside the datasheet */
      }
      rf.push([`Loss at ${f} MHz${f === carrierMHz ? " (band in Prediction)" : ""}`, loss == null ? "not in datasheet" : `${fmt(loss)} dB / 100 m`]);
    }
    rf.push(["Length", part.fixedLengthM ? `fixed, ${part.fixedLengthM} m` : "measured along the plan"]);
  }
  const band = bandOf(part);
  if (band) rf.push(["Frequency range", band]);
  const { ins, outs } = portsOf(type, part);
  const electrical = [
    ...(part.maxPowerW ? [["Maximum average power", `${part.maxPowerW} W`]] : []),
    ...(type === "cable"
      ? [["Connectors", `each end ${DEFAULT_CATALOGUE.connector.name}, ${DEFAULT_CATALOGUE.connector.lossDb} dB`]]
      : type === "riser" && !part.model
        ? []
        : [["Connectors", `${part.connector || connectorOf({ dasType: type })} (${ins.length + outs.length} ports)`]]),
  ];
  return [
    ["RF", rf],
    ...(electrical.length ? [["Electrical", electrical]] : []),
    [
      "General",
      [
        ["Model", part.model || "–"],
        ["Manufacturer", manufacturerOf(part)],
        ["Name", part.name],
        ["Values from", part.source || "–"],
      ],
    ],
  ];
}

function PartDrawing({ type, part }) {
  if (type === "cable")
    return (
      <svg className="part-drawing" viewBox="0 0 220 60" role="img" aria-label={`${part.name}: a cable with a connector at each end`}>
        <path d="M30 30 C 80 6, 140 54, 190 30" className="part-cable" />
        <rect x="18" y="24" width="14" height="12" rx="2" className="part-port" />
        <rect x="188" y="24" width="14" height="12" rx="2" className="part-port" />
        <text x="110" y="54" textAnchor="middle">{part.fixedLengthM ? `${part.fixedLengthM} m` : "length from the plan"}</text>
      </svg>
    );
  const { ins, outs } = portsOf(type, part);
  const rows = Math.max(ins.length, outs.length);
  const h = Math.max(70, rows * 22 + 20);
  const y = (i, n) => h / 2 + (i - (n - 1) / 2) * 22;
  const code =
    type === "splitter" ? `${part.ways}W` : type === "coupler" ? `${part.couplingDb} dB` : type === "riser" ? "R" : (part.name.match(/\dx\d/) || [""])[0];
  return (
    <svg className="part-drawing" viewBox={`0 0 220 ${h}`} role="img" aria-label={`${part.name}: ${ins.join(", ")} → ${outs.join(", ")}`}>
      <rect x="70" y="8" width="80" height={h - 16} rx="8" className="part-body" />
      <text x="110" y={h / 2 + 4} textAnchor="middle" className="part-code">{code}</text>
      {ins.map((p, i) => (
        <g key={p}>
          <line x1="34" x2="70" y1={y(i, ins.length)} y2={y(i, ins.length)} />
          <rect x="64" y={y(i, ins.length) - 4} width="8" height="8" className="part-port" />
          <text x="30" y={y(i, ins.length) + 4} textAnchor="end">{p}</text>
        </g>
      ))}
      {outs.map((p, i) => (
        <g key={p}>
          <line x1="150" x2="186" y1={y(i, outs.length)} y2={y(i, outs.length)} />
          <rect x="148" y={y(i, outs.length) - 4} width="8" height="8" className="part-port" />
          <text x="190" y={y(i, outs.length) + 4}>{p}</text>
        </g>
      ))}
    </svg>
  );
}

// rows of an Excel sheet (the first sheet), as text
async function excelRows(buffer) {
  const mod = await import("exceljs/dist/exceljs.min.js");
  const ExcelJS = mod.default || mod;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.worksheets[0];
  const rows = [];
  sheet?.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let i = 1; i <= row.cellCount; i++) {
      const v = row.getCell(i).value;
      cells.push(v == null ? "" : typeof v === "object" ? String(v.result ?? v.text ?? v.richText?.map((r) => r.text).join("") ?? "") : String(v));
    }
    rows.push(cells);
  });
  return rows;
}

const GROUP_LABEL = { splitters: "splitters", couplers: "couplers", inline: "combiners", risers: "risers", cables: "cables" };

// tool: splitter | coupler | combiner | riser | dascable
// value: the model chosen now; extras (cable): { connectors, extraM }
export default function PartPickerDialog({ tool, value, extras, plan, mutate, carrierMHz, onPick, onCancel }) {
  const info = PART_TYPES[tool];
  const type = info.type;
  const group = GROUP_OF[type];
  const catalogue = dasCatalogue(plan);
  const parts = [
    ...(type === "cable" ? [AUTO_CABLE] : []),
    ...Object.values(catalogue[group] || {}).filter((p) => !info.only || info.only(p)),
  ];
  const fileInput = useRef(null);
  const [report, setReport] = useState(null);
  const [maker, setMaker] = useState("all");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(parts.some((p) => p.id === value) ? value : parts[0]?.id);
  const [connectors, setConnectors] = useState(extras?.connectors ?? 2);
  const [extraM, setExtraM] = useState(extras?.extraM ?? 0);
  const makers = [...new Set(parts.filter((p) => !p.auto).map(manufacturerOf))];
  const shown = parts.filter(
    (p) =>
      (p.auto || maker === "all" || manufacturerOf(p) === maker) &&
      `${p.model || ""} ${p.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const part = parts.find((p) => p.id === chosen);
  const builtIn = (id) => Boolean(DEFAULT_CATALOGUE[group]?.[id]);
  const inUse = (id) =>
    type === "cable"
      ? cellularOf(plan).cables.some((c) => c.cableId === id)
      : (plan.sources || []).some((x) => x.kind === "das" && x.partId === id);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const importFile = async (file) => {
    if (!file) return;
    try {
      const rows = /\.xlsx$/i.test(file.name) ? await excelRows(await file.arrayBuffer()) : parseCsv(await file.text());
      const result = partsFromRows(rows, file.name, catalogue);
      if (result.count) {
        mutate((p) => ({ ...p, cellular: addImportedParts(cellularOf(p), result.parts) }));
        const mine = Object.values(result.parts[group] || {});
        if (mine.length) setChosen(mine[0].id);
      }
      const where = Object.entries(result.parts)
        .map(([g, list]) => [g, Object.keys(list).length])
        .filter(([, n]) => n)
        .map(([g, n]) => `${n} ${GROUP_LABEL[g]}`);
      setReport({ ...result, where, file: file.name });
    } catch (e) {
      setReport({ count: 0, where: [], errors: [`The file could not be read: ${e.message}`], file: file.name });
    }
  };
  const removeImported = (id) =>
    mutate((p) => {
      const c = cellularOf(p);
      const { [id]: _gone, ...rest } = c.catalogue[group] || {}; // eslint-disable-line no-unused-vars
      return { ...p, cellular: { ...c, catalogue: { ...c.catalogue, [group]: rest } } };
    });
  const pick = (id) => onPick(id, type === "cable" ? { connectors, extraM } : undefined);
  const ok = (e) => {
    e?.preventDefault();
    if (part) pick(part.id);
  };
  // arrow keys move through the list
  const step = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = shown.findIndex((p) => p.id === chosen);
    const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) setChosen(next.id);
  };
  const template = () =>
    type === "cable"
      ? downloadBlob(new Blob([cableTemplateCsv()], { type: "text/csv;charset=utf-8" }), "das-cables-template.csv")
      : downloadBlob(new Blob([partTemplateCsv()], { type: "text/csv;charset=utf-8" }), "das-parts-template.csv");

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog part-picker" role="dialog" aria-modal="true" aria-labelledby="part-picker-title" onSubmit={ok}>
        <header className="part-picker-head">
          <h2 id="part-picker-title">Select part · {info.label}</h2>
          <button type="button" className="part-picker-close" aria-label="Close" onClick={onCancel}>×</button>
        </header>
        <div className="part-picker-body">
          <section className="part-picker-left">
            <div className="pp-import">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                title="Add parts from a CSV or Excel file in a template's format (parts or cables): each row goes to its own list"
              >
                Import…
              </button>
              <button
                type="button"
                onClick={template}
                title={type === "cable" ? "Download the cable table: one row per cable, its loss per 100 m at each frequency" : "Download the parts table: splitters, couplers, combiners and risers, one row each, the type in the first column"}
              >
                {type === "cable" ? "Cable template" : "Parts template"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,text/csv"
                hidden
                onChange={(e) => {
                  importFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            {report && (
              <div className={`pp-report${report.errors.length ? " has-errors" : ""}`} role="status">
                <strong>
                  {report.count
                    ? `${report.file}: ${report.where.join(", ")}. ${report.added} new, ${report.updated} updated, ${report.unchanged} already the same.`
                    : `Nothing imported from ${report.file}.`}
                </strong>
                {report.errors.slice(0, 6).map((e) => (
                  <small key={e}>{e}</small>
                ))}
                {report.errors.length > 6 && <small>…and {report.errors.length - 6} more.</small>}
              </div>
            )}
            <label className="pp-field">
              <span>Manufacturer</span>
              <select value={maker} onChange={(e) => setMaker(e.target.value)}>
                <option value="all">All manufacturers</option>
                {makers.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="pp-field">
              <span>Search</span>
              <input type="search" placeholder="Model or name" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="pp-field">
              <span id="pp-models">Model ({shown.length})</span>
              <div className="pp-list" role="listbox" aria-labelledby="pp-models" tabIndex={0} onKeyDown={step}>
                {shown.map((p) => (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={p.id === chosen}
                    className={p.id === chosen ? "selected" : ""}
                    onClick={() => setChosen(p.id)}
                    onDoubleClick={() => pick(p.id)}
                  >
                    <strong>
                      {p.model || p.name}
                      {p.imported && <em className="pp-tag">Imported</em>}
                    </strong>
                    <small>{p.auto ? "chosen per cable" : p.name}</small>
                  </div>
                ))}
                {!shown.length && <p className="hint">No model matches.</p>}
              </div>
            </div>
            {part && (
              <>
                <div className="pp-field">
                  <span>Description</span>
                  <p className="pp-description">
                    {part.auto
                      ? part.description
                      : `${part.name}${type === "cable" || (type === "riser" && !part.model) ? "" : `, ${part.connector || connectorOf({ dasType: type })}`}${part.maxPowerW ? `, ${part.maxPowerW} W` : ""}`}
                  </p>
                </div>
                {!part.auto && (
                  <div className="pp-field">
                    <span>Picture</span>
                    <PartDrawing type={type} part={part} />
                  </div>
                )}
              </>
            )}
          </section>
          <section className="part-picker-right" aria-label="Properties">
            {part ? (
              <>
                <div className="pp-title">
                  <strong>{part.model || part.name}</strong>
                  <span>{part.auto ? "" : manufacturerOf(part)}</span>
                </div>
                {part.imported && (
                  <div className="pp-imported">
                    <span>{builtIn(part.id) ? "Built-in model, with imported values." : "Imported into this project."}</span>
                    <button
                      type="button"
                      disabled={!builtIn(part.id) && inUse(part.id)}
                      title={
                        builtIn(part.id)
                          ? "Go back to the built-in values of this model"
                          : inUse(part.id)
                            ? "In use on the plan: change or delete those first"
                            : "Remove this model from the project"
                      }
                      onClick={() => {
                        removeImported(part.id);
                        if (!builtIn(part.id)) setChosen(parts.find((p) => p.id !== part.id)?.id);
                      }}
                    >
                      {builtIn(part.id) ? "Use built-in values" : "Remove"}
                    </button>
                  </div>
                )}
                <table className="pp-props">
                  {propertiesOf(type, part, carrierMHz).map(([section, rows]) => (
                    <tbody key={section}>
                      <tr className="pp-section">
                        <th colSpan={2}>{section}</th>
                      </tr>
                      {rows.map(([k, v]) => (
                        <tr key={k}>
                          <td className={k.startsWith("  ") ? "pp-sub" : ""}>{k.trim()}</td>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                  {type === "cable" && (
                    <tbody>
                      <tr className="pp-section">
                        <th colSpan={2}>Each new cable</th>
                      </tr>
                      <tr>
                        <td>Connectors ({DEFAULT_CATALOGUE.connector.lossDb} dB each)</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="pp-input"
                            value={connectors}
                            onChange={(e) => setConnectors(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                          />
                        </td>
                      </tr>
                      <tr>
                        <td>Extra length (m)</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            className="pp-input"
                            value={extraM}
                            onChange={(e) => setExtraM(Math.max(0, Number(e.target.value) || 0))}
                          />
                        </td>
                      </tr>
                    </tbody>
                  )}
                </table>
              </>
            ) : (
              <p className="hint">Choose a model on the left.</p>
            )}
          </section>
        </div>
        <footer className="dialog-actions part-picker-foot">
          <small className="hint">
            {type === "cable"
              ? "Double-click a cable, or choose it and press OK, then draw the cables on the plan."
              : "Double-click a model, or choose it and press OK, then click on the plan to place it."}
          </small>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!part}>OK</button>
        </footer>
      </form>
    </div>
  );
}
