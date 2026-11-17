import React, { useEffect, useMemo, useRef, useState } from "react";
import { bbox, boundaryAreas, pointsOf } from "../../utils/geometry.js";
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

export default function Plan2D({
  plan,
  floorId,
  tool,
  snap,
  isStatic = true,
  showRoomNames = true,
  showFurnitureNames = true,
  showWifiNames = true,
  selected,
  onSelect,
  onPlace,
  onMove,
  onMovePolygonPart,
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
}) {
  const shown = (id) => !hiddenLayers.includes(id);
  const svg = useRef(),
    drag = useRef(null),
    panDrag = useRef(null),
    [wallStart, setWallStart] = useState(null),
    [poly, setPoly] = useState([]),
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
  const startPolygonPartDrag = (e, roomId, index, mode) => {
    e.stopPropagation();
    if (tool !== "select") return;
    onSelect({ type: "room", id: roomId });
    const at = point(e, false);
    drag.current = {
      type: "polygon-part",
      id: roomId,
      index,
      mode,
      origin: at,
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
      targetX = snap ? Math.round(rawX * 2) / 2 : rawX,
      targetZ = snap ? Math.round(rawZ * 2) / 2 : rawZ,
      dx = targetX - d.applied.x,
      dz = targetZ - d.applied.z;
    if (dx || dz) {
      if (d.type === "polygon-part")
        onMovePolygonPart(d.id, d.index, dx, dz, d.mode);
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
    if (tool === "select") onSelect(null);
    else onPlace(tool, p);
  };
  const finishPolygon = () => {
    if (poly.length >= 3)
      onPlace(tool === "boundary" ? "boundary" : "polygon", { points: poly });
    setPoly([]);
  };
  const heatAreas = [...rooms, ...boundaryAreas(plan, floorId)];
  // drawing width follows the wall thickness (0.2 m looks like before)
  const wallT = Number(plan.wallThickness) || 0.2;
  // the same merged walls as the 3D view and the ray-tracing export, coloured
  // by material like the legend
  const wallModel = useMemo(
    () => buildWalls(plan, floorId),
    [plan.rooms, plan.boundaries, plan.doors, plan.windows, plan.wallTypes, floorId],
  );
  // names never sit on each other or on a column / AP marker
  const labelSpots = useMemo(() => {
    const AP_R = 0.38 + 0.06;
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
          fontSize: AP_FONT,
          priority: 2,
          preferred: null,
          anchor: rect,
        });
    }
    return layoutLabels(items, obstacles);
  }, [furniture, sources, hiddenLayers, showFurnitureNames, showWifiNames]);
  const wallCore = Math.min(0.4, Math.max(0.05, wallT * 0.6));
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
      {(poly.length > 0 || wallStart) && (
        <div className="plan-canvas-actions">
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
            {selected?.type === "room" &&
              selected.id === r.id &&
              r.shape === "polygon" &&
              pointsOf(r).map((vertex, index) => {
                const next = pointsOf(r)[(index + 1) % pointsOf(r).length];
                return (
                  <g key={`polygon-edit-${index}`}>
                    <line
                      className="polygon-edge-hit"
                      x1={vertex.x}
                      y1={vertex.z}
                      x2={next.x}
                      y2={next.z}
                      stroke="transparent"
                      strokeWidth=".45"
                      pointerEvents="stroke"
                      onPointerDown={(e) =>
                        startPolygonPartDrag(e, r.id, index, "edge")
                      }
                    />
                    <circle
                      className="polygon-vertex-handle"
                      cx={vertex.x}
                      cy={vertex.z}
                      r=".2"
                      onPointerDown={(e) =>
                        startPolygonPartDrag(e, r.id, index, "vertex")
                      }
                    />
                  </g>
                );
              })}
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
              strokeWidth={wallCore * (w.owners.some((o) => o.type === "boundary") ? 1.9 : 1.35)}
              strokeLinecap="square"
            />
            <line
              x1={w.a.x}
              y1={w.a.z}
              x2={w.b.x}
              y2={w.b.z}
              stroke={materialColors[w.material] || materialColors.drywall}
              strokeWidth={wallCore}
              strokeLinecap="square"
            />
          </g>
        ))}
        {(shown("walls") ? walls : []).map((w) => (
          <g key={w.id} onPointerDown={(e) => down(e, "wall", w.id)}>
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
              strokeWidth=".21"
            />
            <line
              x1={w.x1}
              y1={w.z1}
              x2={w.x2}
              y2={w.z2}
              stroke={materialColors[w.material] || materialColors.drywall}
              strokeWidth=".15"
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
        {(shown("sources") ? sources : []).map((s) => (
          <g
            key={s.id}
            onPointerDown={(e) => down(e, "source", s.id)}
            className="draggable"
          >
            <circle
              cx={s.x}
              cy={s.z}
              r=".38"
              fill={s.kind === "wifi" ? "#7c3aed" : "#0e7490"}
              stroke="white"
              strokeWidth=".12"
            />
            {(s.kind !== "wifi" || showWifiNames) && (
              <text
                x={labelSpots[`s:${s.id}`]?.x ?? s.x}
                y={labelSpots[`s:${s.id}`]?.y ?? +s.z - 0.55}
                fontSize={AP_FONT}
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
              pointerEvents={tool === "select" ? "stroke" : "none"}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => down(e, "boundary", b.id)}
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
            <title>{`Uncovered zone: ${z.areaM2} m²`}</title>
          </rect>
        ))}
        {overlay?.candidates?.valid.map((c) => (
          <circle key={c.id} cx={c.x} cy={c.z} r=".14" fill="#16a34a" opacity=".75">
            <title>{`Valid ${c.kind} position · ${c.roomName} · ${c.heightM} m`}</title>
          </circle>
        ))}
        {overlay?.candidates?.rejected.map((c, i) => (
          <g key={`${c.id}-${i}`} stroke="#dc2626" strokeWidth=".07" opacity=".8">
            <line x1={c.x - 0.12} y1={c.z - 0.12} x2={c.x + 0.12} y2={c.z + 0.12} />
            <line x1={c.x - 0.12} y1={c.z + 0.12} x2={c.x + 0.12} y2={c.z - 0.12} />
            <title>{`Rejected: ${c.reasonText}`}</title>
          </g>
        ))}
        {overlay?.recommended?.map((r) => (
          <g key={r.candidateId} pointerEvents="none">
            <circle cx={r.planX} cy={r.planZ} r=".42" fill="#fff" stroke="#e8790a" strokeWidth=".14" />
            <text x={r.planX} y={r.planZ + 0.17} textAnchor="middle" fontSize=".5" fontWeight="700" fill="#b45309">
              {r.rank}
            </text>
          </g>
        ))}
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
      </svg>
    </div>
  );
}
