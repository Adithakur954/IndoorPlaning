import React, { useState } from "react";
import { materialColors, materialLabels } from "../../config/materialColors.js";
import { bandLabel } from "./PredictionPanel.jsx";
import { INDOOR_LOG_KPIS } from "../../utils/indoorLogKpis.js";
import { openEndedBands } from "../../utils/logOverlay.js";

export const LEGEND_SECTIONS = [
  { id: "kpi", label: "KPI colour bands" },
  { id: "access", label: "Access points" },
  { id: "structure", label: "Building structure" },
  { id: "measured", label: "Measured log points" },
];
export const DEFAULT_LEGEND_SECTIONS = ["kpi"];

const PROVENANCE = {
  opt: "Heatmap: Sionna RT, optimisation run (screening used coarse ray tracing, ranking only)",
  rt: "Heatmap: Sionna RT prediction",
  none: "No prediction yet. Press Run prediction.",
};

// Legend in the top corner of the editor workspace: the colour bands, where each
// layer comes from (measured, approximate or ray traced) and the building and
// AP symbols.
export default function MapLegend({
  heatmap,
  predictionMetric,
  predictionRanges,
  hasBoundary,
  overlay,
  provenance = "none",
  hasLogs = false,
  sections = DEFAULT_LEGEND_SECTIONS,
  metric = "rsrp",
  setMetric,
  kpiOptions = INDOOR_LOG_KPIS,
  metricRanges = [],
  optimization,
}) {
  const [open, setOpen] = useState(true);
  const coverageView = predictionRanges.length === 2 && provenance === "opt";
  const show = (id) => sections.includes(id);
  // RSSI and RSRP (dBm) and SNR (dB) have a predicted heatmap; the others are log colours only
  const dbmKpi = metric === "rssi" || metric === "rsrp" || metric === "snr";
  const kpi = INDOOR_LOG_KPIS.find((k) => k.key === metric);
  const bands = openEndedBands(dbmKpi ? predictionRanges : metricRanges);
  if (!sections.length) return null;
  return (
    <div className="map-legend" aria-label="Legend">
      <button
        type="button"
        className="map-legend-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Legend <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="map-legend-body">
          {provenance === "opt" && optimization?.opt && (
            <section aria-label="Displayed optimisation band">
              <strong>Viewing: {optimization.opt.settingsUsed.band} GHz</strong>
              <small className="hint">{optimization.opt.profileUsed?.freqMHz} MHz</small>
              {metric === "snr" && !coverageView && !Object.values(optimization.opt.maps).every((m) => m.afterSnrDb) && (
                <small className="warn">SNR unavailable in this older result. Run optimisation again.</small>
              )}
            </section>
          )}
          {show("kpi") && (
            <section>
              <h4>{coverageView ? "Coverage at target" : "KPI"}</h4>
              {setMetric && !coverageView && (
                <select
                  className="map-legend-kpi"
                  aria-label="KPI shown in the legend"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                >
                  {kpiOptions.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                      {k.unit ? ` (${k.unit})` : ""}
                    </option>
                  ))}
                </select>
              )}
              {[...bands].reverse().map((band, i) => (
                <div key={`${band.color}-${i}`} className="map-legend-row">
                  <i style={{ background: band.color }} />
                  {coverageView
                    ? i === 0
                      ? "Covered"
                      : "Not covered"
                    : dbmKpi
                      ? bandLabel(band, metric === "snr" ? "dB" : "dBm")
                      : bandLabel(band, kpi?.unit)}
                </div>
              ))}
              {heatmap && (
                <small className="map-legend-note">
                  {dbmKpi || coverageView
                    ? PROVENANCE[provenance]
                    : `${kpi?.label || metric}: colours for measured logs. The predicted heatmap is only available for RSSI, RSRP and SNR.`}
                  {metric === "snr" && !coverageView && (
                    <> SNR = strongest AP's signal minus the channel's noise floor (no interference).</>
                  )}
                </small>
              )}
            </section>
          )}
          {show("measured") && hasLogs && (
            <section>
              <h4>Measured</h4>
              <div className="map-legend-row">
                <i className="dot ring" style={{ background: "#16a34a" }} />
                Log points (drive / walk test), coloured by the same bands
              </div>
            </section>
          )}
          {show("access") && (
          <section>
            <h4>Access points</h4>
            <div className="map-legend-row">
              <i className="dot" style={{ background: "#7c3aed" }} />
              Existing / manual AP
            </div>
            {overlay?.recommended?.length > 0 && (
              <div className="map-legend-row">
                <i
                  className="dot ring"
                  style={{ background: "#fff", borderColor: "#e8790a" }}
                />
                Recommended AP (proposed, numbered)
              </div>
            )}
            {overlay?.candidates && (
              <>
                <div className="map-legend-row">
                  <i
                    className="dot"
                    style={{ background: "#16a34a", width: 7, height: 7 }}
                  />
                  Valid mounting position
                </div>
                <div className="map-legend-row">
                  <i className="cross" />
                  Rejected position (reason on hover)
                </div>
              </>
            )}
            {overlay?.weakZones?.length > 0 && (
              <div className="map-legend-row">
                <i className="dash" />
                Largest uncovered zone
              </div>
            )}
          </section>
          )}
          {show("structure") && (
          <section>
            <h4>Building structure</h4>
            <div className="map-legend-row">
              <i className="line boundary" />
              Exterior walls: dark outline, core in the wall material
              {hasBoundary ? "" : " (draw with Boundary)"}
            </div>
            <small className="map-legend-note">
              Wall colour on the plan = its material
            </small>
            {Object.entries(materialLabels).map(([key, label]) => (
              <div key={key} className="map-legend-row">
                <i
                  className="line"
                  style={{ background: materialColors[key] }}
                />
                {label}
              </div>
            ))}
            <div className="map-legend-row">
              <i className="line" style={{ background: "#b45309" }} />
              Door
            </div>
            <div className="map-legend-row">
              <i className="line" style={{ background: "#0ea5e9" }} />
              Window
            </div>
          </section>
          )}
        </div>
      )}
    </div>
  );
}
