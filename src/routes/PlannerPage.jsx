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
import NetworkPanel from "../components/panels/NetworkPanel.jsx";
import DataPanel from "../components/panels/DataPanel.jsx";
import AlignmentPanel from "../components/panels/AlignmentPanel.jsx";
import EditorMenu, {
  EditorQuickTools,
  PredictionMenu,
  DownloadImageButton,
  LegendMenu,
  ShowMenu,
} from "../components/planner/EditorMenu.jsx";
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
  defaultKpiFor,
  kpisForKind,
  networkKindOf,
} from "../utils/indoorLogKpis.js";
import { DEFAULT_LEGEND_SECTIONS } from "../components/planner/MapLegend.jsx";
import PropertyMenu from "../components/planner/PropertyMenu.jsx";
import WorkspaceFooter from "../components/planner/WorkspaceFooter.jsx";

const defaultSource = (kind, p, floorId) => ({
  id: uid(),
  floorId,
  kind,
  name: kind === "wifi" ? "Wi-Fi AP" : "Cellular site",
  technology: kind === "wifi" ? "Wi-Fi" : "5G",
  antennaPattern: "omni",
  x: p.x,
  z: p.z,
  heightM: kind === "wifi" ? 2.7 : 3,
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
  const tab = ["design", "network", "data", "alignment"].includes(section)
    ? section
    : "design";
  const setTab = (value) => navigate(`/projects/${projectId}/${value}`);
  const [project, setProject] = useState(null),
    [plan, setPlan] = useState(initialPlan),
    [projectName, setProjectName] = useState(""),
    [view, setView] = useState("2d"),
    [tool, setTool] = useState("select"),
    [selected, setSelected] = useState(null),
    [panelMode, setPanelMode] = useState("selection"),
    [expandedFloorId, setExpandedFloorId] = useState(null),
    [snap, setSnap] = useState(true),
    [showRoomNames, setShowRoomNames] = useState(true),
    [showFurnitureNames, setShowFurnitureNames] = useState(true),
    [showWifiNames, setShowWifiNames] = useState(true),
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
  const mutate = useCallback((fn) => {
    setPlan((old) => {
      const next = typeof fn === "function" ? fn(old) : fn;
      return next;
    });
    setSaveState("Unsaved");
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
  const selectedSource =
    selected?.type === "source"
      ? plan.sources.find((s) => s.id === selected.id)
      : null;
  const networkKind = networkKindOf(sources, selectedSource);
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
    metric === "snr" ? "snr" : metric === "rssi" ? "rssi" : "rsrp";
  const predictionRanges = useMemo(
    () => getMetricRanges(plan, predictionMetric),
    [plan, predictionMetric],
  );
  // "weak" always means weak signal strength in dBm, whichever KPI is shown
  const weakRanges = useMemo(
    () => getMetricRanges(plan, predictionMetric === "rsrp" ? "rsrp" : "rssi"),
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
      const cells =
        rt.active && rt.maps[floorId]
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
    const list = listKey[selected.type];
    mutate((p) => ({
      ...p,
      [list]: p[list].filter((x) => x.id !== selected.id),
    }));
    setSelected(null);
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
      return next;
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
      return next;
    });
    setSelected(null);
    setPanelMode("selection");
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
        width: 5,
        depth: 4,
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
    if (kind === "cellular" || kind === "wifi") {
      const s = defaultSource(kind, p, floorId);
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
  const movePolygonPart = (roomId, vertexIndex, dx, dz, mode) => {
    mutate((p) => ({
      ...p,
      rooms: p.rooms.map((room) => {
        if (room.id !== roomId || room.shape !== "polygon") return room;
        const polygonPoints = pointsOf(room).map((point) => ({ ...point }));
        const indices =
          mode === "edge"
            ? [vertexIndex, (vertexIndex + 1) % polygonPoints.length]
            : [vertexIndex];
        for (const index of indices) {
          polygonPoints[index] = {
            x: polygonPoints[index].x + dx,
            z: polygonPoints[index].z + dz,
          };
        }
        const updated = { ...room, polygonPoints };
        const bounds = bbox(updated);
        return {
          ...updated,
          x: bounds.minX,
          z: bounds.minZ,
          width: bounds.maxX - bounds.minX,
          depth: bounds.maxZ - bounds.minZ,
        };
      }),
    }));
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
  const downloadReport = async () => {
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
    if (!plan.sources.some((s) => s.kind === "wifi")) {
      setMessage("Place Wi-Fi access points first: the comparison uses them.");
      return;
    }
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
  const panelProps = {
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
    onStaticChange: (value) =>
      mutate((p) => ({
        ...p,
        property: { ...p.property, static: value },
      })),
    onShowRoomNamesChange: setShowRoomNames,
    onShowFurnitureNamesChange: setShowFurnitureNames,
    onShowWifiNamesChange: setShowWifiNames,
    place,
    move,
    movePolygonPart,
    predictions,
    predictionMetric,
    predictionRanges,
    weakBelowDbm,
    rt,
    setRt,
    prediction,
    nestedNotes,
    convertRoomToBoundary,
    convertBoundaryToRoom,
    moveBoundaryTo,
    optimization,
    heatRanges,
    overlay,
    setSelectedFloor,
    heatmap,
    heatmapOpacity,
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
  return (
    <div className="app">
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-project">
            <button
              className="sidebar-back-button"
              onClick={back}
              aria-label="Back to projects"
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
          <div className="sidebar-heading">WORKSPACE</div>
          <nav>
            {[
              ["design", "▦", "Editor"],
              ["network", "⌁", "Network & RF"],
              ["data", "⇪", "Imports & logs"],
              ["alignment", "⌖", "Geo alignment"],
            ].map(([id, icon, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                <span>{icon}</span>
                {label}
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
            <header className="topbar editor-header">
              <strong className="editor-header-title">Editor</strong>
              <EditorQuickTools tool={tool} setTool={setTool} />
              <EditorMenu
                active={panelMode === "tools"}
                onOpen={() => openRightPanel("tools")}
              />
              <PropertyMenu
                active={panelMode === "property"}
                onOpen={() => openRightPanel("property")}
              />
              <PredictionMenu
                active={panelMode === "prediction" || panelMode === "optimize"}
                onOpen={() =>
                  openRightPanel(
                    panelMode === "optimize" ? "optimize" : "prediction",
                  )
                }
              />
              <label
                className="prediction-opacity"
                title="Opacity of the prediction image"
              >
                <span>Opacity {Math.round(heatmapOpacity * 100)}%</span>
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  value={Math.round(heatmapOpacity * 100)}
                  onChange={(e) =>
                    setHeatmapOpacity(Number(e.target.value) / 100)
                  }
                />
              </label>
              <ShowMenu
                hiddenLayers={hiddenLayers}
                onHiddenLayers={setHiddenLayers}
                logCount={plan.logs.length}
                onManageLogs={() => {
                  setSelected(null);
                  setPanelMode("selection");
                }}
                overlays={[
                  {
                    id: "heatmap",
                    label: "Signal heatmap",
                    checked: heatmap,
                    onChange: setHeatmap,
                    defaultOn: false,
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
                    label: "Wi-Fi / cellular names",
                    checked: showWifiNames,
                    onChange: setShowWifiNames,
                    defaultOn: true,
                  },
                ]}
              />
              <LegendMenu
                sections={legendSections}
                onChange={setLegendSections}
              />
              <DownloadImageButton onDownload={downloadPlot} busy={imageBusy} />
              <button
                className="download-image-trigger icon-button"
                type="button"
                disabled={reportBusy}
                aria-label="Download Word report"
                title={
                  reportBusy
                    ? "Building report…"
                    : "Download Word report (.docx): each AP's prediction, the combined prediction, optimised APs and the APs needed for full coverage"
                }
                onClick={downloadReport}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                  <path d="M9 13h6M9 17h6" />
                </svg>
              </button>
              <button
                className="download-image-trigger icon-button"
                type="button"
                disabled={compareBusy || reportBusy}
                aria-label="Download 2.4 GHz vs 5 GHz comparison report"
                title={
                  compareBusy
                    ? "Building the comparison report (predicting both bands)…"
                    : "Download the 2.4 GHz vs 5 GHz comparison report (.docx): the same APs predicted on each band"
                }
                onClick={downloadComparison}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                  <path d="M9 18v-4M12 18v-7M15 18v-5" />
                </svg>
              </button>
              <div className="top-actions">
                <span
                  className={`save-state ${saveState === "Save failed" ? "error" : ""}`}
                >
                  {saveState}
                </span>
              </div>
            </header>
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
            {tab === "data" && <DataPanel {...panelProps} />}
            {tab === "alignment" && <AlignmentPanel {...panelProps} />}
          </main>
        </div>
      </div>
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
        sources={sources.length}
        saveState={saveState}
      />
    </div>
  );
}
