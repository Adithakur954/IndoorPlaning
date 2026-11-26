import React, { useEffect, useState } from "react";
import Field from "../ui/Field.jsx";
import { DEFAULT_MONTE_CARLO } from "../../infra/wifi/capacityModel.js";

// Users and traffic settings of the capacity simulation (stored in plan.capacity.monteCarlo): headcount
// variation, seed and traffic profiles. The simulation itself is CapacitySimulation.jsx (one engine).
const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? "-" : Number(v.toFixed(digits)).toString());

// The Monte Carlo settings, stored in plan.capacity.monteCarlo.
export function MonteCarloSettings({ settings, set, compact = false }) {
  const mc = { ...DEFAULT_MONTE_CARLO, ...(settings.monteCarlo || {}) };
  const setMc = (changes) => set({ monteCarlo: { ...mc, ...changes } });
  const profiles = mc.profiles || [];
  const setProfile = (i, changes) => setMc({ profiles: profiles.map((p, k) => (k === i ? { ...p, ...changes } : p)) });
  const shareTotal = profiles.reduce((s, p) => s + (Number(p.share) || 0), 0);
  const activeShare = shareTotal > 0 ? profiles.filter((p) => p.active).reduce((s, p) => s + (Number(p.share) || 0), 0) / shareTotal : 0;
  return (
    <>
      <h3>{compact ? "Users and traffic" : "Simulation (Monte Carlo)"}</h3>
      <small className="hint">
        {compact
          ? "Every person becomes one user at a random position, with whole devices and their own traffic; repeated many times."
          : "Places every person as one user at a random position, gives each user whole devices and traffic, and repeats it many times. Run it from the result side."}
      </small>
      <div className="inspector-fields">
        {!compact && (
          <>
            <Field label="Runs (at least)" type="number" value={mc.iterations} onChange={(v) => setMc({ iterations: Math.max(10, Math.min(20000, Math.round(v))) })} />
            <Field label="Runs (at most)" type="number" value={mc.maxIterations} onChange={(v) => setMc({ maxIterations: Math.max(10, Math.min(20000, Math.round(v))) })} />
            <Field label="Stop when overload chance is within ± (points)" type="number" value={mc.targetCiPct} onChange={(v) => setMc({ targetCiPct: Math.max(0.5, Math.min(20, v)) })} />
          </>
        )}
        <Field label="Seed (same seed = same result)" type="number" value={mc.seed} onChange={(v) => setMc({ seed: Math.max(0, Math.round(v)) })} />
        <Field label="Headcount varies by ± (%)" type="number" value={mc.peopleVariationPct} onChange={(v) => setMc({ peopleVariationPct: Math.max(0, Math.min(100, v)) })} />
        <Field label="Traffic" type="select" value={mc.traffic} options={["simple", "profiles"]}
          optionLabels={{ simple: "Active share and speeds above", profiles: "Traffic profiles per device" }} onChange={(v) => setMc({ traffic: v })} />
      </div>
      {mc.traffic === "profiles" && (
        <div className="opt-section">
          <small className="hint">
            Each device draws one profile by its share, then a speed between "from" and "to". Idle devices use no airtime.
            {` Shares add up to ${fmt(shareTotal * 100, 0)}% (they are scaled to 100%); ${fmt(activeShare * 100, 0)}% of devices are active.`}
          </small>
          <div style={{ overflowX: "auto" }}>
            <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
              <thead>
                <tr style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                  <th>Profile</th><th title="share of devices">Share %</th><th title="uses airtime">Active</th><th title="minimum speed it needs">Min</th><th>From</th><th>To</th><th title="upload as a share of download">Up %</th><th />
                </tr>
              </thead>
              <tbody>
                {profiles.map((p, i) => (
                  <tr key={p.id ?? i}>
                    <td><input value={p.name} onChange={(e) => setProfile(i, { name: e.target.value })} style={{ width: 120 }} /></td>
                    <td><NumberCell value={Math.round(p.share * 1000) / 10} onChange={(v) => setProfile(i, { share: Math.max(0, v) / 100 })} /></td>
                    <td><input type="checkbox" checked={!!p.active} onChange={(e) => setProfile(i, { active: e.target.checked })} /></td>
                    <td><NumberCell value={p.minMbps} onChange={(v) => setProfile(i, { minMbps: Math.max(0, v) })} /></td>
                    <td><NumberCell value={p.lowMbps} onChange={(v) => setProfile(i, { lowMbps: Math.max(0, v) })} /></td>
                    <td><NumberCell value={p.highMbps} onChange={(v) => setProfile(i, { highMbps: Math.max(0, v) })} /></td>
                    <td><NumberCell value={Math.round(p.uploadShare * 100)} onChange={(v) => setProfile(i, { uploadShare: Math.max(0, v) / 100 })} /></td>
                    <td><button type="button" title="Remove" onClick={() => setMc({ profiles: profiles.filter((_, k) => k !== i) })}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => setMc({ profiles: [...profiles, { id: `p-${Date.now().toString(36)}`, name: "New profile", share: 0.05, active: true, minMbps: 1, lowMbps: 1, highMbps: 2, uploadShare: 0.2 }] })}>Add a profile</button>
            <button type="button" onClick={() => setMc({ profiles: DEFAULT_MONTE_CARLO.profiles })}>Office defaults</button>
          </div>
        </div>
      )}
    </>
  );
}

function NumberCell({ value, onChange }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => {
    if (Number(text) !== Number(value)) setText(String(value ?? ""));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input type="number" step="any" value={text} style={{ width: 56 }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
      }} />
  );
}
