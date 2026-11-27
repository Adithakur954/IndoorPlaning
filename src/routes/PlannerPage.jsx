import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getProject, saveProject } from "../services/projects.js";
import { initialPlan, uid } from "../models/plan.js";
import {
  areaOf,
  bbox,
  inside,
  overlapWarnings,
  nestedRoomNotes,
  pointsOf,
  resizePolygonPoints,
  roomContents,
  shiftRoomContents,
} from "../utils/geometry.js";
import {
  boundaryArea,
  rotateBoundary,
  rotateBuilding,
  rotateFurniture,
  rotateInteriorWall,
  rotateRoom,
  rotationLosesData,
} from "../utils/rotate.js";
import {
  readBuilding,
  readLogs,
  readFloorImage,
  downloadReviewedRooms,
  downloadBuildingTemplate,
} from "../services/imports.js";
import { listSessions, loadSessions } from "../services/sessions.js";
import {
  getFloorLogs,
  getMeasuredArea,
  getMetricRanges,
} from "../utils/logOverlay.js";
import { num } from "../utils/number.js";
import DesignPanel from "../components/panels/DesignPanel.jsx";
import SettingsPanel from "../components/panels/SettingsPanel.jsx";
import NetworkPanel from "../components/panels/NetworkPanel.jsx";
import DataPanel from "../components/panels/DataPanel.jsx";
import AlignmentPanel from "../components/panels/AlignmentPanel.jsx";
import CablingPanel from "../components/panels/CablingPanel.jsx";
import useCableOverlay from "../hooks/useCableOverlay.js";
import CapacityPanel from "../components/panels/CapacityPanel.jsx";
import { useRayTracedPrediction } from "../hooks/useRayTracedPrediction.js";
import { useApOptimization } from "../hooks/useApOptimization.js";
import { plotFileName, plotImageBlob } from "../utils/plotImage.js";
import { downloadBlob } from "../utils/sceneExport.js";
import {
  getMap as getRtMap,
  submitSimulation,
  uploadScene,
  waitForSimulation,
} from "../services/simulation.js";
import { COMPARED_BANDS, planForBand } from "../utils/bandVariants.js";
import { mergeSharedWall, snapCollidingWalls } from "../utils/wallMerge.js";
import {
  distanceAlongWall,
  mergeTwoWalls,
  openingsAfterBreak,
  openingsOntoRoom,
  openingsOntoWalls,
  roomOutlineFromWalls,
  splitWall,
  wallsFromRoom,
} from "../utils/wallRoom.js";
import {
  defaultKpiFor,
  kpisForKind,
} from "../utils/indoorLogKpis.js";
import { DEFAULT_LEGEND_SECTIONS } from "../components/planner/MapLegend.jsx";
import { useCellularPrediction } from "../hooks/useCellularPrediction.js";
import { cellularOf, newAntennaFields } from "../infra/cellular/model.js";
import {
  DAS_TYPES,
  cableProblem,
  cableRoute,
  dasPowers,
  newCable,
  newDasPart,
  connectorOf,
  outputPorts,
  partOutputs,
  portsOf,
  withoutLooseCables,
} from "../infra/cellular/das.js";
import { WORKSPACES, useWorkspace, workspaceOf } from "../workspace.js";
import Ribbon from "../components/planner/Ribbon.jsx";
import WorkspaceFooter from "../components/planner/WorkspaceFooter.jsx";
import { MeasurementUnitProvider } from "../utils/measurementUnits.jsx";

// heights for a newly placed source come from Network & RF (plan.rf)
const defaultSource = (kind, p, floorId, rf = {}) => ({
  id: uid(),
  floorId,
  kind,
  name: kind === "wifi" ? "Wi-Fi AP" : "Cellular site",
  technology: kind === "wifi" ? "Wi-Fi" : "5G",
  antennaPattern: "omni",
  x: p.x,
  z: p.z,
  heightM: kind === "wifi" ? num(rf.newApHeightM, 2.7) : num(rf.newCellHeightM, 3),
  txPowerDbm: kind === "wifi" ? 20 : 30,
  freqMHz: kind === "wifi" ? 2400 : 3500,
  antennaGainDbi: 0,
  azimuthDeg: 0,
  beamwidthDeg: 120,
  sectors: [],
});

const findRoomWallPlacement = (rooms, point, openingWidth, tolerance) => {
  let closest = null;
  for (const room of rooms) {
    if (room.shape && room.shape !== "rectangle") continue;
    const bounds = bbox(room);
    const candidates = [
      {
        side: "north",
        distance: Math.abs(point.z - bounds.minZ),
        along: point.x - bounds.minX,
        length: bounds.maxX - bounds.minX,
      },
      {
        side: "south",
        distance: Math.abs(point.z - bounds.maxZ),
        along: point.x - bounds.minX,
        length: bounds.maxX - bounds.minX,
      },
      {
        side: "west",
        distance: Math.abs(point.x - bounds.minX),
        along: point.z - bounds.minZ,
        length: bounds.maxZ - bounds.minZ,
      },
      {
        side: "east",
        distance: Math.abs(point.x - bounds.maxX),
        along: point.z - bounds.minZ,
        length: bounds.maxZ - bounds.minZ,
      },
    ];
    for (const wall of candidates) {
      const along = Math.max(0, Math.min(wall.length, wall.along));
      const distance = Math.hypot(wall.distance, wall.along - along);
      if (
        wall.length >= openingWidth &&
        distance <= tolerance &&
        (!closest || distance < closest.distance)
      ) {
        closest = {
          room,
          side: wall.side,
          distance,
          offset: Math.max(
            0,
            Math.min(wall.length - openingWidth, along - openingWidth / 2),
          ),
        };
      }
    }
  }
  return closest;
};

export default function PlannerPage() {
  const { projectId, section } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null),
    [plan, setPlan] = useState(initialPlan);
  // Wi-Fi and cellular projects are separate workspaces; cabling and
  // capacity are Wi-Fi tools.
  const workspace = workspaceOf(plan);
  const license = useWorkspace();
  const tabs = workspace === "cellular"
    ? ["design", "network", "data", "alignment", "settings"]
    : ["design", "network", "data", "alignment", "cabling", "capacity", "settings"];
  const tab = tabs.includes(section) ? section : "design";
  const setTab = (value) => navigate(`/projects/${projectId}/${value}`);
  // the open tab, for callbacks of work that finishes later (a floor-plan reading)
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [floorplanBusy, setFloorplanBusy] = useState("");
  // DAS Cable tool: the part or antenna the next cable starts from, and the bends clicked since
  const [cableFrom, setCableFrom] = useState(null);
  const [cablePoints, setCablePoints] = useState([]);
  // Cable tool: the item clicked whose end is being chosen, and the end the cable starts at
  const [cablePick, setCablePick] = useState(null);
  const [cableStartPort, setCableStartPort] = useState(null); // { id, port, dir: "in" | "out" }
  // types chosen in the DAS tool bar for the next part or cable placed
  const [dasOptions, setDasOptions] = useState({ splitter: "s2", coupler: "c10", combiner: "cm21", riser: "riser", cable: "auto", cableConnectors: 2, cableExtraM: 0 });
  const [projectName, setProjectName] = useState(""),
    [view, setView] = useState("2d"),
    [tool, setTool] = useState("select"),
    [selected, setSelected] = useState(null),
    [panelMode, setPanelMode] = useState("selection"),
    [sidebarExpanded, setSidebarExpanded] = useState(false),
    [expandedFloorId, setExpandedFloorId] = useState(null),
    [snap, setSnap] = useState(true),
    [showRoomNames, setShowRoomNames] = useState(true),
    [showFurnitureNames, setShowFurnitureNames] = useState(true),
    [showWifiNames, setShowWifiNames] = useState(true),
    [showMeasurements, setShowMeasurements] = useState(false),
    [showCables, setShowCables] = useState(false),
    [message, setMessage] = useState(""),
    [saveState, setSaveState] = useState("Saved"),
    [busy, setBusy] = useState(false);
  const [heatmap, setHeatmap] = useState(false),
    [heatmapOpacity, setHeatmapOpacity] = useState(0.8),
    [logsVisible, setLogsVisible] = useState(true),
    [logGrid, setLogGrid] = useState(false),
    [metric, setMetric] = useState("rssi"),
    [legendSections, setLegendSections] = useState(DEFAULT_LEGEND_SECTIONS),
    [mapMode, setMapMode] = useState("prediction"),
    [hiddenLayers, setHiddenLayers] = useState([]),
    [collisionFocus, setCollisionFocus] = useState(null),
    [gridSize, setGridSize] = useState(1),
    [aggregation, setAggregation] = useState("mean");
  const [zoom, setZoom] = useState(1);
  const [draftRooms, setDraftRooms] = useState(null),
    [draftWalls, setDraftWalls] = useState([]),
    [draftFurniture, setDraftFurniture] = useState([]),
    [draftFloorId, setDraftFloorId] = useState(null),
    [draftMethod, setDraftMethod] = useState(null),
    [imageWidth, setImageWidth] = useState(20),
    [availableSessions, setAvailableSessions] = useState([]),
    [sessionInput, setSessionInput] = useState("");
  const saveTimer = useRef(null),
    version = useRef(0),
    loaded = useRef(false);
  // ---- undo / redo -----------------------------------------------------------
  // Every edit goes through mutate. Edits less than HISTORY_GAP_MS apart (the
  // pointer moves of one drag, a typed number) are one undo step.
  const HISTORY_LIMIT = 100,
    HISTORY_GAP_MS = 500;
  const planRef = useRef(plan);
  planRef.current = plan;
  const history = useRef({ past: [], future: [], last: 0 });
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
  const syncHistory = () =>
    setHistorySize({
      past: history.current.past.length,
      future: history.current.future.length,
    });
  const resetHistory = () => {
    history.current = { past: [], future: [], last: 0 };
    syncHistory();
  };
  const mutate = useCallback((fn) => {
    const h = history.current,
      now = Date.now();
    if (now - h.last > HISTORY_GAP_MS) {
      h.past.push(planRef.current);
      if (h.past.length > HISTORY_LIMIT) h.past.shift();
      h.future = [];
      syncHistory();
    }
    h.last = now;
    setPlan((old) => {
      const next = typeof fn === "function" ? fn(old) : fn;
      return next;
    });
    setSaveState("Unsaved");
  }, []);
  // step through the history; view preferences are not part of an edit
  const stepHistory = (from, to) => {
    const h = history.current;
    if (!h[from].length) return;
    const current = planRef.current,
      target = h[from].pop();
    h[to].push(current);
    h.last = 0;
    syncHistory();
    setPlan({ ...target, preferences: current.preferences });
    setSaveState("Unsaved");
    // drop a selection the restored plan no longer has
    setSelected((sel) => {
      const key = sel && listKey[sel.type];
      return !key || (target[key] || []).some((x) => x.id === sel.id)
        ? sel
        : null;
    });
  };
  // Static locks dragging whole rooms and boundaries (property menu and footer)
  const setStatic = (value) =>
    mutate((p) => ({
      ...p,
      property: { ...p.property, static: value },
    }));
  const undo = () => stepHistory("past", "future");
  const redo = () => stepHistory("future", "past");
  const undoKeys = useRef();
  // Delete / Backspace removes the selected item; Escape cancels a cable being drawn
  const editKeys = useRef();
  useEffect(() => {
    const onKey = (e) => {
      const k = editKeys.current;
      if (!k?.active) return;
      const t = e.target;
      if (t?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && k.selected) {
        e.preventDefault();
        k.remove();
      } else if (e.key === "Escape") k.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // the shortcuts belong to the editor, like the footer buttons
  undoKeys.current = { undo, redo, active: tab === "design" };
  useEffect(() => {
    const onKey = (e) => {
      if (!undoKeys.current.active || !(e.ctrlKey || e.metaKey) || e.altKey)
        return;
      // text fields keep their own undo
      const t = e.target;
      if (
        t?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName)
      )
        return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undoKeys.current.undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        undoKeys.current.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!project || !loaded.current) return;
    const preferences = {
      view,
      heatmap,
      logsVisible,
      logGrid,
      metric,
      legendSections,
      hiddenLayers,
      gridSize,
      aggregation,
      snap,
      showRoomNames,
      showFurnitureNames,
      showWifiNames,
      showMeasurements,
    };
    if (JSON.stringify(plan.preferences) === JSON.stringify(preferences))
      return;
    setSaveState("Unsaved");
    setPlan((p) => ({ ...p, preferences }));
  }, [
    view,
    heatmap,
    logsVisible,
    logGrid,
    metric,
    legendSections,
    hiddenLayers,
    gridSize,
    aggregation,
    snap,
    showRoomNames,
    showFurnitureNames,
    showWifiNames,
    showMeasurements,
    project?.id,
    plan.preferences,
  ]);
  useEffect(() => {
    if (!project || !loaded.current) return;
    const v = ++version.current;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        setSaveState("Saving…");
        const item = await saveProject(project.id, projectName, plan);
        if (v === version.current) {
          setProject(item);
          setSaveState("Saved");
        }
      } catch (e) {
        setSaveState("Save failed");
        setMessage(e.message);
      }
    }, 650);
    return () => clearTimeout(saveTimer.current);
  }, [plan, projectName, project?.id]);
  const open = async (id) => {
    try {
      clearTimeout(saveTimer.current);
      loaded.current = false;
      const item = await getProject(id);
      const restored = { ...initialPlan(), ...item.plan };
      const pref = restored.preferences || {};
      setProject(item);
      setPlan(restored);
      resetHistory();
      setProjectName(item.name);
      setView(pref.view || "2d");
      setHeatmap(Boolean(pref.heatmap));
      setLogsVisible(pref.logsVisible !== false);
      setLogGrid(Boolean(pref.logGrid));
      setMetric(pref.metric || "rssi");
      setHiddenLayers(
        Array.isArray(pref.hiddenLayers) ? pref.hiddenLayers : [],
      );
      setLegendSections(
        Array.isArray(pref.legendSections)
          ? pref.legendSections
          : DEFAULT_LEGEND_SECTIONS,
      );
      setGridSize(num(pref.gridSize, 1));
      setAggregation(pref.aggregation || "mean");
      setSnap(pref.snap !== false);
      setShowRoomNames(pref.showRoomNames !== false);
      setShowFurnitureNames(pref.showFurnitureNames !== false);
      setShowWifiNames(pref.showWifiNames !== false);
      setShowMeasurements(pref.showMeasurements === true);
      setSelected(null);
      setPanelMode("selection");
      setSaveState("Saved");
      setMessage("");
      setTimeout(() => {
        loaded.current = true;
      }, 0);
    } catch (e) {
      setMessage(e.message);
    }
  };
  useEffect(() => {
    open(projectId);
  }, [projectId]);
  const back = async () => {
    if (saveState !== "Saved" && project) {
      try {
        await saveProject(project.id, projectName, plan);
      } catch (e) {
        setMessage(e.message);
        return;
      }
    }
    clearTimeout(saveTimer.current);
    loaded.current = false;
    setSelected(null);
    navigate("/");
  };
  const floorId = plan.selectedFloorId || plan.floors[0]?.id,
    rooms = plan.rooms.filter((r) => r.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId),
    floor = plan.floors.find((f) => f.id === floorId);
  // Wi-Fi shows RSSI / DL / UL throughput; cellular shows the other KPIs.
  // the project's network decides the KPIs (RSRP / SINR ... or RSSI / throughput)
  const networkKind = workspace;
  const kpiOptions = useMemo(() => kpisForKind(networkKind), [networkKind]);
  useEffect(() => {
    if (!kpiOptions.some((k) => k.key === metric))
      setMetric(
        kpiOptions.some((k) => k.key === defaultKpiFor(networkKind))
          ? defaultKpiFor(networkKind)
          : kpiOptions[0].key,
      );
  }, [kpiOptions, metric, networkKind]);
  const [rt, setRt] = useState({ maps: {}, active: false });
  // moving a room also moves what is inside it (furniture, APs, inner walls, inner rooms)
  const [moveWithContents, setMoveWithContents] = useState(true);
  // The prediction uses the same threshold bands as the measurement logs. It
  // is a dBm value (RSSI, otherwise RSRP) or the SNR in dB.
  const predictionMetric =
    workspace === "cellular"
      ? metric === "sinr" ? "sinr" : "rsrp"
      : metric === "snr" ? "snr" : "rssi";
  const predictionRanges = useMemo(
    () => getMetricRanges(plan, predictionMetric),
    [plan, predictionMetric],
  );
  // "weak" always means weak signal strength in dBm, whichever KPI is shown
  const weakRanges = useMemo(
    () => getMetricRanges(plan, workspace === "cellular" ? "rsrp" : "rssi"),
    [plan, predictionMetric],
  );
  const weakBelowDbm = Number(weakRanges[0]?.max ?? -100);
  const prediction = useRayTracedPrediction({
    plan,
    mutate,
    rt,
    setRt,
    setHeatmap,
    heatmap,
    showOnMap: () => setMapMode("prediction"),
    weakBelowDbm,
  });
  const cellular = useCellularPrediction({
    plan,
    mutate,
    showOnMap: () => setPanelMode("cellular"),
  });
  // One RSRP / SINR choice: the legend's KPI and the cellular map follow each other.
  const cellularMetric = cellular.metric,
    setCellularMetric = cellular.setMetric;
  useEffect(() => {
    if (workspace === "cellular" && (metric === "rsrp" || metric === "sinr") && metric !== cellularMetric)
      setCellularMetric(metric);
  }, [workspace, metric]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (workspace === "cellular" && metric !== cellularMetric && (metric === "rsrp" || metric === "sinr"))
      setMetric(cellularMetric);
  }, [workspace, cellularMetric]); // eslint-disable-line react-hooks/exhaustive-deps
  const optimization = useApOptimization({
    plan, mutate, setHeatmap,
    noiseSettings: prediction.rtSettings,
    setNoiseSettings: prediction.setRtSettings,
  });
  const optThreshold = optimization.opt?.threshold;
  // The map shows either the prediction (A) or the optimiser result (B). It
  // changes only when you open Run prediction / Optimise APs or press the A/B
  // tabs, never because something was selected or moved.
  const optOnMap = mapMode === "optimise";
  const heatRanges = useMemo(
    () =>
      optOnMap &&
      optimization.opt &&
      optimization.show !== "off" &&
      optimization.view === "coverage"
        ? [
            { min: -Infinity, max: optThreshold, color: "#dc2626" },
            { min: optThreshold, max: Infinity, color: "#16a34a" },
          ]
        : predictionRanges,
    [
      optOnMap,
      optimization.opt,
      optimization.show,
      optimization.view,
      optThreshold,
      predictionRanges,
    ],
  );
  const predictions = useMemo(() => {
      if (workspace === "cellular") return cellular.show ? cellular.cellsFor(floorId) : [];
      const optCells = optOnMap ? optimization.heatCells(floorId, {
        metric: predictionMetric,
        snrThreshold: Number(predictionRanges[0]?.max ?? 10),
      }) : null;
      if (optCells)
        return optCells.map((cell) => ({
          ...cell,
          thresholdDbm: cell.thresholdDbm ?? optThreshold,
          ranges: heatRanges,
        }));
      // the one model: the ray-traced result (an older one while a new run is
      // under way); empty until a prediction has been run
      const showSnr = predictionMetric === "snr";
      const snrWeak = Number(predictionRanges[0]?.max ?? 10);
      // an old prediction is left out once the plan has no AP left (it no longer applies)
      const cells =
        rt.active && rt.maps[floorId] && !prediction.noApsLeft
          ? rt.maps[floorId].map((cell) =>
              showSnr
                ? {
                    ...cell,
                    // the heatmap colours the `dbm` value: here the SNR in dB;
                    // a cell no signal reaches has the lowest SNR
                    dbm: Number.isFinite(cell.snr) ? cell.snr : -20,
                    thresholdDbm: snrWeak,
                    covered: Number.isFinite(cell.snr) && cell.snr >= snrWeak,
                  }
                : {
                    ...cell,
                    thresholdDbm: weakBelowDbm,
                    covered: cell.dbm >= weakBelowDbm,
                  },
            )
          : [];
      return cells.map((cell) => ({ ...cell, ranges: predictionRanges }));
    }, [
      plan,
      floorId,
      rt,
      weakBelowDbm,
      predictionMetric,
      predictionRanges,
      optOnMap,
      optimization.opt,
      optimization.show,
      optimization.view,
      heatRanges,
      optThreshold,
      prediction.noApsLeft,
      workspace,
      // the cellular map changes with its run, carrier, metric and targets
      cellular.show,
      cellular.result,
      cellular.carrierId,
      cellular.metric,
      cellular.ranges,
      cellular.threshold,
    ]),
    warnings = useMemo(() => overlapWarnings(rooms), [rooms]),
    nestedNotes = useMemo(() => nestedRoomNotes(rooms), [rooms]),
    totalArea = rooms.reduce((s, r) => s + areaOf(r), 0),
    coveredArea = Math.min(
      totalArea,
      predictions
        .filter((p) => p.covered)
        .reduce(
          (sum, p) => sum + (p.step || num(plan.rf.gridStepM, 1)) ** 2,
          0,
        ),
    ),
    coverage = predictions.length
      ? Math.round(
          (100 * predictions.filter((p) => p.covered).length) /
            predictions.length,
        )
      : 0;
  const boundaryTotal = (plan.boundaries || []).reduce(
    (sum, b) => sum + areaOf({ polygonPoints: b.points, shape: "polygon" }),
    0,
  );
  const roomTotal = plan.rooms.reduce((sum, room) => sum + areaOf(room), 0);
  const carpetFit = Boolean(plan.property?.carpetFit) && boundaryTotal > 0;
  const carpetArea = carpetFit
    ? boundaryTotal
    : plan.property?.carpetAreaM2 == null
      ? roomTotal
      : num(plan.property.carpetAreaM2, roomTotal);
  const obj =
    selected?.type === "room"
      ? plan.rooms.find((x) => x.id === selected.id)
      : selected?.type === "door"
        ? plan.doors.find((x) => x.id === selected.id)
        : selected?.type === "window"
          ? plan.windows.find((x) => x.id === selected.id)
          : selected?.type === "wall"
            ? plan.interiorWalls.find((x) => x.id === selected.id)
            : selected?.type === "furniture"
              ? plan.furniture.find((x) => x.id === selected.id)
              : selected?.type === "source"
                ? plan.sources.find((x) => x.id === selected.id)
                : selected?.type === "dascable"
                  ? (plan.cellular?.cables || []).find((x) => x.id === selected.id)
                : selected?.type === "boundary"
                  ? (plan.boundaries || []).find((x) => x.id === selected.id)
                  : null;
  const listKey = {
    room: "rooms",
    door: "doors",
    window: "windows",
    wall: "interiorWalls",
    furniture: "furniture",
    source: "sources",
    boundary: "boundaries",
  };
  const patchObj = (key, value, growthDirection = 1) => {
    if (!selected) return;
    const list = listKey[selected.type];
    if (
      selected.type === "room" &&
      moveWithContents &&
      (key === "x" || key === "z")
    ) {
      mutate((p) => {
        const room = p.rooms.find((r) => r.id === selected.id);
        const delta = Number(value) - num(room?.[key]);
        return room && Number.isFinite(delta) && delta !== 0
          ? shiftRoomContents(
              p,
              room,
              key === "x" ? delta : 0,
              key === "z" ? delta : 0,
            )
          : p;
      });
    }
    mutate((p) => ({
      ...p,
      [list]: p[list].map((x) => {
        if (x.id !== selected.id) return x;
        if (selected.type === "room" && key === "shape") {
          const bounds = bbox(x);
          if (value === "polygon") {
            const points = resizePolygonPoints(
              pointsOf(x),
              x.shape === "circle" ? 6 : pointsOf(x).length,
            );
            return {
              ...x,
              shape: value,
              polygonPoints: points,
              x: bounds.minX,
              z: bounds.minZ,
              width: bounds.maxX - bounds.minX,
              depth: bounds.maxZ - bounds.minZ,
            };
          }
          if (value === "circle") {
            const radius = Math.max(
              0.1,
              Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) /
                2,
            );
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const centerZ = (bounds.minZ + bounds.maxZ) / 2;
            return {
              ...x,
              shape: value,
              x: centerX - radius,
              z: centerZ - radius,
              width: radius * 2,
              depth: radius * 2,
              radius,
              polygonPoints: undefined,
            };
          }
          return {
            ...x,
            shape: "rectangle",
            x: bounds.minX,
            z: bounds.minZ,
            width: bounds.maxX - bounds.minX,
            depth: bounds.maxZ - bounds.minZ,
            polygonPoints: undefined,
          };
        }
        if (
          selected.type === "room" &&
          x.shape === "polygon" &&
          key === "polygonPoints"
        ) {
          const updated = { ...x, polygonPoints: value };
          const bounds = bbox(updated);
          return {
            ...updated,
            x: bounds.minX,
            z: bounds.minZ,
            width: bounds.maxX - bounds.minX,
            depth: bounds.maxZ - bounds.minZ,
          };
        }
        if (
          selected.type === "room" &&
          x.shape === "polygon" &&
          (key === "x" || key === "z")
        ) {
          const delta = value - num(x[key]);
          const polygonPoints = pointsOf(x).map((point) => ({
            ...point,
            [key]: point[key] + delta,
          }));
          const bounds = bbox({ ...x, polygonPoints });
          return {
            ...x,
            [key]: value,
            polygonPoints,
            x: key === "x" ? value : bounds.minX,
            z: key === "z" ? value : bounds.minZ,
            width: bounds.maxX - bounds.minX,
            depth: bounds.maxZ - bounds.minZ,
          };
        }
        if (
          selected.type === "room" &&
          x.shape === "circle" &&
          key === "radius"
        ) {
          const radius = Math.max(0.1, Number(value) || 0.1);
          const centerX = Number(x.x) + Number(x.radius || x.width / 2);
          const centerZ = Number(x.z) + Number(x.radius || x.depth / 2);
          return {
            ...x,
            x: centerX - radius,
            z: centerZ - radius,
            radius,
            width: radius * 2,
            depth: radius * 2,
          };
        }
        if (
          selected.type === "room" &&
          x.shape === "rectangle" &&
          growthDirection < 0 &&
          (key === "width" || key === "depth")
        ) {
          const size = Math.max(0.1, Number(value) || 0.1);
          if (key === "width")
            return {
              ...x,
              x: num(x.x) + num(x.width) - size,
              width: size,
            };
          return {
            ...x,
            z: num(x.z) + num(x.depth) - size,
            depth: size,
          };
        }
        return { ...x, [key]: value };
      }),
    }));
  };
  const deleteObj = () => {
    if (!selected) return;
    const id = selected.id;
    if (selected.type === "dascable") {
      mutate((p) => ({ ...p, cellular: { ...p.cellular, cables: (p.cellular?.cables || []).filter((c) => c.id !== id) } }));
      setSelected(null);
      return;
    }
    const list = listKey[selected.type];
    mutate((p) => {
      const next = { ...p, [list]: p[list].filter((x) => x.id !== id) };
      // a removed wall takes its doors and windows with it
      if (selected.type === "wall") {
        next.doors = p.doors.filter((d) => d.wallId !== id);
        next.windows = p.windows.filter((w) => w.wallId !== id);
      }
      // a removed DAS part or antenna takes its cables with it
      if (selected.type === "source" && p.cellular?.cables?.some((c) => c.from === id || c.to === id))
        next.cellular = { ...p.cellular, cables: p.cellular.cables.filter((c) => c.from !== id && c.to !== id) };
      return next;
    });
    setSelected(null);
  };
  editKeys.current = {
    active: tab === "design",
    selected: Boolean(selected && obj),
    remove: () => deleteObj(),
    cancel: () => {
      setCableFrom(null);
      setCablePoints([]);
      setCablePick(null);
      setCableStartPort(null);
    },
  };
  const selectEntity = (entity) => {
    setSelected(entity);
    setPanelMode("selection");
  };
  const openRightPanel = (mode) => {
    if (mode === "prediction") setMapMode("prediction");
    if (mode === "optimize") setMapMode("optimise");
    if (tab !== "design") setTab("design");
    setPanelMode(mode);
  };
  const addFloor = () => {
    const name = window.prompt("Floor name", `Level ${plan.floors.length + 1}`);
    if (!name?.trim()) return;
    const id = uid();
    mutate((p) => ({
      ...p,
      floors: [
        ...p.floors,
        { id, name: name.trim(), elevation: p.floors.length * 3.2 },
      ],
      selectedFloorId: id,
    }));
    setSelected(null);
    setPanelMode("selection");
  };
  const deleteFloor = () => {
    if (
      plan.floors.length < 2 ||
      !window.confirm(`Delete ${floor?.name} and its objects?`)
    )
      return;
    mutate((p) => {
      const floors = p.floors.filter((f) => f.id !== floorId);
      const next = {
        ...p,
        floors,
        selectedFloorId: floors[0].id,
        images: { ...p.images },
      };
      delete next.images[floorId];
      for (const key of [
        "rooms",
        "doors",
        "windows",
        "interiorWalls",
        "furniture",
        "sources",
        "logs",
      ])
        next[key] = p[key].filter((x) => x.floorId !== floorId);
      return withoutLooseCables(next);
    });
    setSelected(null);
    setPanelMode("selection");
  };
  // Empties the selected floor (also the only one): rooms, walls, openings, furniture, access points, the building
  // boundary and the imported picture. The floor itself and its measured logs stay.
  const clearFloor = () => {
    if (
      !window.confirm(
        `Remove everything on ${floor?.name}: rooms, walls, doors, windows, furniture, access points, boundary and the imported picture? Measured logs are kept.`,
      )
    )
      return;
    mutate((p) => {
      const gone = new Set(
        p.rooms.filter((r) => r.floorId === floorId).map((r) => r.id),
      );
      const next = { ...p, images: { ...p.images } };
      delete next.images[floorId];
      for (const key of [
        "rooms",
        "doors",
        "windows",
        "interiorWalls",
        "furniture",
        "sources",
        "boundaries",
      ])
        if (Array.isArray(p[key]))
          next[key] = p[key].filter((x) => x.floorId !== floorId);
      next.wallTypes = Object.fromEntries(
        Object.entries(p.wallTypes || {}).filter(
          ([k]) => !gone.has(k.split(":")[0]),
        ),
      );
      return withoutLooseCables(next);
    });
    setSelected(null);
    setPanelMode("selection");
  };
  // one end of a cable chosen (Cable tool): the first is its start, the second
  // finishes it. An output joins an input; the signal runs output -> input.
  const chooseCableEnd = ({ id, port, dir }) => {
    const item = plan.sources.find((s) => s.id === id);
    const end = item && portsOf(plan, item).find((x) => x.id === port);
    if (!end) return;
    if (end.other) {
      setMessage(`${item.name} ${end.label} is already used (${end.dir === "in" ? "from" : "to"} ${end.other}). Choose a free (orange) end.`);
      return;
    }
    setCablePick(null);
    if (!cableStartPort) {
      setCableFrom(id);
      setCableStartPort({ id, port, dir });
      setCablePoints([]);
      setMessage(`From ${item.name} ${end.label}: click corners along the route, then the other antenna or part and its end.`);
      return;
    }
    if (cableStartPort.id === id) {
      setMessage("Choose an end on another antenna or part.");
      return;
    }
    if (cableStartPort.dir === dir) {
      setMessage(
        dir === "out"
          ? "Both ends are outputs: an output joins an input (In or Ant)."
          : "Both ends are inputs: an input (In or Ant) is fed from an output (Out, Through, Tap).",
      );
      return;
    }
    const startIsOut = cableStartPort.dir === "out";
    const from = startIsOut ? cableStartPort : { id, port, dir };
    const to = startIsOut ? { id, port, dir } : cableStartPort;
    const problem = cableProblem(plan, from.id, to.id);
    if (problem) {
      setMessage(problem);
      return;
    }
    addCable(from.id, to.id, startIsOut ? cablePoints : [...cablePoints].reverse(), from.port);
    setCableStartPort(null);
  };
  // reshape a drawn cable: add a bend in the middle of a piece, move a bend, or take one out
  const bendCable = (cableId, action, index, at) =>
    mutate((p) => {
      const cur = cellularOf(p);
      return {
        ...p,
        cellular: {
          ...(p.cellular || {}),
          ...cur,
          cables: cur.cables.map((c) => {
            if (c.id !== cableId) return c;
            const points = [...(c.points || [])];
            if (action === "insert") points.splice(index, 0, { floorId, x: at.x, z: at.z });
            else if (action === "move" && points[index]) points[index] = { ...points[index], x: at.x, z: at.z };
            else if (action === "remove") points.splice(index, 1);
            return { ...c, points };
          }),
        },
      };
    });
  // adds the cable being drawn (port: the chosen output of its start part)
  const addCable = (from, to, points, port) => {
    const name = (id) => plan.sources.find((s) => s.id === id)?.name || "part";
    const c = {
      ...newCable(plan, from, to, uid(), { cableId: dasOptions.cable, points, port }),
      // chosen in the Cable pop-up
      connectors: dasOptions.cableConnectors ?? 2,
      extraM: dasOptions.cableExtraM ?? 0,
    };
    mutate((old) => {
      const cur = cellularOf(old);
      return { ...old, cellular: { ...(old.cellular || {}), ...cur, cables: [...cur.cables, c] } };
    });
    const portName = c.port ? ` (${{ through: "Through", tap: "Tap" }[c.port] || c.port.replace(/^out(\d+)$/, "Out $1")})` : "";
    setMessage(`Cable ${name(from)}${portName} → ${name(to)} added. Click the next end, or Cursor to stop.`);
    setCableFrom(null);
    setCablePoints([]);
    setCablePick(null);
    setCableStartPort(null);
  };
  const place = (kind, p) => {
    if (kind === "select") return;
    if (kind === "rectangle" || kind === "circle" || kind === "polygon") {
      let room = {
        id: uid(),
        floorId,
        name: `Room ${plan.rooms.length + 1}`,
        shape: kind,
        x: p.x,
        z: p.z,
        // a dragged rectangle brings its own size
        width: Number(p.width) > 0 ? +p.width : 5,
        depth: Number(p.depth) > 0 ? +p.depth : 4,
        height: 3,
        material: "drywall",
      };
      if (kind === "circle")
        room = {
          ...room,
          width: 4,
          depth: 4,
          radius: 2,
          x: p.x - 2,
          z: p.z - 2,
        };
      if (kind === "polygon") {
        const xs = p.points.map((q) => q.x),
          zs = p.points.map((q) => q.z);
        room = {
          ...room,
          x: Math.min(...xs),
          z: Math.min(...zs),
          width: Math.max(...xs) - Math.min(...xs),
          depth: Math.max(...zs) - Math.min(...zs),
          polygonPoints: p.points,
        };
      }
      mutate((old) => ({ ...old, rooms: [...old.rooms, room] }));
      selectEntity({ type: "room", id: room.id });
      if (kind === "rectangle" || kind === "polygon") setTool("select");
    }
    if (kind === "boundary") {
      const boundary = {
        id: uid(),
        floorId,
        name: "Building boundary",
        points: p.points,
        height: 3,
        material: "concrete",
      };
      mutate((old) => ({
        ...old,
        boundaries: [...(old.boundaries || []), boundary],
      }));
      selectEntity({ type: "boundary", id: boundary.id });
      setTool("select");
    }
    const dasType = { dassource: "source", splitter: "splitter", coupler: "coupler", combiner: "combiner", riser: "riser" }[kind];
    if (dasType && DAS_TYPES[dasType]) {
      const s = newDasPart(plan, dasType, floorId, p, uid(), { partId: dasOptions[dasType] });
      mutate((old) => ({ ...old, sources: [...old.sources, s] }));
      // the tool stays on (place more until Cursor is chosen); the new part is selected to change its type
      selectEntity({ type: "source", id: s.id });
      return;
    }
    if (kind === "dascable") {
      const name = (id) => plan.sources.find((s) => s.id === id)?.name || "part";
      if (!p.id) {
        // a click on the plan while a cable is being drawn is a bend of its route
        if (cableFrom) setCablePoints((pts) => [...pts, { floorId, x: p.x, z: p.z }]);
        else setMessage("Click the source, splitter, coupler, combiner or riser the cable starts from.");
        return;
      }
      // a click on an antenna or part: it pops out with its ends; one of them is chosen next
      setCablePick(p.id);
      setMessage(`${name(p.id)}: click the end to connect (the big orange squares, or the buttons below).`);
      return;
    }
    if (kind === "dasport") chooseCableEnd(p);
    if (kind === "cellular" || kind === "wifi") {
      const s = {
        ...defaultSource(kind, p, floorId, plan.rf),
        ...(kind === "cellular" ? newAntennaFields(plan) : {}),
      };
      mutate((old) => ({ ...old, sources: [...old.sources, s] }));
      selectEntity({ type: "source", id: s.id });
    }
    if (kind === "furniture") {
      const f = {
        id: uid(),
        floorId,
        name: "Furniture",
        x: p.x,
        z: p.z,
        width: 1.5,
        depth: 0.8,
        height: 0.8,
      };
      mutate((old) => ({ ...old, furniture: [...old.furniture, f] }));
      selectEntity({ type: "furniture", id: f.id });
    }
    if (kind === "wall") {
      const w = {
        id: uid(),
        floorId,
        name: "Interior wall",
        ...p,
        material: "drywall",
      };
      mutate((old) => ({ ...old, interiorWalls: [...old.interiorWalls, w] }));
      setSelected({ type: "wall", id: w.id });
    }
    if (kind === "door" || kind === "window") {
      const openingWidth = kind === "door" ? 0.9 : 1.2;
      const wallPlacement =
        kind === "door"
          ? findRoomWallPlacement(
              rooms,
              p,
              openingWidth,
              Math.max(0.5, Number(plan.wallThickness) + 0.3),
            )
          : null;
      // not on a room side: the nearest loose wall within reach takes it
      if (!wallPlacement) {
        const reach = Math.max(0.5, Number(plan.wallThickness) + 0.3);
        const near = plan.interiorWalls
          .filter((w) => w.floorId === floorId)
          .map((w) => {
            const along = distanceAlongWall(w, p),
              length = Math.hypot(w.x2 - w.x1, w.z2 - w.z1),
              t = length ? along / length : 0;
            const gap = Math.hypot(
              p.x - (+w.x1 + (w.x2 - w.x1) * t),
              p.z - (+w.z1 + (w.z2 - w.z1) * t),
            );
            return { w, along, length, gap };
          })
          .filter((c) => c.gap <= reach && c.length >= openingWidth)
          .sort((a, b) => a.gap - b.gap)[0];
        if (near) {
          const o = {
            id: uid(),
            floorId,
            wallId: near.w.id,
            offset: Math.max(0, Math.min(near.length - openingWidth, near.along - openingWidth / 2)),
            width: openingWidth,
            height: kind === "door" ? 2.1 : 1.2,
            ...(kind === "window" ? { sillHeight: 1 } : {}),
          };
          const listName = kind === "door" ? "doors" : "windows";
          mutate((old) => ({ ...old, [listName]: [...old[listName], o] }));
          setSelected({ type: kind, id: o.id });
          return;
        }
      }
      if (kind === "door" && !wallPlacement) {
        setMessage(
          rooms.length ? "Place the door on a room wall." : "Add a room first.",
        );
        return;
      }
      const r =
        wallPlacement?.room ||
        rooms.find((r) => inside(p.x, p.z, r)) ||
        rooms.reduce((best, r) => {
          const b = bbox(r),
            d = Math.hypot(
              p.x - (b.minX + b.maxX) / 2,
              p.z - (b.minZ + b.maxZ) / 2,
            );
          return !best || d < best.d ? { r, d } : best;
        }, null)?.r;
      if (!r) {
        setMessage("Add a room first.");
        return;
      }
      const b = bbox(r),
        dist = {
          north: Math.abs(p.z - b.minZ),
          south: Math.abs(p.z - b.maxZ),
          west: Math.abs(p.x - b.minX),
          east: Math.abs(p.x - b.maxX),
        },
        side =
          wallPlacement?.side ||
          Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0],
        offset = Math.max(
          0,
          wallPlacement?.offset ??
            (side === "north" || side === "south"
              ? p.x - b.minX
              : p.z - b.minZ),
        );
      const o = {
        id: uid(),
        floorId,
        roomId: r.id,
        wallSide: side,
        offset,
        width: openingWidth,
        height: kind === "door" ? 2.1 : 1.2,
        ...(kind === "window" ? { sillHeight: 1 } : {}),
      };
      mutate((old) => ({
        ...old,
        [kind === "door" ? "doors" : "windows"]: [
          ...old[kind === "door" ? "doors" : "windows"],
          o,
        ],
      }));
      setSelected({ type: kind, id: o.id });
    }
  };
  const confirmRotation = (roomIds, deg) =>
    !rotationLosesData(plan, roomIds, deg) ||
    window.confirm(
      "Turning a rectangular room by an angle that is not a multiple of 90° makes it a polygon. Its doors, windows and per-side wall materials will be removed. Continue?",
    );
  const rotateSelected = (deg) => {
    if (!selected) return;
    if (selected.type === "room") {
      const room = plan.rooms.find((r) => r.id === selected.id);
      if (!room) return;
      const ids = [
        room.id,
        ...(moveWithContents ? roomContents(plan, room).rooms : []),
      ];
      if (!confirmRotation(ids, deg)) return;
      mutate((p) => rotateRoom(p, selected.id, deg, moveWithContents));
    } else if (selected.type === "furniture")
      mutate((p) => rotateFurniture(p, selected.id, deg));
    else if (selected.type === "wall")
      mutate((p) => rotateInteriorWall(p, selected.id, deg));
    else if (selected.type === "boundary") {
      const b = (plan.boundaries || []).find((x) => x.id === selected.id);
      if (!b) return;
      const ids = moveWithContents
        ? roomContents(plan, boundaryArea(b)).rooms
        : [];
      if (!confirmRotation(ids, deg)) return;
      mutate((p) => rotateBoundary(p, selected.id, deg, moveWithContents));
    }
  };
  const rotateWholeBuilding = (deg) => {
    if (
      !confirmRotation(
        plan.rooms.map((r) => r.id),
        deg,
      )
    )
      return;
    mutate((p) => rotateBuilding(p, deg));
  };
  const move = (type, id, dx, dz) => {
    const key = listKey[type];
    mutate((plan0) => {
      const carried =
        (type === "room" || type === "boundary") && moveWithContents
          ? (() => {
              const area =
                type === "room"
                  ? plan0.rooms.find((r) => r.id === id)
                  : (() => {
                      const b = (plan0.boundaries || []).find(
                        (x) => x.id === id,
                      );
                      return b && boundaryArea(b);
                    })();
              return area ? shiftRoomContents(plan0, area, dx, dz) : plan0;
            })()
          : plan0;
      const p = carried;
      return {
        ...p,
        [key]: p[key].map((x) =>
          x.id === id
            ? type === "boundary"
              ? {
                  ...x,
                  points: x.points.map((q) => ({ x: q.x + dx, z: q.z + dz })),
                }
              : type === "wall"
                ? {
                    ...x,
                    x1: +x.x1 + dx,
                    x2: +x.x2 + dx,
                    z1: +x.z1 + dz,
                    z2: +x.z2 + dz,
                  }
                : (type === "door" || type === "window") && x.wallId
                  ? {
                      ...x,
                      offset: (() => {
                        const w = p.interiorWalls.find((item) => item.id === x.wallId);
                        if (!w) return x.offset;
                        const length = Math.hypot(w.x2 - w.x1, w.z2 - w.z1) || 1;
                        const along = (dx * (w.x2 - w.x1) + dz * (w.z2 - w.z1)) / length;
                        return Math.max(
                          0,
                          Math.min(length - Number(x.width || 0), num(x.offset) + along),
                        );
                      })(),
                    }
                : type === "door" || type === "window"
                  ? {
                      ...x,
                      offset: (() => {
                        const room = p.rooms.find(
                          (item) => item.id === x.roomId,
                        );
                        const wallLength = room
                          ? ["north", "south"].includes(x.wallSide)
                            ? bbox(room).maxX - bbox(room).minX
                            : bbox(room).maxZ - bbox(room).minZ
                          : Infinity;
                        return Math.max(
                          0,
                          Math.min(
                            wallLength - Number(x.width || 0),
                            num(x.offset) +
                              (x.wallSide === "north" || x.wallSide === "south"
                                ? dx
                                : dz),
                          ),
                        );
                      })(),
                    }
                  : type === "room" && x.shape === "polygon"
                    ? {
                        ...x,
                        x: +x.x + dx,
                        z: +x.z + dz,
                        polygonPoints: pointsOf(x).map((point) => ({
                          x: point.x + dx,
                          z: point.z + dz,
                        })),
                      }
                    : { ...x, x: +x.x + dx, z: +x.z + dz }
            : x,
        ),
      };
    });
  };
  // Drag one vertex, or one edge (vertices index and index + 1), of a room,
  // a building boundary or an interior wall. A rectangle room becomes a
  // polygon on its first reshape; its doors and windows move from wall sides
  // to edge indices so they stay where they were.
  const moveShapePart = (type, id, vertexIndex, dx, dz, mode) => {
    const shift = (points) => {
      const out = points.map((point) => ({ x: point.x, z: point.z }));
      const indices =
        mode === "edge"
          ? [vertexIndex, (vertexIndex + 1) % out.length]
          : [vertexIndex % out.length];
      for (const index of indices)
        out[index] = { x: out[index].x + dx, z: out[index].z + dz };
      return out;
    };
    mutate((p) => {
      if (type === "wall")
        return {
          ...p,
          interiorWalls: p.interiorWalls.map((w) => {
            if (w.id !== id) return w;
            const [a, b] = shift([
              { x: +w.x1, z: +w.z1 },
              { x: +w.x2, z: +w.z2 },
            ]);
            return { ...w, x1: a.x, z1: a.z, x2: b.x, z2: b.z };
          }),
        };
      if (type === "boundary")
        return {
          ...p,
          boundaries: (p.boundaries || []).map((b) =>
            b.id === id ? { ...b, points: shift(b.points) } : b,
          ),
        };
      const room = p.rooms.find((r) => r.id === id);
      // circles keep their own radius editing
      if (!room || room.shape === "circle") return p;
      const wasRectangle = room.shape !== "polygon";
      const polygonPoints = shift(pointsOf(room));
      const updated = { ...room, shape: "polygon", polygonPoints };
      const bounds = bbox(updated);
      const rooms = p.rooms.map((r) =>
        r.id === id
          ? {
              ...updated,
              x: bounds.minX,
              z: bounds.minZ,
              width: bounds.maxX - bounds.minX,
              depth: bounds.maxZ - bounds.minZ,
            }
          : r,
      );
      if (!wasRectangle) return { ...p, rooms };
      // rectangle vertices run NW, NE, SE, SW: edge i is side SIDES[i], and
      // south / west offsets were measured against the edge direction
      const SIDES = ["north", "east", "south", "west"];
      const b0 = bbox(room);
      const toEdge = (o) => {
        if (o.roomId !== id || Number.isInteger(+o.edgeIndex)) return o;
        const edgeIndex = SIDES.indexOf(o.wallSide || "east");
        const length =
          edgeIndex % 2 === 0 ? b0.maxX - b0.minX : b0.maxZ - b0.minZ;
        const offset =
          edgeIndex >= 2
            ? Math.max(0, length - num(o.offset) - num(o.width))
            : num(o.offset);
        return { ...o, edgeIndex, offset };
      };
      const wallTypes = { ...(p.wallTypes || {}) };
      const sideMaterial = SIDES.map((s) => wallTypes[`${id}:${s}`]).filter(Boolean);
      const material =
        sideMaterial.length && sideMaterial.every((m) => m === sideMaterial[0])
          ? sideMaterial[0]
          : undefined;
      return {
        ...p,
        rooms: material
          ? rooms.map((r) => (r.id === id ? { ...r, material } : r))
          : rooms,
        doors: p.doors.map(toEdge),
        windows: p.windows.map(toEdge),
      };
    });
  };
  const importBuilding = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = await readBuilding(file);
      const { floors } = parsed;
      mutate((p) => ({
        ...p,
        floors,
        selectedFloorId: floors[0].id,
        rooms: parsed.rooms,
        doors: parsed.doors,
        windows: parsed.windows,
        interiorWalls: parsed.interiorWalls,
        furniture: parsed.furniture,
        wallThickness: parsed.wallThickness,
        boundaryPolygon: parsed.boundaryPolygon,
      }));
      setMessage(
        `Imported ${parsed.rooms.length} rooms across ${floors.length} floors.`,
      );
      setTab("design");
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const importLogs = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = await readLogs(file, floorId, plan.alignment);
      mutate((p) => ({
        ...p,
        logs: [
          ...p.logs,
          ...parsed.logs.map((l) => ({ ...l, source: file.name })),
        ],
        thresholds: { ...p.thresholds, ...parsed.zipThresholds },
      }));
      setMessage(
        `Imported ${parsed.total} logs; ${parsed.pendingAlignment || 0} GPS samples await alignment.`,
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const importImage = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      if (num(imageWidth) <= 0)
        throw Error("Enter an image width greater than zero.");
      const { imageData, rooms: found } = await readFloorImage(
        file,
        num(imageWidth, 20),
        floorId,
      );
      mutate((p) => ({
        ...p,
        images: {
          ...p.images,
          [floorId]: imageData,
        },
      }));
      setDraftRooms(found.length ? found : null);
      setDraftWalls([]);
      setDraftFurniture([]);
      setDraftFloorId(found.length ? floorId : null);
      setDraftMethod(found.length ? "Quick scan" : null);
      setMessage(
        found.length
          ? `Quick scan found ${found.length} possible enclosed rooms.`
          : "Quick scan found no reliable enclosed rooms.",
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const discardDraft = () => {
    setDraftRooms(null);
    setDraftWalls([]);
    setDraftFurniture([]);
    setDraftFloorId(null);
    setDraftMethod(null);
  };
  const applyDraft = () => {
    if (!draftRooms || !draftFloorId) return;
    mutate((p) => ({
      ...p,
      rooms: [...p.rooms, ...draftRooms],
      interiorWalls: [...p.interiorWalls, ...draftWalls],
      furniture: [...p.furniture, ...draftFurniture],
    }));
    discardDraft();
    setTab("design");
    setMessage(
      "Trace added to the playground. You can edit each object in the editor.",
    );
  };
  const reviewedWorkbook = async () => {
    try {
      await downloadReviewedRooms(
        draftRooms,
        projectName,
        plan.wallThickness,
        floor,
        draftWalls,
        draftFurniture,
      );
    } catch (e) {
      setMessage(e.message);
    }
  };
  const template = async () => {
    try {
      await downloadBuildingTemplate();
    } catch (e) {
      setMessage(e.message);
    }
  };
  const loadSession = async () => {
    const ids = sessionInput.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) return;
    setBusy(true);
    try {
      const combined = await loadSessions(ids, floorId, plan.alignment);
      mutate((p) => ({
        ...p,
        logs: [...p.logs, ...combined],
        sessionIds: [...new Set([...p.sessionIds, ...ids])],
      }));
      setMessage(`Loaded ${combined.length} session samples.`);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const browseSessions = async () => {
    try {
      const list = await listSessions();
      setAvailableSessions(list);
      setMessage(
        list.length
          ? `${list.length} local sessions available.`
          : "No local sessions found in data/sessions.",
      );
    } catch (e) {
      setMessage(e.message);
    }
  };
  const currentLogs = getFloorLogs(plan, floorId);
  const metricRanges = getMetricRanges(plan, metric);
  const { sampledCells, measuredArea: sampledArea } = getMeasuredArea({
    logs: currentLogs,
    rooms,
    gridSize,
    totalArea,
  });
  const applyAlignment = ({ lat, lng, x, z, rotationDeg }) => {
    mutate((p) => ({
      ...p,
      alignment: {
        lat: num(lat),
        lng: num(lng),
        x: num(x),
        z: num(z),
        rotationDeg: num(rotationDeg),
        unit: "m",
        referenceFloorId: floorId,
      },
    }));
    setMessage("Geographic logs projected onto the plan.");
  };
  // A room that is really the building outline becomes the boundary: exterior
  // wall and one floor slab; rooms inside it stay as they are.
  const convertRoomToBoundary = (roomId) => {
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const boundary = {
      id: uid(),
      floorId: room.floorId,
      name: "Building boundary",
      points: pointsOf(room).map((p) => ({ x: p.x, z: p.z })),
      height: Number(room.height) || 3,
      material: room.material || "concrete",
    };
    mutate((p) => ({
      ...p,
      rooms: p.rooms.filter((r) => r.id !== roomId),
      boundaries: [...(p.boundaries || []), boundary],
    }));
    selectEntity({ type: "boundary", id: boundary.id });
  };
  // Walls drawn one by one become a room: the walls joined end to end with the
  // chosen one give the outline (an open chain is closed with a straight side).
  // Those loose walls are removed, as the room draws its own walls.
  const makeRoomFromWalls = (wallId) => {
    const wall = plan.interiorWalls.find((w) => w.id === wallId);
    if (!wall) return;
    const walls = plan.interiorWalls.filter((w) => w.floorId === wall.floorId);
    const tolerance = Math.max(0.3, Number(plan.wallThickness) || 0.2);
    const found = roomOutlineFromWalls(walls, wallId, tolerance);
    if (found.error) {
      setMessage(found.error);
      return;
    }
    const used = walls.filter((w) => found.wallIds.includes(w.id));
    const counts = {};
    for (const w of used) counts[w.material || "drywall"] = (counts[w.material || "drywall"] || 0) + 1;
    const material = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const xs = found.points.map((q) => q.x),
      zs = found.points.map((q) => q.z);
    const x = Math.min(...xs),
      z = Math.min(...zs),
      maxX = Math.max(...xs),
      maxZ = Math.max(...zs);
    const upright =
      found.points.length === 4 &&
      found.points.every(
        (q) =>
          (Math.abs(q.x - x) < 1e-6 || Math.abs(q.x - maxX) < 1e-6) &&
          (Math.abs(q.z - z) < 1e-6 || Math.abs(q.z - maxZ) < 1e-6),
      );
    const room = {
      id: uid(),
      floorId: wall.floorId,
      name: `Room ${plan.rooms.length + 1}`,
      shape: upright ? "rectangle" : "polygon",
      x,
      z,
      width: maxX - x,
      depth: maxZ - z,
      height: Math.max(...used.map((w) => Number(w.height) || 0), 0) || 3,
      material,
      ...(upright ? {} : { polygonPoints: found.points.map((q) => ({ x: q.x, z: q.z })) }),
    };
    const gone = new Set(found.wallIds);
    mutate((p) => ({
      ...p,
      interiorWalls: p.interiorWalls.filter((w) => !gone.has(w.id)),
      rooms: [...p.rooms, room],
      // doors and windows on those walls move onto the room's sides
      doors: openingsOntoRoom(room, used, p.doors),
      windows: openingsOntoRoom(room, used, p.windows),
    }));
    selectEntity({ type: "room", id: room.id });
    setMessage(
      found.closed
        ? `${room.name} made from ${used.length} walls.`
        : `${room.name} made from ${used.length} walls; the open side was closed with a straight wall.`,
    );
  };
  // Breaks one interior wall into two walls at `at` metres from its first end.
  // Both keep the wall's material, height and name; the first stays selected.
  const breakWall = (wallId, at) => {
    const wall = plan.interiorWalls.find((w) => w.id === wallId);
    if (!wall) return;
    const pieces = splitWall(wall, at, uid());
    if (pieces.error) {
      setMessage(pieces.error);
      return;
    }
    const doors = openingsAfterBreak(plan.doors, wallId, pieces[1].id, at),
      windows = openingsAfterBreak(plan.windows, wallId, pieces[1].id, at);
    if (doors.error || windows.error) {
      setMessage(doors.error || windows.error);
      return;
    }
    mutate((p) => ({
      ...p,
      interiorWalls: p.interiorWalls.flatMap((w) => (w.id === wallId ? pieces : [w])),
      doors: openingsAfterBreak(p.doors, wallId, pieces[1].id, at).items,
      windows: openingsAfterBreak(p.windows, wallId, pieces[1].id, at).items,
    }));
    selectEntity({ type: "wall", id: pieces[0].id });
    setMessage("Wall broken into two walls.");
  };
  // Two loose walls in one line become one wall (the first keeps its id, name
  // and material); doors and windows of both stay where they are.
  const mergeWalls = (keepId, otherId) => {
    const a = plan.interiorWalls.find((w) => w.id === keepId),
      b = plan.interiorWalls.find((w) => w.id === otherId);
    if (!a || !b) return;
    mutate((p) => {
      const doors = mergeTwoWalls(a, b, p.doors),
        windows = mergeTwoWalls(a, b, p.windows);
      return {
        ...p,
        interiorWalls: p.interiorWalls
          .filter((w) => w.id !== otherId)
          .map((w) => (w.id === keepId ? doors.wall : w)),
        doors: doors.items,
        windows: windows.items,
      };
    });
    selectEntity({ type: "wall", id: keepId });
    setMessage(`${a.name || "Wall"} and ${b.name || "wall"} merged into one wall.`);
  };
  // Turns a room into loose walls, one per side (a rectangle gives four), so
  // each wall can be moved, broken or deleted on its own. Each wall keeps its
  // side's material and the room height.
  const splitRoomIntoWalls = (roomId) => {
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const walls = wallsFromRoom(room, plan.wallTypes || {}, uid);
    if (walls.error) {
      setMessage(walls.error);
      return;
    }
    mutate((p) => ({
      ...p,
      rooms: p.rooms.filter((r) => r.id !== roomId),
      interiorWalls: [...p.interiorWalls, ...walls],
      // doors and windows stay where they are, now on the new walls
      doors: openingsOntoWalls(room, walls, p.doors),
      windows: openingsOntoWalls(room, walls, p.windows),
      wallTypes: Object.fromEntries(
        Object.entries(p.wallTypes || {}).filter(([key]) => !key.startsWith(`${roomId}:`)),
      ),
    }));
    selectEntity({ type: "wall", id: walls[0].id });
    setMessage(`${room.name || "Room"} split into ${walls.length} walls.`);
  };
  // Splits an upright rectangle room into four equal quarter rooms (NW, NE,
  // SW, SE). Outer walls keep their materials, doors and windows move to the
  // quarter whose side they sit on; the new inner walls use the room material.
  const splitRoomInFour = (roomId) => {
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room || (room.shape && room.shape !== "rectangle")) return;
    const x0 = +room.x,
      z0 = +room.z,
      hw = +room.width / 2,
      hd = +room.depth / 2;
    if (!(hw > 0 && hd > 0)) return;
    const quarters = [
      { key: "nw", x: x0, z: z0, sides: ["north", "west"] },
      { key: "ne", x: x0 + hw, z: z0, sides: ["north", "east"] },
      { key: "sw", x: x0, z: z0 + hd, sides: ["south", "west"] },
      { key: "se", x: x0 + hw, z: z0 + hd, sides: ["south", "east"] },
    ].map((q, i) => ({
      ...q,
      room: {
        ...room,
        id: uid(),
        name: `${room.name || "Room"} ${i + 1}`,
        shape: "rectangle",
        x: q.x,
        z: q.z,
        width: hw,
        depth: hd,
      },
    }));
    const byKey = Object.fromEntries(quarters.map((q) => [q.key, q.room]));
    const SIDES = ["north", "east", "south", "west"];
    const moveOpening = (o) => {
      if (o.roomId !== roomId) return o;
      const side =
        o.wallSide || (Number.isInteger(+o.edgeIndex) ? SIDES[+o.edgeIndex] : "north");
      const along = side === "north" || side === "south";
      const half = along ? hw : hd;
      const width = Number(o.width) || 0;
      const start = Number(o.offset) || 0;
      const second = start + width / 2 >= half;
      const key = along
        ? (side === "north" ? "n" : "s") + (second ? "e" : "w")
        : (second ? "s" : "n") + (side === "west" ? "w" : "e");
      const offset = Math.max(
        0,
        Math.min(start - (second ? half : 0), half - width),
      );
      const { edgeIndex, ...rest } = o;
      return { ...rest, roomId: byKey[key].id, wallSide: side, offset };
    };
    mutate((p) => {
      const wallTypes = Object.fromEntries(
        Object.entries(p.wallTypes || {}).filter(
          ([k]) => k.split(":")[0] !== roomId,
        ),
      );
      for (const q of quarters)
        for (const side of q.sides) {
          const m = (p.wallTypes || {})[`${roomId}:${side}`];
          if (m) wallTypes[`${q.room.id}:${side}`] = m;
        }
      return {
        ...p,
        rooms: [
          ...p.rooms.filter((r) => r.id !== roomId),
          ...quarters.map((q) => q.room),
        ],
        doors: p.doors.map(moveOpening),
        windows: p.windows.map(moveOpening),
        wallTypes,
      };
    });
    selectEntity({ type: "room", id: quarters[0].room.id });
    setMessage(`${room.name || "Room"} split into four rooms.`);
  };
  // Panel position fields: top-left of the boundary's bounding box.
  const boundaryCorner = (b) => ({
    x: Math.min(...b.points.map((q) => q.x)),
    z: Math.min(...b.points.map((q) => q.z)),
  });
  const moveBoundaryTo = (id, axis, value) => {
    const target = Number(value);
    if (!Number.isFinite(target)) return;
    // the shift is worked out from the plan being updated, not from a render
    mutate((p) => {
      const b = (p.boundaries || []).find((x) => x.id === id);
      if (!b) return p;
      const delta = target - boundaryCorner(b)[axis];
      if (!delta) return p;
      const dx = axis === "x" ? delta : 0,
        dz = axis === "z" ? delta : 0;
      const carried = moveWithContents
        ? shiftRoomContents(p, boundaryArea(b), dx, dz)
        : p;
      return {
        ...carried,
        boundaries: carried.boundaries.map((x) =>
          x.id === id
            ? {
                ...x,
                points: x.points.map((q) => ({ x: q.x + dx, z: q.z + dz })),
              }
            : x,
        ),
      };
    });
  };
  // Back to an ordinary room (the reverse of "Use as building boundary"). An
  // upright four-corner outline becomes a rectangle room, anything else a polygon.
  const convertBoundaryToRoom = (id) => {
    const b = (plan.boundaries || []).find((x) => x.id === id);
    if (!b) return;
    const xs = b.points.map((q) => q.x),
      zs = b.points.map((q) => q.z);
    const x = Math.min(...xs),
      z = Math.min(...zs);
    const near = (a, c) => Math.abs(a - c) < 1e-6;
    const upright =
      b.points.length === 4 &&
      b.points.every(
        (q) =>
          (near(q.x, x) || near(q.x, Math.max(...xs))) &&
          (near(q.z, z) || near(q.z, Math.max(...zs))),
      );
    const room = {
      id: uid(),
      floorId: b.floorId,
      name: `Room ${plan.rooms.length + 1}`,
      shape: upright ? "rectangle" : "polygon",
      x,
      z,
      width: Math.max(...xs) - x,
      depth: Math.max(...zs) - z,
      height: Number(b.height) || 3,
      material: b.material || "drywall",
      ...(upright ? {} : { polygonPoints: b.points.map((q) => ({ ...q })) }),
    };
    mutate((p) => ({
      ...p,
      boundaries: p.boundaries.filter((x2) => x2.id !== id),
      rooms: [...p.rooms, room],
    }));
    selectEntity({ type: "room", id: room.id });
  };
  const mergeWall = (collision, material) => {
    mutate((p) => mergeSharedWall(p, collision, material));
    setCollisionFocus(null);
    setMessage("Walls merged into one wall.");
  };
  const snapWalls = (collision) => {
    mutate((p) => snapCollidingWalls(p, collision));
    setCollisionFocus(null);
    setMessage("Walls snapped together and merged into one wall.");
  };
  const [imageBusy, setImageBusy] = useState(false);
  const downloadPlot = async () => {
    setImageBusy(true);
    try {
      const blob = await plotImageBlob({
        title: [projectName, floor?.name].filter(Boolean).join(" · "),
      });
      downloadBlob(blob, plotFileName(projectName, floor?.name));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setImageBusy(false);
    }
  };
  const [reportBusy, setReportBusy] = useState(false);
  // ---- reports of the optimiser's design (not applied to the plan) ---------------------------------------
  // The plan as Apply would leave it, predicted on that band, then the usual report. Used when the plan has no
  // APs, or when you choose the optimised design; with your own APs and no choice, the reports are as before.
  const preferOptimised = (what) =>
    !window.confirm(
      `Your plan has access points and there is also an optimiser result.

OK: ${what} of your current access points (as before).
Cancel: ${what} of the optimised design instead.`,
    );
  const predictOnBand = async (somePlan, band, label) => {
    const { buildSceneZip } = await import("../utils/sceneExport.js");
    setMessage(`${label}: preparing the ${band} GHz prediction of the optimised design…`);
    const { blob } = await buildSceneZip(planForBand(somePlan, band), {});
    const { sceneId } = await uploadScene(blob);
    const job = await submitSimulation(sceneId, {
      ...prediction.rtSettings,
      receiverGainDbi: Number(plan.rf?.rxGainDbi) || 0,
    });
    const status = await waitForSimulation(job.id, {
      onStatus: (phase) => setMessage(`${label}: ${band} GHz prediction of the optimised design · ${phase}…`),
    });
    return { jobId: job.id, result: status.result, finishedAt: new Date().toISOString() };
  };
  const optimisedLabel = (run) =>
    `Optimised ${run.settingsUsed.band} GHz design from the optimiser run of ${run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "the saved run"} (not applied to the plan)`;
  const downloadOptimisedReport = async () => {
    const run = optimization.opt;
    setReportBusy(true);
    try {
      const band = run.settingsUsed.band;
      const designed = optimization.optimisedPlan(band);
      if (!designed) throw Error("The optimiser result could not be loaded: run the optimiser again.");
      const rtRun = await predictOnBand(designed, band, "Report");
      const { buildReport } = await import("../utils/reportBuilder.js");
      const { loadReportLogos } = await import("../utils/reportLogos.js");
      const blob = await buildReport({
        logos: await loadReportLogos(),
        snrRanges: getMetricRanges(plan, "snr"),
        plan: designed,
        projectName,
        rt: rtRun,
        opt: run,
        ranges: weakRanges,
        thresholdDbm: weakBelowDbm,
        getMap: (jobId, file) => getRtMap(jobId, file),
        onProgress: (text) => setMessage(`Building report of the optimised design: ${text}…`),
        designLabel: optimisedLabel(run),
      });
      downloadBlob(blob, `${(projectName || "plan").replace(/[^w.-]+/g, "_")}-optimised-${band}GHz-wifi-report.docx`);
      setMessage("Report of the optimised design downloaded.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setReportBusy(false);
    }
  };
  const downloadOptimisedComparison = async () => {
    setCompareBusy(true);
    try {
      const planByBand = {};
      const runs = {};
      for (const band of COMPARED_BANDS) {
        planByBand[band] = optimization.optimisedPlan(band);
        if (!planByBand[band]) throw Error(`The ${band} GHz optimiser result could not be loaded: run the optimiser again.`);
        runs[band] = await predictOnBand(planByBand[band], band, "Comparison");
      }
      const { buildBandComparisonReport } = await import("../utils/reportCompare.js");
      const { loadReportLogos } = await import("../utils/reportLogos.js");
      const when = optimization.altRuns[COMPARED_BANDS[0]]?.finishedAt;
      const blob = await buildBandComparisonReport({
        logos: await loadReportLogos(),
        snrRanges: getMetricRanges(plan, "snr"),
        plan,
        planByBand,
        projectName,
        runs,
        ranges: weakRanges,
        designThr: Number.isFinite(optimization.opt?.threshold) ? optimization.opt.threshold : weakBelowDbm,
        getMap: (jobId, file) => getRtMap(jobId, file),
        onProgress: (text) => setMessage(`Building comparison of the optimised designs: ${text}…`),
        designLabel: `Optimised designs from the optimiser run of ${when ? new Date(when).toLocaleString() : "the saved run"} (not applied to the plan)`,
      });
      downloadBlob(blob, `${(projectName || "plan").replace(/[^w.-]+/g, "_")}-optimised-2.4-vs-5GHz-report.docx`);
      setMessage("Comparison of the optimised designs downloaded.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setCompareBusy(false);
    }
  };

  const downloadReport = async () => {
    {
      const hasWifiAps = plan.sources.some((s) => s.kind === "wifi");
      const proposes = optimization.opt?.result?.recommendations?.length > 0;
      if (proposes && (!hasWifiAps || preferOptimised("the report"))) return downloadOptimisedReport();
    }
    setReportBusy(true);
    try {
      const { buildReport } = await import("../utils/reportBuilder.js");
      const { loadReportLogos } = await import("../utils/reportLogos.js");
      const blob = await buildReport({
        logos: await loadReportLogos(),
        snrRanges: getMetricRanges(plan, "snr"),
        plan,
        projectName,
        rt,
        opt: optimization.opt,
        ranges: weakRanges, // signal-strength bands (dBm), whatever KPI the legend shows
        thresholdDbm: weakBelowDbm,
        getMap: (jobId, file) => getRtMap(jobId, file),
        onProgress: (text) => setMessage(`Building report: ${text}…`),
      });
      downloadBlob(
        blob,
        `${(projectName || "plan").replace(/[^\w.-]+/g, "_")}-wifi-report.docx`,
      );
      setMessage("Report downloaded.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setReportBusy(false);
    }
  };
  // 2.4 GHz vs 5 GHz report: the same APs predicted on each band (two runs, the
  // service reuses saved ones), then one Word report that compares them.
  const [compareBusy, setCompareBusy] = useState(false);
  const downloadComparison = async () => {
    const hasWifiAps = plan.sources.some((s) => s.kind === "wifi");
    const bothRuns = COMPARED_BANDS.every((b) => optimization.altRuns?.[b]?.result?.recommendations?.length > 0);
    if (!hasWifiAps && !bothRuns) {
      setMessage("Place Wi-Fi access points first, or run the optimiser for 2.4 and 5 GHz: the comparison uses them.");
      return;
    }
    if (bothRuns && (!hasWifiAps || preferOptimised("the comparison"))) return downloadOptimisedComparison();
    setCompareBusy(true);
    try {
      const [{ buildSceneZip }, { buildBandComparisonReport }] =
        await Promise.all([
          import("../utils/sceneExport.js"),
          import("../utils/reportCompare.js"),
        ]);
      const runs = {};
      for (const band of COMPARED_BANDS) {
        setMessage(`Comparison: preparing the ${band} GHz prediction…`);
        const { blob } = await buildSceneZip(planForBand(plan, band), {});
        const { sceneId } = await uploadScene(blob);
        const job = await submitSimulation(sceneId, {
          ...prediction.rtSettings,
          receiverGainDbi: Number(plan.rf?.rxGainDbi) || 0,
        });
        const status = await waitForSimulation(job.id, {
          onStatus: (phase) =>
            setMessage(`Comparison: ${band} GHz prediction · ${phase}…`),
        });
        runs[band] = { jobId: job.id, result: status.result };
      }
      const { loadReportLogos } = await import("../utils/reportLogos.js");
      const blob = await buildBandComparisonReport({
        logos: await loadReportLogos(),
        snrRanges: getMetricRanges(plan, "snr"),
        plan,
        projectName,
        runs,
        ranges: weakRanges, // signal-strength bands (dBm), whatever KPI the legend shows
        designThr: Number.isFinite(optimization.opt?.threshold)
          ? optimization.opt.threshold
          : weakBelowDbm,
        getMap: (jobId, file) => getRtMap(jobId, file),
        onProgress: (text) => setMessage(`Building comparison report: ${text}…`),
      });
      downloadBlob(
        blob,
        `${(projectName || "plan").replace(/[^\w.-]+/g, "_")}-2.4-vs-5GHz-report.docx`,
      );
      setMessage("Comparison report downloaded.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setCompareBusy(false);
    }
  };
  const setSelectedFloor = (id) => {
    mutate((p) => ({ ...p, selectedFloorId: id }));
    setSelected(null);
  };
  const overlay = useMemo(() => {
    const o = optimization;
    const shown = o.opt && o.show !== "off" && optOnMap;
    return {
      recommended: shown
        ? o.opt.result.recommendations.filter((r) => r.floorId === floorId)
        : [],
      weakZones: shown
        ? o.opt.result.weakZones.filter((z) => z.floorId === floorId)
        : [],
      focus: collisionFocus,
      candidates:
        o.previewOn && o.candidates
          ? {
              valid: o.candidates.valid.filter((c) => c.floorId === floorId),
              rejected: o.candidates.rejected.filter(
                (c) => c.floorId === floorId,
              ),
            }
          : null,
    };
  }, [
    optOnMap,
    optimization.opt,
    optimization.show,
    optimization.previewOn,
    optimization.candidates,
    floorId,
    collisionFocus,
  ]);
  const cableDesign = useCableOverlay(plan, showCables);
  useEffect(() => {
    if (tool !== "dascable") {
      setCableFrom(null);
      setCablePoints([]);
      setCablePick(null);
      setCableStartPort(null);
    }
  }, [tool]);
  // DAS cables with an end on this floor (dashed when the other end is on another floor)
  const dasCables = useMemo(() => {
    return (plan.cellular?.cables || []).flatMap((c) => {
      const route = cableRoute(plan, c);
      if (route.length < 2 || !route.some((p) => p.floorId === floorId)) return [];
      const otherFloor = route[0].floorId !== route[route.length - 1].floorId;
      // the runs of the route on this floor (bends included)
      const runs = [];
      let run = [];
      for (const p of route) {
        if (p.floorId === floorId) run.push(p);
        else if (run.length) {
          runs.push(run);
          run = [];
        }
      }
      if (run.length) runs.push(run);
      // a cable that only touches this floor at one end: a short stub toward the shaft
      const drawn = runs.map((r) => (r.length > 1 ? r : [r[0], { x: r[0].x + 1.2, z: r[0].z - 1.2 }]));
      const first = drawn[0];
      const mid = first[Math.floor((first.length - 1) / 2)];
      const next = first[Math.floor((first.length - 1) / 2) + 1] || mid;
      return [{
        id: c.id,
        otherFloor,
        runs: drawn,
        // ends and bends in order (bend j is route[j + 1]), for reshaping the cable
        route,
        label: c.port === "tap" ? { text: "tap", x: (mid.x + next.x) / 2, z: (mid.z + next.z) / 2 } : null,
      }];
    });
  }, [plan, floorId]);
  // the cable being drawn: its start (when on this floor) and its bends on this floor
  const cableDraft = useMemo(() => {
    if (!cableFrom) return null;
    const start = plan.sources.find((s) => s.id === cableFrom);
    return {
      start: start && start.floorId === floorId ? { x: +start.x, z: +start.z } : null,
      points: cablePoints.filter((p) => p.floorId === floorId),
    };
  }, [cableFrom, cablePoints, plan.sources, floorId]);
  // port power of each antenna at the band chosen in Prediction, and the outputs of each DAS part
  const dasCarrier = workspace === "cellular" ? cellularOf(plan).carriers.find((x) => x.id === cellular.carrierId) : null;
  const antennaPowers = useMemo(() => {
    if (!dasCarrier || !(plan.cellular?.cables || []).length) return {};
    return Object.fromEntries(Object.entries(dasPowers(plan, dasCarrier).antennas).map(([id, a]) => [id, a.powerDbm]));
  }, [plan, dasCarrier]);
  // connectors of each DAS part and antenna on this floor: its input (used or free) and its outputs
  const dasPorts = useMemo(() => {
    const cables = plan.cellular?.cables || [];
    return Object.fromEntries(
      plan.sources
        .filter((s) => (s.kind === "das" || s.kind === "cellular") && s.floorId === floorId)
        .map((s) => {
          const outs = s.kind === "das" ? partOutputs(plan, s) : { total: 0, used: 0, ports: [] };
          return [
            s.id,
            {
              ...outs,
              input:
                s.dasType === "source"
                  ? null
                  : { id: s.kind === "cellular" ? "ant" : "in", label: s.kind === "cellular" ? "Ant" : "In", used: cables.some((c) => c.to === s.id) },
            },
          ];
        }),
    );
  }, [plan, floorId]);
  // hover text of each DAS part and antenna: its ports, what they join and the connector
  const portInfo = useMemo(() => {
    if (workspace !== "cellular") return {};
    return Object.fromEntries(
      plan.sources
        .filter((s) => (s.kind === "das" || s.kind === "cellular") && s.floorId === floorId)
        .map((s) => [
          s.id,
          [
            // the name, and the type in words (the plan label is the short name only)
            [
              s.name,
              s.dasType === "splitter"
                ? `${outputPorts(plan, s).length}-way splitter`
                : s.dasType === "coupler"
                  ? `${String(s.partId || "c10").replace(/^c/, "")} dB coupler`
                  : s.dasType === "combiner"
                    ? `combiner ${{ cm21: "2x1", cm22: "2x2", cm44: "4x4" }[s.partId] || ""}`
                    : s.kind === "das"
                      ? DAS_TYPES[s.dasType]?.label
                      : "antenna",
            ]
              .filter(Boolean)
              .join(" · "),
            ...portsOf(plan, s).map((port) =>
              `${port.label}: ${port.other ? `${port.dir === "in" ? "from" : "to"} ${port.other}${port.otherPort ? ` (${port.otherPort})` : ""}` : "free"}`,
            ),
            `Connector: ${connectorOf(s)}`,
            Number.isFinite(antennaPowers[s.id]) ? `Port power: ${antennaPowers[s.id].toFixed(1)} dBm` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ]),
    );
  }, [plan, floorId, workspace, antennaPowers]);
  const measurementUnit = plan.property?.unit || "m";
  const panelProps = {
    dasCables,
    cableFrom,
    cableDraft,
    cablePoints,
    antennaPowers,
    dasPorts,
    bendCable,
    portInfo,
    dasOptions,
    setDasOptions,
    cancelCable: () => {
      setCableFrom(null);
      setCablePoints([]);
      setCablePick(null);
      setCableStartPort(null);
    },
    cablePick,
    cableStartPort,
    chooseCableEnd,
    undoCableBend: () => setCablePoints((pts) => pts.slice(0, -1)),
    tool,
    setTool,
    view,
    setView,
    plan,
    floorId,
    snap,
    setSnap,
    isStatic: plan.property?.static !== false,
    showRoomNames,
    showFurnitureNames,
    showWifiNames,
    showMeasurements,
    cableDesign,
    selected,
    setSelected: selectEntity,
    panelMode,
    setPanelMode,
    carpetArea,
    isCustomCarpetArea: plan.property?.carpetAreaM2 != null,
    carpetFit,
    boundaryAreaM2: boundaryTotal,
    carpetLengthM: plan.property?.carpetLengthM ?? null,
    carpetWidthM: plan.property?.carpetWidthM ?? null,
    // typing the area directly drops the length x width and the boundary fit
    onCarpetAreaChange: (value) =>
      mutate((p) => ({
        ...p,
        property: {
          ...p.property,
          carpetAreaM2: value,
          carpetLengthM: null,
          carpetWidthM: null,
          carpetFit: false,
        },
      })),
    onCarpetSize: (length, width) =>
      mutate((p) => {
        const l = length === "" || length == null ? null : Number(length);
        const w = width === "" || width == null ? null : Number(width);
        return {
          ...p,
          property: {
            ...p.property,
            carpetLengthM: l,
            carpetWidthM: w,
            carpetFit: false,
            carpetAreaM2:
              l > 0 && w > 0
                ? Math.round(l * w * 100) / 100
                : (p.property?.carpetAreaM2 ?? null),
          },
        };
      }),
    onCarpetFitBoundary: () =>
      mutate((p) => ({
        ...p,
        property: {
          ...p.property,
          carpetFit: true,
          carpetAreaM2: null,
          carpetLengthM: null,
          carpetWidthM: null,
        },
      })),
    onCarpetAreaReset: () =>
      mutate((p) => ({
        ...p,
        property: {
          ...p.property,
          carpetAreaM2: null,
          carpetLengthM: null,
          carpetWidthM: null,
          carpetFit: false,
        },
      })),
    moveWithContents,
    setMoveWithContents,
    mapMode,
    setMapMode,
    hiddenLayers,
    setHiddenLayers,
    mergeWall,
    snapWalls,
    setCollisionFocus,
    rotateSelected,
    rotateWholeBuilding,
    onStaticChange: setStatic,
    onShowRoomNamesChange: setShowRoomNames,
    onShowFurnitureNamesChange: setShowFurnitureNames,
    onShowWifiNamesChange: setShowWifiNames,
    place,
    move,
    moveShapePart,
    predictions,
    predictionMetric,
    predictionRanges,
    weakBelowDbm,
    rt,
    setRt,
    prediction,
    nestedNotes,
    convertRoomToBoundary,
    splitRoomInFour,
    makeRoomFromWalls,
    breakWall,
    mergeWalls,
    splitRoomIntoWalls,
    convertBoundaryToRoom,
    moveBoundaryTo,
    optimization,
    heatRanges,
    overlay,
    setSelectedFloor,
    // Each map has its own visibility: the optimiser's (B) follows its After / Before / Hide choice and its band,
    // and shows as soon as a result is there; the prediction's (A) follows its own Hide / Show heatmap switch.
    heatmap:
      workspace === "cellular"
        ? cellular.show && cellular.hasResult
        : optOnMap
          ? Boolean(optimization.opt) && optimization.show !== "off"
          : heatmap,
    // an out-of-date prediction is shown faded until the new one is in
    heatmapOpacity:
      (workspace === "cellular" ? cellular.stale : prediction.stale && mapMode !== "optimise")
        ? heatmapOpacity * 0.45
        : heatmapOpacity,
    workspace,
    cellular,
    logsVisible,
    logGrid,
    metric,
    gridSize,
    aggregation,
    obj,
    patchObj,
    mutate,
    rooms,
    deleteObj,
    floor,
    deleteFloor,
    clearFloor,
    warnings,
    setHeatmap,
    coverage,
    coveredArea,
    totalArea,
    sources,
    setTab,
    importBuilding,
    template,
    imageWidth,
    setImageWidth,
    importImage,
    setMessage,
    busy,
    draftRooms,
    setDraftRooms,
    draftWalls,
    draftFurniture,
    draftFloorId,
    draftMethod,
    applyDraft,
    discardDraft,
    reviewedWorkbook,
    importLogs,
    sessionInput,
    setSessionInput,
    loadSession,
    browseSessions,
    availableSessions,
    setMetric,
    kpiOptions,
    legendSections,
    setLogsVisible,
    setLogGrid,
    setGridSize,
    setAggregation,
    currentLogs,
    sampledCells,
    sampledArea,
    metricRanges,
    applyAlignment,
    zoom,
    setZoom,
  };
  if (!project)
    return <div className="empty">{message || "Loading project..."}</div>;
  if (license.ready && !license.licensed.includes(workspace))
    return (
      <div className="empty">
        <p>
          “{projectName}” is a {WORKSPACES[workspace].label} project. Your license does not include
          the {WORKSPACES[workspace].label} module.
        </p>
        <button className="primary" onClick={() => navigate("/")}>
          Back to projects
        </button>
      </div>
    );
  return (
    <MeasurementUnitProvider unit={measurementUnit}>
    <div className="app">
      <div className="workspace">
        <aside className={`sidebar ${sidebarExpanded ? "sidebar-expanded" : ""}`}>
          <div className="sidebar-project">
            <button
              className="sidebar-collapse-toggle"
              type="button"
              aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={sidebarExpanded}
              title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
              onClick={() => setSidebarExpanded((expanded) => !expanded)}
            >
              <span aria-hidden="true">{sidebarExpanded ? "‹" : "›"}</span>
            </button>
            <button
              className="sidebar-back-button"
              onClick={back}
              aria-label="Back to projects"
              title="Back to projects"
            >
              <span aria-hidden="true">&#x2190;</span> Projects
            </button>
            <input
              className="project-name sidebar-project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              aria-label="Project name"
            />
          </div>
          <div className="sidebar-heading">
            {WORKSPACES[workspace].label.toUpperCase()} WORKSPACE
          </div>
          <nav>
            {[
              ["design", "▦", "Editor"],
              ["network", "⌁", "Network & RF"],
              ["data", "⇪", "Imports & logs"],
              ["alignment", "⌖", "Geo alignment"],
              ["cabling", "⌇", "Cabling"],
              ["capacity", "▤", "Capacity"],
              ["settings", "⚙", "Settings"],
            ].filter(([id]) => tabs.includes(id)).map(([id, icon, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
                aria-label={label}
                title={label}
              >
                <span>{icon}</span>
                {label}
                {id === "data" && floorplanBusy && (
                  <i className="nav-busy" title={`Floor plan: ${floorplanBusy}`} aria-label="Floor plan import running" />
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-heading with-action">
            FLOORS{" "}
            <button onClick={addFloor} title="Add floor">
              ＋
            </button>
          </div>
          <div className="floor-list">
            {plan.floors.map((f) => {
              const floorRooms = plan.rooms.filter(
                (room) => room.floorId === f.id,
              );
              const expanded = expandedFloorId === f.id;
              return (
                <div className="floor-entry" key={f.id}>
                  <div
                    className={`floor-row ${floorId === f.id ? "active" : ""}`}
                  >
                    <button
                      className="floor-select"
                      aria-label={`Select floor ${f.name}`}
                      title={f.name}
                      onClick={() => {
                        mutate((p) => ({ ...p, selectedFloorId: f.id }));
                        setSelected(null);
                        setPanelMode("selection");
                      }}
                    >
                      <span aria-hidden="true">&#x25A4;</span>
                      <span className="floor-name">{f.name}</span>
                    </button>
                    <button
                      className={`floor-expand ${expanded ? "expanded" : ""}`}
                      type="button"
                      aria-label={`${expanded ? "Hide" : "Show"} rooms on ${f.name}`}
                      aria-expanded={expanded}
                      onClick={() => setExpandedFloorId(expanded ? null : f.id)}
                    >
                      <span aria-hidden="true">&#x203A;</span>
                    </button>
                  </div>
                  <div
                    className={`floor-room-disclosure ${expanded ? "open" : ""}`}
                    aria-hidden={!expanded}
                  >
                    <div className="floor-room-list">
                      {floorRooms.length ? (
                        floorRooms.map((room) => (
                          <button
                            className={
                              selected?.type === "room" &&
                              selected.id === room.id
                                ? "selected"
                                : ""
                            }
                            key={room.id}
                            tabIndex={expanded ? 0 : -1}
                            onClick={() => {
                              mutate((p) => ({ ...p, selectedFloorId: f.id }));
                              setSelected({ type: "room", id: room.id });
                              setPanelMode("selection");
                              if (tab !== "design") setTab("design");
                            }}
                          >
                            {room.name || "Untitled room"}
                          </button>
                        ))
                      ) : (
                        <span className="floor-room-empty">
                          No rooms on this floor
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="sidebar-bottom">
            <div>
              <strong>{rooms.length}</strong>
              <small>Rooms</small>
            </div>
            <div>
              <strong>{totalArea.toFixed(1)}</strong>
              <small>m² gross</small>
            </div>
            <div>
              <strong>{sources.length}</strong>
              <small>Sources</small>
            </div>
          </div>
        </aside>
        <div className="workspace-content">
          {tab === "design" && (
            <Ribbon
              workspace={workspace}
              tool={tool}
              setTool={setTool}
              snap={snap}
              setSnap={setSnap}
              onUndo={undo}
              onRedo={redo}
              canUndo={historySize.past > 0}
              canRedo={historySize.future > 0}
              hasSelection={Boolean(selected && obj)}
              onDelete={deleteObj}
              panelMode={panelMode}
              openPanel={openRightPanel}
              isStatic={plan.property?.static !== false}
              onStaticChange={setStatic}
              showMeasurements={showMeasurements}
              onShowMeasurementsChange={setShowMeasurements}
              view={view}
              setView={setView}
              zoom={zoom}
              setZoom={setZoom}
              hiddenLayers={hiddenLayers}
              setHiddenLayers={setHiddenLayers}
              overlays={[
                  {
                    id: "heatmap",
                    // cellular: the prediction map (RSRP / SINR), the same switch as Show / Hide map in Prediction
                    label: workspace === "cellular" ? "Prediction map (RSRP / SINR)" : "Signal heatmap",
                    checked: workspace === "cellular" ? cellular.show : heatmap,
                    onChange: workspace === "cellular" ? cellular.setShow : setHeatmap,
                    defaultOn: workspace === "cellular",
                  },
                  {
                    id: "logs",
                    label: "Measured log points",
                    checked: logsVisible,
                    onChange: setLogsVisible,
                    defaultOn: true,
                  },
                  {
                    id: "loggrid",
                    label: "Logs aggregated to grid",
                    checked: logGrid,
                    onChange: setLogGrid,
                    defaultOn: false,
                  },
                  {
                    id: "rn",
                    label: "Room names",
                    checked: showRoomNames,
                    onChange: setShowRoomNames,
                    defaultOn: true,
                  },
                  {
                    id: "fn",
                    label: "Furniture names",
                    checked: showFurnitureNames,
                    onChange: setShowFurnitureNames,
                    defaultOn: true,
                  },
                  {
                    id: "wn",
                    label: workspace === "cellular" ? "Antenna names" : "Wi-Fi AP names",
                    checked: showWifiNames,
                    onChange: setShowWifiNames,
                    defaultOn: true,
                  },
                  workspace === "wifi" && {
                    id: "cables",
                    label: "Cables (Wi-Fi cabling)",
                    checked: showCables,
                    onChange: setShowCables,
                    defaultOn: false,
                  },
                ].filter(Boolean)}
              heatmapOpacity={heatmapOpacity}
              setHeatmapOpacity={setHeatmapOpacity}
              legendSections={legendSections}
              setLegendSections={setLegendSections}
              onDownloadImage={downloadPlot}
              imageBusy={imageBusy}
              onReport={downloadReport}
              reportBusy={reportBusy}
              onCompare={downloadComparison}
              compareBusy={compareBusy}
            />
          )}
          <main className={`main ${tab === "design" ? "main-editor" : ""}`}>
            {message && (
              <div className="notice" role="status">
                <span>{message}</span>
                <button onClick={() => setMessage("")}>×</button>
              </div>
            )}
            {busy && (
              <div className="notice" role="status">
                Processing floor plan or session…
              </div>
            )}
            {tab === "design" && <DesignPanel {...panelProps} />}
            {tab === "network" && <NetworkPanel {...panelProps} />}
            {/* kept mounted while hidden: a floor-plan reading carries on when another tab is opened */}
            <div hidden={tab !== "data"}>
              <DataPanel
                {...panelProps}
                onFloorplanBusy={setFloorplanBusy}
                onFloorplanFinished={(ok, error) => {
                  if (tabRef.current === "data") return;
                  setMessage(
                    ok
                      ? "The floor plan has been read. Open Imports & logs to check it and add it to the plan."
                      : `Reading the floor plan failed: ${error}`,
                  );
                }}
              />
            </div>
            {tab === "alignment" && <AlignmentPanel {...panelProps} />}
            {tab === "cabling" && <CablingPanel {...panelProps} projectName={projectName} />}
            {tab === "settings" && <SettingsPanel {...panelProps} />}
            {tab === "capacity" && <CapacityPanel {...panelProps} rtMaps={rt.active ? rt.maps : null} />}
          </main>
        </div>
      </div>
      {tab === "design" && (
      <WorkspaceFooter
        view={view}
        onViewChange={setView}
        outputBand={optOnMap && optimization.show !== "off" ? optimization.opt?.settingsUsed.band : null}
        outputBands={Object.keys(optimization.altRuns).sort((a, b) => Number(a) - Number(b))}
        onBandChange={optimization.chooseBand}
        bandBusy={optimization.busy}
        zoom={zoom}
        onZoom={setZoom}
        floorName={plan.floors.find((f) => f.id === floorId)?.name}
        rooms={rooms.length}
        area={totalArea}
        unit={measurementUnit}
        sources={sources.length}
        saveState={saveState}
        showMeasurements={showMeasurements}
        onShowMeasurementsChange={setShowMeasurements}
        isStatic={plan.property?.static !== false}
        onStaticChange={setStatic}
      />
      )}
    </div>
    </MeasurementUnitProvider>
  );
}
