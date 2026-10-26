import React, { useEffect, useRef, useState } from "react";
import { bbox, pointsOf } from "../../utils/geometry.js";
import { colorFor } from "../../utils/prediction.js";
import {
  getFloorLogs,
  getLogGridCells,
  getMetricColor,
  getMetricRanges,
} from "../../utils/logOverlay.js";

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
  heatmap,
  logsVisible,
  logGrid,
  metric,
  gridSize,
  aggregation,
  draft,
}) {
  const svg = useRef(),
    drag = useRef(null),
    panDrag = useRef(null),
    [wallStart, setWallStart] = useState(null),
    [poly, setPoly] = useState([]),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, z: 0 });
  const rooms = plan.rooms.filter((r) => r.floorId === floorId),
    doors = plan.doors.filter((d) => d.floorId === floorId),
    windows = plan.windows.filter((w) => w.floorId === floorId),
    walls = plan.interiorWalls.filter((w) => w.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId),
    furniture = plan.furniture.filter((f) => f.floorId === floorId);
  useEffect(() => {
    if (tool !== "polygon") setPoly([]);
    if (tool !== "wall") setWallStart(null);
  }, [tool]);
  const rawLogs = getFloorLogs(plan, floorId);
  const floorImage = plan.images[floorId];
  const xs = [
      0,
      floorImage ? floorImage.widthM : 30,
      ...rooms.flatMap((r) => {
        const b = bbox(r);
        return [b.minX, b.maxX];
      }),
      ...sources.map((s) => +s.x),
      ...(draft?.rooms || []).flatMap((r) => [r.x, +r.x + +r.width]),
    ],
    zs = [
      0,
      floorImage ? floorImage.heightM : 22,
      ...rooms.flatMap((r) => {
        const b = bbox(r);
        return [b.minZ, b.maxZ];
      }),
      ...sources.map((s) => +s.z),
      ...(draft?.rooms || []).flatMap((r) => [r.z, +r.z + +r.depth]),
    ];
  const minX = Math.min(...xs),
    minZ = Math.min(...zs),
    width = Math.max(...xs) - minX,
    height = Math.max(...zs) - minZ,
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
    if (isStatic && type === "room") return;
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
    if (tool === "polygon") {
      setPoly([...poly, p]);
      return;
    }
    if (tool === "select") onSelect(null);
    else onPlace(tool, p);
  };
  const finishPolygon = () => {
    if (poly.length >= 3) onPlace("polygon", { points: poly });
    setPoly([]);
  };
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
        stroke={type === "door" ? "#b45309" : "#0ea5e9"}
        strokeWidth=".28"
        onPointerDown={(e) => down(e, type, item.id)}
      />
    );
  };
  return (
    <div className="plan2d">
      {(poly.length > 0 || wallStart) && (
        <div className="plan-canvas-actions">
          {poly.length > 0 && (
            <button onClick={finishPolygon} disabled={poly.length < 3}>
              Finish polygon ({poly.length})
            </button>
          )}
          {wallStart && <span>Click wall end point</span>}
        </div>
      )}
      <svg
        ref={svg}
        viewBox={`${minX + pan.x} ${minZ + pan.z} ${viewWidth} ${viewHeight}`}
        onPointerDownCapture={startPan}
        onWheel={(e) => {
          e.preventDefault();
          setZoom((v) =>
            Math.max(0.5, Math.min(4, v * (e.deltaY < 0 ? 1.1 : 0.9))),
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
        <rect
          data-background="true"
          x={minX}
          y={minZ}
          width={width}
          height={height}
          fill="url(#grid)"
        />
        {floorImage && (
          <image
            href={floorImage.url}
            x="0"
            y="0"
            width={floorImage.widthM}
            height={floorImage.heightM}
            opacity=".35"
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        )}
        {heatmap &&
          predictions.map((p, i) => (
            <rect
              key={i}
              x={p.x - p.step / 2}
              y={p.z - p.step / 2}
              width={p.step}
              height={p.step}
              fill={colorFor(p.dbm, plan.rf.thresholdDbm)}
              opacity=".65"
            >
              <title>{`${p.dbm.toFixed(1)} dBm · ${p.sourceName} · wall loss ${p.wallLoss.toFixed(1)} dB`}</title>
            </rect>
          ))}
        {rooms.map((r) => (
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
              stroke="#285e57"
              strokeWidth=".12"
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
        {walls.map((w) => (
          <line
            key={w.id}
            x1={w.x1}
            y1={w.z1}
            x2={w.x2}
            y2={w.z2}
            stroke={
              selected?.type === "wall" && selected.id === w.id
                ? "#f59e0b"
                : "#435b60"
            }
            strokeWidth=".15"
            onPointerDown={(e) => down(e, "wall", w.id)}
          />
        ))}
        {doors.map((d, i) => opening(d, i, "door"))}
        {windows.map((w, i) => opening(w, i, "window"))}
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
        {furniture.map((f) => (
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
                x={+f.x + f.width / 2}
                y={+f.z + f.depth / 2}
                fontSize=".4"
                textAnchor="middle"
                dominantBaseline="middle"
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
        {sources.map((s) => (
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
                x={s.x}
                y={+s.z - 0.55}
                fontSize=".55"
                textAnchor="middle"
                fill="#213547"
                pointerEvents="none"
              >
                {s.name}
              </text>
            )}
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
