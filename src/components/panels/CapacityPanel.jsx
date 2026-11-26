import React, { useEffect, useMemo, useState } from "react";
import CapacityMap, { apColour } from "../planner/CapacityMap.jsx";
import Field from "../ui/Field.jsx";
import { MonteCarloSettings } from "./MonteCarloCapacity.jsx";
import { LoadTestSettings } from "./LoadTest.jsx";
import CapacitySimulation from "./CapacitySimulation.jsx";
import {
  DEFAULT_CAPACITY_MODEL,
  STANDARDS,
  capacityLoadError,
  capacityReady,
  capacitySensitivity,
  isCapacityReady,
  maxWidthMHz,
  planWifiCapacity,
} from "../../infra/wifi/capacityModel.js";
import { areaOf, inside, pointsOf } from "../../utils/geometry.js";
import { formatArea } from "../../utils/measurementUnits.jsx";

// The capacity engine is WebAssembly and loads once, in the background.
function useCapacityEngine() {
  const [state, setState] = useState(() => (isCapacityReady() ? "ready" : "loading"));
  useEffect(() => {
    if (state === "ready") return;
    let live = true;
    capacityReady.then(
      () => live && setState("ready"),
      () => live && setState("failed"),
    );
    return () => {
      live = false;
    };
  }, [state]);
  return state;
}

const Tile = ({ label, value, unit, tone }) => (
  <div style={{ border: "1px solid var(--line, #d0d7de)", borderRadius: 8, padding: "8px 10px", minWidth: 120, flex: "1 1 120px" }}>
    <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? "#b91c1c" : tone === "ok" ? "#15803d" : undefined }}>
      {value}
      {unit && <span style={{ fontSize: 12, fontWeight: 400 }}> {unit}</span>}
    </div>
  </div>
);

const VERDICT = {
  internet: "The internet plan is too small",
  radio: "The Wi-Fi radio is the limit",
  coverage: "Some people have no usable signal",
};

// Capacity planning: two separate checks, the internet plan and the Wi-Fi radio.
// Separate from the coverage simulation, but it uses its ray-traced signal when
// that has been run. The settings are stored in plan.capacity.
export default function CapacityPanel({ plan, mutate, rtMaps = null }) {
  const settings = { ...DEFAULT_CAPACITY_MODEL, ...(plan.capacity || {}) };
  const set = (changes) => mutate((p) => ({ ...p, capacity: { ...DEFAULT_CAPACITY_MODEL, ...(p.capacity || {}), ...changes } }));
  const apCount = plan.sources.filter((s) => s.kind === "wifi").length;
  const engine = useCapacityEngine();
  const out = useMemo(
    () => (engine === "ready" ? planWifiCapacity({ plan, settings: plan.capacity || {}, cells: rtMaps }) : null),
    [engine, plan.rooms, plan.sources, plan.floors, plan.capacity, plan.boundaries, plan.furniture, rtMaps], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sens = useMemo(
    () => (engine === "ready" ? capacitySensitivity({ plan, settings: plan.capacity || {}, cells: rtMaps }) : null),
    [engine, plan.rooms, plan.sources, plan.floors, plan.capacity, plan.boundaries, plan.furniture, rtMaps], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const wifiAps = plan.sources.filter((s) => s.kind === "wifi");
  const [mapFloor, setMapFloor] = useState(null);
  const [view, setView] = useState("demand");
  const shownFloor = plan.floors.find((f) => f.id === mapFloor)?.id ?? plan.floors[0]?.id;
  if (!out || !sens) {
    return (
      <section className="panel">
        <h2>Capacity planning</h2>
        {engine === "failed" ? (
          <p className="error">The capacity engine did not load: {capacityLoadError()?.message || "unknown error"}. Reload the page; if it persists, rebuild it with npm run capacity:build.</p>
        ) : (
          <p className="hint">Loading the capacity engine…</p>
        )}
      </section>
    );
  }
  const floorButtons =
    plan.floors.length > 1 ? (
      <div className="button-row">
        {plan.floors.map((f) => (
          <button key={f.id} type="button" className={f.id === shownFloor ? "active" : ""} onClick={() => setMapFloor(f.id)}>{f.name}</button>
        ))}
      </div>
    ) : null;
  const zones = settings.zones || [];
  const setZone = (id, changes) => set({ zones: zones.map((z) => (z.id === id ? { ...z, ...changes } : z)) });
  const addZone = () =>
    set({ zones: [...zones, { id: `zone-${Date.now().toString(36)}`, floorId: shownFloor, name: `Zone ${zones.length + 1}`, x: 0, z: 0, width: 10, depth: 10, people: 0 }] });
  const leaf = (room) =>
    !plan.rooms.some((o) => o.id !== room.id && o.floorId === room.floorId && pointsOf(o).every((p) => inside(p.x, p.z, room)) && areaOf(o) < areaOf(room));
  const setRoomUsers = (roomId, value) => {
    const next = { ...(settings.roomUsers || {}) };
    if (value === "" || value == null) delete next[roomId];
    else next[roomId] = Number(value);
    set({ roomUsers: next });
  };
  const num = (key, min = 0, max = Infinity) => (v) => set({ [key]: Math.max(min, Math.min(max, v)) });
  const w = out.wan;
  const widths = [20, 40, 80, 160, 320].filter((x) => x <= maxWidthMHz(settings.standard, settings.band));

  // Each tab pairs a group of inputs (left) with the results they drive (right),
  // so a change shows its effect at once.
  const tabs = [
    ["demand", "Demand & internet"],
    ["wifi", "Wi-Fi & access points"],
    // one simulation (one engine) for "is this headcount OK?" and "how many can the APs carry?"
    ["simulation", "Capacity simulation"],
  ];
  const shown = (id) => (view === id ? {} : { display: "none" });

  return (
    <>
    <h2 style={{ margin: "0 0 12px" }}>Capacity planning</h2>
    <div className="segmented" role="tablist" aria-label="Capacity view" style={{ marginBottom: 12 }}>
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
          {label}
        </button>
      ))}
    </div>
    {/* All tabs stay mounted, so a finished simulation survives a tab switch. */}
    <div className="panel-grid capacity-grid" style={shown("demand")}>
      <section className="panel">
        <h2>Demand</h2>
        <h3>People and traffic</h3>
        <div className="inspector-fields">
          <Field label="Number of people (blank = estimate from the density)" type="number" value={settings.totalPeople ?? ""}
            onChange={(v) => set({ totalPeople: v > 0 ? Math.round(v) : null })} />
          {settings.totalPeople == null && (
            <Field label="People per m² of room" type="number" measurement="density" value={settings.usersPerM2} onChange={num("usersPerM2")} />
          )}
          <Field label="Devices per person" type="number" value={settings.devicesPerUser} onChange={num("devicesPerUser")} />
          <Field label="Active at a time (%)" type="number" value={Math.round(settings.activeFraction * 100)} onChange={(v) => set({ activeFraction: Math.max(0, Math.min(100, v)) / 100 })} />
          <Field label="Minimum speed per active device (Mbps)" type="number" value={settings.minMbps} onChange={num("minMbps")} />
          <Field label="Typical speed (Mbps)" type="number" value={settings.demandMbpsPerActive} onChange={num("demandMbpsPerActive")} />
          <Field label="Peak speed (Mbps)" type="number" value={settings.peakMbps} onChange={num("peakMbps")} />
        </div>

        <h3>Internet plan</h3>
        <div className="inspector-fields">
          <Field label="Download (Mbps)" type="number" value={settings.wanDownMbps} onChange={num("wanDownMbps", 1)} />
          <Field label="Upload (Mbps)" type="number" value={settings.wanUpMbps} onChange={num("wanUpMbps", 1)} />
          <Field label="Kept spare (%)" type="number" value={settings.wanHeadroomPct} onChange={num("wanHeadroomPct", 0, 90)} />
          <Field label="Upload as share of download (%)" type="number" value={Math.round(settings.uploadShare * 100)} onChange={(v) => set({ uploadShare: Math.max(0, Math.min(100, v)) / 100 })} />
        </div>
      </section>
      <section className="panel">
        <h2>Internet result</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Tile label="Usable download" value={w.usableDownMbps} unit="Mbps" />
          <Tile label="Needed at the minimum speed" value={w.demandMinMbps} unit="Mbps" tone={w.sufficientForMin ? "ok" : "bad"} />
          <Tile label="Active devices" value={w.activeDevices} />
          <Tile label="Demand / usable" value={w.downVsMinPct ?? "-"} unit="%" tone={w.sufficientForMin ? "ok" : "bad"} />
        </div>
        <small className="hint">
          Plan {w.planDownMbps} Mbps with {w.headroomPct}% kept spare. If every active device ran at its peak, {w.demandPeakMbps} Mbps
          would be needed{w.sufficientForPeak ? " (the plan covers that)" : ""}. Upload need at the minimum speed: {w.upDemandMinMbps} Mbps of {w.usableUpMbps} Mbps.
        </small>

        <h3>If the assumptions are wrong</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 13, width: "100%" }} className="compact-table">
            <thead>
              <tr style={{ whiteSpace: "nowrap", textAlign: "left" }}>
                <th>Case</th><th>People</th><th>Active</th><th>Needs</th><th>Plan needed</th><th>Meet {settings.minMbps} Mbps</th><th>Busy APs</th><th>Limit</th>
              </tr>
            </thead>
            <tbody>
              {sens.map((r) => (
                <tr key={r.label} style={{ whiteSpace: "nowrap" }}>
                  <td>{r.label}</td><td>{r.people}</td><td>{r.activeDevices}</td><td>{r.demandMinMbps} Mbps</td><td>{Math.ceil(r.neededPlanMbps)} Mbps</td>
                  <td className={r.meetingMinimumPct != null && r.meetingMinimumPct < 100 ? "error" : ""}>{r.meetingMinimumPct ?? "-"}%</td>
                  <td>{r.overloadedAps}</td>
                  <td>{r.verdict.length ? r.verdict.map((k) => ({ internet: "internet", radio: "radio", coverage: "coverage" })[k]).join(", ") : "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details>
          <summary>Assumptions</summary>
          {out.assumptions.map((t, i) => (
            <small key={i} className="hint">{t}</small>
          ))}
        </details>
      </section>
    </div>

    <div className="panel-grid capacity-grid" style={shown("wifi")}>
      <section className="panel">
        <h2>Wi-Fi radio</h2>
        <div className="inspector-fields">
          <Field label="Wi-Fi standard" type="select" value={settings.standard} options={Object.keys(STANDARDS)} optionLabels={STANDARDS}
            onChange={(v) => set({ standard: v, widthMHz: Math.min(settings.widthMHz, maxWidthMHz(v, settings.band)) })} />
          <Field label="Band" type="select" value={settings.band} options={["2.4", "5", "6"]} optionLabels={{ "2.4": "2.4 GHz", 5: "5 GHz", 6: "6 GHz" }}
            onChange={(v) => set({ band: v, widthMHz: Math.min(settings.widthMHz, maxWidthMHz(settings.standard, v)) })} />
          <Field label="Channel width (MHz)" type="select" value={String(Math.min(settings.widthMHz, maxWidthMHz(settings.standard, settings.band)))}
            options={widths.map(String)} onChange={(v) => set({ widthMHz: Number(v) })} />
          <Field label="AP streams" type="number" value={settings.apStreams} onChange={(v) => set({ apStreams: Math.max(1, Math.min(8, Math.round(v))) })} />
          <Field label="Device streams" type="number" value={settings.clientStreams} onChange={(v) => set({ clientStreams: Math.max(1, Math.min(4, Math.round(v))) })} />
          <Field label="Real speed as % of data rate" type="number" value={Math.round(settings.macEfficiency * 100)} onChange={(v) => set({ macEfficiency: Math.max(10, Math.min(95, v)) / 100 })} />
          <Field label="Highest airtime use (%)" type="number" value={Math.round(settings.targetUtilisation * 100)} onChange={(v) => set({ targetUtilisation: Math.max(1, Math.min(100, v)) / 100 })} />
          <Field label="Most devices on one AP" type="number" value={settings.maxClientsPerAp} onChange={(v) => set({ maxClientsPerAp: Math.max(1, Math.round(v)) })} />
          <Field label="Devices join" type="select" value={settings.association} options={["strongest", "load-aware"]}
            optionLabels={{ strongest: "The strongest AP", "load-aware": "A less busy AP if nearly as strong" }} onChange={(v) => set({ association: v })} />
          {settings.association === "load-aware" && (
            <Field label="Counts as nearly as strong (dB)" type="number" value={settings.roamMarginDb} onChange={num("roamMarginDb", 0, 30)} />
          )}
          <Field label="APs closer than this share a channel (m)" type="number" value={settings.interferenceM} onChange={num("interferenceM", 1)} />
        </div>

        <h3>Where the people are</h3>
        <small className="hint">
          Spread over the whole floor, rooms and open space. A device can join any AP it
          can hear, so rooms only change how many people a place holds.
        </small>
        <div className="inspector-fields">
          <Field label="Spread" type="select" value={settings.distribution} options={["uniform", "furniture"]}
            optionLabels={{ uniform: "Evenly over the floor", furniture: "More near desks and seats" }} onChange={(v) => set({ distribution: v })} />
          {settings.distribution === "furniture" && (
            <Field label="Desk and seat weight (x)" type="number" value={settings.seatWeight} onChange={num("seatWeight", 1, 100)} />
          )}
        </div>
        <details open={zones.length > 0}>
          <summary>Zones with their own headcount ({zones.length})</summary>
          <small className="hint">A zone holds exactly that many people. A zone with 0 people is empty (lift shaft, plant room, void).</small>
          {zones.map((z) => (
            <div key={z.id} className="opt-section">
              <div className="inspector-fields">
                <Field label="Name" value={z.name} onChange={(v) => setZone(z.id, { name: v })} />
                <Field label="Floor" type="select" value={z.floorId} options={plan.floors.map((f) => f.id)}
                  optionLabels={Object.fromEntries(plan.floors.map((f) => [f.id, f.name]))} onChange={(v) => setZone(z.id, { floorId: v })} />
                <Field label="People (0 = nobody)" type="number" value={z.people} onChange={(v) => setZone(z.id, { people: Math.max(0, Math.round(v)) })} />
                <Field label="x (m)" type="number" value={z.x} onChange={(v) => setZone(z.id, { x: v })} />
                <Field label="z (m)" type="number" value={z.z} onChange={(v) => setZone(z.id, { z: v })} />
                <Field label="Width (m)" type="number" value={z.width} onChange={(v) => setZone(z.id, { width: Math.max(0.5, v) })} />
                <Field label="Depth (m)" type="number" value={z.depth} onChange={(v) => setZone(z.id, { depth: Math.max(0.5, v) })} />
              </div>
              <button type="button" onClick={() => set({ zones: zones.filter((x) => x.id !== z.id) })}>Remove zone</button>
            </div>
          ))}
          <button type="button" onClick={addZone}>Add a zone</button>
        </details>

        <details>
          <summary>People in a particular room (overrides the density)</summary>
          {plan.rooms.filter(leaf).map((room) => (
            <Field key={room.id} label={room.name || "Room"} type="number" value={settings.roomUsers?.[room.id] ?? ""}
              onChange={(v) => setRoomUsers(room.id, v === 0 ? "" : v)} />
          ))}
        </details>
      </section>
      <section className="panel">
        <h2>Access point result</h2>
        {out.aps.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 13, width: "100%" }} className="compact-table">
                <thead>
                  <tr style={{ whiteSpace: "nowrap", textAlign: "left" }}>
                    <th>AP</th><th title="expected devices (expected active)">Devices (active)</th><th title="average data rate of its devices">Rate</th>
                    <th title="airtime used at the typical speed">Air use</th><th>Internet share</th><th>Per device</th>
                    <th title="share of active devices that get the minimum speed">Meet {settings.minMbps} Mbps</th><th>Ch.</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {out.aps.map((r) => (
                    <tr key={r.id} style={{ whiteSpace: "nowrap" }}>
                      <td>{r.name}</td>
                      <td>{r.devices} ({r.activeDevices})</td>
                      <td>{r.avgRateMbps} Mbps</td>
                      <td title={`at the minimum speed ${r.airtimeMinPct}%, at peak ${r.airtimePeakPct}%${r.sharedWith ? `; shares the air with ${r.sharedWith} nearby AP(s): ${r.sharedAirtimeMinPct}% at the minimum speed` : ""}`}>{r.airtimeTypicalPct}%</td>
                      <td>{r.internetShareMbps} Mbps</td>
                      <td>{r.perDeviceMbps != null ? `${r.perDeviceMbps} Mbps` : "-"}</td>
                      <td className={r.meetsMinimumPct != null && r.meetsMinimumPct < 100 ? "error" : ""}>{r.meetsMinimumPct != null ? `${r.meetsMinimumPct}%` : "-"}</td>
                      <td>{r.channel ?? "-"}</td>
                      <td className={r.status === "ok" ? "" : "error"} style={{ whiteSpace: "normal", minWidth: 150 }}>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {out.summary.meetingMinimumPct != null && (
          <p>
            About <strong>{out.summary.meetingMinimumPct}%</strong> of active devices get at least {settings.minMbps} Mbps (radio and internet together).
          </p>
        )}
        {out.aps.length === 0 && <p className="hint">No access points to check yet.</p>}
        <h3>Who joins which AP</h3>
        {out.clients.length > 0 && (
          <>
            {floorButtons}
            <CapacityMap plan={plan} floorId={shownFloor} clients={out.clients} aps={wifiAps} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, marginTop: 6 }}>
              {wifiAps.filter((a) => a.floorId === shownFloor).map((a) => (
                <span key={a.id}><span style={{ display: "inline-block", width: 10, height: 10, background: apColour(wifiAps.indexOf(a)), marginRight: 4 }} />{a.name}</span>
              ))}
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#dc2626", marginRight: 4 }} />no usable signal</span>
              <span>darker = more people</span>
            </div>
          </>
        )}

        {out.clients.length === 0 && <p className="hint">Nobody to place yet: add access points and people.</p>}
        <small className="hint">
          Signal: {out.source}. {out.source !== "ray-traced" ? "Run the ray-traced prediction on the Network & RF tab for a better result." : ""}
        </small>
      </section>
    </div>

    <div className="panel-grid capacity-grid" style={shown("simulation")}>
      <section className="panel">
        <MonteCarloSettings settings={settings} set={set} compact />
        <LoadTestSettings settings={settings} set={set} title="Targets and capacity limit" />
      </section>
      <section className="panel">
        <CapacitySimulation plan={plan} settings={settings} rtMaps={rtMaps} wifiAps={wifiAps} floorId={shownFloor} floorButtons={floorButtons} mutate={mutate} />
      </section>
    </div>
    <section className="panel" style={{ marginTop: 16 }}>
      <h2>Summary</h2>
        <p className="panel-note">
          Two separate checks: whether the <strong>internet plan</strong> can carry what the
          devices need, and whether the <strong>Wi-Fi radio</strong> of each access point can
          serve them. More access points never raise the internet speed. These are planning
          estimates from the assumptions in the tabs above: replace them with the client's figures.
        </p>
        {apCount === 0 && <p className="warn">The plan has no access points yet.</p>}
        {out.bottleneck.verdict.length > 0 ? (
          <p className="error"><strong>{out.bottleneck.verdict.map((k) => VERDICT[k]).join(" · ")}</strong></p>
        ) : (
          <p className="ok"><strong>No bottleneck found for these assumptions</strong></p>
        )}
        <p className="hint">
          {out.summary.totalUsers} people over {formatArea(out.summary.floorAreaM2, plan.property?.unit || "m")} of floor → {out.wan.totalDevices} devices → about {out.wan.activeDevices} active at a time.
          Counts are expected loads, so they can be fractions; the Capacity simulation tab places whole users instead.
          {settings.totalPeople == null ? " People are estimated from the density; enter the number of people for a real occupancy." : ""}
        </p>
        {out.notes.map((t, i) => (
          <p key={i} className="warn">{t}</p>
        ))}
        <details open={out.bottleneck.verdict.length > 0}>
          <summary>What to do ({out.recommendations.length})</summary>
          {out.recommendations.map((t, i) => (
            <p key={i} className={out.bottleneck.verdict.length ? "warn" : "hint"}>{t}</p>
          ))}
        </details>
    </section>
    </>
  );
}
