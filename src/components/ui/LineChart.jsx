import React, { useRef, useState } from "react";

// A small line chart: one y axis, 2px lines with point markers, recessive grid,
// dashed reference lines (limits) and vertical markers (e.g. the breaking point).
// Hovering shows a crosshair and every series' value at the nearest x.
//
// series: [{ id, name, colour, points: [{ x, y }] }]   (y null = no value)
// refs:   [{ y, label }]      marks: [{ x, label }]

const W = 560, H = 230, M = { l: 44, r: 92, t: 12, b: 34 };
const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#898781", GRID = "#e1e0d9", AXIS = "#c3c2b7";

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? 10 * mag;
  // from a tick at or below lo to a tick at or above hi, so every value is inside
  const ticks = [];
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step) * step; v <= end + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
const fmt = (v) => (v == null || !Number.isFinite(v) ? "-" : Number(v.toFixed(1)).toLocaleString());

export default function LineChart({ title, series, refs = [], marks = [], xLabel = "Users", unit = "", yMin = 0, yMax = null }) {
  const svg = useRef(null);
  const [hover, setHover] = useState(null);
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const top = yMax ?? Math.max(...ys, ...refs.map((r) => r.y)) * 1.05;
  const yTicks = niceTicks(Math.min(yMin, ...ys), top);
  const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
  const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
  const px = (x) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
  const py = (y) => H - M.b - ((y - y0) / (y1 - y0)) * (H - M.t - M.b);
  const xTicks = niceTicks(x0, x1, 6).filter((t) => t >= x0 && t <= x1);

  const onMove = (e) => {
    const r = svg.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = xs[0];
    for (const v of xs) if (Math.abs(px(v) - x) < Math.abs(px(best) - x)) best = v;
    setHover(best);
  };
  const legend = series.length >= 2;
  const lastOf = (s) => [...s.points].reverse().find((p) => Number.isFinite(p.y));

  return (
    <figure style={{ margin: "8px 0", minWidth: 0 }}>
      <figcaption style={{ fontSize: 13, fontWeight: 600, color: INK }}>{title}</figcaption>
      {legend && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: INK2, margin: "2px 0" }}>
          {series.map((s) => (
            <span key={s.id}><span style={{ display: "inline-block", width: 14, height: 2, background: s.colour, verticalAlign: "middle", marginRight: 4 }} />{s.name}</span>
          ))}
        </div>
      )}
      <div style={{ position: "relative" }}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", background: "#fcfcfb", borderRadius: 8 }}
          role="img" aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={py(t)} y2={py(t)} stroke={t === y0 ? AXIS : GRID} strokeWidth={1} />
              <text x={M.l - 6} y={py(t) + 4} textAnchor="end" fontSize={11} fill={MUTED} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={px(t)} y={H - M.b + 16} textAnchor="middle" fontSize={11} fill={MUTED} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t)}</text>
          ))}
          <text x={(M.l + W - M.r) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill={MUTED}>{xLabel}</text>
          {unit && <text x={4} y={M.t + 2} fontSize={11} fill={MUTED} dominantBaseline="hanging">{unit}</text>}
          {refs.filter((r) => Number.isFinite(r.y) && r.y >= y0 && r.y <= y1).map((r) => (
            <g key={r.label}>
              <line x1={M.l} x2={W - M.r} y1={py(r.y)} y2={py(r.y)} stroke={INK2} strokeDasharray="4 4" strokeWidth={1} />
              <text x={W - M.r + 4} y={py(r.y) + 4} fontSize={11} fill={INK2}>{r.label}</text>
            </g>
          ))}
          {marks.filter((m) => Number.isFinite(m.x) && m.x >= x0 && m.x <= x1).map((m, i) => (
            <g key={m.label}>
              <line x1={px(m.x)} x2={px(m.x)} y1={M.t} y2={H - M.b} stroke={INK} strokeWidth={1} strokeDasharray={i ? "2 3" : undefined} />
              <text x={px(m.x) + 3} y={M.t + 10 + i * 13} fontSize={11} fill={INK}>{m.label}</text>
            </g>
          ))}
          {series.map((s) => {
            const pts = s.points.filter((p) => Number.isFinite(p.y));
            return (
              <g key={s.id}>
                <polyline fill="none" stroke={s.colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={pts.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")} />
                {pts.length <= 40 && pts.map((p) => <circle key={p.x} cx={px(p.x)} cy={py(p.y)} r={3} fill={s.colour} stroke="#fcfcfb" strokeWidth={1.5} />)}
              </g>
            );
          })}
          {series.length <= 4 && series.map((s) => {
            const p = lastOf(s);
            return p ? <text key={`l-${s.id}`} x={px(p.x) + 6} y={py(p.y) + 4} fontSize={11} fill={INK2}>{s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name}</text> : null;
          })}
          {hover != null && <line x1={px(hover)} x2={px(hover)} y1={M.t} y2={H - M.b} stroke={MUTED} strokeWidth={1} />}
          <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" />
        </svg>
        {hover != null && (
          <div style={{ position: "absolute", top: 8, left: `${Math.min(70, (px(hover) / W) * 100 + 2)}%`, background: "#fff", border: "1px solid rgba(11,11,11,0.10)", borderRadius: 6,
            padding: "4px 8px", fontSize: 12, color: INK, pointerEvents: "none", boxShadow: "0 2px 6px rgba(0,0,0,0.08)", whiteSpace: "nowrap" }}>
            <div style={{ fontWeight: 600 }}>{fmt(hover)} {xLabel.toLowerCase()}</div>
            {series.map((s) => {
              const p = s.points.find((q) => q.x === hover);
              return (
                <div key={s.id}><span style={{ display: "inline-block", width: 8, height: 8, background: s.colour, marginRight: 4, borderRadius: 4 }} />{s.name}: {fmt(p?.y)}{unit ? ` ${unit}` : ""}</div>
              );
            })}
          </div>
        )}
      </div>
    </figure>
  );
}
