import React from "react";
import Field from "../ui/Field.jsx";
import { timeLabel } from "../../utils/savedResults.js";
import NoiseSettings from "./NoiseSettings.jsx";

const open = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v));
export const bandLabel = ({ min, max }, unit = "dBm") => {
  const u = unit ? ` ${unit}` : "";
  return open(min)
    ? `below ${max}${u}`
    : open(max)
      ? `${min}${u} and above`
      : `${min} to ${max}${u}`;
};

// Settings, run button and results of the ray-traced prediction. Used in the
// editor's right sidebar and on the Network & RF page.
export default function PredictionPanel({
  plan,
  rt,
  setRt,
  prediction,
  predictionMetric,
  predictionRanges,
  weakBelowDbm,
}) {
  const {
    rtSettings,
    setRtSettings,
    run,
    busy,
    stale,
    modelOutdated,
    fresh,
    setFresh,
    restoreNote,
    runPrediction,
    clearPrediction,
    deletePrediction,
    noApsLeft,
    showPrediction,
    heatmapOn,
    removeOptimizedAps,
  } = prediction;
  const optimizedAps = plan.sources.filter((s) => s.origin === "optimized");
  return (
    <>
      <div className="inspector-fields">
        <Field
          label="Device"
          value={rtSettings.device}
          options={["auto", "gpu", "cpu"]}
          onChange={(v) => setRtSettings((s) => ({ ...s, device: v }))}
        />
        {[
          ["resolutionM", "Resolution (m)"],
          ["maxDepth", "Ray depth"],
          ["samplesPerTx", "Samples per AP"],
        ].map(([key, label]) => (
          <Field
            key={key}
            label={label}
            type="number"
            value={rtSettings[key]}
            onChange={(v) => setRtSettings((s) => ({ ...s, [key]: Number(v) }))}
          />
        ))}
      </div>
      <NoiseSettings settings={rtSettings} setSettings={setRtSettings} />
      <button
        className="primary"
        type="button"
        onClick={runPrediction}
        disabled={busy || !plan.sources.length}
      >
        {busy ? `${run.phase}…` : "Run prediction"}
      </button>
      <button
        type="button"
        onClick={heatmapOn ? clearPrediction : showPrediction}
        disabled={busy || !rt.jobId}
        title={
          heatmapOn
            ? "Hide the heatmap to see only the building (the prediction stays saved)"
            : "Show the saved prediction again without running it"
        }
      >
        {heatmapOn ? "Hide heatmap" : "Show heatmap"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.confirm("Clear the prediction? It is deleted from this project; run it again to get a new one."))
            deletePrediction();
        }}
        disabled={busy || !rt.jobId}
        title="Delete the saved prediction (it does not come back until you run it again)"
      >
        Clear prediction
      </button>
      {optimizedAps.length > 0 && (
        <p className="panel-note">
          {optimizedAps.length} optimised AP
          {optimizedAps.length === 1 ? "" : "s"} (
          {optimizedAps.map((s) => s.name).join(", ")}) from an applied
          recommendation {optimizedAps.length === 1 ? "is" : "are"} part of the
          plan, so {optimizedAps.length === 1 ? "it is" : "they are"} included
          in this prediction.{" "}
          <button type="button" onClick={removeOptimizedAps}>
            Remove optimised APs
          </button>
        </p>
      )}
      <label
        className="check"
        title="Ignore any saved result and cache and simulate everything again"
      >
        <input
          type="checkbox"
          checked={fresh}
          onChange={(e) => setFresh(e.target.checked)}
        />
        Recompute everything (ignore saved results)
      </label>
      {restoreNote && <p className="error">{restoreNote}</p>}
      {!plan.sources.length && (
        <p className="panel-note">Place a Wi-Fi access point first.</p>
      )}
      {run?.error && <p className="error">{run.error}</p>}
      {run?.warnings?.map((w) => (
        <small key={w} style={{ display: "block" }}>
          ⚠ {w}
        </small>
      ))}
      {rt.result && (
        <>
          {noApsLeft && (
            <p className="warn">
              No Wi-Fi access points are in the plan any more: the old prediction no longer applies, so it is hidden.
              Place an AP and run the prediction again.
            </p>
          )}
          {stale && !noApsLeft && !busy && !run?.error && (
            <p className="panel-note">
              Out of date: the plan changed after this run (the heatmap is shown faded). The prediction updates
              automatically in a moment.
            </p>
          )}
          {predictionMetric === "snr" &&
            Object.values(rt.maps).some((cells) => cells[0]?.hasSnrMap === false) && (
              <p className="error">
                This run has no SNR map. Run the prediction again to get SNR.
              </p>
            )}
          {modelOutdated && (
            <p className="error">
              The simulation model was updated after this run. Run it again to
              get results from the current model.
            </p>
          )}
          {rt.finishedAt && (
            <small className="hint">
              Latest run: {timeLabel(rt.finishedAt)}
            </small>
          )}
          {Object.entries(rt.maps).map(([id, cells]) => {
            const weak = cells.filter((c) => c.dbm < weakBelowDbm);
            const area = (list) => list.reduce((a, c) => a + c.step ** 2, 0);
            return (
              <div key={id} className="metric-row">
                <strong>
                  {plan.floors.find((f) => f.id === id)?.name || id}
                </strong>
                <small>
                  weak {area(weak).toFixed(1)} m² of {area(cells).toFixed(1)} m²
                  (
                  {cells.length
                    ? ((100 * weak.length) / cells.length).toFixed(0)
                    : 0}
                  %)
                </small>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
