import React from "react";
import Field from "../ui/Field.jsx";
import {
  BANDS,
  channelCenterMHz,
  eirpDbm,
  profileWarnings,
} from "../../config/apProfiles.js";

// Wi-Fi AP properties (model, band, power, gain, channel). They live on the
// Network & RF page; the optimiser and the prediction read the chosen profile.
export default function ApProfileEditor({ plan, mutate, optimization: o }) {
  const { settings, patch, profile, radio } = o;
  const warnings = profileWarnings(profile, settings.band);
  const wifiAps = plan.sources.filter((s) => s.kind === "wifi");
  return (
      <section className="panel">
        <h2>Wi-Fi AP properties</h2>
        <label className="field">
          <span>Model</span>
          <select
            value={profile.id}
            onChange={(e) => {
              const next = o.profiles.find((p) => p.id === e.target.value);
              patch({
                profileId: e.target.value,
                band: next.bands[settings.band]
                  ? settings.band
                  : Object.keys(next.bands)[0],
              });
            }}
          >
            {o.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Band">
          {BANDS.filter((b) => profile.bands[b]).map((b) => (
            <button
              key={b}
              type="button"
              className={settings.band === b ? "active" : ""}
              onClick={() => patch({ band: b })}
            >
              {b} GHz
            </button>
          ))}
          {BANDS.filter((b) => !profile.bands[b]).map((b) => (
            <button
              key={b}
              type="button"
              title={`Add a ${b} GHz radio`}
              onClick={() => o.addBand(b)}
            >
              + {b}
            </button>
          ))}
        </div>
        <div className="inspector-fields">
          <Field
            label="Transmit power (dBm)"
            type="number"
            value={radio.txPowerDbm}
            onChange={(v) => o.updateRadio({ txPowerDbm: v })}
          />
          <Field
            label="Antenna gain (dBi)"
            type="number"
            value={radio.gainDbi}
            onChange={(v) => o.updateRadio({ gainDbi: v })}
          />
          <Field
            label="Channel"
            type="number"
            value={radio.channel}
            onChange={(v) => o.updateRadio({ channel: v })}
          />
          <Field
            label="Width (MHz)"
            type="number"
            value={radio.widthMHz}
            onChange={(v) => o.updateRadio({ widthMHz: v })}
          />
        </div>
        <small className="hint">
          EIRP {eirpDbm(radio).toFixed(1)} dBm ·{" "}
          {channelCenterMHz(settings.band, radio.channel)} MHz
          {radio.maxTxPowerDbm != null
            ? ` · model max ${radio.maxTxPowerDbm} dBm`
            : ""}
        </small>
        <div className="inspector-fields">
          <Field
            label="Receiver (client device) gain (dBi)"
            type="number"
            value={plan.rf?.rxGainDbi ?? 0}
            onChange={(v) => mutate((p) => ({ ...p, rf: { ...p.rf, rxGainDbi: v } }))}
          />
        </div>
        <small className="hint">
          Used by the prediction and the optimiser: the antenna gain of the phone or laptop that receives.
        </small>
        {warnings.map((w) => (
          <small key={w} className="warn">
            ⚠ {w}
          </small>
        ))}
        {profile.note && <small className="hint">{profile.note}</small>}
        <div className="button-row">
          <button type="button" onClick={o.duplicateProfile}>
            Duplicate profile
          </button>
          <button
            type="button"
            disabled={!wifiAps.length}
            title="Sets power, gain and channel of the existing Wi-Fi APs from this profile"
            onClick={o.applyProfileToExisting}
          >
            Use on existing APs
          </button>
        </div>
      </section>
  );
}
