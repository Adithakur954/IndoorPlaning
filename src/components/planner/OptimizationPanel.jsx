import React from "react";
import Field from "../ui/Field.jsx";
import NoiseSettings from "./NoiseSettings.jsx";
import { eirpDbm, profileWarnings } from "../../config/apProfiles.js";
import {
  ACCURACY_PRESETS,
  AP_ROLES,
  THRESHOLD_PRESETS,
  bandOfMHz,
  handlingOf,
  roleOf,
  stringentWarning,
} from "../../hooks/useApOptimization.js";
import { REJECTION_REASONS } from "../../utils/apCandidates.js";
import { timeLabel } from "../../utils/savedResults.js";
import { clearCache, getCacheInfo } from "../../services/maintenance.js";

const pct = (v) => (v == null ? "–" : `${v.toFixed(1)}%`);

// Size of the service's row cache, with a button to empty it. The rows are what
// makes a rerun fast; a saved result does not depend on them.
function CacheControl() {
  const [info, setInfo] = React.useState(null);
  const [note, setNote] = React.useState("");
  const refresh = () =>
    getCacheInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  React.useEffect(() => {
    refresh();
  }, []);
  if (!info) return null;
  const mb = (info.bytes / 1e6).toFixed(1);
  return (
    <div className="cache-control">
      <small className="hint">
        Cache for faster reruns: {mb} MB of {info.limitMb} MB
        {note && ` · ${note}`}
      </small>
      <button
        type="button"
        disabled={!info.bytes}
        onClick={() =>
          clearCache()
            .then((r) => {
              setNote(`freed ${(r.freedBytes / 1e6).toFixed(1)} MB`);
              refresh();
            })
            .catch((e) => setNote(e.message))
        }
      >
        Clear cache
      </button>
    </div>
  );
}

export default function OptimizationPanel({
  plan,
  optimization: o,
  setSelectedFloor,
  setTab,
}) {
  const { settings, patch, profile, radio, run, busy, opt } = o;
  const warnings = profileWarnings(profile, settings.band);
  const strict = stringentWarning(settings.thresholdDbm);
  const wifiAps = plan.sources.filter((s) => s.kind === "wifi");
  const stats = o.candidates?.stats;
  const handling = handlingOf(settings);
  const reuse = handling === "reuse";

  return (
    <>
      <p className="panel-note">
        Finds how many APs are needed and where to mount them, from ray-traced
        coverage on real wall and ceiling positions. Your existing APs are never
        changed until you press <strong>Apply</strong>.
      </p>
      {opt && <OutputBandSelector o={o} />}

      <section className="opt-section">
        <h4>AP profile</h4>
        <small className="hint">
          {profile.name} · {settings.band} GHz · EIRP{" "}
          {eirpDbm(radio).toFixed(1)} dBm · channel {radio.channel}
        </small>
        {warnings.map((w) => (
          <small key={w} className="warn">
            ⚠ {w}
          </small>
        ))}
        <div className="field">
          <span>Bands to optimise</span>
          {["2.4", "5", "6"]
            .filter((b) => profile.bands[b])
            .map((b) => (
              <label key={b} className="check">
                <input
                  type="checkbox"
                  checked={settings.bands.includes(b)}
                  onChange={(e) =>
                    patch({
                      bands: e.target.checked
                        ? [...settings.bands, b]
                        : settings.bands.filter((x) => x !== b),
                    })
                  }
                />{" "}
                {b} GHz
              </label>
            ))}
          <small className="hint">
            Each ticked band is planned on its own with its own APs, then
            compared. {wifiAps.length === 0 &&
              "Your plan has no APs yet, so each band shows where to place new ones and the coverage they give."}
          </small>
        </div>
        {wifiAps.some((s) => !settings.bands.includes(bandOfMHz(s.freqMHz))) && (
          <small className="warn">
            ⚠ Some of your existing APs are on a band you did not tick. They
            are left out of the run, so removing them from the plan is not
            part of the result.
          </small>
        )}
        <div className="button-row">
          <button type="button" onClick={() => setTab("network")}>
            Edit Wi-Fi AP properties in Network &amp; RF
          </button>
        </div>
      </section>

      <section className="opt-section">
        <h4>Target</h4>
        <Field
          label="Required signal (dBm)"
          type="number"
          value={settings.thresholdDbm}
          onChange={(v) => patch({ thresholdDbm: v })}
        />
        <div className="button-row">
          {THRESHOLD_PRESETS.map((t) => (
            <button
              key={t}
              type="button"
              className={settings.thresholdDbm === t ? "active" : ""}
              onClick={() => patch({ thresholdDbm: t })}
            >
              {t}
            </button>
          ))}
        </div>
        {strict && <small className="warn">⚠ {strict}</small>}
        <div className="segmented" role="group" aria-label="Objective">
          <button
            type="button"
            className={settings.objective === "min-aps" ? "active" : ""}
            onClick={() => patch({ objective: "min-aps" })}
          >
            Fewest APs for target
          </button>
          <button
            type="button"
            className={settings.objective === "max-coverage" ? "active" : ""}
            onClick={() => patch({ objective: "max-coverage" })}
          >
            Best with AP budget
          </button>
        </div>
        {settings.objective === "min-aps" ? (
          <>
            <Field
              label="Coverage target (%)"
              type="number"
              value={settings.targetCoveragePct}
              onChange={(v) =>
                patch({ targetCoveragePct: Math.min(100, Math.max(1, v)) })
              }
            />
            <div className="button-row">
              {[90, 95, 99].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={settings.targetCoveragePct === t ? "active" : ""}
                  onClick={() => patch({ targetCoveragePct: t })}
                >
                  {t}%
                </button>
              ))}
            </div>
          </>
        ) : reuse && !settings.allowNewAps ? (
          <small className="hint">
            With no new APs allowed, the result never has more APs than you have
            now ({wifiAps.length}).
          </small>
        ) : (
          <Field
            label={reuse ? "Extra APs allowed" : "New APs allowed"}
            type="number"
            value={settings.budget}
            onChange={(v) => patch({ budget: Math.max(0, Math.round(v)) })}
          />
        )}
        <Field
          label="APs reaching each point"
          type="number"
          value={settings.redundancy}
          onChange={(v) =>
            patch({ redundancy: Math.min(4, Math.max(1, Math.round(v))) })
          }
        />
      </section>

      {wifiAps.length > 0 && (
        <section className="opt-section">
          <h4>Existing APs ({wifiAps.length})</h4>
          {[
            ["fixed", "Keep all of them; add new APs only where needed"],
            ["reuse", "Use my existing APs: keep, move or remove them"],
            ["ignore", "Start from scratch (ignore them)"],
          ].map(([value, label]) => (
            <label key={value} className="check">
              <input
                type="radio"
                name="existing"
                checked={handling === value}
                onChange={() => patch({ existingHandling: value })}
              />
              {label}
            </label>
          ))}
          {reuse && (
            <>
              <small className="hint">
                The optimiser picks only as many of your APs as are enough and
                puts each one where it helps most. Choose per AP what it may do.
              </small>
              {wifiAps.map((ap) => (
                <div key={ap.id} className="room-target">
                  <span title={ap.name}>{ap.name}</span>
                  <select
                    value={roleOf(settings, ap.id)}
                    onChange={(e) =>
                      patch({
                        apRoles: { ...settings.apRoles, [ap.id]: e.target.value },
                      })
                    }
                  >
                    {AP_ROLES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.allowNewAps}
                  onChange={(e) => patch({ allowNewAps: e.target.checked })}
                />
                Allow adding new APs if these are not enough
              </label>
            </>
        )}
      </section>
      )}

      <section className="opt-section">
        <h4>Mounting</h4>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.mounting.wall}
            onChange={(e) =>
              patch({
                mounting: { ...settings.mounting, wall: e.target.checked },
              })
            }
          />
          Wall-mounted (height {settings.wallHeightM} m)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.mounting.ceiling}
            onChange={(e) =>
              patch({
                mounting: { ...settings.mounting, ceiling: e.target.checked },
              })
            }
          />
          Ceiling-mounted
        </label>
        <small className="hint">
          Rooms can be excluded from mounting in their properties (AP mounting).
        </small>
        <details>
          <summary>Spacing and clearance</summary>
          <div className="inspector-fields">
            <Field
              label="Wall height (m)"
              type="number"
              value={settings.wallHeightM}
              onChange={(v) => patch({ wallHeightM: v })}
            />
            <Field
              label="Wall spacing (m)"
              type="number"
              value={settings.wallSpacingM}
              onChange={(v) => patch({ wallSpacingM: Math.max(0.5, v) })}
            />
            <Field
              label="Ceiling spacing (m)"
              type="number"
              value={settings.ceilingSpacingM}
              onChange={(v) => patch({ ceilingSpacingM: Math.max(1, v) })}
            />
            <Field
              label="Corner clearance (m)"
              type="number"
              value={settings.cornerClearanceM}
              onChange={(v) => patch({ cornerClearanceM: v })}
            />
            <Field
              label="Door/window clearance (m)"
              type="number"
              value={settings.openingClearanceM}
              onChange={(v) => patch({ openingClearanceM: v })}
            />
            <Field
              label="Min. distance between new APs (m)"
              type="number"
              value={settings.minApSeparationM}
              onChange={(v) => patch({ minApSeparationM: v })}
            />
          </div>
        </details>
        <label className="check">
          <input
            type="checkbox"
            checked={o.previewOn}
            onChange={(e) => o.setPreviewOn(e.target.checked)}
          />
          Preview candidate positions on the plan
        </label>
        {stats && (
          <details open>
            <summary>
              {stats.valid} valid, {stats.rejected} rejected positions
            </summary>
            {Object.entries(stats.byReason).map(([k, n]) => (
              <small key={k} className="hint">
                {n} × {REJECTION_REASONS[k]}
              </small>
            ))}
            <small className="hint">
              Green dots are valid; red crosses are rejected, with the reason on
              hover.
            </small>
          </details>
        )}
      </section>

      <section className="opt-section">
        <h4>Receiver and accuracy</h4>
        {o.setNoiseSettings && <NoiseSettings settings={o.noiseSettings} setSettings={o.setNoiseSettings} />}
        <div className="inspector-fields">
          <Field
            label="Device height (m)"
            type="number"
            value={settings.receiverHeightM}
            onChange={(v) => patch({ receiverHeightM: v })}
          />
          <Field
            label="Grid resolution (m)"
            type="number"
            value={settings.resolutionM}
            onChange={(v) => patch({ resolutionM: Math.max(0.25, v) })}
          />
        </div>
        <div className="segmented" role="group" aria-label="Accuracy">
          {Object.keys(ACCURACY_PRESETS).map((key) => (
            <button
              key={key}
              type="button"
              className={settings.accuracy === key ? "active" : ""}
              onClick={() =>
                patch({
                  accuracy: key,
                  resolutionM: ACCURACY_PRESETS[key].resolutionM,
                })
              }
            >
              {key}
            </button>
          ))}
        </div>
        <small className="hint">
          {ACCURACY_PRESETS[settings.accuracy].samplesPerTx.toLocaleString()}{" "}
          rays per AP, depth {ACCURACY_PRESETS[settings.accuracy].maxDepth}.
          Finer grids and more rays take longer.
        </small>
        <Field
          label="Device"
          value={settings.device}
          options={["auto", "gpu", "cpu"]}
          onChange={(v) => patch({ device: v })}
        />
        <details>
          <summary>Floors and rooms in the target</summary>
          {plan.floors.map((f) => (
            <label key={f.id} className="check">
              <input
                type="checkbox"
                checked={!settings.excludedFloors.includes(f.id)}
                onChange={(e) =>
                  patch({
                    excludedFloors: e.target.checked
                      ? settings.excludedFloors.filter((id) => id !== f.id)
                      : [...settings.excludedFloors, f.id],
                  })
                }
              />
              {f.name}
            </label>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={settings.includeCommonArea}
              onChange={(e) => patch({ includeCommonArea: e.target.checked })}
            />
            Halls and common areas
          </label>
          {plan.rooms.map((r) => {
            const ov = settings.roomOverrides[r.id] || {};
            const set = (changes) =>
              patch({
                roomOverrides: {
                  ...settings.roomOverrides,
                  [r.id]: { ...ov, ...changes },
                },
              });
            return (
              <div key={r.id} className="room-target">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={ov.include !== false}
                    onChange={(e) => set({ include: e.target.checked })}
                  />
                  {r.name}
                </label>
                <input
                  type="number"
                  placeholder={String(settings.thresholdDbm)}
                  title="Required signal for this room (dBm); empty = the main target"
                  value={ov.thresholdDbm ?? ""}
                  onChange={(e) =>
                    set({
                      thresholdDbm:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
                <input
                  type="number"
                  placeholder="1"
                  title="Weight of this room's area"
                  value={ov.weight ?? ""}
                  onChange={(e) =>
                    set({
                      weight:
                        e.target.value === ""
                          ? 1
                          : Math.max(0, Number(e.target.value)),
                    })
                  }
                />
              </div>
            );
          })}
        </details>
      </section>

      {busy ? (
        <div className="opt-run">
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={Math.round((run.fraction || 0) * 100)}
          >
            <i style={{ width: `${Math.round((run.fraction || 0) * 100)}%` }} />
          </div>
          <small>{run.phase}…</small>
          <button type="button" onClick={o.cancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="primary" type="button" onClick={o.start}>
          {opt ? "Run optimisation again" : "Find AP placement"}
        </button>
      )}
      <label
        className="check"
        title="Ignore any saved result and cache and simulate everything again"
      >
        <input
          type="checkbox"
          checked={o.fresh}
          onChange={(e) => o.setFresh(e.target.checked)}
        />
        Recompute everything (ignore saved results and cache)
      </label>
      <small className="hint">
        All bands from the latest run are saved with the project. A new run
        replaces the previous comparison.
      </small>
      {o.restoreNote && <p className="error">{o.restoreNote}</p>}
      {run?.error && <p className="error">{run.error}</p>}
      <CacheControl />

      {opt && (
        <OptimizationResults
          plan={plan}
          o={o}
          setSelectedFloor={setSelectedFloor}
        />
      )}
    </>
  );
}

function OptimizationResults({ plan, o, setSelectedFloor }) {
  const { opt } = o;
  const r = opt.result;
  const outcome = r.outcome;
  return (
    <section className="opt-results">
      <h4>Result</h4>
      {Object.keys(o.altRuns).length > 1 && <BandComparison o={o} />}
      <p className={outcome.targetAchieved ? "ok" : "warn"}>
        {outcome.message}
      </p>
      {o.stale && (
        <p className="error">The plan changed after this run. Run it again.</p>
      )}
      {o.modelOutdated && (
        <p className="error">
          The simulation model was updated after this run. Run it again to get
          results from the current model.
        </p>
      )}
      {opt.finishedAt && (
        <small className="hint">Latest run: {timeLabel(opt.finishedAt)}</small>
      )}
      <div className="compare">
        <div>
          <small>Before</small>
          <strong>{pct(r.before.coveragePct)}</strong>
          <small>{outcome.existingApCount} existing AP(s)</small>
        </div>
        <div>
          <small>After</small>
          <strong>{pct(r.after.coveragePct)}</strong>
          <small>
            {outcome.finalApCount != null
              ? `${outcome.finalApCount} AP(s)`
              : `+${outcome.newApCount} new AP(s)`}
            {outcome.removedApCount > 0 &&
              ` (${outcome.removedApCount} removed)`}
          </small>
        </div>
      </div>
      <small className="hint">
        Coverage = share of the target area where {r.settings.redundancy} AP(s)
        reach {opt.threshold} dBm at {r.settings.receiver_height_m ?? 1.5} m
        (area weighted). Best achievable with these positions:{" "}
        {pct(outcome.bestAchievableWithCandidatesPct)}.
      </small>

      <div className="segmented" role="group" aria-label="Show">
        {[
          ["after", "After"],
          ["before", "Before"],
          ["off", "Hide"],
        ].map(([v, label]) => (
          <button
            key={v}
            type="button"
            className={o.show === v ? "active" : ""}
            onClick={() => {
              o.setShow(v);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="Colours">
        <button
          type="button"
          className={o.view === "signal" ? "active" : ""}
          onClick={() => o.setView("signal")}
        >
          Signal level
        </button>
        <button
          type="button"
          className={o.view === "coverage" ? "active" : ""}
          onClick={() => o.setView("coverage")}
        >
          Covered / not
        </button>
      </div>

      {!!r.existingActions?.length && (
        <>
          <h4>What happens to your existing APs</h4>
          {r.existingActions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="source-list-item"
              onClick={() => setSelectedFloor(a.floorId)}
            >
              <strong>
                {a.name} ·{" "}
                {
                  {
                    keep: "keep",
                    move: "move",
                    remove: "remove",
                    fixed: "fixed (locked)",
                  }[a.action]
                }
              </strong>
              {a.action === "move" && (
                <small>
                  from x {a.from.x.toFixed(1)} z {a.from.z.toFixed(1)} to x{" "}
                  {a.to.x.toFixed(1)} z {a.to.z.toFixed(1)}
                  {a.to.room ? ` (${a.to.room})` : ""}
                </small>
              )}
              {a.action === "remove" && (
                <small>
                  not needed at x {a.from.x.toFixed(1)} z {a.from.z.toFixed(1)}
                </small>
              )}
            </button>
          ))}
        </>
      )}
      <h4>{r.existingActions?.length ? "New APs" : "Recommended APs"}</h4>
      {r.recommendations
        .filter((rec) => !r.existingActions?.length || rec.action === "new")
        .map((rec) => (
          <button
            key={rec.candidateId}
            type="button"
            className="source-list-item"
            onClick={() => setSelectedFloor(rec.floorId)}
          >
            <span className="opt-badge">{rec.rank}</span>
            <strong>
              {rec.floor} · {rec.room || "Common area"}
            </strong>
            <small>
              {rec.kind === "ceiling"
                ? "ceiling"
                : rec.kind === "existing"
                  ? "at its current spot"
                  : `wall ${rec.wallSide || ""}`.trim()}{" "}
              · x {rec.planX.toFixed(1)} z {rec.planZ.toFixed(1)} ·{" "}
              {rec.heightM} m · +{rec.marginalCoveragePct.toFixed(1)}% →{" "}
              {rec.cumulativeCoveragePct.toFixed(1)}%
            </small>
          </button>
        ))}
      {!r.recommendations.some(
        (rec) => !r.existingActions?.length || rec.action === "new",
      ) && <small className="hint">No new APs are needed.</small>}

      <h4>Coverage by floor</h4>
      {r.after.perFloor.map((f, i) => (
        <div key={f.floorId} className="metric-row">
          <strong>{f.floor}</strong>
          <small>
            {pct(r.before.perFloor[i]?.coveragePct)} → {pct(f.coveragePct)}
          </small>
        </div>
      ))}
      <details>
        <summary>Coverage by room</summary>
        {r.after.perRoom.map((room, i) => (
          <div key={room.roomId || "common"} className="metric-row">
            <strong>{room.room}</strong>
            <small>
              {pct(
                r.before.perRoom.find((b) => b.roomId === room.roomId)
                  ?.coveragePct,
              )}{" "}
              → {pct(room.coveragePct)}
            </small>
          </div>
        ))}
      </details>
      {!!r.weakZones.length && (
        <details>
          <summary>Largest uncovered zones</summary>
          {r.weakZones.map((z, i) => (
            <button
              key={i}
              type="button"
              className="source-list-item"
              onClick={() => setSelectedFloor(z.floorId)}
            >
              <strong>{z.floor}</strong>
              <small>
                {z.areaM2} m² near x {z.centroid.x}, z {z.centroid.z}
              </small>
            </button>
          ))}
        </details>
      )}

      <div className="button-row">
        <button
          className="primary"
          type="button"
          onClick={() => {
            const acts = r.existingActions || [];
            const moved = acts.filter((a) => a.action === "move").length;
            const removed = acts.filter((a) => a.action === "remove").length;
            if (
              (moved || removed) &&
              !window.confirm(
                `Apply will move ${moved} and remove ${removed} of your existing APs. You can undo it with "Undo apply". Continue?`,
              )
            )
              return;
            o.applyRecommendations();
          }}
          disabled={!r.recommendations.length && !r.existingActions?.length}
        >
          Apply {opt.settingsUsed.band} GHz to plan
        </button>
        <button
          type="button"
          onClick={o.undoApply}
          disabled={!o.hasApplyBackup}
          title="Put your APs back as they were before Apply: moved and removed ones return, added ones are deleted"
        >
          Undo apply
        </button>
      </div>
      <details>
        <summary>How this was computed</summary>
        <small className="hint">
          {r.backend.device.toUpperCase()} · {r.resources.wallSeconds}s ·
          screening {r.timingsSeconds.screening}s · ray tracing{" "}
          {r.timingsSeconds.simulation}s · optimisation{" "}
          {r.timingsSeconds.optimization}s · cache {r.cache.rowHits} hits /{" "}
          {r.cache.rowMisses} new · sionna-rt {r.versions["sionna-rt"]}
        </small>
        <small className="hint">
          {r.candidates.shortlisted} of{" "}
          {r.candidates.supplied + r.candidates.existingAddedAsCandidates}{" "}
          candidates were ray traced at full accuracy; the others were ranked
          with coarse ray tracing (approximate).
        </small>
        {r.assumptions.map((a) => (
          <small key={a} className="hint">
            {a}
          </small>
        ))}
        {r.ignoredOtherBandAps.length > 0 && (
          <small className="hint">
            Ignored (other band): {r.ignoredOtherBandAps.join(", ")}
          </small>
        )}
      </details>
    </section>
  );
}

// One row per band: what your APs cover now, what the optimised network
// covers, and which band is recommended.
function BandComparison({ o }) {
  const rows = Object.entries(o.altRuns);
  const best = o.recommendedBand;
  return (
    <div className="band-compare">
      <table>
        <thead>
          <tr>
            <th>Band</th>
            <th>Now</th>
            <th>Optimised</th>
            <th>APs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([band, r]) => (
            <tr
              key={band}
              className={o.opt.settingsUsed.band === band ? "active" : ""}
            >
              <td>
                <button type="button" aria-pressed={o.opt.settingsUsed.band === band}
                  disabled={o.busy} onClick={() => o.chooseBand(band)}>
                  {band} GHz{band === best ? " ★" : ""}
                </button>
              </td>
              <td>
                {r.result.outcome.existingApCount
                  ? `${(r.result.before?.coveragePct ?? 0).toFixed(1)}%`
                  : "none on this band"}
              </td>
              <td>{(r.result.after?.coveragePct ?? 0).toFixed(1)}%</td>
              <td>{r.result.outcome.finalApCount ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.map(([band, run]) => {
        const cells = Object.values(run.maps).flatMap((m) =>
          m.afterDbm.flatMap((row, iy) => row.flatMap((signal, ix) =>
            m.inTarget[iy][ix] && signal != null
              ? [{ signal, snr: m.afterSnrDb?.[iy]?.[ix] }] : [])));
        const range = (key, unit) => {
          const values = cells.map((c) => c[key]).filter(Number.isFinite);
          if (!values.length) return `${unit} unavailable`;
          const min = values.reduce((a, b) => Math.min(a, b), Infinity);
          const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
          return `${min.toFixed(1)} to ${max.toFixed(1)} ${unit}`;
        };
        return <small className="hint" key={band}>
          {band} GHz: signal {range("signal", "dBm")} · SNR {range("snr", "dB")}
        </small>;
      })}
      <small className="hint">
        ★ is a suggestion based on coverage and AP count. Select a band to view
        its locations and heatmap, then apply the band you choose.
      </small>
    </div>
  );
}

export function OutputBandSelector({ o }) {
  const band = o.opt.settingsUsed.band;
  const frequency = o.opt.profileUsed?.freqMHz ?? o.opt.result.settings?.profile?.freqMHz;
  const hasSnr = Object.values(o.opt.maps).every((m) => m.afterSnrDb && m.beforeSnrDb);
  return (
    <section className="opt-section" aria-label="Optimisation output frequency">
      <strong>Viewing: {band} GHz{frequency ? ` (${frequency} MHz)` : ""}</strong>
      {Object.keys(o.altRuns).length > 1 && (
        <div className="segmented" role="group" aria-label="Output band">
          {Object.keys(o.altRuns).map((b) => (
            <button key={b} type="button" className={b === band ? "active" : ""}
              aria-pressed={b === band} onClick={() => o.chooseBand(b)} disabled={o.busy}>
              {b} GHz
            </button>
          ))}
        </div>
      )}
      <small className="hint">Locations, coverage and Apply use the selected band.</small>
      {Object.values(o.opt.maps)[0]?.snr && (
        <small className="hint">
          This run: {Object.values(o.opt.maps)[0].snr.noiseFloor20MHzDbm} dBm noise at 20 MHz;
          new APs use {Object.values(o.opt.maps)[0].snr.newApBandwidthMHz} MHz channels.
        </small>
      )}
      {!hasSnr && <small className="warn">This older result has no SNR map. Run optimisation again to view SNR.</small>}
    </section>
  );
}
