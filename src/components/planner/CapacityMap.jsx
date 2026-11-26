import React from "react";
import { bbox, boundaryAreas, pointsOf } from "../../utils/geometry.js";

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#65a30d", "#dc2626", "#475569", "#0d9488", "#ca8a04", "#7c3aed"];
export const apColour = (index) => PALETTE[index % PALETTE.length];
const PROBLEM = "#dc2626";
const OK_STATUS = new Set(["ok", "idle"]);

// The floor, drawn from the capacity result only, as one of:
//  - "density":  expected people per square, coloured by the AP they join
//                (deterministic), red where no AP reaches;
//  - "users":    each simulated user of one Monte Carlo run as a dot,
//                coloured by its AP, ringed red when a device misses its
//                minimum; the selected user shows its distance to every AP;
//  - "problems": how often active devices at a place missed their minimum
//                over all the Monte Carlo runs.
export default function CapacityMap({ plan, floorId, clients, aps, layer = "density", users = null, bins = null, selectedUserId = null, onSelectUser = null, links = null }) {
  const here = (clients || []).filter((c) => c.floorId === floorId);
  const people = (users || []).filter((u) => u.floorId === floorId);
  const problems = (bins || []).filter((b) => b.floorId === floorId && b.failPct > 0);
  const shapes = [...plan.rooms.filter((r) => r.floorId === floorId), ...boundaryAreas(plan, floorId)];
  const boxes = [
    ...shapes.map(bbox),
    ...here.map((c) => ({ minX: c.x, maxX: c.x, minZ: c.z, maxZ: c.z })),
    ...people.map((u) => ({ minX: u.x, maxX: u.x, minZ: u.z, maxZ: u.z })),
  ];
  if (!boxes.length) return <p className="hint">Nothing to draw on this floor.</p>;
  const minX = Math.min(...boxes.map((b) => b.minX)) - 1, maxX = Math.max(...boxes.map((b) => b.maxX)) + 1;
  const minZ = Math.min(...boxes.map((b) => b.minZ)) - 1, maxZ = Math.max(...boxes.map((b) => b.maxZ)) + 1;
  const index = new Map(aps.map((a, i) => [a.id, i]));
  const w = maxX - minX, h = maxZ - minZ;
  const unit = Math.max(w, h);
  const floorAps = aps.filter((a) => a.floorId === floorId);
  const selected = layer === "users" ? people.find((u) => u.id === selectedUserId) : null;
  const joinedIds = new Set((selected?.devices || []).map((d) => d.apId).filter(Boolean));

  const userColour = (u) => {
    const d = u.devices.find((x) => x.active && x.apId) ?? u.devices.find((x) => x.apId);
    return d ? apColour(index.get(d.apId) ?? 0) : PROBLEM;
  };
  const userFails = (u) => u.devices.some((d) => !OK_STATUS.has(d.status));

  return (
    <svg viewBox={`${minX} ${minZ} ${w} ${h}`} style={{ width: "100%", maxHeight: 460, background: "#f8fafc", border: "1px solid var(--line, #d0d7de)", borderRadius: 8 }} role="img"
      aria-label={layer === "users" ? "Simulated users by access point" : layer === "problems" ? "Where devices miss their minimum speed" : "People by access point"}>
      {layer === "density" && (() => {
        const peak = Math.max(1e-9, ...here.map((c) => c.people / (c.side * c.side)));
        return here.map((c, i) => (
          <rect key={i} x={c.x - c.side / 2} y={c.z - c.side / 2} width={c.side} height={c.side}
            fill={c.apId ? apColour(index.get(c.apId) ?? 0) : PROBLEM}
            opacity={c.apId ? 0.25 + 0.7 * Math.min(1, c.people / (c.side * c.side) / peak) : 0.7} />
        ));
      })()}
      {layer === "problems" && problems.map((b, i) => (
        <rect key={i} x={b.x - b.size / 2} y={b.z - b.size / 2} width={b.size} height={b.size} fill={PROBLEM} opacity={0.15 + 0.8 * Math.min(1, b.failPct / 100)}>
          <title>{`${b.failPct}% of active devices here missed their minimum`}</title>
        </rect>
      ))}
      {shapes.map((s, i) => (
        <polygon key={i} fill="none" stroke="#64748b" strokeWidth={unit / 400} points={pointsOf(s).map((p) => `${p.x},${p.z}`).join(" ")} />
      ))}
      {selected && links && floorAps.map((a) => {
        const link = links.find((x) => x.apId === a.id);
        if (!link) return null;
        const joined = joinedIds.has(a.id);
        return (
          <g key={`l-${a.id}`}>
            <line x1={selected.x} y1={selected.z} x2={a.x} y2={a.z} stroke={joined ? apColour(index.get(a.id)) : "#94a3b8"}
              strokeWidth={unit / (joined ? 250 : 500)} strokeDasharray={joined ? undefined : `${unit / 150} ${unit / 200}`} />
            <text x={(selected.x + a.x) / 2} y={(selected.z + a.z) / 2} fontSize={unit / 70} fill="#0f172a" textAnchor="middle"
              stroke="#f8fafc" strokeWidth={unit / 600} paintOrder="stroke">{`${link.distanceM} m`}</text>
          </g>
        );
      })}
      {layer === "users" && people.map((u) => {
        const isSel = u.id === selectedUserId;
        return (
          <circle key={u.id} cx={u.x} cy={u.z} r={unit / (isSel ? 90 : 160)} fill={userColour(u)}
            stroke={userFails(u) ? PROBLEM : isSel ? "#0f172a" : "#fff"} strokeWidth={unit / (userFails(u) || isSel ? 400 : 900)}
            style={onSelectUser ? { cursor: "pointer" } : undefined} onClick={onSelectUser ? () => onSelectUser(u.id) : undefined}>
            <title>{`${u.id} at ${u.x}, ${u.z} m`}</title>
          </circle>
        );
      })}
      {floorAps.map((a) => (
        <g key={a.id}>
          <circle cx={a.x} cy={a.z} r={unit / 80} fill="#fff" stroke={apColour(index.get(a.id))} strokeWidth={unit / 250} />
          <text x={a.x} y={a.z - unit / 60} textAnchor="middle" fontSize={unit / 50} fontWeight="700" fill="#0f172a">{a.name}</text>
        </g>
      ))}
    </svg>
  );
}
