import React, { useEffect, useRef, useState } from "react";
import { floorRoutingInput } from "../../infra/core/planGeometry.js";

const COLOUR = { ok: "#1f8a4c", "near limit": "#d98200", PoE: "#c0392b", "too long": "#c0392b" };
// walls by what a cable may do there
const WALL_STYLE = {
  blocked: { stroke: "#9a3412", width: 2.6, dash: null },
  permitted: { stroke: "#16a34a", width: 1.8, dash: [6, 3] },
  penalty: { stroke: "#7a8794", width: 1.6, dash: null },
};

// distance from a point to a segment, in plan metres
const distToSegment = (p, a, b) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

// A plain top-down drawing of one floor with the cabling on it: walls, APs,
// racks, risers and the routed cables. It only draws; the plan is not changed.
export default function CablingMap({
  plan,
  floorId,
  design,
  racks,
  risers,
  placing,
  onPlace,
  onMoveRack,
  pathway = {},
  wallMode = false,
  selectedWall = null,
  onWallClick,
  drawMode = null, // "tray" | "nogo" while the user is drawing
  draft = [],
  onDraftPoint,
  routeMode = false,
  selectedAp = null,
  routeEdits = {},
  onRouteClick,
  onMoveWaypoint,
}) {
  const [dragWp, setDragWp] = useState(null); // { apId, index, x, z } while a waypoint is dragged
  const svg = useRef(null);
  const [drag, setDrag] = useState(null); // { id, x, z } while a rack is being dragged
  // Pointer position in plan metres. The drawing is scaled and centred inside
  // its box, so the conversion must use the SVG's own transform: dividing by
  // the box size would be wrong whenever there is blank space around it.
  const toPlan = (clientX, clientY) => {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!matrix) return null;
    const point = el.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const p = point.matrixTransform(matrix.inverse());
    return { x: Math.round(p.x * 100) / 100, z: Math.round(p.y * 100) / 100 };
  };
  useEffect(() => {
    if (!dragWp) return undefined;
    const move = (e) => {
      const at = toPlan(e.clientX, e.clientY);
      if (at) setDragWp((d) => (d ? { ...d, ...at } : d));
    };
    const up = (e) => {
      const at = toPlan(e.clientX, e.clientY);
      if (at && onMoveWaypoint) onMoveWaypoint(dragWp.apId, dragWp.index, { x: Math.round(at.x * 4) / 4, z: Math.round(at.z * 4) / 4 });
      setDragWp(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragWp?.apId, dragWp?.index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const at = toPlan(e.clientX, e.clientY);
      if (at) setDrag((d) => (d ? { ...d, ...at } : d));
    };
    const up = (e) => {
      const at = toPlan(e.clientX, e.clientY);
      if (at && onMoveRack) onMoveRack(drag.id, at);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const input = floorRoutingInput(plan, floorId, pathway);
  if (!input)
    return <p className="panel-note">This floor has no rooms or boundary to draw.</p>;
  const { bounds } = input;
  const pad = 1;
  const x0 = bounds.minX - pad;
  const z0 = bounds.minZ - pad;
  const w = bounds.maxX - bounds.minX + 2 * pad;
  const h = bounds.maxZ - bounds.minZ + 2 * pad;
  const walls = input.walls;
  const stroke = Math.max(w, h) / 400;
  const onClick = (event) => {
    const at = toPlan(event.clientX, event.clientY);
    if (!at) return;
    if (routeMode && onRouteClick) {
      // an AP near the click selects its route; anywhere else adds a waypoint to the selected route
      const apsHere = (plan.sources || []).filter((s) => s.kind === "wifi" && s.floorId === floorId);
      const near = apsHere
        .map((s) => ({ s, d: Math.hypot(s.x - at.x, s.z - at.z) }))
        .filter((e) => e.d < 1)
        .sort((a, b) => a.d - b.d)[0];
      onRouteClick({ at: { x: Math.round(at.x * 4) / 4, z: Math.round(at.z * 4) / 4 }, apId: near ? near.s.id : null });
      return;
    }
    if (drawMode && onDraftPoint) {
      // quarter-metre steps keep drawn pathways tidy
      onDraftPoint({ x: Math.round(at.x * 4) / 4, z: Math.round(at.z * 4) / 4 });
      return;
    }
    if (wallMode && onWallClick) {
      // the wall piece nearest to the click, if it is close enough
      let best = null;
      for (const wall of walls) {
        const d = distToSegment({ x: at.x, z: at.z }, wall.a, wall.b);
        if (d < 0.6 && (!best || d < best.d)) best = { d, wall };
      }
      onWallClick(best ? best.wall : null);
      return;
    }
    if (placing) onPlace(at);
  };
  const legs = (design?.runs || []).flatMap((run) =>
    run.paths
      .filter((p) => p.floorId === floorId)
      .map((p) => ({ run, points: p.points })),
  );
  const aps = (plan.sources || []).filter((s) => s.kind === "wifi" && s.floorId === floorId);
  return (
    <svg
      ref={svg}
      viewBox={`${x0} ${z0} ${w} ${h}`}
      style={{
        width: "100%",
        maxHeight: 520,
        background: "var(--surface, #fff)",
        border: "1px solid var(--line, #d0d7de)",
        borderRadius: 8,
        cursor: placing || wallMode || drawMode || routeMode ? "crosshair" : "default",
      }}
      onClick={onClick}
      role="img"
      aria-label="Cabling plan of the selected floor"
    >
      {input.noGo.map((poly, i) => (
        <polygon key={`n${i}`} points={poly.map((p) => `${p.x},${p.z}`).join(" ")}
          fill="#dc2626" fillOpacity="0.16" stroke="#dc2626" strokeWidth={stroke * 1.4}
          strokeDasharray={`${stroke * 5} ${stroke * 3}`} />
      ))}
      {input.powerRoutes.map((pr, i) => (
        <polyline key={`p${i}`} fill="none" points={pr.points.map((p) => `${p.x},${p.z}`).join(" ")}
          stroke="#ea580c" strokeWidth={stroke * 2.4} strokeDasharray={`${stroke * 2} ${stroke * 3}`} />
      ))}
      {input.trays.map((tray, i) => (
        <g key={`t${i}`}>
          <polyline fill="none" points={tray.points.map((p) => `${p.x},${p.z}`).join(" ")}
            stroke="#1d4ed8" strokeWidth={stroke * 3.4} strokeOpacity="0.45" strokeLinejoin="round"
            strokeDasharray={tray.status === "confirmed" ? undefined : `${stroke * 8} ${stroke * 4}`} />
          <text x={tray.points[0].x + stroke * 4} y={tray.points[0].z - stroke * 5} fontSize={stroke * 8} fill="#1e3a8a">
            {tray.name || "Tray"} ({tray.kind === "existing" ? "existing" : "new"})
          </text>
        </g>
      ))}
      {walls.map((wall, i) => {
        const style = WALL_STYLE[wall.policy] || WALL_STYLE.penalty;
        const chosen = selectedWall && selectedWall.key === wall.key;
        return (
          <line key={`w${i}`} x1={wall.a.x} y1={wall.a.z} x2={wall.b.x} y2={wall.b.z}
            stroke={chosen ? "#2563eb" : style.stroke}
            strokeWidth={stroke * (chosen ? 4 : style.width)}
            strokeDasharray={style.dash && !chosen ? style.dash.map((n) => n * stroke).join(" ") : undefined} />
        );
      })}
      {draft.length > 0 && (
        <g>
          {drawMode === "nogo" && draft.length > 2 && (
            <polygon points={draft.map((p) => `${p.x},${p.z}`).join(" ")} fill="#dc2626" fillOpacity="0.12" />
          )}
          <polyline fill="none" points={draft.map((p) => `${p.x},${p.z}`).join(" ")}
            stroke={drawMode === "nogo" ? "#dc2626" : drawMode === "power" ? "#ea580c" : "#1d4ed8"} strokeWidth={stroke * 2.4} strokeDasharray={`${stroke * 4} ${stroke * 3}`} />
          {draft.map((p, i) => <circle key={i} cx={p.x} cy={p.z} r={stroke * 3} fill="#0f172a" />)}
        </g>
      )}
      {legs.map(({ run, points }, i) => (
        <polyline key={`r${i}`} fill="none"
          points={points.map((p) => `${p.x},${p.z}`).join(" ")}
          stroke={COLOUR[run.check] || COLOUR.ok} strokeWidth={stroke * 2}
          strokeDasharray={run.pathwayStatus === "estimated" ? `${stroke * 8} ${stroke * 4}` : undefined}
          strokeLinejoin="round" opacity="0.9" />
      ))}
      {legs.map(({ run, points }, i) => {
        const end = points[points.length - 1];
        return end && run.floorId === floorId ? (
          <text key={`l${i}`} x={end.x - stroke * 4} y={end.z - stroke * 7} fontSize={stroke * 8}
            fill="#14532d" textAnchor="end">
            {run.permanentLinkM} m
          </text>
        ) : null;
      })}
      {legs.flatMap(({ run }, i) =>
        run.floorId === floorId && i === legs.findIndex((l) => l.run === run)
          ? (run.crossingPoints || []).filter((c) => c.floorId === floorId).map((c, j) => (
              <g key={`x${i}-${j}`}>
                {c.kind === "penetration" && (
                  <rect x={c.x - stroke * 4} y={c.z - stroke * 4} width={stroke * 8} height={stroke * 8}
                    transform={`rotate(45 ${c.x} ${c.z})`} fill="#7c3aed" stroke="#fff" strokeWidth={stroke * 0.8} />
                )}
                {c.kind === "ceiling" && (
                  <rect x={c.x - stroke * 3} y={c.z - stroke * 3} width={stroke * 6} height={stroke * 6} fill="#16a34a" stroke="#fff" strokeWidth={stroke * 0.8} />
                )}
                {c.kind === "estimated" && (
                  <circle cx={c.x} cy={c.z} r={stroke * 4.5} fill="none" stroke="#d97706" strokeWidth={stroke * 1.8} />
                )}
              </g>
            ))
          : [],
      )}
      {Object.entries(routeEdits).flatMap(([apId, edit]) =>
        (edit.waypoints || []).map((w, index) => {
          const at = dragWp && dragWp.apId === apId && dragWp.index === index ? dragWp : w;
          const chosen = selectedAp === apId;
          return (
            <g key={`w${apId}-${index}`} style={{ cursor: "grab", touchAction: "none" }}
              onPointerDown={(e) => {
                if (!routeMode) return;
                e.preventDefault();
                e.stopPropagation();
                setDragWp({ apId, index, x: w.x, z: w.z });
              }}>
              <circle cx={at.x} cy={at.z} r={stroke * (chosen ? 5 : 3.5)} fill={chosen ? "#2563eb" : "#94a3b8"} stroke="#fff" strokeWidth={stroke} />
              <text x={at.x} y={at.z + stroke * 2.6} fontSize={stroke * 7} fill="#fff" textAnchor="middle">{index + 1}</text>
            </g>
          );
        }),
      )}
      {aps.map((ap) => (
        <g key={ap.id}>
          <circle cx={ap.x} cy={ap.z} r={stroke * 5} fill="#2563eb"
            stroke={selectedAp === ap.id ? "#f59e0b" : "none"} strokeWidth={stroke * 2} />
          <text x={ap.x + stroke * 7} y={ap.z + stroke * 3} fontSize={stroke * 9} fill="#1e293b">
            {ap.name || "AP"}
          </text>
        </g>
      ))}
      {risers
        .filter((r) => !r.floorIds || r.floorIds.includes(floorId))
        .map((r) => (
          <g key={r.id}>
            <rect x={r.x - stroke * 5} y={r.z - stroke * 5} width={stroke * 10} height={stroke * 10}
              transform={`rotate(45 ${r.x} ${r.z})`} fill="#7c3aed" />
            <text x={r.x + stroke * 8} y={r.z} fontSize={stroke * 9} fill="#4c1d95">{r.name || "Riser"}</text>
          </g>
        ))}
      {racks
        .filter((r) => r.floorId === floorId)
        .map((r) => {
          const at = drag?.id === r.id ? drag : r;
          return (
            <g
              key={r.id}
              data-rack={r.id}
              style={{ cursor: onMoveRack ? "grab" : "default", touchAction: "none" }}
              onPointerDown={(e) => {
                if (!onMoveRack || placing) return;
                e.preventDefault();
                e.stopPropagation();
                setDrag({ id: r.id, x: r.x, z: r.z });
              }}
            >
              <rect x={at.x - stroke * 6} y={at.z - stroke * 6} width={stroke * 12} height={stroke * 12}
                fill={r.needsRoom ? "#b45309" : "#0f172a"} />
              <text x={at.x + stroke * 8} y={at.z} fontSize={stroke * 9} fill="#0f172a">{r.name || "Rack"}</text>
            </g>
          );
        })}
    </svg>
  );
}
