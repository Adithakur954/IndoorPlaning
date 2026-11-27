// Cellular (IBS/DAS) prediction: its own runs, results and map, separate from
// the Wi-Fi prediction (useRayTracedPrediction) and optimiser. The project
// keeps the latest run of each carrier in plan.savedResults.cellular, so
// switching carriers shows its map without simulating again.
import { useEffect, useMemo, useRef, useState } from "react";
import { boundaryAreas } from "../utils/geometry.js";
import { buildSceneZip } from "../utils/sceneExport.js";
import { getMap, getSimulation, uploadScene, waitForSimulation } from "../services/simulation.js";
import { deleteJob } from "../services/maintenance.js";
import { licensedFeatures, submitCellularPrediction } from "../services/cellular.js";
import { buildingStamp, isMissingResult } from "../utils/savedResults.js";
import { buildCellularRequest } from "../infra/cellular/request.js";
import { cellularOf, mapRanges } from "../infra/cellular/model.js";
import { cellStats, cellularCells } from "../infra/cellular/mapCells.js";

// What a carrier's result depends on: the building and the cellular job inputs.
export const cellularStamp = (plan, request) => JSON.stringify([buildingStamp(plan), request || null]);

export function useCellularPrediction({ plan, mutate, showOnMap }) {
  const [licensed, setLicensed] = useState(null); // null until known
  const [carrierId, setCarrierId] = useState(null);
  const [metric, setMetric] = useState("rsrp");
  const [show, setShow] = useState(true);
  const [run, setRun] = useState(null);
  const [fresh, setFresh] = useState(false);
  const [loaded, setLoaded] = useState({}); // carrierId -> { jobId, result, maps: floorId -> raw map }
  const [note, setNote] = useState(null);
  const latestPlan = useRef(plan);
  latestPlan.current = plan;

  useEffect(() => {
    let off = false;
    licensedFeatures().then((f) => !off && setLicensed(f.includes("cellular")));
    return () => {
      off = true;
    };
  }, []);

  const c = cellularOf(plan);
  const saved = plan.savedResults?.cellular;
  const carriers = c.carriers;
  // the chosen carrier, else the last one run, else the first
  const activeId = carriers.some((x) => x.id === carrierId)
    ? carrierId
    : carriers.some((x) => x.id === saved?.carrierId)
      ? saved.carrierId
      : carriers[0]?.id || null;
  const built = useMemo(() => (activeId ? buildCellularRequest(plan, activeId) : { problems: [] }), [plan, activeId]);
  const stamp = useMemo(() => cellularStamp(plan, built.request), [plan, built.request]);
  const savedRun = activeId ? saved?.runs?.[activeId] : null;
  const current = activeId && savedRun && loaded[activeId]?.jobId === savedRun.jobId ? loaded[activeId] : null;
  const stale = Boolean(current && savedRun.stamp !== stamp);
  const busy = Boolean(run?.phase);

  // load a carrier's saved run when it is shown and not loaded yet
  useEffect(() => {
    if (!savedRun?.jobId || loaded[activeId]?.jobId === savedRun.jobId) return undefined;
    let off = false;
    (async () => {
      try {
        const status = await getSimulation(savedRun.jobId);
        if (status.status !== "done") throw Error("no longer available");
        const maps = {};
        for (const f of status.result.floors) maps[f.floorId] = await getMap(savedRun.jobId, f.file.split("/").pop());
        if (!off) {
          setLoaded((l) => ({ ...l, [activeId]: { jobId: savedRun.jobId, result: status.result, maps } }));
          setNote(null);
        }
      } catch (error) {
        if (!off)
          setNote(
            isMissingResult(error)
              ? "The saved cellular prediction is no longer available. Run it again."
              : `Could not load the saved cellular prediction: ${error.message}`,
          );
      }
    })();
    return () => {
      off = true;
    };
  }, [savedRun?.jobId, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPrediction = async () => {
    if (busy || !activeId) return;
    showOnMap?.();
    const { problems, request, notes = [] } = buildCellularRequest(plan, activeId);
    if (problems.length) {
      setRun({ error: problems.join(" ") });
      return;
    }
    const stampAtStart = cellularStamp(plan, request);
    try {
      setRun({ phase: "Building scene", notes });
      const { blob, warnings } = await buildSceneZip(plan, { sources: "none" });
      setRun({ phase: "Uploading scene", notes, warnings });
      const { sceneId } = await uploadScene(blob);
      const job = await submitCellularPrediction(sceneId, request, fresh);
      const status = await waitForSimulation(job.id, {
        onStatus: (phase) => setRun({ phase: job.cached ? "Loading saved result" : phase, notes, warnings }),
      });
      const maps = {};
      for (const f of status.result.floors) maps[f.floorId] = await getMap(job.id, f.file.split("/").pop());
      setLoaded((l) => ({ ...l, [activeId]: { jobId: job.id, result: status.result, maps } }));
      const previous = latestPlan.current.savedResults?.cellular?.runs?.[activeId]?.jobId;
      const finishedAt = new Date().toISOString();
      mutate((p) => {
        const old = p.savedResults?.cellular || {};
        const runs = {
          ...(old.runs || {}),
          [activeId]: { jobId: job.id, finishedAt, stamp: stampAtStart, modelVersion: status.result.model?.modelVersion },
        };
        return { ...p, savedResults: { ...(p.savedResults || {}), cellular: { carrierId: activeId, jobId: job.id, runs } } };
      });
      if (previous && previous !== job.id) deleteJob(previous).catch(() => {});
      setNote(null);
      setFresh(false);
      setShow(true);
      setRun({ notes, warnings, cached: job.cached });
    } catch (error) {
      setRun({ error: error.message });
    }
  };

  // Forget every cellular result of the project (their files are deleted too).
  const deleteResults = () => {
    const old = latestPlan.current.savedResults?.cellular;
    mutate((p) => {
      const { cellular: _gone, ...rest } = p.savedResults || {}; // eslint-disable-line no-unused-vars
      return { ...p, savedResults: rest };
    });
    for (const r of Object.values(old?.runs || {})) if (r.jobId) deleteJob(r.jobId).catch(() => {});
    setLoaded({});
    setRun(null);
  };

  const ranges = useMemo(() => mapRanges(plan, metric), [plan, metric]);
  const threshold = metric === "sinr" ? Number(c.settings.sinrTargetDb) : Number(c.settings.rsrpTargetDbm);
  // display only (not part of the run request): smooth gradient or flat bands
  const mapStyle = c.settings.mapStyle === "bands" ? "bands" : "smooth";
  const setMapStyle = (style) =>
    mutate((p) => {
      const cur = p.cellular || {};
      return { ...p, cellular: { ...cur, settings: { ...(cur.settings || {}), mapStyle: style } } };
    });

  // heatmap cells of one floor for the map (empty when nothing is loaded)
  const cellsFor = (floorId) => {
    const map = current?.maps?.[floorId];
    if (!map) return [];
    const areas = [...plan.rooms.filter((r) => r.floorId === floorId), ...boundaryAreas(plan, floorId)];
    const skip = plan.rooms.filter((r) => r.floorId === floorId && r.receiverGrid === "excluded");
    return cellularCells(map, areas, skip, { metric, threshold }).map((cell) => ({ ...cell, ranges }));
  };
  const statsFor = (floorId) => cellStats(cellsFor(floorId));

  return {
    licensed,
    carriers,
    carrierId: activeId,
    setCarrierId,
    metric,
    setMetric,
    show,
    setShow,
    run,
    fresh,
    setFresh,
    note,
    busy,
    stale,
    problems: built.problems || [],
    result: current?.result || null,
    hasResult: Boolean(current),
    finishedAt: savedRun?.finishedAt || null,
    ranges,
    threshold,
    mapStyle,
    setMapStyle,
    cellsFor,
    statsFor,
    runPrediction,
    deleteResults,
  };
}
