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
  pointsOf,
  resizePolygonPoints,
} from "../utils/geometry.js";
import { predict } from "../utils/prediction.js";
import {
  readBuilding,
  readLogs,
  readFloorImage,
  downloadReviewedRooms,
  downloadBuildingTemplate,
} from "../services/imports.js";
import { listSessions, loadSessions } from "../services/sessions.js";
import { traceFloorImage } from "../services/floorTrace.js";
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
import EditorMenu, { EditorQuickTools } from "../components/planner/EditorMenu.jsx";
import PropertyMenu from "../components/planner/PropertyMenu.jsx";

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
    [logsVisible, setLogsVisible] = useState(true),
    [logGrid, setLogGrid] = useState(false),
    [metric, setMetric] = useState("rsrp"),
    [gridSize, setGridSize] = useState(1),
    [aggregation, setAggregation] = useState("mean");
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
      setMetric(pref.metric || "rsrp");
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
  const predictions = useMemo(() => predict(plan, floorId), [plan, floorId]),
    warnings = useMemo(() => overlapWarnings(rooms), [rooms]),
    totalArea = rooms.reduce((s, r) => s + areaOf(r), 0),
    coveredArea = Math.min(
      totalArea,
      predictions.filter((p) => p.covered).length *
        num(plan.rf.gridStepM, 1) ** 2,
    ),
    coverage = predictions.length
      ? Math.round(
          (100 * predictions.filter((p) => p.covered).length) /
            predictions.length,
        )
      : 0;
  const carpetArea =
    plan.property?.carpetAreaM2 == null
      ? plan.rooms.reduce((sum, room) => sum + areaOf(room), 0)
      : num(
          plan.property.carpetAreaM2,
          plan.rooms.reduce((sum, room) => sum + areaOf(room), 0),
        );
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
                : null;
  const listKey = {
    room: "rooms",
    door: "doors",
    window: "windows",
    wall: "interiorWalls",
    furniture: "furniture",
    source: "sources",
  };
  const patchObj = (key, value, growthDirection = 1) => {
    if (!selected) return;
    const list = listKey[selected.type];
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
        side = wallPlacement?.side ||
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
  const move = (type, id, dx, dz) => {
    const key = listKey[type];
    mutate((p) => ({
      ...p,
      [key]: p[key].map((x) =>
        x.id === id
          ? type === "wall"
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
                    const room = p.rooms.find((item) => item.id === x.roomId);
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
    }));
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
        logs: [...p.logs, ...parsed.logs],
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
          ? `Quick scan found ${found.length} possible enclosed rooms. For the full layout, click Trace full plan with AI.`
          : "Quick scan found no reliable enclosed rooms. Click Trace full plan with AI to find spaces, walls, and desk groups.",
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const traceImage = async () => {
    const image = plan.images[floorId];
    if (!image) return;
    setBusy(true);
    try {
      const trace = await traceFloorImage(image, floorId);
      setDraftRooms(trace.rooms);
      setDraftWalls(trace.walls);
      setDraftFurniture(trace.furniture);
      setDraftFloorId(floorId);
      setDraftMethod("AI trace");
      setView("2d");
      setTab("design");
      setMessage(
        `AI proposed ${trace.rooms.length} spaces, ${trace.walls.length} walls, and ${trace.furniture.length} desk groups. Review the overlay, then apply.`,
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
    onCarpetAreaChange: (value) =>
      mutate((p) => ({
        ...p,
        property: { ...p.property, carpetAreaM2: value },
      })),
    onCarpetAreaReset: () =>
      mutate((p) => ({
        ...p,
        property: { ...p.property, carpetAreaM2: null },
      })),
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
    heatmap,
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
    traceImage,
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
    setLogsVisible,
    setLogGrid,
    setGridSize,
    setAggregation,
    currentLogs,
    sampledCells,
    sampledArea,
    metricRanges,
    applyAlignment,
  };
  if (!project)
    return <div className="empty">{message || "Loading project..."}</div>;
  return (
    <div className="app">
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-project">
            <button className="sidebar-back-button" onClick={back} aria-label="Back to projects">
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
    </div>
  );
}
