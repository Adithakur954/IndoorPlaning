import { useEffect, useMemo, useRef, useState } from "react";
import { boundaryAreas } from "../utils/geometry.js";
import { buildSceneZip } from "../utils/sceneExport.js";
import {
  getMap,
  getSimulation,
  mapToCells,
  submitSimulation,
  uploadScene,
  waitForSimulation,
} from "../services/simulation.js";
import { deleteJob, getModelVersion } from "../services/maintenance.js";
import {
  isMissingResult,
  planStamp,
  replaceSavedResult,
  savedJobIds,
} from "../utils/savedResults.js";

// Noise floor (dBm) of a 20 MHz channel, per band, for the SNR map. These are
// planning assumptions for the RF environment, not measurements; a wider
// channel adds 3 dB per doubling (done by the worker).
export const NOISE_PRESETS = [
  { id: "quiet", label: "Quiet office", noiseFloor24Dbm: -95, noiseFloor5Dbm: -97 },
  { id: "typical", label: "Typical office", noiseFloor24Dbm: -90, noiseFloor5Dbm: -92 },
  { id: "default", label: "Fairly noisy office (default)", noiseFloor24Dbm: -86, noiseFloor5Dbm: -88 },
  { id: "busy", label: "Busy office", noiseFloor24Dbm: -85, noiseFloor5Dbm: -87 },
  { id: "noisy", label: "Very noisy environment", noiseFloor24Dbm: -80, noiseFloor5Dbm: -82 },
];
export const DEFAULT_NOISE_FLOORS = {
  noiseFloor24Dbm: -86,
  noiseFloor5Dbm: -88,
  noiseFloor6Dbm: -88,
};
export const noisePresetOf = (s) =>
  NOISE_PRESETS.find(
    (p) =>
      p.noiseFloor24Dbm === Number(s.noiseFloor24Dbm) &&
      p.noiseFloor5Dbm === Number(s.noiseFloor5Dbm),
  )?.id || "custom";

// Version of the simulation model the service would use now (null until known).
export function useModelVersion(...triggers) {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    let off = false;
    getModelVersion()
      .then((v) => !off && setVersion(v))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, triggers); // eslint-disable-line react-hooks/exhaustive-deps
  return version;
}

// Settings, run state and the run action for the Sionna RT prediction. It is
// shared by the editor's right sidebar and the Network & RF page. The project
// keeps only the latest run (plan.savedResults.prediction); it is loaded again
// whenever the project is opened.
export function useRayTracedPrediction({
  plan,
  mutate,
  rt,
  setRt,
  setHeatmap,
  heatmap,
  showOnMap, // switches the map to the prediction (not the optimiser result)
  weakBelowDbm,
}) {
  const [rtSettings, setRtSettings] = useState({
    device: "auto",
    resolutionM: 0.5,
    maxDepth: 5,
    samplesPerTx: 1000000,
    ...DEFAULT_NOISE_FLOORS, // noise floor per band (20 MHz channel) for the SNR map
  });
  const [run, setRun] = useState(null);
  const [fresh, setFresh] = useState(false); // ignore saved results and caches
  const [restoreNote, setRestoreNote] = useState(null);
  const stamp = useMemo(() => planStamp(plan), [plan]);
  const saved = plan.savedResults?.prediction;
  const latestPlan = useRef(plan);
  latestPlan.current = plan;
  const modelNow = useModelVersion(rt.jobId);
  const stale = Boolean(rt.result) && rt.planStamp !== stamp;
  const modelOutdated =
    Boolean(rt.result) &&
    Boolean(modelNow) &&
    rt.result.model?.modelVersion !== modelNow;
  const busy = Boolean(run?.phase);

  const loadMaps = async (jobId, result, currentPlan) => {
    const maps = {};
    for (const floor of result.floors) {
      const map = await getMap(jobId, floor.file.split("/").pop());
      const areas = [
        ...currentPlan.rooms.filter((r) => r.floorId === floor.floorId),
        ...boundaryAreas(currentPlan, floor.floorId),
      ];
      const skip = currentPlan.rooms.filter(
        (r) => r.floorId === floor.floorId && r.receiverGrid === "excluded",
      );
      maps[floor.floorId] = mapToCells(map, areas, weakBelowDbm, skip);
    }
    return maps;
  };

  // Show the saved result when a project is opened (or clear it when the
  // project has none, e.g. after opening another project).
  useEffect(() => {
    if (!saved?.jobId) {
      if (rt.jobId) setRt({ maps: {}, active: false });
      setRestoreNote(null);
      return undefined;
    }
    if (rt.jobId === saved.jobId) return undefined;
    let off = false;
    (async () => {
      try {
        const status = await getSimulation(saved.jobId);
        if (status.status !== "done") throw Error("no longer available");
        const maps = await loadMaps(
          saved.jobId,
          status.result,
          latestPlan.current,
        );
        if (off) return;
        setRt({
          maps,
          active: true,
          result: status.result,
          planStamp: saved.planStamp,
          jobId: saved.jobId,
          finishedAt: saved.finishedAt,
          cached: true,
        });
        setRestoreNote(null);
      } catch (error) {
        if (!off)
          setRestoreNote(
            isMissingResult(error)
              ? "The saved prediction is no longer available. Run it again."
              : `Could not load the saved prediction: ${error.message}`,
          );
      }
    })();
    return () => {
      off = true;
    };
  }, [saved?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPrediction = async (options = {}) => {
    const auto = options?.auto === true;
    if (busy) return;
    if (!auto) showOnMap?.();
    setRun({ phase: "Building scene" });
    const stampAtStart = planStamp(plan);
    try {
      const { blob, warnings } = await buildSceneZip(plan, {});
      setRun({ phase: "Uploading scene", warnings });
      const { sceneId } = await uploadScene(blob);
      const job = await submitSimulation(
        sceneId,
        {
          ...rtSettings,
          receiverGainDbi: Number(plan.rf?.rxGainDbi) || 0,
        },
        fresh,
      );
      const status = await waitForSimulation(job.id, {
        onStatus: (phase) =>
          setRun({
            phase: job.cached ? "Loading saved result" : phase,
            warnings,
          }),
      });
      const maps = await loadMaps(job.id, status.result, plan);
      const finishedAt = new Date().toISOString();
      setRt({
        maps,
        active: true,
        result: status.result,
        planStamp: stampAtStart,
        jobId: job.id,
        finishedAt,
        cached: job.cached,
      });
      // the project now points at this run only; the previous one is deleted
      replaceSavedResult(
        mutate,
        "prediction",
        {
          jobId: job.id,
          finishedAt,
          planStamp: stampAtStart,
          modelVersion: status.result.model?.modelVersion,
          settings: rtSettings,
        },
        latestPlan.current.savedResults?.prediction?.jobId,
      );
      setRestoreNote(null);
      setFresh(false);
      if (!auto) setHeatmap(true);
      setRun({ warnings });
    } catch (error) {
      setRun({ error: error.message });
    }
  };

  // Hides the heatmap so only the building is shown. The run stays loaded and
  // saved: "Show heatmap" brings it back without simulating again.
  const clearPrediction = () => setHeatmap(false);
  // Really clears it: the project forgets the prediction and the service deletes its files. Nothing comes back
  // until the prediction is run again.
  const deletePrediction = () => {
    const old = latestPlan.current.savedResults?.prediction;
    mutate((p) => {
      const { prediction: _gone, ...rest } = p.savedResults || {}; // eslint-disable-line no-unused-vars
      return { ...p, savedResults: rest };
    });
    for (const id of savedJobIds(old)) deleteJob(id).catch(() => {});
    setRt({ maps: {}, active: false });
    setHeatmap(false);
    setRun(null);
  };
  const showPrediction = () => {
    showOnMap?.();
    setHeatmap(true);
  };

  // APs added by "apply recommendations" are ordinary APs of the plan and are part
  // of every prediction; this takes them out again.
  const removeOptimizedAps = () =>
    mutate((p) => ({
      ...p,
      sources: p.sources.filter((s) => s.origin !== "optimized"),
      optimizationApplied: undefined,
    }));

  // One model: after the plan changes (an AP moved, a wall edited, ...) the
  // ray-traced prediction is run again a moment after the last edit. It only
  // follows a run that already exists, and it tries once per plan state, so a
  // stopped simulation service cannot cause a retry loop.
  const autoTried = useRef(null);
  const hasWifi = plan.sources.some((s) => s.kind === "wifi");
  // With no access point left, the old prediction describes APs that are gone: the map leaves its cells out
  // (only the prediction's; the optimiser's map is not affected). It is not deleted: the next run replaces it.
  const noApsLeft = Boolean(rt.result) && !hasWifi;
  useEffect(() => {
    if (!rt.jobId || !stale || busy || !hasWifi) return undefined;
    if (autoTried.current === stamp) return undefined;
    const timer = setTimeout(() => {
      autoTried.current = stamp;
      runPrediction({ auto: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, [stamp, stale, busy, rt.jobId, hasWifi]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
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
    showPrediction,
    noApsLeft,
    heatmapOn: Boolean(heatmap),
    removeOptimizedAps,
  };
}
