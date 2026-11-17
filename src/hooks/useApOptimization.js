import { useEffect, useMemo, useRef, useState } from "react";
import { uid } from "../models/plan.js";
import {
  channelCenterMHz,
  getProfiles,
  sourceFieldsFromProfile,
} from "../config/apProfiles.js";
import { applyOptimization, undoOptimization } from "../utils/applyOptimization.js";
import { generateAllCandidates } from "../utils/apCandidates.js";
import { buildSceneZip } from "../utils/sceneExport.js";
import { uploadScene } from "../services/simulation.js";
import { DEFAULT_NOISE_FLOORS, useModelVersion } from "./useRayTracedPrediction.js";
import {
  isMissingResult,
  planStamp,
  replaceSavedResult,
} from "../utils/savedResults.js";
import {
  cancelJob,
  getOptimizationMap,
  loadOptimizationComparison,
  optimizationCells,
  submitOptimization,
  waitForOptimization,
} from "../services/optimization.js";

export const ACCURACY_PRESETS = {
  fast: { samplesPerTx: 300000, maxDepth: 3, resolutionM: 2 },
  balanced: { samplesPerTx: 1000000, maxDepth: 5, resolutionM: 1 },
  accurate: { samplesPerTx: 4000000, maxDepth: 6, resolutionM: 0.5 },
};

export const THRESHOLD_PRESETS = [-67, -70, -75];

const DEFAULTS = {
  profileId: "ion4i",
  band: "5",
  bands: ["2.4", "5"], // bands taking part in a run; each is optimised separately
  thresholdDbm: -67,
  targetCoveragePct: 95,
  objective: "min-aps", // min-aps | max-coverage
  budget: 4,
  redundancy: 1,
  existingHandling: "fixed",
  apRoles: {}, // reuse: access point id -> "fixed" | "move" | "free" (default free)
  allowNewAps: false,
  mounting: { wall: true, ceiling: false },
  wallHeightM: 2.5,
  wallSpacingM: 1.5,
  ceilingSpacingM: 3,
  cornerClearanceM: 0.5,
  openingClearanceM: 0.5,
  minApSeparationM: 3,
  receiverHeightM: 1.5,
  accuracy: "balanced",
  resolutionM: 1,
  device: "auto",
  includeCommonArea: true,
  roomOverrides: {}, // roomId -> { include, thresholdDbm, weight }
  excludedFloors: [],
};

// Projects saved before the "use my existing APs" option called it "reposition".
export const handlingOf = (settings) =>
  settings.existingHandling === "reposition"
    ? "reuse"
    : settings.existingHandling;

export const AP_ROLES = [
  ["free", "Can move or be removed"],
  ["move", "Can move, must stay"],
  ["fixed", "Fixed"],
];
export const roleOf = (settings, id) => settings.apRoles?.[id] || "free";

// What the worker needs to know about each existing AP in "reuse" mode.
export function reuseSettings(plan, settings, band = settings.band) {
  const ids = plan.sources.filter((s) => s.kind === "wifi").map((s) => s.id);
  const onBand = plan.sources.some(
    (s) => s.kind === "wifi" && bandOfMHz(s.freqMHz) === String(band),
  );
  return {
    lockedApIds: ids.filter((id) => roleOf(settings, id) === "fixed"),
    keepApIds: ids.filter((id) => roleOf(settings, id) === "move"),
    // a band without any AP of yours can only be planned by adding new ones
    allowNewAps: Boolean(settings.allowNewAps) || !onBand,
  };
}

// A threshold that almost nobody needs: warn instead of refusing.
export const stringentWarning = (thresholdDbm) =>
  thresholdDbm > -50
    ? `${thresholdDbm} dBm is exceptionally strict (typical targets are −67 to −75 dBm); expect many APs.`
    : null;

const BAND_ORDER = ["2.4", "5", "6"];

export const bandOfMHz = (f) =>
  Number(f) < 3000 ? "2.4" : Number(f) < 5925 ? "5" : "6";

// Start from the band and profile the project's own APs use, so the
// optimiser compares like with like instead of silently switching band.
function initialSettings(plan) {
  const aps = plan.sources.filter((s) => s.kind === "wifi");
  if (!aps.length) return DEFAULTS;
  const band = bandOfMHz(aps[0].freqMHz);
  const bands = [...new Set(aps.map((a) => bandOfMHz(a.freqMHz)))];
  const profiles = getProfiles(plan);
  const profile =
    profiles.find((p) => p.id === aps[0].profileId && p.bands[band]) ||
    profiles.find((p) => p.bands[band]);
  return profile
    ? { ...DEFAULTS, band, bands, profileId: profile.id }
    : DEFAULTS;
}

export function useApOptimization({ plan, mutate, setHeatmap, rtActiveOff,
  noiseSettings = DEFAULT_NOISE_FLOORS, setNoiseSettings }) {
  const [chosen, setSettings] = useState({}); // only what the user changed
  // Until the user picks, follow the project's own APs (same band, same
  // profile). This also holds when the project loads after this hook starts.
  const settings = useMemo(
    () => ({
      ...DEFAULTS,
      ...initialSettings(plan),
      ...chosen,
      // An empty network always plans new APs, even after the last AP is removed.
      ...(!plan.sources.some((s) => s.kind === "wifi")
        ? { existingHandling: "ignore" }
        : {}),
    }),
    [plan.sources, plan.apProfiles, chosen], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [run, setRun] = useState(null); // { phase, fraction, message, jobId, error }
  const [opt, setOpt] = useState(null); // { result, maps, jobId }
  const [show, setShow] = useState("off"); // off | after | before
  const [view, setView] = useState("signal"); // signal | coverage
  const [previewOn, setPreviewOn] = useState(false);
  const abort = useRef(null);
  const [fresh, setFresh] = useState(false); // ignore saved results and caches
  const [restoreNote, setRestoreNote] = useState(null);
  const latestPlan = useRef(plan);
  latestPlan.current = plan;
  const saved = plan.savedResults?.optimization;

  const patch = (changes) => setSettings((s) => ({ ...s, ...changes }));
  const profiles = getProfiles(plan);
  const profile =
    profiles.find((p) => p.id === settings.profileId) || profiles[0];
  const radio = profile.bands[settings.band];

  const floorIds = plan.floors
    .map((f) => f.id)
    .filter((id) => !settings.excludedFloors.includes(id));
  const candidateOptions = useMemo(
    () => ({
      mounting: ["wall", "ceiling"].filter((m) => settings.mounting[m]),
      wallHeightM: settings.wallHeightM,
      wallSpacingM: settings.wallSpacingM,
      ceilingSpacingM: settings.ceilingSpacingM,
      cornerClearanceM: settings.cornerClearanceM,
      openingClearanceM: settings.openingClearanceM,
    }),
    [settings],
  );
  const candidates = useMemo(
    () =>
      previewOn || run?.phase
        ? generateAllCandidates(plan, floorIds, candidateOptions)
        : null,
    // plan geometry and exclusions decide candidates
    [
      previewOn,
      run?.phase,
      plan.rooms,
      plan.boundaries,
      plan.interiorWalls,
      plan.doors,
      plan.windows,
      plan.furniture,
      plan.wallMountable,
      floorIds.join(),
      candidateOptions,
    ],
  );

  const simulationSettings = (band = settings.band) => {
    const preset = ACCURACY_PRESETS[settings.accuracy];
    return {
      device: settings.device,
      noiseFloor24Dbm: noiseSettings.noiseFloor24Dbm,
      noiseFloor5Dbm: noiseSettings.noiseFloor5Dbm,
      noiseFloor6Dbm: noiseSettings.noiseFloor6Dbm,
      band,
      thresholdDbm: settings.thresholdDbm,
      targetCoveragePct:
        settings.objective === "max-coverage"
          ? null
          : settings.targetCoveragePct,
      // the budget limits new APs only when maximising coverage
      budget:
        settings.objective === "max-coverage" ? settings.budget : undefined,
      redundancy: settings.redundancy,
      existingHandling: handlingOf(settings),
      ...(handlingOf(settings) === "reuse"
        ? reuseSettings(plan, settings, band)
        : {}),
      receiverHeightM: settings.receiverHeightM,
      resolutionM: settings.resolutionM,
      samplesPerTx: preset.samplesPerTx,
      maxDepth: preset.maxDepth,
      screeningResolutionM: Math.max(2, settings.resolutionM),
      minApSeparationM: settings.minApSeparationM,
      includeCommonArea: settings.includeCommonArea,
      receiverGainDbi: Number(plan.rf?.rxGainDbi) || 0,
      floorIds,
      // rooms marked "not a receiver area" are left out of the coverage target
      roomOverrides: {
        ...Object.fromEntries(
          plan.rooms
            .filter((r) => r.receiverGrid === "excluded")
            .map((r) => [r.id, { include: false }]),
        ),
        ...settings.roomOverrides,
      },
    };
  };

  const [recommendedBand, setRecommendedBand] = useState(null);
  const [altRuns, setAltRuns] = useState({}); // band -> run, from the last multi-band run

  // Runs the optimiser for one band with that band's own radio settings.
  const runBand = async (band, ctx) => {
    const bandProfile =
      profiles.find((p) => p.id === settings.profileId && p.bands[band]) ||
      profiles.find((p) => p.bands[band]);
    if (!bandProfile) throw Error(`No AP profile has a ${band} GHz radio.`);
    const bandRadio = bandProfile.bands[band];
    const config = {
      txPowerDbm: Number(bandRadio.txPowerDbm),
      gainDbi: Number(bandRadio.gainDbi || 0),
      freqMHz: channelCenterMHz(band, bandRadio.channel),
      bandwidthMHz: Number(bandRadio.widthMHz) || 20,
    };
    const label = `${band} GHz`;
    const job = await submitOptimization(
      ctx.sceneId,
      simulationSettings(band),
      config,
      ctx.candidates,
      fresh,
    );
    setRun({ phase: `${label}: queued`, fraction: 0.03, jobId: job.id });
    const status = await waitForOptimization(job.id, {
      signal: ctx.controller.signal,
      onProgress: (p, state) =>
        setRun({
          phase: state === "queued" ? `${label}: queued` : `${label}: ${p.message}`,
          fraction: p.fraction,
          stage: p.stage,
          jobId: job.id,
        }),
    });
    const maps = {};
    for (const m of status.result.maps)
      maps[m.floorId] = await getOptimizationMap(job.id, m.file.split("/").pop());
    return {
      result: status.result,
      maps,
      jobId: job.id,
      finishedAt: new Date().toISOString(),
      threshold: settings.thresholdDbm,
      settingsUsed: { ...settings, band, profileId: bandProfile.id,
        noiseFloor24Dbm: noiseSettings.noiseFloor24Dbm,
        noiseFloor5Dbm: noiseSettings.noiseFloor5Dbm,
        noiseFloor6Dbm: noiseSettings.noiseFloor6Dbm,
      },
      profileUsed: { name: bandProfile.name, band, channel: bandRadio.channel, ...config },
      cached: job.cached,
      planStamp: ctx.stamp,
    };
  };

  // Better run: reaches more coverage, then needs fewer APs.
  const score = (r) => [
    Math.round((r.result.after?.coveragePct ?? 0) * 10) / 10,
    -(r.result.outcome?.finalApCount ?? 99),
  ];
  // A band you already use wins unless another band is clearly better (1 %).
  const better = (a, b) => {
    const [ac, an] = score(a);
    const [bc, bn] = score(b);
    const aOwn = a.result.outcome?.existingApCount > 0;
    const bOwn = b.result.outcome?.existingApCount > 0;
    if (aOwn !== bOwn) {
      const [own, other] = aOwn ? [ac, bc] : [bc, ac];
      if (own >= other - 1) return aOwn;
    }
    return ac !== bc ? ac > bc : an > bn;
  };

  const referenceFor = (run) => ({
    jobId: run.jobId,
    finishedAt: run.finishedAt,
    planStamp: run.planStamp,
    modelVersion: run.result.model?.modelVersion,
    threshold: run.threshold,
    settingsUsed: run.settingsUsed,
    profileUsed: run.profileUsed,
  });

  const showRun = (best, runs, recommendation) => {
    setOpt(best);
    patch({ band: best.settingsUsed.band, profileId: best.settingsUsed.profileId });
    replaceSavedResult(
      mutate,
      "optimization",
      {
        ...referenceFor(best),
        runs: Object.fromEntries(Object.entries(runs).map(([band, r]) => [band, referenceFor(r)])),
        recommendedBand: recommendation,
      },
      latestPlan.current.savedResults?.optimization,
    );
  };

  const start = async () => {
    if (run?.phase) return;
    const controller = new AbortController();
    abort.current = controller;
    setRun({ phase: "Preparing", fraction: 0 });
    const stamp = planStamp(plan);
    try {
      const bands = BAND_ORDER.filter((b) => settings.bands.includes(b));
      if (!bands.length) throw Error("Choose at least one band.");
      const generated = generateAllCandidates(plan, floorIds, candidateOptions);
      if (!generated.valid.length)
        throw Error(
          "No valid AP mounting positions. Check the mounting type, clearances and excluded rooms.",
        );
      const { blob } = await buildSceneZip(plan, {});
      setRun({ phase: "Uploading scene", fraction: 0.02 });
      const { sceneId } = await uploadScene(blob);
      const ctx = { sceneId, candidates: generated.valid, controller, stamp };
      const runs = {};
      for (const band of bands) runs[band] = await runBand(band, ctx);
      const best = Object.values(runs).reduce((a, b) => (better(b, a) ? b : a));
      setAltRuns(runs);
      setRecommendedBand(best.settingsUsed.band);
      // Initially show the user's current band when it participated. The
      // recommendation is a hint; applying a result is always the user's choice.
      showRun(runs[settings.band] || runs[bands[0]], runs, best.settingsUsed.band);
      setRestoreNote(null);
      setFresh(false);
      setShow("after");
      setHeatmap(true);
      rtActiveOff?.();
      setRun(null);
    } catch (error) {
      setRun(error.message === "Cancelled" ? null : { error: error.message });
    } finally {
      abort.current = null;
    }
  };

  // Look at another band's result from the same run.
  const chooseBand = (band) => {
    if (altRuns[band]) showRun(altRuns[band], altRuns, recommendedBand);
  };

  const cancel = async () => {
    abort.current?.abort();
    if (run?.jobId) await cancelJob(run.jobId).catch(() => {});
    setRun(null);
  };

  // ---- applying the recommendation ---------------------------------------
  const applyRecommendations = () => {
    if (!opt) return;
    const fields = sourceFieldsFromProfile(profile, opt.settingsUsed.band);
    fields.profileId = opt.settingsUsed.profileId;
    const used = opt.profileUsed;
    if (used) Object.assign(fields, {
      txPowerDbm: used.txPowerDbm, antennaGainDbi: used.gainDbi,
      freqMHz: used.freqMHz,
      ...(used.channel != null ? { channel: Number(used.channel) } : {}),
      ...(used.bandwidthMHz != null ? { bandwidthMHz: used.bandwidthMHz } : {}),
    });
    mutate((p) => applyOptimization(p, opt.result, fields));
    setShow("off");
  };

  // Puts the APs back as they were before Apply.
  const undoApply = () => mutate(undoOptimization);
  const hasApplyBackup = Boolean(plan.optimizationBackup);

  const removeOptimizedAps = () =>
    mutate((p) => ({
      ...p,
      sources: p.sources.filter((s) => s.origin !== "optimized"),
    }));

  // ---- profile editing (stored in the project) ----------------------------
  const saveProfiles = (list) => mutate((p) => ({ ...p, apProfiles: list }));
  const updateRadio = (changes) =>
    saveProfiles(
      profiles.map((p) =>
        p.id === profile.id
          ? {
              ...p,
              bands: {
                ...p.bands,
                [settings.band]: { ...p.bands[settings.band], ...changes },
              },
            }
          : p,
      ),
    );
  const updateProfile = (changes) =>
    saveProfiles(
      profiles.map((p) => (p.id === profile.id ? { ...p, ...changes } : p)),
    );
  const duplicateProfile = () => {
    const copy = {
      ...structuredClone(profile),
      id: uid(),
      name: `${profile.name} (copy)`,
    };
    saveProfiles([...profiles, copy]);
    patch({ profileId: copy.id });
  };
  const addBand = (band) =>
    saveProfiles(
      profiles.map((p) =>
        p.id === profile.id
          ? {
              ...p,
              bands: {
                ...p.bands,
                [band]: {
                  txPowerDbm: 20,
                  maxTxPowerDbm: null,
                  gainDbi: 3,
                  channel: band === "6" ? 5 : 36,
                  widthMHz: 20,
                },
              },
            }
          : p,
      ),
    );
  const applyProfileToExisting = () => {
    const fields = sourceFieldsFromProfile(profile, settings.band);
    mutate((p) => ({
      ...p,
      sources: p.sources.map((s) =>
        s.kind === "wifi" && s.origin !== "optimized" ? { ...s, ...fields } : s,
      ),
    }));
  };

  const stale = Boolean(opt) && opt.planStamp !== planStamp(plan);
  const modelNow = useModelVersion(opt?.jobId);
  const modelOutdated =
    Boolean(opt) &&
    Boolean(modelNow) &&
    opt.result.model?.modelVersion !== modelNow;

  // Show the saved result when a project is opened (and drop it when the
  // project has none, e.g. after opening another project).
  useEffect(() => {
    if (!saved?.jobId) {
      if (opt?.jobId) setOpt(null);
      setAltRuns({});
      setRecommendedBand(null);
      setRestoreNote(null);
      return undefined;
    }
    if (opt?.jobId === saved.jobId) return undefined;
    setOpt(null);
    setAltRuns({});
    setRecommendedBand(null);
    let off = false;
    (async () => {
      try {
        const { runs, selected, partial } = await loadOptimizationComparison(saved);
        if (off) return;
        setOpt(selected);
        setAltRuns(runs);
        setRecommendedBand(saved.recommendedBand || null);
        patch({ band: selected.settingsUsed.band, profileId: selected.settingsUsed.profileId });
        const noise = Object.fromEntries(Object.keys(DEFAULT_NOISE_FLOORS)
          .filter((k) => Number.isFinite(selected.settingsUsed[k]))
          .map((k) => [k, selected.settingsUsed[k]]));
        if (setNoiseSettings && Object.keys(noise).length)
          setNoiseSettings((s) => ({ ...s, ...noise }));
        setShow("after");
        setRestoreNote(partial
          ? "Some saved bands could not be loaded. Run optimisation again to compare all bands." : null);
      } catch (error) {
        if (!off)
          setRestoreNote(
            isMissingResult(error)
              ? "The saved optimisation is no longer available. Run it again."
              : `Could not load the saved optimisation: ${error.message}`,
          );
      }
    })();
    return () => {
      off = true;
    };
  }, [saved?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // heat cells for the selected floor, or null
  const heatCells = (floorId, display = {}) => {
    if (!opt || show === "off" || !opt.maps[floorId]) return null;
    return optimizationCells(opt.maps[floorId], show, {
      coverage: view === "coverage",
      referenceDbm: opt.threshold,
      ...display,
    });
  };

  return {
    settings,
    noiseSettings,
    setNoiseSettings,
    patch,
    setSettings,
    profiles,
    profile,
    radio,
    run,
    busy: Boolean(run?.phase),
    start,
    cancel,
    altRuns,
    recommendedBand,
    chooseBand,
    candidates,
    previewOn,
    setPreviewOn,
    opt,
    stale,
    modelOutdated,
    fresh,
    setFresh,
    restoreNote,
    show,
    setShow,
    view,
    setView,
    heatCells,
    applyRecommendations,
    undoApply,
    hasApplyBackup,
    removeOptimizedAps,
    updateRadio,
    updateProfile,
    duplicateProfile,
    addBand,
    applyProfileToExisting,
    simulationSettings,
  };
}
