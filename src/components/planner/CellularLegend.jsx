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

export default function CellularLegend({ cellular }) {
  const [open, setOpen] = useState(true);
  if (!cellular?.hasResult || !cellular.show) return null;
  const unit = cellular.metric === "sinr" ? "dB" : "dBm";
  const carrier = cellular.carriers.find((c) => c.id === cellular.carrierId);
  return (
    <div className="map-legend" aria-label="Cellular legend">
      <button type="button" className="map-legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Legend <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="map-legend-body">
          <section>
            <h4>{cellular.metric === "sinr" ? "SINR (best cell)" : "RSRP (best cell)"}</h4>
            {carrier && (
              <small className="hint">
                {carrierLabel(carrier)}
              </small>
            )}
            {[...cellular.ranges].reverse().map((band, i) => (
              <div key={`${band.color}-${i}`} className="map-legend-row">
                <i style={{ background: band.color }} />
                {label(band, unit)}
              </div>
            ))}
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
