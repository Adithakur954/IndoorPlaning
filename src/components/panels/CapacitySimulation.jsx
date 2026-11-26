import React, { useEffect, useMemo, useState } from "react";
import { cancelLoadTest, runLoadTestHeatmap } from "../../infra/wifi/capacityWorkerClient.js";
import { Badge, Heatmaps, LoadTestResults } from "./LoadTest.jsx";

// Capacity simulation: ONE engine (capacity/src/loadmodel.rs through loadtest.rs) for both questions:
//   "Run for N users"     - is this number of people OK? (default: the headcount on the Demand tab)
//   "Find capacity limit" - how many can the APs carry? (the same simulation at a rising number of users)
// Both show the same four maps (throughput, signal, congestion, AP association) with the simulated users.

const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? "-" : Number(v.toFixed(digits)).toLocaleString());

const Tile = ({ label, value, unit, note, tone }) => (
  <div style={{ border: "1px solid var(--line, #d0d7de)", borderRadius: 8, padding: "8px 10px", minWidth: 130, flex: "1 1 130px" }}>
    <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? "#b91c1c" : tone === "ok" ? "#15803d" : undefined }}>
      {value}
      {unit && <span style={{ fontSize: 12, fontWeight: 400 }}> {unit}</span>}
    </div>
    {note && <div style={{ fontSize: 11, opacity: 0.75 }}>{note}</div>}
  </div>
);

export default function CapacitySimulation({ plan, settings, rtMaps, wifiAps, floorId, floorButtons, mutate }) {
  const [mode, setMode] = useState("users");
  const headcount = Math.max(1, Math.round(Number(settings.totalPeople) || 100));
  const [users, setUsers] = useState(String(headcount));
  const [state, setState] = useState({ running: false, error: null, out: null, inputs: null, key: null, run: 0 });
  const key = useMemo(
    () => JSON.stringify([plan.capacity || {}, plan.rooms, plan.sources.filter((s) => s.kind === "wifi"), plan.floors, plan.boundaries, plan.furniture]),
    [plan.capacity, plan.rooms, plan.sources, plan.floors, plan.boundaries, plan.furniture],
  );
  const [cellsAtRun, setCellsAtRun] = useState(null);
  useEffect(() => () => cancelLoadTest(), []);

  const run = () => {
    const n = Math.max(1, Math.round(Number(users) || headcount));
    const inputs = { plan, settings: plan.capacity || {}, cells: rtMaps };
    setState((s) => ({ ...s, running: true, error: null }));
    setCellsAtRun(rtMaps);
    const runKey = key;
    runLoadTestHeatmap({ ...inputs, users: n })
      .then(({ result: out }) => {
        if (!out.heat) throw new Error("No map: the plan has no access points with a floor to map.");
        setState((s) => ({ running: false, error: null, out, inputs, key: runKey, run: s.run + 1 }));
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState((s) => ({ ...s, running: false, error: err.message }));
      });
  };
  const stale = state.out && (state.key !== key || cellsAtRun !== rtMaps);
  const out = state.out;
  const f = out?.step?.floor;
  const overloaded = out ? out.step.aps.filter((a) => (a.overloadPct ?? 0) > 50).length : 0;
  const belowMin = f ? 100 - (f.meetsMinimumWifiPct ?? 100) : null;
  const apsOfRun = (state.inputs?.plan ?? plan).sources.filter((s) => s.kind === "wifi");

  return (
    <>
      <h2>Capacity simulation</h2>
      <p className="hint">
        Every user is placed on the floor, joins an AP from the signal where they stand, and shares that AP's airtime with
        the others; repeated many times. One calculation for both questions below.
      </p>
      <div className="segmented" role="tablist" aria-label="What to simulate" style={{ marginBottom: 10 }}>
        <button type="button" role="tab" aria-selected={mode === "users"} className={mode === "users" ? "active" : ""} onClick={() => setMode("users")}>
          Run for a number of users
        </button>
        <button type="button" role="tab" aria-selected={mode === "limit"} className={mode === "limit" ? "active" : ""} onClick={() => setMode("limit")}>
          Find capacity limit
        </button>
      </div>

      <div style={mode === "users" ? {} : { display: "none" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="field" style={{ maxWidth: 180 }}>
            <span>Users</span>
            <input type="number" min={1} step={1} value={users} onChange={(e) => setUsers(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          </label>
          <button type="button" className="primary" onClick={run} disabled={state.running || wifiAps.length === 0}>
            {state.running ? "Running…" : state.out ? "Run again" : "Run simulation"}
          </button>
          {Number(users) !== headcount && (
            <button type="button" onClick={() => setUsers(String(headcount))}>Use the headcount ({headcount})</button>
          )}
        </div>
        {wifiAps.length === 0 && <p className="hint">Add access points first.</p>}
        {state.error && <p className="error">{state.error}</p>}
        {stale && !state.running && <p className="warn">The plan or the settings changed after this run. Run it again to update it.</p>}
        {out && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
              <Tile label="Simulated users" value={fmt(f.usersSimulated, 0)} note={`${fmt(f.activeDevices, 0)} active devices at a time`} />
              <Tile label="Average Wi-Fi speed per user" value={fmt(f.wifiAvgMbps, 1)} unit="Mbps" note={`worst 5%: ${fmt(f.wifiLowMbps, 1)} Mbps`}
                tone={f.wifiLowMbps < settings.minMbps - 1e-9 ? "bad" : "ok"} />
              <Tile label="Below the minimum" value={fmt(belowMin, 1)} unit="%" note={`minimum ${settings.minMbps} Mbps over Wi-Fi`} tone={belowMin > 0.05 ? "bad" : "ok"} />
              <Tile label="Overloaded APs" value={overloaded} note={`of ${apsOfRun.length}, in most runs`} tone={overloaded ? "bad" : "ok"} />
              <Tile label="After the internet plan" value={fmt(f.netAvgMbps, 1)} unit="Mbps" note={`${settings.wanDownMbps} Mbps plan`} />
            </div>
            <div style={{ fontSize: 13, margin: "4px 0 8px" }}>
              Overall <Badge status={out.step.status} /> · Wi-Fi <Badge status={out.step.wifiStatus} /> · Internet <Badge status={out.step.internetStatus} /> ·
              Coverage <Badge status={out.step.coverageStatus} />
            </div>
            <Heatmaps key={state.run} result={null} plan={state.inputs?.plan ?? plan} settings={settings} floorId={floorId} floorButtons={floorButtons}
              single={{ users: out.users, floors: out.floors, heat: out.heat, step: out.step, aps: apsOfRun.map((a) => ({ name: a.name || a.id })) }} />
            <h4 style={{ marginBottom: 4 }}>Access points</h4>
            <div style={{ overflowX: "auto" }}>
              <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th>AP</th><th>Devices</th><th>Active</th><th title="typical run">Congestion (airtime)</th><th>Meet the minimum</th>
                    <th title="share of runs in which it is overloaded">Overloaded</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {out.step.aps.map((a, i) => (
                    <tr key={i}>
                      <td>{apsOfRun[i]?.name ?? apsOfRun[i]?.id ?? i + 1}</td>
                      <td>{fmt(a.devices, 1)}</td><td>{fmt(a.activeDevices, 1)}</td>
                      <td>{fmt(a.airtimePct, 0)}%</td><td>{a.meetsMinimumPct == null ? "-" : `${fmt(a.meetsMinimumPct, 1)}%`}</td>
                      <td>{fmt(a.overloadPct, 0)}%</td><td>{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div style={mode === "limit" ? {} : { display: "none" }}>
        <LoadTestResults plan={plan} settings={settings} rtMaps={rtMaps} wifiAps={wifiAps} floorId={floorId} floorButtons={floorButtons} mutate={mutate} />
      </div>
    </>
  );
}
