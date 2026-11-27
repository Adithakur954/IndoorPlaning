import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  bbox,
  boundaryAreas,
  edgeMeasures,
  pointsOf,
} from "../../utils/geometry.js";
import { formatArea, formatLength, useMeasurementUnit } from "../../utils/measurementUnits.jsx";
import { buildWalls } from "../../utils/wallGraph.js";
import { materialColors } from "../../config/materialColors.js";
import PlanCompass from "./PlanCompass.jsx";
import { Heatmap2D } from "./SmoothHeatmap.jsx";
import { layoutLabels } from "../../utils/labelLayout.js";
import {
  getFloorLogs,
  getLogGridCells,
  getMetricColor,
  getMetricRanges,
} from "../../utils/logOverlay.js";

// older projects named detected APs "AP-detected-3": show them as "AP3"
const AP_FONT = 0.4;
const shortApName = (name) =>
  String(name ?? "").replace(/^AP-detected-(\d+)$/, "AP$1");


// Plan symbols. Wi-Fi AP: a filled dot. Cellular antenna: a circle with an X
// (a wall panel also shows where it points). DAS parts: a source box, a
// splitter (one in, several out), a coupler (through and tap) and a riser.
function SourceSymbol({ s, r, stroke, selected }) {
  const ring = selected ? "#e8790a" : null;
  if (s.kind === "wifi" || (s.kind !== "cellular" && s.kind !== "das"))
    return <circle cx={s.x} cy={s.z} r={r} fill="#7c3aed" stroke={ring || "white"} strokeWidth={stroke} />;
  const x = +s.x;
  const z = +s.z;
  const k = r * 0.62;
  const ink = "#111827";
  if (s.kind === "cellular") {
    const az = ((Number(s.azimuthDeg) || 0) * Math.PI) / 180;
    return (
      <g>
        <circle cx={x} cy={z} r={r} fill="white" stroke={ring || ink} strokeWidth={stroke} />
        <path d={`M${x - k} ${z - k}L${x + k} ${z + k}M${x + k} ${z - k}L${x - k} ${z + k}`} stroke={ink} strokeWidth={stroke * 0.9} />
        {s.mount === "wall" && (
          <line x1={x} y1={z} x2={x + Math.cos(az) * r * 1.9} y2={z + Math.sin(az) * r * 1.9} stroke={ink} strokeWidth={stroke} />
        )}
      </g>
    );
  }
  const box = (fill) => (
    <rect x={x - r} y={z - r} width={r * 2} height={r * 2} rx={r * 0.25} fill={fill} stroke={ring || "white"} strokeWidth={stroke} />
  );
  if (s.dasType === "source")
    return (
      <g>
        {box("#1e3a8a")}
        <text x={x} y={z} fontSize={r * 1.05} fontWeight={700} fill="white" textAnchor="middle" dominantBaseline="central" pointerEvents="none">
          BTS
        </text>
      </g>
    );
  if (s.dasType === "riser")
    return (
      <g>
        {box(ink)}
        <path d={`M${x} ${z + k}L${x} ${z - k}M${x - k * 0.6} ${z - k * 0.3}L${x} ${z - k}L${x + k * 0.6} ${z - k * 0.3}`} stroke="white" strokeWidth={stroke} fill="none" />
      </g>
    );
  if (s.dasType === "combiner")
    return (
      <g>
        {box("#374151")}
        <text x={x} y={z} fontSize={r * 0.9} fontWeight={700} fill="white" textAnchor="middle" dominantBaseline="central" pointerEvents="none">
          CB
        </text>
      </g>
    );
  if (s.dasType === "coupler")
    return (
      <g>
        <rect x={x - r} y={z - r * 0.7} width={r * 2} height={r * 1.4} rx={r * 0.2} fill={ink} stroke={ring || "white"} strokeWidth={stroke} />
        <text x={x} y={z} fontSize={r * 0.95} fontWeight={700} fill="white" textAnchor="middle" dominantBaseline="central" pointerEvents="none">
          {String(s.partId || "c").replace(/^c/, "")}
        </text>
      </g>
    );
  // splitter: one input on the left, outputs fanning to the right
  return (
    <g>
      <circle cx={x} cy={z} r={r} fill={ink} stroke={ring || "white"} strokeWidth={stroke} />
      <path
        d={`M${x - k} ${z}L${x - k * 0.1} ${z}M${x - k * 0.1} ${z}L${x + k} ${z - k * 0.7}M${x - k * 0.1} ${z}L${x + k} ${z + k * 0.7}M${x - k * 0.1} ${z}L${x + k} ${z}`}
        stroke="white"
        strokeWidth={stroke * 0.9}
        fill="none"
      />
    </g>
  );
}

export default function Plan2D({
  plan,
  floorId,
  tool,
  snap,
  isStatic = true,
  showRoomNames = true,
  showFurnitureNames = true,
  showWifiNames = true,
  showMeasurements = false,
  cables = null,
  racks = null,
  selected,
  onSelect,
  onPlace,
  onMove,
  onMoveShapePart,
  predictions,
  overlay,
  heatmap,
  heatmapOpacity = 0.8,
  logsVisible,
  logGrid,
  metric,
  gridSize,
  aggregation,
  draft,
  hiddenLayers = [],
  zoom = 1,
  onZoom,
  // DAS network (cellular): cables drawn on this floor, the part a new cable starts from
  dasCables = [],
  cableFrom = null,
}) {
  const unit = useMeasurementUnit();
  const shown = (id) => !hiddenLayers.includes(id);
  const svg = useRef(),
    drag = useRef(null),
    panDrag = useRef(null),
    [wallStart, setWallStart] = useState(null),
    [poly, setPoly] = useState([]),
    // rectangle being drawn: press at one corner, drag to the opposite corner
    [rectDraft, setRectDraft] = useState(null),
    [pan, setPan] = useState({ x: 0, z: 0 });
  const rooms = plan.rooms.filter((r) => r.floorId === floorId),
    doors = plan.doors.filter((d) => d.floorId === floorId),
    windows = plan.windows.filter((w) => w.floorId === floorId),
    walls = plan.interiorWalls.filter((w) => w.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId),
    furniture = plan.furniture.filter((f) => f.floorId === floorId);
  useEffect(() => {
    // a different floor starts framed on its own content
    setPan({ x: 0, z: 0 });
    onZoom?.(1);
  }, [floorId]);
  useEffect(() => {
    if (tool !== "polygon" && tool !== "boundary") setPoly([]);
    if (tool !== "wall") setWallStart(null);
    if (tool !== "rectangle") setRectDraft(null);
  }, [tool]);
  const rawLogs = getFloorLogs(plan, floorId);
  const floorImage = plan.images[floorId];
  // The view frames what is drawn on this floor (with a margin), so the building
  // is centred; an empty floor shows a default 30 x 22 m area.
  const contentPoints = [
    ...rooms.flatMap((r) => pointsOf(r)),
    ...boundaryAreas(plan, floorId).flatMap((r) => pointsOf(r)),
    ...sources.map((s) => ({ x: +s.x, z: +s.z })),
    ...furniture.flatMap((f) => [
      { x: +f.x, z: +f.z },
      { x: +f.x + +f.width, z: +f.z + +f.depth },
    ]),
    ...(draft?.rooms || []).flatMap((r) => [
      { x: +r.x, z: +r.z },
      { x: +r.x + +r.width, z: +r.z + +r.depth },
    ]),
  ];
  if (floorImage) {
    const ox = floorImage.offsetX || 0,
      oz = floorImage.offsetZ || 0;
    const w = floorImage.widthM,
      h = floorImage.heightM;
    const turn = ((floorImage.rotationDeg || 0) * Math.PI) / 180;
    for (const [cx, cz] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]) {
      const dx = cx - w / 2,
        dz = cz - h / 2;
      contentPoints.push({
        x: ox + w / 2 + dx * Math.cos(turn) - dz * Math.sin(turn),
        z: oz + h / 2 + dx * Math.sin(turn) + dz * Math.cos(turn),
      });
    }
  }
  const finite = contentPoints.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.z),
  );
  const box = finite.length
    ? {
        minX: Math.min(...finite.map((p) => p.x)),
        maxX: Math.max(...finite.map((p) => p.x)),
        minZ: Math.min(...finite.map((p) => p.z)),
        maxZ: Math.max(...finite.map((p) => p.z)),
      }
    : { minX: 0, maxX: 30, minZ: 0, maxZ: 22 };
  const spanX = Math.max(box.maxX - box.minX, 8),
    spanZ = Math.max(box.maxZ - box.minZ, 6);
  const margin = Math.max(2, Math.max(spanX, spanZ) * 0.12);
  const minX = (box.minX + box.maxX) / 2 - spanX / 2 - margin,
    minZ = (box.minZ + box.maxZ) / 2 - spanZ / 2 - margin,
    width = spanX + 2 * margin,
    height = spanZ + 2 * margin,
    viewWidth = width / zoom,
    viewHeight = height / zoom;
  // AP markers and their names keep a readable size on screen (at least 14 px dot, 12 px text) on any size of
  // building: a fixed size in metres becomes a speck on a 190 m factory
  const [svgPx, setSvgPx] = useState({ w: 900, h: 600 });
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setSvgPx({ w: el.clientWidth || 900, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mPerPx = Math.max(viewWidth / Math.max(svgPx.w, 1), viewHeight / Math.max(svgPx.h, 1));
  const apR = Math.max(0.38, 7 * mPerPx);
  const apFont = Math.max(AP_FONT, 12 * mPerPx);
  const apStroke = Math.max(0.12, 2 * mPerPx);
  const point = (e, shouldSnap = snap) => {
    const p = svg.current.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(svg.current.getScreenCTM().inverse());
    return {
      x: shouldSnap ? Math.round(q.x * 2) / 2 : q.x,
      z: shouldSnap ? Math.round(q.y * 2) / 2 : q.y,
    };
  };
  const entity = (type, id) => ({ type, id });
  const down = (e, type, id) => {
    e.stopPropagation();
    // the Cable tool joins the part or antenna clicked first to the one clicked next
    if (tool === "dascable" && type === "source") {
      onPlace("dascable", { id });
      return;
    }
    if (tool !== "select") {
      background(e);
      return;
    }
    onSelect(entity(type, id));
    if (isStatic && (type === "room" || type === "boundary")) return;
    const at = point(e, false);
    drag.current = {
      type,
      id,
      origin: at,
      applied: { x: 0, z: 0 },
      pointer: { x: e.clientX, y: e.clientY },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  // grab a vertex, or an edge (vertex index -> index + 1), of a room, a
  // boundary or a wall; Shift on an edge drags the whole shape instead
  const startPartDrag = (e, type, id, index, mode, anchor) => {
    if (tool !== "select") return;
    if (mode === "edge" && e.shiftKey) {
      down(e, type, id);
      return;
    }
    e.stopPropagation();
    onSelect(entity(type, id));
    drag.current = {
      type: "shape-part",
      partType: type,
      id,
      index,
      mode,
      anchor,
      origin: point(e, false),
      applied: { x: 0, z: 0 },
      pointer: { x: e.clientX, y: e.clientY },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (panDrag.current) {
      const { startX, startY, origin, unitXPerPixel, unitYPerPixel } =
        panDrag.current;
      setPan({
        x: origin.x - (e.clientX - startX) * unitXPerPixel,
        z: origin.z - (e.clientY - startY) * unitYPerPixel,
      });
      return;
    }
    if (rectDraft) {
      const p = point(e);
      setRectDraft((d) => (d ? { ...d, end: p } : d));
      return;
    }
    if (!drag.current) {
      svg.current.style.cursor = e.ctrlKey ? "grab" : "auto";
      return;
    }
    const d = drag.current;
    if (Math.hypot(e.clientX - d.pointer.x, e.clientY - d.pointer.y) < 4)
      return;
    const p = point(e, false),
      rawX = p.x - d.origin.x,
      rawZ = p.z - d.origin.z,
      // a dragged vertex / edge lands on the grid itself, not by grid steps
      ax = d.anchor?.x ?? 0,
      az = d.anchor?.z ?? 0,
      targetX = snap ? Math.round((ax + rawX) * 2) / 2 - ax : rawX,
      targetZ = snap ? Math.round((az + rawZ) * 2) / 2 - az : rawZ,
      dx = targetX - d.applied.x,
      dz = targetZ - d.applied.z;
    if (dx || dz) {
      if (d.type === "shape-part")
        onMoveShapePart(d.partType, d.id, d.index, dx, dz, d.mode);
      else onMove(d.type, d.id, dx, dz);
      d.applied = { x: targetX, z: targetZ };
    }
  };
  const startPan = (e) => {
    if (!e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const inverse = svg.current.getScreenCTM().inverse();
    panDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      origin: pan,
      unitXPerPixel: inverse.a,
      unitYPerPixel: inverse.d,
    };
    svg.current.style.cursor = "grabbing";
    svg.current.setPointerCapture(e.pointerId);
  };
  const up = (e) => {
    drag.current = null;
    if (rectDraft) {
      const end = e && e.type !== "pointercancel" ? point(e) : rectDraft.end;
      const x = Math.min(rectDraft.start.x, end.x),
        z = Math.min(rectDraft.start.z, end.z),
        w = Math.abs(end.x - rectDraft.start.x),
        d = Math.abs(end.z - rectDraft.start.z);
      setRectDraft(null);
      if (e && svg.current.hasPointerCapture(e.pointerId))
        svg.current.releasePointerCapture(e.pointerId);
      // a click without a real drag draws nothing
      if (w >= 0.3 && d >= 0.3)
        onPlace("rectangle", { x, z, width: w, depth: d });
      return;
    }
    if (panDrag.current) {
      panDrag.current = null;
      svg.current.style.cursor = e?.ctrlKey ? "grab" : "auto";
      if (e && svg.current.hasPointerCapture(e.pointerId))
        svg.current.releasePointerCapture(e.pointerId);
    }
  };
  const background = (e) => {
    const p = point(e);
    if (tool === "wall") {
      if (wallStart) {
        onPlace("wall", { x1: wallStart.x, z1: wallStart.z, x2: p.x, z2: p.z });
        setWallStart(null);
      } else setWallStart(p);
      return;
    }
    if (tool === "polygon" || tool === "boundary") {
      setPoly([...poly, p]);
      return;
    }
    if (tool === "rectangle") {
      setRectDraft({ start: p, end: p });
      svg.current.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "select") onSelect(null);
    else onPlace(tool, p);
  };
  const finishPolygon = () => {
    if (poly.length >= 3)
      onPlace(tool === "boundary" ? "boundary" : "polygon", { points: poly });
    setPoly([]);
  };
  // memoised: a new array here would rebuild the whole heatmap image on every
  // pan/zoom frame
  const heatAreas = useMemo(
    () => [
      ...plan.rooms.filter((r) => r.floorId === floorId),
      ...boundaryAreas(plan, floorId),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.rooms, plan.boundaries, floorId],
  );
  // drawing width follows the wall thickness (0.2 m looks like before)
  const wallT = Number(plan.wallThickness) || 0.2;
  const wallCore = Math.min(0.4, Math.max(0.05, wallT * 0.6));
  // walls are drawn at their real width, but never thinner than a few pixels on screen: on a 190 m site a
  // 0.2 m wall would otherwise be a hairline (display only; the plan keeps the real thickness)
  const onScreen = (metres, minPx) => Math.max(metres, minPx * mPerPx);
  // the same merged walls as the 3D view and the ray-tracing export, coloured
  // by material like the legend
  const wallModel = useMemo(
    () => buildWalls(plan, floorId),
    [plan.rooms, plan.boundaries, plan.doors, plan.windows, plan.wallTypes, floorId],
  );
  // ---- vertex / edge editing ----------------------------------------------
  // handle sizes follow the zoom so they stay grabbable
  const handleR = Math.min(0.35, Math.max(0.08, viewWidth * 0.007));
  const edgeHitW = handleR * 2.6;
  const editable = tool === "select";
  const editShapes = [
    ...(shown("boundary") ? plan.boundaries || [] : [])
      .filter((b) => b.floorId === floorId && b.points?.length >= 3)
      .map((b) => ({ type: "boundary", id: b.id, points: b.points, closed: true })),
    ...(shown("rooms") ? rooms : [])
      .filter((r) => r.shape === "polygon" || r.shape === "rectangle" || !r.shape)
      .map((r) => ({ type: "room", id: r.id, points: pointsOf(r), closed: true })),
    ...(shown("walls") ? walls : []).map((w) => ({
      type: "wall",
      id: w.id,
      points: [
        { x: +w.x1, z: +w.z1 },
        { x: +w.x2, z: +w.z2 },
      ],
      closed: false,
    })),
  ];
  const isSel = (s) => selected?.type === s.type && selected.id === s.id;
  const edgesOf = (s) =>
    s.points
      .slice(0, s.closed ? s.points.length : s.points.length - 1)
      .map((a, i) => ({ a, b: s.points[(i + 1) % s.points.length], i }));
  const edgeHits = (s) =>
    edgesOf(s).map(({ a, b, i }) => (
      <line
        key={`${s.type}-${s.id}-e${i}`}
        className={isSel(s) ? "shape-edge-hit selected" : "shape-edge-hit"}
        x1={a.x}
        y1={a.z}
        x2={b.x}
        y2={b.z}
        stroke="transparent"
        strokeWidth={edgeHitW}
        strokeLinecap="round"
        pointerEvents="stroke"
        onPointerDown={(e) => startPartDrag(e, s.type, s.id, i, "edge", a)}
      >
        <title>Drag to move this edge · Shift+drag moves the whole shape</title>
      </line>
    ));
  const selectedShape = editShapes.find(isSel);
  // ---- edge lengths ---------------------------------------------------------
  const measureFont = Math.min(0.5, Math.max(0.16, viewWidth * 0.011));
  const measureLabels = !showMeasurements
    ? []
    : [
        ...(shown("rooms") ? rooms : []).flatMap((r) =>
          r.shape === "circle"
            ? [
                {
                  key: `m-${r.id}-d`,
                  x: +r.x + +r.width / 2,
                  z: +r.z + +r.depth / 2 + measureFont * 1.4,
                  angle: 0,
                  text: `Ø ${formatLength(2 * Number(r.radius || r.width / 2), unit)}`,
                },
              ]
            : edgeMeasures(pointsOf(r)).map((m) => ({
                key: `m-${r.id}-${m.index}`,
                x: m.mid.x + m.inward.x * (wallCore / 2 + measureFont * 0.8),
                z: m.mid.z + m.inward.z * (wallCore / 2 + measureFont * 0.8),
                angle: m.angleDeg,
                text: formatLength(m.length, unit),
              })),
        ),
        ...(shown("boundary") ? plan.boundaries || [] : [])
          .filter((b) => b.floorId === floorId && b.points?.length >= 3)
          .flatMap((b) =>
            // outside the building, so they never sit on the room labels
            edgeMeasures(b.points).map((m) => ({
              key: `m-${b.id}-${m.index}`,
              x: m.mid.x - m.inward.x * (wallCore + measureFont * 0.9),
              z: m.mid.z - m.inward.z * (wallCore + measureFont * 0.9),
              angle: m.angleDeg,
              text: formatLength(m.length, unit),
              boundary: true,
            })),
          ),
        ...(shown("walls") ? walls : []).flatMap((w) =>
          edgeMeasures(
            [
              { x: w.x1, z: w.z1 },
              { x: w.x2, z: w.z2 },
            ],
            false,
          ).map((m) => ({
            key: `m-${w.id}`,
            x: m.mid.x + m.inward.x * (0.12 + measureFont * 0.7),
            z: m.mid.z + m.inward.z * (0.12 + measureFont * 0.7),
            angle: m.angleDeg,
            text: formatLength(m.length, unit),
          })),
        ),
      ];
  // names never sit on each other or on a column / AP marker
  const labelSpots = useMemo(() => {
    const AP_R = apR + apStroke / 2;
    const items = [],
      obstacles = [];
    const visibleFurniture = shown("furniture") ? furniture : [];
    const visibleSources = shown("sources") ? sources : [];
    for (const f of visibleFurniture) {
      const rect = {
        x0: +f.x,
        y0: +f.z,
        x1: +f.x + +f.width,
        y1: +f.z + +f.depth,
      };
      obstacles.push({ ...rect, owner: `f:${f.id}` });
      if (showFurnitureNames)
        items.push({
          id: `f:${f.id}`,
          text: f.name,
          fontSize: 0.4,
          priority: 1,
          preferred: { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 },
          anchor: rect,
        });
    }
    for (const s of visibleSources) {
      const rect = {
        x0: +s.x - AP_R,
        y0: +s.z - AP_R,
        x1: +s.x + AP_R,
        y1: +s.z + AP_R,
      };
      obstacles.push({ ...rect, owner: `s:${s.id}` });
      if (s.kind !== "wifi" || showWifiNames)
        items.push({
          id: `s:${s.id}`,
          text: shortApName(s.name),
          fontSize: apFont,
          priority: 2,
          preferred: null,
          anchor: rect,
        });
    }
    return layoutLabels(items, obstacles);
  }, [furniture, sources, hiddenLayers, showFurnitureNames, showWifiNames, apR, apFont, apStroke]);
  const ranges = getMetricRanges(plan, metric);
  const color = (value) => getMetricColor(value, ranges);
  const cells = logGrid
    ? getLogGridCells({
        logs: rawLogs,
        rooms,
        gridSize,
        aggregation,
        metric,
        ranges,
      })
    : [];
  const opening = (item, i, type) => {
    const r = rooms.find((r) => r.id === item.roomId);
    if (!r) return null;
    const b = bbox(r),
      off = +item.offset,
      w = +item.width;
    let x1, x2, z1, z2;
    // polygon rooms have no sides: the opening sits on edge i (vertex i -> i + 1)
    if (r.shape !== "rectangle" && Number.isInteger(+item.edgeIndex)) {
      const pts = pointsOf(r),
        a = pts[+item.edgeIndex % pts.length],
        c = pts[(+item.edgeIndex + 1) % pts.length],
        len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      const ux = (c.x - a.x) / len,
        uz = (c.z - a.z) / len;
      x1 = a.x + ux * off;
      z1 = a.z + uz * off;
      x2 = x1 + ux * w;
      z2 = z1 + uz * w;
    } else
    switch (item.wallSide) {
      case "north":
        x1 = b.minX + off;
        x2 = x1 + w;
        z1 = z2 = b.minZ;
        break;
      case "south":
        x1 = b.minX + off;
        x2 = x1 + w;
        z1 = z2 = b.maxZ;
        break;
      case "west":
        z1 = b.minZ + off;
        z2 = z1 + w;
        x1 = x2 = b.minX;
        break;
      default:
        z1 = b.minZ + off;
        z2 = z1 + w;
        x1 = x2 = b.maxX;
    }
    return (
      <line
        key={item.id}
        x1={x1}
        y1={z1}
        x2={x2}
        y2={z2}
        stroke={item.needsReview ? "#a21caf" : type === "door" ? "#b45309" : "#0ea5e9"}
        strokeWidth=".28"
        strokeDasharray={item.needsReview ? ".3 .15" : undefined}
        onPointerDown={(e) => down(e, type, item.id)}
      />
    );
  };
  return (
    <div className="plan2d">
      {shown("compass") && <PlanCompass alignment={plan.alignment} />}
      {(poly.length > 0 || wallStart || tool === "rectangle") && (
        <div className="plan-canvas-actions">
          {tool === "rectangle" && (
            <span>
              {rectDraft
                ? "Release to place the room"
                : "Press and drag from one corner to the opposite corner"}
            </span>
          )}
          {poly.length > 0 && (
            <button onClick={finishPolygon} disabled={poly.length < 3}>
              Finish {tool === "boundary" ? "boundary" : "polygon"} ({poly.length})
            </button>
          )}
          {wallStart && <span>Click wall end point</span>}
        </div>
      )}
      <svg
        ref={svg}
        className="plan-svg"
        viewBox={`${minX + (width - viewWidth) / 2 + pan.x} ${
          minZ + (height - viewHeight) / 2 + pan.z
        } ${viewWidth} ${viewHeight}`}
        onPointerDownCapture={startPan}
        onWheel={(e) => {
          e.preventDefault();
          onZoom?.(
            Math.max(0.25, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 0.9))),
          );
        }}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerDown={(e) => {
          if (e.target === svg || e.target.dataset.background) background(e);
        }}
      >
        <defs>
          <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
            <path
              d="M 1 0 L 0 0 0 1"
              fill="none"
              stroke="#dce5e4"
              strokeWidth=".035"
            />
          </pattern>
        </defs>
        <rect
          data-background="true"
          x={minX}
          y={minZ}
          width={width}
          height={height}
          fill="#f8fbfa"
        />
        {shown("grid") && (
          <rect
            data-background="true"
            x={minX}
            y={minZ}
            width={width}
            height={height}
            fill="url(#grid)"
          />
        )}
        {floorImage && shown("image") && (
          <image
            href={floorImage.url}
            x={floorImage.offsetX || 0}
            y={floorImage.offsetZ || 0}
            width={floorImage.widthM}
            height={floorImage.heightM}
            transform={`rotate(${floorImage.rotationDeg || 0} ${
              (floorImage.offsetX || 0) + floorImage.widthM / 2
            } ${(floorImage.offsetZ || 0) + floorImage.heightM / 2})`}
            opacity=".35"
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        )}
        {heatmap && (
          <Heatmap2D
            cells={predictions}
            rooms={heatAreas}
            opacity={heatmapOpacity}
            ranges={predictions[0]?.ranges}
          />
        )}
        {(shown("rooms") ? rooms : []).map((r) => (
          <g
            key={r.id}
            onPointerDown={(e) => down(e, "room", r.id)}
            className={isStatic ? "draggable static-object" : "draggable"}
          >
            <polygon
              points={pointsOf(r)
                .map((p) => `${p.x},${p.z}`)
                .join(" ")}
              fill={
                selected?.type === "room" && selected.id === r.id
                  ? "#7dd3c7"
                  : "#bde9df"
              }
              fillOpacity={heatmap ? 0.35 : 0.78}
              stroke={r.needsReview ? "#f59e0b" : "none"}
              strokeWidth={r.needsReview ? 0.12 : undefined}
              strokeDasharray={r.needsReview ? ".5 .3" : undefined}
            />
            {showRoomNames && (
              <text
                x={+r.x + +r.width / 2}
                y={+r.z + +r.depth / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize=".65"
                fill="#193c39"
                pointerEvents="none"
              >
                {r.name}
              </text>
            )}
          </g>
        ))}
        {(shown("walls")
          ? wallModel
          : []
        )
          .filter(
            (w) =>
              shown("boundary") || !w.owners.every((o) => o.type === "boundary"),
          )
          .map((w, i) => (
          <g key={`wall-${i}`} pointerEvents="none">
            <line
              x1={w.a.x}
              y1={w.a.z}
              x2={w.b.x}
              y2={w.b.z}
              stroke={w.owners.some((o) => o.type === "boundary") ? "#1f3f3a" : "#435b60"}
              strokeWidth={onScreen(wallCore * (w.owners.some((o) => o.type === "boundary") ? 1.9 : 1.35), w.owners.some((o) => o.type === "boundary") ? 5 : 4)}
              strokeLinecap="square"
            />
            <line
              x1={w.a.x}
              y1={w.a.z}
              x2={w.b.x}
              y2={w.b.z}
              stroke={materialColors[w.material] || materialColors.drywall}
              strokeWidth={onScreen(wallCore, w.owners.some((o) => o.type === "boundary") ? 3 : 2.4)}
              strokeLinecap="square"
            />
          </g>
        ))}
        {editable && (
          <g className="shape-edit-edges">
            {editShapes
              .filter((s) => s.type !== "wall" && !isSel(s))
              .flatMap(edgeHits)}
            {selectedShape && selectedShape.type !== "wall" && edgeHits(selectedShape)}
          </g>
        )}
        {(shown("walls") ? walls : []).map((w) => (
          <g key={w.id} className="draggable" onPointerDown={(e) => down(e, "wall", w.id)}>
            <line
              x1={w.x1}
              y1={w.z1}
              x2={w.x2}
              y2={w.z2}
              stroke={
                selected?.type === "wall" && selected.id === w.id
                  ? "#f59e0b"
                  : "#435b60"
              }
              strokeWidth={onScreen(0.21, 4)}
            />
            <line
              x1={w.x1}
              y1={w.z1}
              x2={w.x2}
              y2={w.z2}
              stroke={materialColors[w.material] || materialColors.drywall}
              strokeWidth={onScreen(0.15, 2.4)}
            />
          </g>
        ))}
        {(shown("openings") ? doors : []).map((d, i) => opening(d, i, "door"))}
        {(shown("openings") ? windows : []).map((w, i) => opening(w, i, "window"))}
        {logGrid &&
          logsVisible &&
          cells.map((c) => (
            <rect
              key={c.id}
              x={c.x - c.width / 2}
              y={c.z - c.depth / 2}
              width={c.width}
              height={c.depth}
              fill={c.color}
              opacity=".67"
            >
              <title>{`${metric}: ${c.value?.toFixed(1)} · ${c.samples} samples`}</title>
            </rect>
          ))}
        {!logGrid &&
          logsVisible &&
          rawLogs.map((l) => (
            <circle
              key={l.id}
              cx={l.x}
              cy={l.z}
              r=".18"
              fill={color(l[metric])}
              stroke="white"
              strokeWidth=".05"
            >
              <title>{`${metric}: ${l[metric] ?? "N/A"}`}</title>
            </circle>
          ))}
        {(shown("furniture") ? furniture : []).map((f) => (
          <g
            key={f.id}
            onPointerDown={(e) => down(e, "furniture", f.id)}
            className="draggable"
          >
            <rect
              x={f.x}
              y={f.z}
              width={f.width}
              height={f.depth}
              rx=".1"
              fill="#b79d79"
              stroke="#735c3c"
              strokeWidth=".06"
            />
            {showFurnitureNames && (
              <text
                x={labelSpots[`f:${f.id}`]?.x ?? +f.x + f.width / 2}
                y={labelSpots[`f:${f.id}`]?.y ?? +f.z + f.depth / 2}
                fontSize=".4"
                textAnchor="middle"
                dominantBaseline="middle"
                className="plan-label"
                pointerEvents="none"
              >
                {f.name}
              </text>
            )}
          </g>
        ))}
        {draft && (
          <g className="trace-preview" pointerEvents="none">
            {draft.rooms.map((r) => (
              <rect
                key={r.id}
                x={r.x}
                y={r.z}
                width={r.width}
                height={r.depth}
                fill="#a78bfa"
                fillOpacity=".24"
                stroke="#6d28d9"
                strokeWidth=".15"
                strokeDasharray=".35 .18"
              />
            ))}
            {draft.walls.map((w) => (
              <line
                key={w.id}
                x1={w.x1}
                y1={w.z1}
                x2={w.x2}
                y2={w.z2}
                stroke="#6d28d9"
                strokeWidth=".2"
                strokeDasharray=".4 .18"
              />
            ))}
            {draft.furniture.map((f) => (
              <rect
                key={f.id}
                x={f.x}
                y={f.z}
                width={f.width}
                height={f.depth}
                fill="#f59e0b"
                fillOpacity=".3"
                stroke="#b45309"
                strokeWidth=".12"
                strokeDasharray=".3 .15"
              />
            ))}
          </g>
        )}
        {shown("sources") &&
          dasCables.map((c) => {
            const on = selected?.type === "dascable" && selected.id === c.id;
            return (
              <g key={c.id} onPointerDown={(e) => {
                e.stopPropagation();
                if (tool === "select") onSelect(entity("dascable", c.id));
              }}>
                {/* wide invisible line: easy to click */}
                <line x1={c.x1} y1={c.z1} x2={c.x2} y2={c.z2} stroke="transparent" strokeWidth={apR * 1.6} />
                <line
                  x1={c.x1}
                  y1={c.z1}
                  x2={c.x2}
                  y2={c.z2}
                  stroke={on ? "#e8790a" : "#7c3aed"}
                  strokeWidth={apStroke * (on ? 2.2 : 1.5)}
                  strokeDasharray={c.otherFloor ? `${apR} ${apR / 2}` : undefined}
                />
                {c.port === "tap" && (
                  <text x={(c.x1 + c.x2) / 2} y={(c.z1 + c.z2) / 2} fontSize={apFont * 0.8} fill="#7c3aed" textAnchor="middle" pointerEvents="none">
                    tap
                  </text>
                )}
              </g>
            );
          })}
        {(shown("sources") ? sources : []).map((s) => (
          <g
            key={s.id}
            onPointerDown={(e) => down(e, "source", s.id)}
            className="draggable"
          >
            {cableFrom === s.id && (
              <circle cx={s.x} cy={s.z} r={apR * 1.8} fill="none" stroke="#e8790a" strokeWidth={apStroke * 1.5} strokeDasharray={`${apR / 2} ${apR / 3}`} />
            )}
            <SourceSymbol s={s} r={apR} stroke={apStroke} selected={selected?.type === "source" && selected.id === s.id} />
            {(s.kind !== "wifi" || showWifiNames) && (
              <text
                x={labelSpots[`s:${s.id}`]?.x ?? s.x}
                y={labelSpots[`s:${s.id}`]?.y ?? +s.z - apR - apFont * 0.7}
                fontSize={apFont}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#213547"
                className="plan-label"
                pointerEvents="none"
              >
                {shortApName(s.name)}
              </text>
            )}
          </g>
        ))}
        {(shown("boundary") ? plan.boundaries || [] : [])
          .filter((b) => b.floorId === floorId)
          .map((b) => (
            <polygon
              key={b.id}
              points={b.points.map((q) => `${q.x},${q.z}`).join(" ")}
              fill="none"
              stroke={
                selected?.type === "boundary" && selected.id === b.id
                  ? "#e8790a"
                  : "transparent"
              }
              strokeWidth={Math.min(0.8, Math.max(0.06, wallT * 2))}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          ))}
        {overlay?.focus?.a && (
          <line
            x1={overlay.focus.a.x}
            y1={overlay.focus.a.z}
            x2={overlay.focus.b.x}
            y2={overlay.focus.b.z}
            stroke="#f97316"
            strokeWidth={Math.max(0.3, wallCore * 1.8)}
            strokeDasharray=".5 .3"
            opacity=".9"
            pointerEvents="none"
          />
        )}
        {overlay?.focus?.rooms &&
          rooms
            .filter((r) => overlay.focus.rooms.includes(r.id))
            .map((r) => (
              <polygon
                key={`focus-${r.id}`}
                points={pointsOf(r)
                  .map((q) => `${q.x},${q.z}`)
                  .join(" ")}
                fill="#f9731633"
                stroke="#f97316"
                strokeWidth=".15"
                strokeDasharray=".5 .3"
                pointerEvents="none"
              />
            ))}
        {overlay?.weakZones?.map((z, i) => (
          <rect
            key={`weak-${i}`}
            x={z.bbox.minX}
            y={z.bbox.minZ}
            width={z.bbox.maxX - z.bbox.minX}
            height={z.bbox.maxZ - z.bbox.minZ}
            fill="none"
            stroke="#dc2626"
            strokeWidth=".12"
            strokeDasharray=".4 .3"
            pointerEvents="none"
          >
            <title>{`Uncovered zone: ${formatArea(z.areaM2, unit)}`}</title>
          </rect>
        ))}
        {overlay?.candidates?.valid.map((c) => (
          <circle key={c.id} cx={c.x} cy={c.z} r=".14" fill="#16a34a" opacity=".75">
            <title>{`Valid ${c.kind} position · ${c.roomName} · ${formatLength(c.heightM, unit)}`}</title>
          </circle>
        ))}
        {overlay?.candidates?.rejected.map((c, i) => (
          <g key={`${c.id}-${i}`} stroke="#dc2626" strokeWidth={onScreen(0.07, 1.5)} opacity=".8">
            <line x1={c.x - onScreen(0.12, 3)} y1={c.z - onScreen(0.12, 3)} x2={c.x + onScreen(0.12, 3)} y2={c.z + onScreen(0.12, 3)} />
            <line x1={c.x - onScreen(0.12, 3)} y1={c.z + onScreen(0.12, 3)} x2={c.x + onScreen(0.12, 3)} y2={c.z - onScreen(0.12, 3)} />
            <title>{`Rejected: ${c.reasonText}`}</title>
          </g>
        ))}
        {/* suggested APs: the same readable size as placed APs at any zoom, orange, numbered and labelled */}
        {overlay?.recommended?.map((r) => (
          <g key={r.candidateId} pointerEvents="none">
            <circle cx={r.planX} cy={r.planZ} r={apR * 1.25} fill="#fff7ed" stroke="#e8790a" strokeWidth={apStroke * 1.6} />
            <text x={r.planX} y={r.planZ} textAnchor="middle" dominantBaseline="central" fontSize={apFont * 0.95}
              fontWeight="700" fill="#b45309">
              {r.rank}
            </text>
            <text x={r.planX} y={+r.planZ - apR * 1.25 - apFont * 0.6} textAnchor="middle" fontSize={apFont}
              fontWeight="700" fill="#b45309" stroke="#fff" strokeWidth={apFont * 0.25} paintOrder="stroke">
              {r.action === "move" ? `Move AP here (${r.rank})` : r.action === "keep" ? `Keep AP (${r.rank})` : `New AP ${r.rank}`}
            </text>
          </g>
        ))}
        {cables && (
          <g pointerEvents="none">
            {cables.runs.flatMap((run) =>
              run.paths
                .filter((p) => p.floorId === floorId)
                .map((p, i) => (
                  <polyline key={`cable-${run.apId}-${i}`} fill="none" strokeLinejoin="round"
                    points={p.points.map((q) => `${q.x},${q.z}`).join(" ")}
                    stroke={run.check === "ok" ? "#1f8a4c" : run.check === "near limit" ? "#d98200" : "#c0392b"}
                    strokeWidth=".09" strokeDasharray={run.pathwayStatus === "estimated" ? ".35 .18" : undefined} opacity=".9" />
                )),
            )}
            {(racks || []).filter((r) => r.floorId === floorId).map((r) => (
              <g key={`rack-${r.id}`}>
                <rect x={r.x - 0.35} y={r.z - 0.35} width=".7" height=".7" fill="#fff" stroke="#1d4ed8" strokeWidth=".1" />
                <text x={r.x} y={r.z + 0.14} textAnchor="middle" fontSize=".4" fontWeight="700" fill="#1d4ed8">R</text>
              </g>
            ))}
          </g>
        )}
        {measureLabels.length > 0 && (
          <g className="plan-measurements" pointerEvents="none">
            {measureLabels.map((l) => (
              <text
                key={l.key}
                x={l.x}
                y={l.z}
                transform={`rotate(${l.angle} ${l.x} ${l.z})`}
                fontSize={measureFont}
                textAnchor="middle"
                dominantBaseline="middle"
                className={l.boundary ? "plan-label measure boundary" : "plan-label measure"}
              >
                {l.text}
              </text>
            ))}
          </g>
        )}
        {editable && selectedShape && (
          <g className="shape-edit-vertices">
            {selectedShape.points.map((v, i) => (
              <circle
                key={`v${i}`}
                className="polygon-vertex-handle"
                cx={v.x}
                cy={v.z}
                r={handleR}
                strokeWidth={handleR * 0.45}
                onPointerDown={(e) =>
                  startPartDrag(e, selectedShape.type, selectedShape.id, i, "vertex", v)
                }
              >
                <title>{`Drag vertex ${i + 1}`}</title>
              </circle>
            ))}
          </g>
        )}
        {poly.length > 0 && (
          <polyline
            points={poly.map((p) => `${p.x},${p.z}`).join(" ")}
            fill="none"
            stroke="#e8790a"
            strokeWidth=".1"
          />
        )}
        {wallStart && (
          <circle cx={wallStart.x} cy={wallStart.z} r=".2" fill="#e8790a" />
        )}
        {rectDraft && (() => {
          const x = Math.min(rectDraft.start.x, rectDraft.end.x),
            z = Math.min(rectDraft.start.z, rectDraft.end.z),
            w = Math.abs(rectDraft.end.x - rectDraft.start.x),
            d = Math.abs(rectDraft.end.z - rectDraft.start.z),
            font = Math.max(0.35, 12 * mPerPx);
          return (
            <g pointerEvents="none">
              <rect
                x={x}
                y={z}
                width={w}
                height={d}
                fill="rgba(232,121,10,.12)"
                stroke="#e8790a"
                strokeWidth={onScreen(0.08, 2)}
                strokeDasharray={`${4 * mPerPx} ${3 * mPerPx}`}
              />
              {w > 0 && d > 0 && (
                <text
                  x={x + w / 2}
                  y={z + d / 2}
                  fontSize={font}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#9a4f05"
                >
                  {`${formatLength(w, unit)} × ${formatLength(d, unit)}`}
                </text>
              )}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
