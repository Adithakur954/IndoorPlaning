import React, { useEffect, useMemo, useState } from "react";
import Field from "../ui/Field.jsx";
import LineChart from "../ui/LineChart.jsx";
import KpiHeatmap, { DOT_COLOURS, HEAT_KPIS, HeatLegend } from "../planner/KpiHeatmap.jsx";
import { apColour } from "../planner/CapacityMap.jsx";
import { DEFAULT_LOAD_TEST } from "../../infra/wifi/capacityModel.js";
import { cancelLoadTest, runLoadTest, runLoadTestHeatmap } from "../../infra/wifi/capacityWorkerClient.js";
import { uid } from "../../models/plan.js";

// Progressive load test: the same APs under a rising number of users. All the
// figures come from the capacity engine (capacity/src/loadtest.rs); this file
// only shows them. Settings are stored in plan.capacity.loadTest.

const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? "-" : Number(v.toFixed(digits)).toLocaleString());
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const STATUS = {
  pass: { colour: "#0ca30c", icon: "✓", label: "Pass" },
  warning: { colour: "#b07800", icon: "!", label: "Warning" },
  fail: { colour: "#d03b3b", icon: "✕", label: "Fail" },
};
const KPI = {
  airtime: { label: "Airtime on the busiest channel", unit: "%" },
  minSpeed: { label: "Active devices getting their minimum over Wi-Fi", unit: "%" },
  throughput: { label: "Per-user Wi-Fi throughput, worst 5%", unit: "Mbps" },
  devices: { label: "Most devices on one AP", unit: "" },
  internet: { label: "Internet plan use at the minimum speed", unit: "%" },
  coverage: { label: "Devices with a usable signal", unit: "%" },
  latency: { label: "Latency (estimate)", unit: "ms" },
  retries: { label: "Retries (estimate)", unit: "%" },
};
const BOTTLENECK = { radio: "Wi-Fi radio capacity", internet: "Internet bandwidth", coverage: "Coverage (no usable signal)" };

export const Badge = ({ status }) => {
  const s = STATUS[status] ?? STATUS.pass;
  return (
    <span style={{ color: s.colour, fontWeight: 600, whiteSpace: "nowrap" }} aria-label={s.label}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
};

const Tile = ({ label, value, unit, note, tone }) => (
  <div style={{ border: "1px solid var(--line, #d0d7de)", borderRadius: 8, padding: "8px 10px", minWidth: 140, flex: "1 1 140px" }}>
    <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? "#b91c1c" : tone === "ok" ? "#15803d" : undefined }}>
      {value}
      {unit && <span style={{ fontSize: 12, fontWeight: 400 }}> {unit}</span>}
    </div>
    {note && <div style={{ fontSize: 11, opacity: 0.75 }}>{note}</div>}
  </div>
);

// ---------------------------------------------------------------- settings

export function LoadTestSettings({ settings, set, title = "Load test" }) {
  const lt = { ...DEFAULT_LOAD_TEST, ...(settings.loadTest || {}) };
  const setLt = (changes) => set({ loadTest: { ...lt, ...changes } });
  const int = (key, min, max) => (v) => setLt({ [key]: Math.max(min, Math.min(max, Math.round(v))) });
  const num = (key, min, max) => (v) => setLt({ [key]: Math.max(min, Math.min(max, v)) });
  const steps = Math.floor((lt.maxUsers - lt.startUsers) / Math.max(1, lt.stepUsers)) + 1;
  return (
    <>
      <h2>{title}</h2>
      <small className="hint">
        {title === "Load test"
          ? "Keeps the existing APs and raises the number of users step by step, to find how many users they can carry and what fails first. Your own headcount on the Demand tab is not changed."
          : "Pass / fail targets for every run, and the range used by Find capacity limit (the same APs under a rising number of users). Your headcount on the Demand tab is not changed."}
      </small>
      <h3>Users</h3>
      <div className="inspector-fields">
        <Field label="Start at (users)" type="number" value={lt.startUsers} onChange={int("startUsers", 1, 1e6)} />
        <Field label="Go up to (users)" type="number" value={lt.maxUsers} onChange={int("maxUsers", 1, 1e6)} />
        <Field label="Step (users)" type="number" value={lt.stepUsers} onChange={int("stepUsers", 1, 1e6)} />
        <Field label="Find the limit to within (users)" type="number" value={lt.refineUsers} onChange={int("refineUsers", 1, 1e6)} />
      </div>
      <small className="hint">{Math.max(1, steps)} steps, then narrowed down where it fails.</small>

      <h3>Pass and fail</h3>
      <small className="hint">
        Uses the targets on the other tabs: minimum speed {settings.minMbps} Mbps, highest airtime {Math.round(settings.targetUtilisation * 100)}%,
        at most {settings.maxClientsPerAp} devices per AP, and the internet plan ({settings.wanDownMbps} Mbps).
      </small>
      <div className="inspector-fields">
        <Field label="Active devices that must get the minimum (%)" type="number" value={lt.passMeetsPct} onChange={num("passMeetsPct", 0, 100)} />
        <Field label="Warning below (%)" type="number" value={lt.warnMeetsPct} onChange={num("warnMeetsPct", 0, 100)} />
        <Field label="Warning within this share of a limit (%)" type="number" value={lt.warnPct} onChange={num("warnPct", 1, 100)} />
        <Field label="Must hold in this share of runs (%)" type="number" value={lt.confidencePct} onChange={num("confidencePct", 50, 99.9)} />
      </div>

      <details>
        <summary>More settings</summary>
        <div className="inspector-fields">
          <Field label="Runs per step" type="number" value={lt.runsPerStep} onChange={int("runsPerStep", 10, 5000)} />
          <Field label="Stop after this many failing steps (0 = go to the end)" type="number" value={lt.stopAfterFailSteps} onChange={int("stopAfterFailSteps", 0, 1000)} />
          <Field label="Heat-map square (m)" type="number" value={lt.heatmapM} onChange={num("heatmapM", 0.5, 50)} />
          <Field label="Runs per heat map" type="number" value={lt.heatmapRuns} onChange={int("heatmapRuns", 1, 1000)} />
          <Field label="Latency warning (ms, estimate)" type="number" value={lt.latencyWarnMs} onChange={num("latencyWarnMs", 0, 1e4)} />
          <Field label="Latency failure (ms, estimate)" type="number" value={lt.latencyFailMs} onChange={num("latencyFailMs", 0, 1e4)} />
          <Field label="Retries warning (%, estimate)" type="number" value={lt.retryWarnPct} onChange={num("retryWarnPct", 0, 100)} />
          <Field label="Retries failure (%, estimate)" type="number" value={lt.retryFailPct} onChange={num("retryFailPct", 0, 100)} />
          <Field label="Time per transmission (ms)" type="number" value={lt.txopMs} onChange={num("txopMs", 0.1, 20)} />
          <Field label="Estimates decide Pass / Fail" type="select" value={lt.estimatesDecide ? "yes" : "no"} options={["no", "yes"]}
            optionLabels={{ no: "No: shown only", yes: "Yes" }} onChange={(v) => setLt({ estimatesDecide: v === "yes" })} />
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------- running

const withProposedAp = (plan, p) => ({
  ...plan,
  sources: [...plan.sources, { id: "proposed-ap", kind: "wifi", name: "Proposed AP", floorId: p.floorId, x: p.x, z: p.z, proposed: true }],
});

function useLoadTestRun() {
  const [s, setS] = useState({ running: false, progress: null, error: null, result: null, ms: 0, inputs: null, run: 0 });
  const start = (inputs, onDone) => {
    setS((x) => ({ ...x, running: true, error: null, progress: { done: 0, total: 1 } }));
    return runLoadTest(inputs, (done, total) => setS((x) => (x.running ? { ...x, progress: { done, total } } : x)))
      .then(({ result, ms }) => {
        setS((x) => ({ running: false, progress: null, error: null, result, ms, inputs, run: x.run + 1 }));
        onDone?.(result);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setS((x) => ({ ...x, running: false, progress: null, error: err.message }));
      });
  };
  const stop = () => {
    cancelLoadTest();
    setS((x) => ({ ...x, running: false, progress: null }));
  };
  return [s, start, stop, setS];
}

const Progress = ({ progress }) => {
  const pct = progress ? Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100)) : 0;
  return (
    <div style={{ margin: "6px 0" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ height: 6, background: "#e1e0d9", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#2a78d6", transition: "width 0.2s" }} />
      </div>
      <small className="hint">{pct}% · step {progress?.done ?? 0} of about {progress?.total ?? 0}</small>
    </div>
  );
};

export function LoadTestResults({ plan, settings, rtMaps, wifiAps, floorId, floorButtons, mutate }) {
  const key = useMemo(
    () => JSON.stringify([plan.capacity || {}, plan.rooms, plan.sources.filter((s) => s.kind === "wifi"), plan.floors, plan.boundaries, plan.furniture]),
    [plan.capacity, plan.rooms, plan.sources, plan.floors, plan.boundaries, plan.furniture],
  );
  const [base, startBase, stopBase] = useLoadTestRun();
  const [after, startAfter, stopAfter, setAfter] = useLoadTestRun();
  const [baseKey, setBaseKey] = useState(null);
  const [cellsAtRun, setCellsAtRun] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [view, setView] = useState("existing");
  useEffect(() => () => cancelLoadTest(), []);

  const run = () => {
    setBaseKey(key);
    setCellsAtRun(rtMaps);
    setAfter((x) => ({ ...x, result: null, error: null }));
    setView("existing");
    startBase({ plan, settings: plan.capacity || {}, cells: rtMaps }, (result) => setProposal(result.proposal ? { ...result.proposal } : null));
  };
  const testProposal = () => {
    if (!proposal || !base.inputs) return;
    startAfter({ ...base.inputs, plan: withProposedAp(base.inputs.plan, proposal) }, () => setView("proposed"));
  };
  const addToPlan = () => {
    if (!proposal) return;
    mutate((p) => {
      const near = p.sources.find((s) => s.id === proposal.nearApId) ?? p.sources.find((s) => s.kind === "wifi" && s.floorId === proposal.floorId);
      const n = p.sources.filter((s) => s.origin === "capacity").length + 1;
      const { id, name, x, z, origin, ...radio } = near || {}; // eslint-disable-line no-unused-vars
      return { ...p, sources: [...p.sources, { ...radio, id: uid(), kind: "wifi", name: `AP-cap-${n}`, origin: "capacity", floorId: proposal.floorId, x: proposal.x, z: proposal.z }] };
    });
  };
  const stale = base.result && (baseKey !== key || cellsAtRun !== rtMaps);
  const shown = view === "proposed" && after.result ? after : base;

  return (
    <>
      <p className="hint">
        The {wifiAps.length} APs stay where they are. The same simulation runs at a rising number of users and checks every
        target; between the last passing and the first failing count the number is narrowed down.
      </p>
      <div className="button-row">
        <button type="button" className="primary" onClick={run} disabled={base.running || wifiAps.length === 0}>
          {base.running ? "Running…" : base.result ? "Run again" : "Find capacity limit"}
        </button>
        {base.running && <button type="button" onClick={stopBase}>Cancel</button>}
      </div>
      {wifiAps.length === 0 && <p className="hint">Add access points first.</p>}
      {base.running && <Progress progress={base.progress} />}
      {base.error && <p className="error">{base.error}</p>}
      {stale && !base.running && <p className="warn">The plan or the settings changed after this test. Run it again to update it.</p>}

      {base.result && (
        <>
          <Headline result={base.result} apCount={wifiAps.length} />
          <ProposalBox result={base.result} proposal={proposal} setProposal={setProposal} plan={plan} after={after}
            onTest={testProposal} onCancel={stopAfter} onAdd={addToPlan} />
          {after.result && (
            <div className="button-row" role="tablist" aria-label="Which layout">
              <button type="button" className={view === "existing" ? "active" : ""} onClick={() => setView("existing")}>Existing APs</button>
              <button type="button" className={view === "proposed" ? "active" : ""} onClick={() => setView("proposed")}>With the proposed AP</button>
            </div>
          )}
          <LoadTestReport key={`${view}-${shown.run}`} result={shown.result} ms={shown.ms} inputs={shown.inputs} plan={view === "proposed" && after.inputs ? after.inputs.plan : plan}
            settings={settings} floorId={floorId} floorButtons={floorButtons} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- headline

function Headline({ result: r, apCount, label = "Existing deployment" }) {
  const res = r.result;
  const at = res.firstFailUsers != null ? r.steps.find((s) => s.users === res.firstFailUsers) : null;
  return (
    <div className="opt-section" style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, opacity: 0.8 }}>{label}: {apCount} APs</div>
      {res.failsAtStart ? (
        <>
          <div style={{ fontSize: 30, fontWeight: 700, color: "#b91c1c" }}>Fails at {res.firstFailUsers} users</div>
          <div className="hint">The first step already fails. Lower the starting number to find where it starts.</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 30, fontWeight: 700 }}>{res.maxSupportedUsers} users</div>
          <div className="hint">
            {res.firstFailUsers != null
              ? `Estimated capacity under the selected criteria (to within ${res.resolutionUsers} users).`
              : `No step failed up to ${res.testedUpToUsers} users: the limit is higher.`}
            {res.degradationStartsUsers != null && res.degradationStartsUsers !== res.firstFailUsers && ` Performance starts to degrade (first warning) at about ${res.degradationStartsUsers} users.`}
          </div>
        </>
      )}
      <PartLimits result={r} />
      {at && (
        <>
          <div style={{ marginTop: 8, fontWeight: 600 }}>At {at.users} users: capacity requirement failed</div>
          <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 13 }}>
            {res.failingAtFirstFail.filter((f) => f.kind === "ap").map((f) => (
              <li key={f.id}>{f.name}: {f.reason ?? "overloaded"} (in {fmt(f.overloadPct, 0)}% of runs)</li>
            ))}
            {res.failingAtFirstFail.filter((f) => f.kind === "internet").map((f) => (
              <li key="wan">Internet: {f.status === "fail" ? "over the available bandwidth" : f.status === "warning" ? "close to the available bandwidth" : "within the available bandwidth"} ({fmt(f.usePct, 0)}% used at the minimum speed)</li>
            ))}
            {at.failing.filter((k) => !["airtime", "internet"].includes(k)).map((k) => (
              <li key={k}>{KPI[k].label}: {fmt(at.kpis[k].value)} {KPI[k].unit} (limit {fmt(at.kpis[k].limit)})</li>
            ))}
          </ul>
          <div style={{ fontSize: 13 }}>Main bottleneck: <strong>{res.bottleneck.map((b) => BOTTLENECK[b] ?? b).join(" and ") || "-"}</strong></div>
        </>
      )}
      {r.recommendations.length > 0 && (
        <>
          <div style={{ marginTop: 8, fontWeight: 600 }}>Recommended action</div>
          {r.recommendations.map((t, i) => <p key={i} className="hint" style={{ margin: "2px 0" }}>{t}</p>)}
        </>
      )}
    </div>
  );
}

// Where each part fails on its own: the Wi-Fi radio, the internet plan, coverage.
function PartLimits({ result: r }) {
  const first = (keys) => {
    const v = keys.map((k) => r.kpiFirstFail[k]).filter((u) => u != null);
    return v.length ? Math.min(...v) : null;
  };
  const upTo = r.result.testedUpToUsers;
  const rows = [
    ["Wi-Fi radio", first(["airtime", "minSpeed", "throughput", "devices"])],
    ["Internet plan", first(["internet"])],
    ["Coverage", first(["coverage"])],
  ];
  return (
    <table className="compact-table" style={{ fontSize: 13, marginTop: 8 }}>
      <tbody>
        {rows.map(([label, u]) => (
          <tr key={label}>
            <td style={{ paddingRight: 12 }}>{label}</td>
            <td>{u == null ? <Badge status="pass" /> : <Badge status="fail" />}</td>
            <td style={{ paddingLeft: 8 }}>{u == null ? `no failure up to ${upTo} users` : u === r.steps[0]?.users ? `fails already at ${u} users` : `fails from ${u} users`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- proposed AP

function ProposalBox({ result, proposal, setProposal, plan, after, onTest, onCancel, onAdd }) {
  if (!proposal) return null;
  const floors = plan.floors;
  const before = result.result;
  const res = after.result?.result;
  const delta = res && before.maxSupportedUsers != null && res.maxSupportedUsers != null ? res.maxSupportedUsers - before.maxSupportedUsers : null;
  return (
    <div className="opt-section">
      <strong>Proposed AP</strong>
      <small className="hint">
        {proposal.reason === "coverage"
          ? "Placed where devices find no usable signal."
          : `Placed to take load off ${proposal.nearApName}; a quick check at ${proposal.users} users brings the busiest AP from ${fmt(proposal.busiestLoadBeforePct, 0)}% to ${fmt(proposal.busiestLoadAfterPct, 0)}% of its limit.`}{" "}
        Move it if needed, then test it: the load test is run again with this AP, and only that shows whether it really helps.
      </small>
      <div className="inspector-fields">
        {floors.length > 1 && (
          <Field label="Floor" type="select" value={proposal.floorId} options={floors.map((f) => f.id)} optionLabels={Object.fromEntries(floors.map((f) => [f.id, f.name]))}
            onChange={(v) => setProposal({ ...proposal, floorId: v })} />
        )}
        <Field label="x (m)" type="number" value={proposal.x} onChange={(v) => setProposal({ ...proposal, x: v })} />
        <Field label="y (m)" type="number" value={proposal.z} onChange={(v) => setProposal({ ...proposal, z: v })} />
      </div>
      <div className="button-row">
        <button type="button" className="primary" onClick={onTest} disabled={after.running}>{after.running ? "Testing…" : after.result ? "Test again" : "Test with this AP"}</button>
        {after.running && <button type="button" onClick={onCancel}>Cancel</button>}
        <button type="button" onClick={onAdd} title="Adds a copy of the nearby AP at this position to the plan">Add this AP to the plan</button>
      </div>
      {after.running && <Progress progress={after.progress} />}
      {after.error && <p className="error">{after.error}</p>}
      {res && (
        <>
          <p style={{ margin: "6px 0" }}>
            {delta == null
              ? "Compare the results below."
              : delta > 0
                ? <><strong className="ok">Improves capacity by {delta} users</strong> ({before.maxSupportedUsers} → {res.maxSupportedUsers}).</>
                : <><strong className="error">Does not raise capacity</strong> ({before.maxSupportedUsers} → {res.maxSupportedUsers}): try another position or another change.</>}
          </p>
          <Comparison before={result} after={after.result} />
          <small className="hint">The proposed AP has no ray-traced prediction: its signal is estimated from distance. Run the prediction with the AP in place to confirm.</small>
        </>
      )}
    </div>
  );
}

function Comparison({ before, after }) {
  const b = before.result, a = after.result;
  const firstAp = (r) => (r.result.firstOverloadedAp ? `${r.result.firstOverloadedAp.name} at ${r.result.firstOverloadedAp.users}` : "none");
  const rows = [
    ["Maximum supported users", b.maxSupportedUsers, a.maxSupportedUsers],
    ["First failing user count", b.firstFailUsers, a.firstFailUsers],
    ["Degradation starts at", b.degradationStartsUsers, a.degradationStartsUsers],
    ["First overloaded AP", firstAp(before), firstAp(after)],
    ["Main bottleneck", b.bottleneck.map((x) => BOTTLENECK[x] ?? x).join(", ") || "-", a.bottleneck.map((x) => BOTTLENECK[x] ?? x).join(", ") || "-"],
    ...Object.keys(KPI).map((k) => [`${KPI[k].label}: fails at`, before.kpiFirstFail[k], after.kpiFirstFail[k]]),
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
        <thead><tr style={{ textAlign: "left" }}><th /><th>Existing APs</th><th>With the proposed AP</th></tr></thead>
        <tbody>
          {rows.map(([label, x, y]) => (
            <tr key={label}><td>{label}</td><td>{x ?? "not reached"}</td><td>{y ?? "not reached"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- the report

export function LoadTestReport({ result: r, ms, plan, settings, floorId, floorButtons, inputs = null }) {
  const [showRefined, setShowRefined] = useState(true);
  const steps = r.steps;
  const res = r.result;
  const aps = r.aps;
  const marks = [
    res.maxSupportedUsers != null && !res.failsAtStart ? { x: res.maxSupportedUsers, label: `max ${res.maxSupportedUsers}` } : null,
    res.firstFailUsers != null ? { x: res.firstFailUsers, label: `fails ${res.firstFailUsers}` } : null,
  ].filter(Boolean);
  const pts = (f) => steps.map((s) => ({ x: s.users, y: f(s) }));
  const airLimit = settings.targetUtilisation * 100;
  const lt = { ...DEFAULT_LOAD_TEST, ...(r.settings || {}) };
  // per-AP lines: the APs that get busiest, at most eight, in their map colours
  const last = steps[steps.length - 1];
  const apOrder = aps.map((a, i) => i).sort((i, j) => (last?.aps[j]?.airtimeHighPct ?? 0) - (last?.aps[i]?.airtimeHighPct ?? 0)).slice(0, 8);
  const shownSteps = showRefined ? steps : steps.filter((s) => !s.refined);

  return (
    <>
      <small className="hint">{r.runsPerStep} runs per step · seed {r.seed} · {steps.length} steps tested · {fmt(ms / 1000, 1)} s</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
        <Tile label="Maximum supported" value={res.failsAtStart ? "-" : res.maxSupportedUsers} unit="users" tone={res.failsAtStart ? "bad" : "ok"}
          note={res.firstFailUsers == null ? `no failure up to ${res.testedUpToUsers}` : undefined} />
        <Tile label="First failing count" value={res.firstFailUsers ?? "-"} unit={res.firstFailUsers != null ? "users" : undefined} tone={res.firstFailUsers != null ? "bad" : "ok"} />
        <Tile label="Degradation starts" value={res.degradationStartsUsers ?? "-"} unit={res.degradationStartsUsers != null ? "users" : undefined} note="first warning" />
        <Tile label="First overloaded AP" value={res.firstOverloadedAp?.name ?? "-"} note={res.firstOverloadedAp ? `at ${res.firstOverloadedAp.users} users` : "none"} />
        <Tile label="Main bottleneck" value={res.bottleneck.length ? res.bottleneck.map((b) => ({ radio: "Wi-Fi", internet: "Internet", coverage: "Coverage" })[b]).join(" + ") : "-"} />
      </div>

      <h3>When each KPI fails</h3>
      <div style={{ overflowX: "auto" }}>
        <table className="compact-table" style={{ fontSize: 13, width: "100%" }}>
          <thead><tr style={{ textAlign: "left", whiteSpace: "nowrap" }}><th>KPI</th><th>First warning</th><th>First failure</th><th>Limit</th></tr></thead>
          <tbody>
            {Object.keys(KPI).map((k) => {
              const ref = steps.find((s) => s.users === r.kpiFirstFail[k]) ?? last;
              return (
                <tr key={k}>
                  <td>{KPI[k].label}{(k === "latency" || k === "retries") && !lt.estimatesDecide ? " (does not decide)" : ""}</td>
                  <td>{r.kpiFirstWarn[k] != null ? `${r.kpiFirstWarn[k]} users` : "-"}</td>
                  <td className={r.kpiFirstFail[k] != null ? "error" : ""}>{r.kpiFirstFail[k] != null ? `${r.kpiFirstFail[k]} users` : `not up to ${res.testedUpToUsers}`}</td>
                  <td>{ref?.kpis[k]?.limit != null ? `${fmt(ref.kpis[k].limit)} ${KPI[k].unit}` : "per profile"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>How the network changes as users increase</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
        <LineChart title="Per-user throughput over Wi-Fi (after sharing airtime)" unit="Mbps" marks={marks}
          series={[
            { id: "avg", name: "Average user", colour: SERIES[0], points: pts((s) => s.floor.wifiAvgMbps) },
            { id: "low", name: "Worst 5% of users", colour: SERIES[1], points: pts((s) => s.floor.wifiLowMbps) },
          ]}
          refs={[{ y: settings.minMbps, label: `min ${settings.minMbps}` }]} />
        <LineChart title="Per-user throughput with the internet plan" unit="Mbps" marks={marks}
          series={[
            { id: "avg", name: "Average user", colour: SERIES[0], points: pts((s) => s.floor.netAvgMbps) },
            { id: "low", name: "Worst 5% of users", colour: SERIES[1], points: pts((s) => s.floor.netLowMbps) },
          ]}
          refs={[{ y: settings.minMbps, label: `min ${settings.minMbps}` }]} />
        <LineChart title="Airtime on the busiest channel (in 95% of runs)" unit="%" marks={marks}
          series={[{ id: "air", name: "Busiest channel", colour: SERIES[0], points: pts((s) => s.floor.airtimeMaxHighPct) }]}
          refs={[{ y: airLimit, label: `limit ${fmt(airLimit, 0)}%` }]} />
        <LineChart title="Active devices getting their minimum (worst 5% of runs)" unit="%" marks={marks} yMax={100}
          series={[
            { id: "wifi", name: "Over Wi-Fi", colour: SERIES[0], points: pts((s) => s.floor.meetsMinimumWifiLowPct) },
            { id: "all", name: "With the internet plan", colour: SERIES[1], points: pts((s) => s.floor.meetsMinimumLowPct) },
          ]}
          refs={[{ y: lt.passMeetsPct, label: `pass ${fmt(lt.passMeetsPct, 0)}%` }]} />
        <LineChart title="Airtime per AP (typical run)" unit="%" marks={marks}
          series={apOrder.map((i) => ({ id: aps[i].id, name: aps[i].name, colour: apColour(i), points: pts((s) => s.aps[i]?.airtimePct) }))}
          refs={[{ y: airLimit, label: `limit ${fmt(airLimit, 0)}%` }]} />
        <LineChart title="Internet plan use" unit="%" marks={marks}
          series={[
            { id: "min", name: "At the minimum speed", colour: SERIES[0], points: pts((s) => s.floor.wanMinHighPct) },
            { id: "typ", name: "At the typical speed", colour: SERIES[1], points: pts((s) => s.floor.wanUseHighPct) },
          ]}
          refs={[{ y: 100, label: "plan" }]} />
        <LineChart title="Latency on the busiest AP (estimate)" unit="ms" marks={marks}
          series={[{ id: "lat", name: "Latency", colour: SERIES[0], points: pts((s) => s.floor.latencyHighMs) }]}
          refs={[{ y: lt.latencyWarnMs, label: "warning" }]} />
      </div>
      {aps.length > 8 && <small className="hint">Airtime per AP shows the 8 busiest APs.</small>}

      <h3>Every step</h3>
      <label style={{ fontSize: 12 }}>
        <input type="checkbox" checked={showRefined} onChange={(e) => setShowRefined(e.target.checked)} /> Show the steps added to find the limit
      </label>
      <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
        <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--panel, #fff)" }}>
              <th>Users</th><th>Wi-Fi</th><th>Internet</th><th>Coverage</th><th>Overall</th>
              <th title="busiest channel, in 95% of runs">Airtime</th>
              <th title="average / worst 5% of active users, Mbps">Per user, Wi-Fi</th><th title="average / worst 5% of active users, Mbps">Per user, with internet</th>
              <th title="over Wi-Fi, worst 5% of runs">Meet minimum</th><th>Most devices on an AP</th><th title="at the minimum speed, in 95% of runs">Internet use</th>
              <th>No signal</th><th>Latency (est.)</th><th>Retries (est.)</th><th>Failing</th>
            </tr>
          </thead>
          <tbody>
            {shownSteps.map((s) => (
              <tr key={s.users} style={{ whiteSpace: "nowrap", fontStyle: s.refined ? "italic" : undefined }}>
                <td>{s.users}{s.refined ? " *" : ""}</td>
                <td><Badge status={s.wifiStatus} /></td>
                <td><Badge status={s.internetStatus} /></td>
                <td><Badge status={s.coverageStatus} /></td>
                <td><Badge status={s.status} /></td>
                <td>{fmt(s.floor.airtimeMaxHighPct, 0)}%</td>
                <td>{fmt(s.floor.wifiAvgMbps)} / {fmt(s.floor.wifiLowMbps)}</td>
                <td>{fmt(s.floor.netAvgMbps)} / {fmt(s.floor.netLowMbps)}</td>
                <td>{fmt(s.floor.meetsMinimumWifiLowPct, 0)}%</td>
                <td>{fmt(s.kpis.devices.value, 0)}</td>
                <td>{fmt(s.floor.wanMinHighPct, 0)}%</td>
                <td>{fmt(s.floor.noSignalPct)}%</td>
                <td>{fmt(s.floor.latencyHighMs)} ms</td>
                <td>{fmt(s.floor.retryHighPct, 0)}%</td>
                <td>{s.failing.map((k) => KPI[k]?.label ?? k).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="hint">* added between steps to find the limit.</small>

      <ApTable result={r} />
      <Heatmaps result={r} plan={plan} settings={settings} floorId={floorId} floorButtons={floorButtons} inputs={inputs} />

      <details>
        <summary>How the load test works</summary>
        {r.assumptions.map((t, i) => <small key={i} className="hint">{t}</small>)}
        {r.notes.map((t, i) => <small key={`n${i}`} className="warn">{t}</small>)}
      </details>
    </>
  );
}

function ApTable({ result: r }) {
  const users = [...new Set(r.steps.filter((s) => !s.refined).map((s) => s.users))];
  const keyCounts = [r.result.maxSupportedUsers, r.result.firstFailUsers].filter((u) => u != null && !users.includes(u));
  const [at, setAt] = useState(r.result.firstFailUsers ?? r.result.testedUpToUsers);
  const step = r.steps.find((s) => s.users === at) ?? r.steps[r.steps.length - 1];
  return (
    <>
      <h3>Per AP</h3>
      <div className="inspector-fields" style={{ maxWidth: 260 }}>
        <Field label="At (users)" type="select" value={String(step.users)} options={[...users, ...keyCounts].sort((a, b) => a - b).map(String)} onChange={(v) => setAt(Number(v))} />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", whiteSpace: "nowrap" }}>
              <th>AP</th><th>Ch.</th><th>Devices</th><th>Active</th><th title="typical run (in 95% of runs)">Airtime</th><th>Meet minimum</th>
              <th title="share of runs in which it is overloaded">Overloaded</th><th>Latency (est.)</th><th>Retries (est.)</th><th>Status</th><th>First overloaded at</th>
            </tr>
          </thead>
          <tbody>
            {r.aps.map((a, i) => {
              const s = step.aps[i];
              return (
                <tr key={a.id} style={{ whiteSpace: "nowrap" }}>
                  <td><span style={{ display: "inline-block", width: 10, height: 10, background: apColour(i), marginRight: 4 }} />{a.name}{a.proposed ? " (proposed)" : ""}</td>
                  <td>{a.channel ?? "-"}</td>
                  <td>{fmt(s.devices, 0)}</td>
                  <td>{fmt(s.activeDevices, 0)}</td>
                  <td>{fmt(s.airtimePct, 0)}% ({fmt(s.airtimeHighPct, 0)}%)</td>
                  <td>{s.meetsMinimumPct != null ? `${fmt(s.meetsMinimumPct, 0)}%` : "-"}</td>
                  <td className={s.overloadPct > 5 ? "error" : ""} title={`95% range ${s.overloadLow}–${s.overloadHigh}%`}>{fmt(s.overloadPct, 0)}%</td>
                  <td>{fmt(s.latencyMs)} ms</td>
                  <td>{fmt(s.retryPct, 0)}%</td>
                  <td>{s.overloadPct > 5 ? s.overloadReason ?? s.status : s.status}</td>
                  <td>{a.firstOverloadUsers != null ? `${a.firstOverloadUsers} users` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- heat maps

const EMPTY = [];
// The capacity simulation's four maps (one engine, one meaning each):
//   Throughput: what one active user standing there can achieve under that load (data rate x fair airtime share);
//   Signal: SNR or RSSI from the prediction (does not change with users);
//   Congestion: airtime the AP's channel needs over what it can use;
//   AP association: the AP a user standing there joins.
const MAPS = [["throughput", "Throughput"], ["signal", "Signal"], ["congestion", "Congestion (airtime)"], ["assoc", "AP association"]];

// a clicked user: its AP and, per device, signal, rate, demand, airtime and what it actually gets
const dotDetails = (u) => {
  const lines = [`Connected to: ${u.apName ?? "no AP (no usable signal)"} · at ${fmt(u.x)}, ${fmt(u.z)} m`];
  u.devices.forEach((d, i) => {
    const head = u.devices.length > 1 ? `Device ${i + 1}: ` : "";
    if (!d.active) return lines.push(`${head}idle`);
    if (d.wifiMbps == null) return lines.push(`${head}no usable signal`);
    lines.push(`${head}RSSI ${fmt(d.rssiDbm)} dBm · SNR ${fmt(d.snrDb)} dB · data rate ${fmt(d.rateMbps)} Mbps`);
    lines.push(`${head}demand ${fmt(d.demandMbps)} Mbps (minimum ${fmt(d.minMbps)}) · airtime ${fmt(d.airtimePct, 2)}%`);
    lines.push(`${head}gets ${fmt(d.wifiMbps, 2)} Mbps over Wi-Fi · ${fmt(d.netMbps, 2)} Mbps after the internet plan`);
  });
  return lines;
};

// one tooltip line per simulated user (load test dots)
const dotLabel = (u) => {
  const act = u.devices.filter((d) => d.active);
  const speeds = act.map((d) => (d.wifiMbps == null ? "no signal" : `${fmt(d.wifiMbps)} Mbps (rate ${fmt(d.rateMbps)}, SNR ${fmt(d.snrDb)} dB)`));
  const who = u.apName != null ? `AP ${u.apName}` : "no AP";
  return `${u.status} · ${who} · ${act.length ? speeds.join("; ") : `${u.devices.length} idle device(s)`}`;
};

// Under each map: why this number of users passes or fails, with its own figures,
// for the Wi-Fi radio and the internet plan separately.
function StepExplain({ step: s, result: r, settings }) {
  const f = s.floor;
  const min = settings.minMbps;
  const usable = settings.wanDownMbps * (1 - settings.wanHeadroomPct / 100);
  const needed = (f.activeDevices ?? 0) * min;
  const airLimit = settings.targetUtilisation * 100;
  // with traffic profiles the minimum differs per device: no single figure per user
  const simple = settings.monteCarlo?.traffic !== "profiles";
  const perUser = simple ? (settings.devicesPerUser || 0) * (settings.activeFraction || 0) * min : 0;
  const busy = r.aps
    .map((a, i) => ({ name: a.name, over: s.aps[i]?.overloadPct ?? 0, air: s.aps[i]?.airtimeHighPct, reason: s.aps[i]?.overloadReason }))
    .filter((a) => a.over > 5)
    .sort((a, b) => b.over - a.over);
  const line = { margin: "2px 0", fontSize: 12, lineHeight: 1.4 };
  const users = (n) => `${Math.max(0, Math.floor(n))} users`;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={line}>
        <Badge status={s.status} /> <strong>{s.users} users</strong> · {fmt(f.activeDevices, 0)} active devices at a time
      </div>
      <div style={line}>
        <Badge status={s.wifiStatus} /> <strong>Wi-Fi:</strong>{" "}
        {f.wifiLowMbps >= min - 1e-9
          ? `every active user gets ${fmt(f.wifiAvgMbps)} Mbps (worst 5%: ${fmt(f.wifiLowMbps)}).`
          : `users get ${fmt(f.wifiAvgMbps)} Mbps on average, the worst 5% only ${fmt(f.wifiLowMbps)} (minimum ${min}).`}{" "}
        Busiest channel {fmt(f.airtimeMaxHighPct, 0)}% airtime (limit {fmt(airLimit, 0)}%).
        {busy.length > 0 && ` Overloaded: ${busy.slice(0, 3).map((a) => `${a.name} (${a.reason ?? "busy"}, ${fmt(a.over, 0)}% of runs)`).join(", ")}.`}
        {s.kpis.devices.status === "fail" && ` Up to ${fmt(s.kpis.devices.value, 0)} devices on one AP (limit ${settings.maxClientsPerAp}).`}
      </div>
      <div style={line}>
        <Badge status={s.internetStatus} /> <strong>Internet:</strong>{" "}
        {needed > usable
          ? `${fmt(f.activeDevices, 0)} devices × ${min} Mbps = ${fmt(needed, 0)} Mbps needed, ${fmt(usable, 0)} Mbps usable, so each user gets about ${fmt(f.netAvgMbps)} Mbps.`
          : `${fmt(needed, 0)} of ${fmt(usable, 0)} Mbps usable is needed at the minimum speed.`}
        {perUser > 0 && ` The plan carries about ${users(usable / perUser)} at ${min} Mbps.`}
      </div>
      {s.coverageStatus !== "pass" && (
        <div style={line}>
          <Badge status={s.coverageStatus} /> <strong>Coverage:</strong> {fmt(f.noSignalPct)}% of devices have no usable signal.
        </div>
      )}
    </div>
  );
}

// The maps shown first: the ones around the breaking point (a step before the
// limit, the last count that passes, the first that fails, a step after).
function aroundTheLimit(counts, res) {
  if (!counts.length) return [];
  const { maxSupportedUsers: max, firstFailUsers: fail, failsAtStart } = res || {};
  if (failsAtStart || max == null) return counts.slice(0, 4);
  if (fail == null) return counts.slice(-4);
  const before = counts.filter((u) => u < max).slice(-1);
  const after = counts.filter((u) => u > fail).slice(0, 1);
  return [...new Set([...before, max, fail, ...after])].filter((u) => counts.includes(u)).slice(0, 4);
}

// single: one number of users from the capacity simulation ({ users, floors, heat, step, aps }); otherwise the
// "find capacity limit" result with a map per number of users.
export function Heatmaps({ result: r, plan, settings, floorId, floorButtons, single = null, inputs = null }) {
  const hm = single ? null : r.heatmaps;
  const res = r?.result;
  // maps for numbers of users asked for here, on top of the test's own
  const [extra, setExtra] = useState({ heats: [], steps: [] });
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(null);
  const heats = useMemo(
    () => (hm ? [...hm.steps, ...extra.heats.filter((h) => !hm.steps.some((s) => s.users === h.users))].sort((a, b) => a.users - b.users) : []),
    [hm, extra],
  );
  const all = heats.map((s) => s.users);
  const stepRows = single ? [single.step] : [...(r.steps || []), ...extra.steps];
  const [map, setMap] = useState("throughput");
  const [afterNet, setAfterNet] = useState(false);
  const [rssiView, setRssiView] = useState(false);
  const [showDots, setShowDots] = useState(true);
  const [chosen, setChosen] = useState(() => (single ? [] : aroundTheLimit(hm ? hm.steps.map((s) => s.users) : [], res)));
  if (!hm && !single) return null;
  const grids = single ? single.floors : hm.floors;
  const grid = grids.find((g) => g.floorId === floorId);
  const stepsData = single ? [single.heat] : heats.filter((s) => chosen.includes(s.users));

  // a new choice beyond four replaces the one chosen longest ago
  const choose = (u) => setChosen((c) => (c.includes(u) ? c : [...c, u].slice(-4)));
  const toggle = (u) => setChosen((c) => (c.includes(u) ? c.filter((x) => x !== u) : [...c, u].slice(-4)));
  const askFor = () => {
    const u = Math.round(Number(ask));
    if (!(u > 0) || !inputs) return;
    if (all.includes(u)) return choose(u);
    setAsking({ users: u, error: null });
    runLoadTestHeatmap({ ...inputs, users: u })
      .then(({ result: out }) => {
        if (!out.heat) throw new Error("No map: the plan has no access points with a floor to map.");
        setExtra((x) => ({ heats: [...x.heats, out.heat], steps: [...x.steps, out.step] }));
        choose(u);
        setAsking(null);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setAsking({ users: u, error: err.message });
      });
  };
  const lt = { ...DEFAULT_LOAD_TEST, ...(settings.loadTest || {}), ...(single ? {} : r.settings || {}) };
  const airLimitPct = settings.targetUtilisation * 100;
  const wifiAps = plan.sources.filter((s) => s.kind === "wifi");
  const apIndex = new Map(wifiAps.map((a, i) => [a.id, i]));
  const limits = {
    minMbps: settings.minMbps,
    demandMbps: settings.demandMbpsPerActive,
    airLimitPct,
    airWarnPct: (airLimitPct * (lt.warnPct ?? 85)) / 100,
    assocColours: wifiAps.map((_, i) => apColour(i)),
    assocNames: wifiAps.map((a) => a.name || a.id),
  };
  const apsById = new Map(wifiAps.map((a) => [a.id, a]));
  const worst = (r?.worstLocations || []).map((w) => ({ ...w, label: `${w.failPct}% of active devices here miss their minimum (${w.apName})` }));
  const kpi = map === "signal" ? (rssiView ? "rssi" : "snr") : map;
  const signal = map === "signal";
  const valuesOf = (f) => {
    if (!f) return EMPTY;
    if (map === "throughput") return f[afterNet ? "achievableNet" : "achievable"] ?? EMPTY;
    if (map === "congestion") return f.air ?? EMPTY;
    if (map === "assoc") return (f.ap ?? EMPTY).map((id) => (id == null ? null : apIndex.get(id) ?? null));
    return EMPTY;
  };
  const dotsOf = (s) =>
    showDots && Array.isArray(s?.userDots)
      ? s.userDots.map((u) => ({ floorId: u.floorId, x: u.x, z: u.z, status: u.status, apId: u.apId, label: dotLabel(u), details: dotDetails(u) }))
      : EMPTY;

  return (
    <>
      <h3>{single ? `Maps for ${single.users} users` : "Maps by number of users"}</h3>
      <div className="button-row" role="tablist" aria-label="Map">
        {MAPS.map(([id, label]) => (
          <button key={id} type="button" className={map === id ? "active" : ""} onClick={() => setMap(id)}>{label}</button>
        ))}
      </div>
      {!single && !signal && (
        <>
          <small className="hint">Compare up to 4 numbers of users side by side. Shown first: the ones around the limit.</small>
          <div className="button-row" aria-label="Numbers of users to compare">
            {all.map((u) => (
              <button key={u} type="button" className={chosen.includes(u) ? "active" : ""} onClick={() => toggle(u)}>
                {u} users{u === res?.maxSupportedUsers ? " (max)" : u === res?.firstFailUsers ? " (fails)" : ""}
              </button>
            ))}
          </div>
          {inputs && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label className="field" style={{ maxWidth: 200 }}>
                <span>Any number of users</span>
                <input type="number" min={1} step={1} value={ask} placeholder="e.g. 60" onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && askFor()} />
              </label>
              <button type="button" onClick={askFor} disabled={!(Number(ask) > 0) || asking?.error === null}>
                {asking && asking.error === null ? `Calculating ${asking.users}…` : "Show its maps"}
              </button>
              {asking?.error && <span className="error">{asking.error}</span>}
            </div>
          )}
        </>
      )}
      {floorButtons}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <label className="check">
          <input type="checkbox" checked={showDots} onChange={(e) => setShowDots(e.target.checked)} />
          Users
        </label>
        {map === "throughput" && (
          <label className="check">
            <input type="checkbox" checked={afterNet} onChange={(e) => setAfterNet(e.target.checked)} />
            After the internet plan
          </label>
        )}
        {signal && (
          <label className="check">
            <input type="checkbox" checked={rssiView} onChange={(e) => setRssiView(e.target.checked)} />
            Show RSSI (dBm) instead of SNR
          </label>
        )}
        {showDots && (
          <small className="hint">
            <span style={{ color: DOT_COLOURS.ok }}>●</span> gets its demand · <span style={{ color: DOT_COLOURS["below demand"] }}>●</span> below demand ·{" "}
            <span style={{ color: DOT_COLOURS["below minimum"] }}>●</span> below minimum · <span style={{ color: DOT_COLOURS["no signal"] }}>●</span> no signal ·{" "}
            <span style={{ color: DOT_COLOURS.idle }}>●</span> idle. One simulated run; click a user to see its AP.
          </small>
        )}
      </div>
      <HeatLegend kpi={kpi} limits={limits} />
      {!grid ? (
        <p className="hint">No map for this floor (no access points on it).</p>
      ) : signal ? (
        // the signal does not change with the number of users: one map, with the users of the first count shown
        <KpiHeatmap plan={plan} floorId={floorId} grid={grid} values={grid[kpi]} aps={wifiAps} kpi={kpi} limits={limits} apsById={apsById}
          dots={dotsOf(stepsData[0])} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${stepsData.length > 1 ? 260 : 320}px, 1fr))`, gap: 10 }}>
          {stepsData.map((s) => {
            const f = s.floors.find((x) => x.floorId === floorId);
            const stepRow = stepRows.find((x) => x.users === s.users);
            return (
              <div key={s.users}>
                <KpiHeatmap plan={plan} floorId={floorId} grid={grid} apIds={f?.ap} values={valuesOf(f)} aps={wifiAps} kpi={kpi} limits={limits} apsById={apsById}
                  title={single ? null : `${s.users} users`} dots={dotsOf(s)} maxHeight={stepsData.length > 1 ? 300 : 460} />
                {stepRow && <StepExplain step={stepRow} result={single ? { aps: single.aps } : r} settings={settings} />}
              </div>
            );
          })}
          {stepsData.length === 0 && <p className="hint">Pick one or more numbers of users above.</p>}
        </div>
      )}
      {!single && worst.length > 0 && (
        <>
          <h4 style={{ marginBottom: 4 }}>Worst places at {res.firstFailUsers ?? res.testedUpToUsers} users</h4>
          <div style={{ overflowX: "auto" }}>
            <table className="compact-table" style={{ fontSize: 12, width: "100%" }}>
              <thead><tr style={{ textAlign: "left" }}><th>Floor</th><th>x, y (m)</th><th>Devices missing the minimum</th><th>Throughput there</th><th>AP</th></tr></thead>
              <tbody>
                {worst.map((w, i) => (
                  <tr key={i}>
                    <td>{plan.floors.find((f) => f.id === w.floorId)?.name ?? w.floorId}</td>
                    <td>{w.x}, {w.z}</td><td>{w.failPct}%</td><td>{fmt(w.availMbps)} Mbps</td><td>{w.apName ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
