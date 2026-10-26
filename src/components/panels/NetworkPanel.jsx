import React from "react";
import Field from "../ui/Field.jsx";

export default function NetworkPanel({
  plan,
  mutate,
  heatmap,
  setHeatmap,
  predictions,
  coverage,
  coveredArea,
  totalArea,
  sources,
  setTab,
  setSelected,
}) {
  return (
    <div className="panel-grid">
      <section className="panel">
        <h2>RF prediction</h2>
        <p>
          Free-space path loss with directional antenna attenuation and material
          or door penetration loss. Values are estimates for planning.
        </p>
        <div className="form-grid">
          {[
            ["gridStepM", "Grid step (m)"],
            ["thresholdDbm", "Covered threshold (dBm)"],
            ["rxGainDbi", "Receiver gain (dBi)"],
            ["wallLossDb", "Other wall loss (dB)"],
            ["doorLossDb", "Door loss (dB)"],
          ].map(([k, label]) => (
            <Field
              key={k}
              label={label}
              type="number"
              value={plan.rf[k]}
              onChange={(v) =>
                mutate((p) => ({ ...p, rf: { ...p.rf, [k]: v } }))
              }
            />
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={heatmap}
            onChange={(e) => setHeatmap(e.target.checked)}
          />{" "}
          Show prediction heatmap
        </label>
        <div className="stat-row">
          <div>
            <strong>{predictions.length}</strong>
            <small>Sample cells</small>
          </div>
          <div>
            <strong>{coverage}%</strong>
            <small>Covered cells</small>
          </div>
          <div>
            <strong>{coveredArea.toFixed(1)} m²</strong>
            <small>Estimated covered area</small>
          </div>
          <div>
            <strong>
              {Math.max(0, totalArea - coveredArea).toFixed(1)} m²
            </strong>
            <small>Estimated uncovered area</small>
          </div>
        </div>
        <div className="legend">
          {[
            ["#2563eb", "Strong"],
            ["#16a34a", "Good"],
            ["#eab308", "Fair"],
            ["#f97316", "Edge"],
            ["#dc2626", "Uncovered"],
          ].map(([c, n]) => (
            <span key={n}>
              <i style={{ background: c }} />
              {n}
            </span>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Network sources</h2>
        <p>
          Use the Cellular or Wi-Fi tool in the editor to place a source. Select
          it to configure power, frequency, gain, pattern, sectors, azimuth and
          mounting height.
        </p>
        {sources.length ? (
          sources.map((s) => (
            <button
              key={s.id}
              className="source-list-item"
              onClick={() => {
                setTab("design");
                setSelected({ type: "source", id: s.id });
              }}
            >
              <span className={s.kind === "wifi" ? "wifi-dot" : "cell-dot"} />
              <strong>{s.name}</strong>
              <small>
                {s.freqMHz} MHz · {s.txPowerDbm} dBm
              </small>
              →
            </button>
          ))
        ) : (
          <div className="empty small">No sources on this floor.</div>
        )}
      </section>
    </div>
  );
}
