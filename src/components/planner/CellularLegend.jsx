// Legend of the cellular map (RSRP or SINR of the best cell). Separate from the
// Wi-Fi legend so neither changes the other.
import React, { useState } from "react";
import { carrierLabel } from "../../infra/cellular/bands.js";

const label = (band, unit) =>
  !Number.isFinite(band.min)
    ? `< ${band.max} ${unit}`
    : !Number.isFinite(band.max)
      ? `≥ ${band.min} ${unit}`
      : `${band.min} to ${band.max} ${unit}`;

// Vertical colour bar of the smooth map, highest value on top, with a tick and
// "> edge (share above it)" at every band edge, as the design tool's legend.
function GradientBar({ ranges, share }) {
  const stops = ranges
    .filter((b) => Number.isFinite(b.min))
    .map((b) => ({ value: b.min, color: b.color }))
    .sort((a, b) => a.value - b.value);
  if (stops.length < 2) return null;
  const lo = stops[0].value,
    hi = stops[stops.length - 1].value;
  const at = (v) => (100 * (v - lo)) / (hi - lo || 1);
  const gradient = `linear-gradient(to top, ${stops.map((s) => `${s.color} ${at(s.value).toFixed(2)}%`).join(", ")})`;
  return (
    <div className="map-legend-gradient">
      <div className="map-legend-gradient-bar" style={{ background: gradient }} />
      <div className="map-legend-gradient-ticks">
        {stops.map((s) => (
          <span key={s.value} style={{ bottom: `${at(s.value)}%` }}>
            &gt;{s.value.toFixed(2)}
            {share(s.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CellularLegend({ cellular, floorId }) {
  const [open, setOpen] = useState(true);
  if (!cellular?.hasResult || !cellular.show) return null;
  const unit = cellular.metric === "sinr" ? "dB" : "dBm";
  const carrier = cellular.carriers.find((c) => c.id === cellular.carrierId);
  // as the design legend: the share of the floor at or above each band, and the average
  const values = floorId ? cellular.cellsFor(floorId).map((c) => c.dbm) : [];
  const share = (min) =>
    values.length && Number.isFinite(min) ? ` (${((100 * values.filter((v) => v >= min).length) / values.length).toFixed(1)}%)` : "";
  // Bar (smooth) or Ranges: chosen in Settings
  const smooth = cellular.mapStyle !== "bands";
  // mean of the values in dBm (dB), as the design tool's legend gives it
  const average = values.length ? values.reduce((a, v) => a + v, 0) / values.length : null;
  return (
    <div className="map-legend" aria-label="Cellular legend">
      <button type="button" className="map-legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Legend <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="map-legend-body">
          <section>
            <h4>KPI</h4>
            {/* one run gives both maps: the KPI only chooses which one is shown, as in Wi-Fi */}
            <select
              className="map-legend-kpi"
              aria-label="KPI shown on the map"
              value={cellular.metric}
              onChange={(e) => cellular.setMetric(e.target.value)}
            >
              <option value="rsrp">RSRP (dBm), best cell</option>
              <option value="sinr">SINR (dB), best cell</option>
            </select>
            {carrier && (
              <small className="hint">
                {carrierLabel(carrier)}
              </small>
            )}
            <small className="hint">{cellular.metric === "sinr" ? "SINR" : "RSRP"} (best path) [{unit}]</small>
            {smooth ? (
              <GradientBar ranges={cellular.ranges} share={share} />
            ) : (
              [...cellular.ranges].reverse().map((band, i) => (
                <div key={`${band.color}-${i}`} className="map-legend-row">
                  <i style={{ background: band.color }} />
                  {label(band, unit)}
                  {share(band.min)}
                </div>
              ))
            )}
            {average !== null && (
              <small className="hint">
                Average: {average.toFixed(2)} {unit}
              </small>
            )}
            <small className="map-legend-note">
              Cellular prediction (Sionna RT). Target: {cellular.threshold} {unit}.
              {cellular.stale ? " Out of date: run it again." : ""}
            </small>
          </section>
        </div>
      )}
    </div>
  );
}
