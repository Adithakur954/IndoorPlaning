import React, { useId, useMemo, useRef, useState } from "react";
import { bbox, boundaryAreas, pointsOf } from "../../utils/geometry.js";

// Capacity heat maps from the engine's grid (one value per square, from the
// simulation). Drawn as a smooth surface: the grid is painted into a small
// image, one pixel per square, which the browser scales up with bilinear
// smoothing; the image is clipped to the building and the floor drawing
// (rooms, walls, room names, APs) is drawn over it.
//
// KPIs judged against a requirement (throughput, airtime, latency, retries,
// problem share) run red → orange → yellow → green, with the requirement
// marked on the legend. Signal magnitudes (RSSI, SNR, data rate) use one blue
// ramp, light = weak, dark = strong. Places with no usable AP are grey.

const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };
const RAMP = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
const NONE = "#c9c8c2";
const fmt = (v) => (v == null || !Number.isFinite(v) ? "-" : Number(v.toFixed(1)).toString());

const ramp = (values) => values.map((v, i) => ({ v, c: RAMP[i] }));

// key -> { label, long, unit, baseline, estimate, stops(limits), ticks(limits), note(limits) }
// per-user throughput: red below the minimum, green once the device gets its full demand
const perUser = (net) => ({
  label: net ? "Per user (with internet)" : "Per user (Wi-Fi)",
  long: net ? "Per-user throughput after the internet plan's share" : "Per-user throughput over Wi-Fi, after sharing the AP's airtime",
  unit: "Mbps",
  stops: ({ minMbps: m, demandMbps: d }) => {
    const full = Math.max(m, d || m);
    const low = [{ v: 0, c: STATUS.critical }, { v: m * 0.6, c: STATUS.critical }, { v: m * 0.95, c: STATUS.serious }];
    // the full demand is green; between the minimum and the demand, yellow
    return full > m ? [...low, { v: m, c: STATUS.warning }, { v: full, c: STATUS.good }] : [...low, { v: m, c: STATUS.good }];
  },
  ticks: ({ minMbps: m, demandMbps: d }) => {
    const full = Math.max(m, d || m);
    return full > m ? [{ v: 0, t: "0" }, { v: m, t: `${fmt(m)} min` }, { v: full, t: `${fmt(full)} demand` }] : [{ v: 0, t: "0" }, { v: m, t: `${fmt(m)} min = demand` }];
  },
  note: ({ minMbps: m }) =>
    net
      ? `What each active user gets once the internet plan is shared too. Red: below ${fmt(m)} Mbps.`
      : `Green: each active user gets its full demand. It drops (red) where the AP's airtime runs out. Red: below ${fmt(m)} Mbps.`,
});

// Capacity simulation: achievable throughput in fixed Mbps bands set from the minimum and the demand
// (with a 5 Mbps demand: red below the minimum, orange to 10, yellow to 25, green from 25 Mbps).
const bands = ({ minMbps: m, demandMbps: d }) => {
  const dd = Math.max(m, d || m);
  return { m, low: Math.max(m * 1.5, dd * 2), high: Math.max(m * 3, dd * 5) };
};

export const HEAT_KPIS = {
  // capacity simulation: what one active user standing there could achieve under that load, not capped
  throughput: {
    label: "Throughput",
    long: "Throughput: what a user standing there can achieve under this load (over Wi-Fi)",
    unit: "Mbps",
    stops: (l) => {
      const { m, low, high } = bands(l);
      return [{ v: 0, c: STATUS.critical }, { v: m * 0.999, c: STATUS.critical }, { v: m, c: STATUS.serious }, { v: low * 0.999, c: STATUS.serious },
        { v: low, c: STATUS.warning }, { v: high * 0.999, c: STATUS.warning }, { v: high, c: STATUS.good }, { v: high * 1.6, c: STATUS.good }];
    },
    ticks: (l) => {
      const { m, low, high } = bands(l);
      return [{ v: 0, t: "0" }, { v: m, t: `${fmt(m)} min` }, { v: low, t: fmt(low) }, { v: high, t: `${fmt(high)} Mbps` }];
    },
    note: (l) => {
      const { m, low, high } = bands(l);
      return `Its data rate at that spot × its fair share of the AP's airtime under this load. Green: ${fmt(high)}+ Mbps; yellow: ${fmt(low)}–${fmt(high)}; orange: ${fmt(m)}–${fmt(low)}; red: below the ${fmt(m)} Mbps minimum. The dots are the simulated users (what each actually gets); click one to see its AP.`;
    },
  },
  congestion: {
    label: "Congestion (airtime)",
    long: "Congestion: airtime the AP's channel needs, over what it can use",
    unit: "%",
    stops: ({ airWarnPct: w, airLimitPct: l }) => [{ v: 0, c: STATUS.good }, { v: w * 0.6, c: STATUS.good }, { v: w, c: STATUS.warning }, { v: l, c: STATUS.serious }, { v: Math.max(100, l * 1.5), c: STATUS.critical }],
    ticks: ({ airLimitPct: l }) => [{ v: 0, t: "0%" }, { v: l, t: `${fmt(l)}% limit` }, { v: 100, t: "100% full" }],
    note: ({ airLimitPct: l }) => `Orange from your ${fmt(l)}% planning limit; red: the channel needs more airtime than it has (its users lose speed).`,
  },
  assoc: {
    label: "AP association",
    long: "AP association: the AP a user standing there joins",
    unit: "",
    categorical: true,
    // one colour per AP: index i is drawn in colours[i]
    stops: ({ assocColours: cs = [] }) => (cs.length ? cs.flatMap((c, i) => [{ v: i - 0.5, c }, { v: i + 0.499, c }]) : [{ v: 0, c: NONE }]),
    ticks: () => [],
    note: () => "Each colour is one AP; a user standing there joins that AP. The dots are coloured by what they get.",
  },
  // load test: what a user standing there would get under that run's AP load (never more than it asks for)
  actual: {
    ...perUser(false),
    label: "Estimated throughput",
    long: "Estimated throughput: what a user standing there would get under this load (over Wi-Fi)",
    // fixed bands, not a ramp: 4.6 Mbps against a 5 Mbps minimum fails and must look like it
    stops: ({ minMbps: m, demandMbps: d }) => {
      const full = Math.max(m, d || m);
      const below = [{ v: 0, c: STATUS.critical }, { v: m * 0.999, c: STATUS.critical }];
      return full > m
        ? [...below, { v: m, c: STATUS.warning }, { v: full * 0.999, c: STATUS.warning }, { v: full, c: STATUS.good }]
        : [...below, { v: m, c: STATUS.good }];
    },
    note: ({ minMbps: m }) =>
      `A user standing there, with the APs as loaded as in the simulation. Green: gets its demand; yellow: below its demand; red: below ${fmt(m)} Mbps; grey: no usable AP. The dots are the simulated users and what they actually get; click one to see its AP.`,
  },
  delivered: perUser(false),
  deliveredNet: perUser(true),
  avail: {
    label: "Spare capacity",
    long: "Spare capacity: what one device could get if it wanted more (Wi-Fi)",
    unit: "Mbps",
    // one scale for every map compared (topMbps: the most any square gets in them),
    // so a drop in throughput shows as a change of colour
    stops: ({ minMbps: m, topMbps }) => {
      const top = Math.max(m * 4, topMbps || 0);
      return [{ v: 0, c: STATUS.critical }, { v: m, c: STATUS.critical }, { v: m * 2, c: STATUS.serious }, { v: Math.max(m * 3, top * 0.3), c: STATUS.warning }, { v: top * 0.75, c: STATUS.good }, { v: top, c: STATUS.good }];
    },
    ticks: ({ minMbps: m, topMbps }) => {
      const top = Math.max(m * 4, topMbps || 0);
      return [{ v: m, t: `${fmt(m)} min` }, { v: top * 0.3, t: fmt(top * 0.3) }, { v: top, t: fmt(top) }];
    },
    note: ({ minMbps: m }) => `Headroom, not the speed each user gets. Red: below ${fmt(m)} Mbps. The same scale for every map shown.`,
  },
  air: {
    label: "Airtime",
    long: "Airtime used on the serving channel",
    unit: "%",
    stops: ({ airWarnPct: w, airLimitPct: l }) => [{ v: 0, c: STATUS.good }, { v: w * 0.6, c: STATUS.good }, { v: w, c: STATUS.warning }, { v: l, c: STATUS.serious }, { v: Math.max(100, l * 1.5), c: STATUS.critical }],
    ticks: ({ airLimitPct: l }) => [{ v: 0, t: "0%" }, { v: l, t: `${fmt(l)}% limit` }, { v: Math.max(100, l * 1.5), t: `${fmt(Math.max(100, l * 1.5))}%` }],
    note: ({ airLimitPct: l }) => `Orange from the ${fmt(l)}% airtime limit; red: the channel is saturated.`,
  },
  rate: {
    label: "Data rate",
    long: "Data rate at the SNR (after MAC efficiency)",
    unit: "Mbps",
    stops: ({ maxRate }) => ramp([0, 0.25, 0.5, 0.75, 1].map((f) => f * maxRate)),
    ticks: ({ maxRate }) => [{ v: 0, t: "0" }, { v: maxRate, t: `${fmt(maxRate)} Mbps` }],
    note: () => "Darker: a faster link to the AP the device joins.",
  },
  fail: {
    label: "Problem areas",
    long: "Share of active devices missing their minimum (Wi-Fi)",
    unit: "%",
    empty: "blank",
    stops: () => [{ v: 0, c: STATUS.warning, a: 0 }, { v: 1, c: STATUS.warning, a: 0.85 }, { v: 5, c: STATUS.warning }, { v: 25, c: STATUS.serious }, { v: 60, c: STATUS.critical }],
    ticks: () => [{ v: 0, t: "none" }, { v: 25, t: "25%" }, { v: 60, t: "60%+" }],
    note: () => "Uncoloured: no Wi-Fi problem there (or nobody stood there in the sampled runs).",
  },
  latency: {
    label: "Latency (est.)",
    long: "Estimated access delay",
    unit: "ms",
    estimate: true,
    stops: ({ latencyWarnMs: w, latencyFailMs: f }) => [{ v: 0, c: STATUS.good }, { v: w / 2, c: STATUS.good }, { v: w, c: STATUS.warning }, { v: f, c: STATUS.serious }, { v: f * 1.5, c: STATUS.critical }],
    ticks: ({ latencyWarnMs: w, latencyFailMs: f }) => [{ v: 0, t: "0" }, { v: w, t: `${fmt(w)} ms` }, { v: f, t: `${fmt(f)} ms` }],
    note: ({ latencyWarnMs: w, latencyFailMs: f }) => `Estimate. Yellow from ${fmt(w)} ms (warning), orange to red from ${fmt(f)} ms.`,
  },
  retry: {
    label: "Retries (est.)",
    long: "Estimated retries (collisions)",
    unit: "%",
    estimate: true,
    stops: ({ retryWarnPct: w, retryFailPct: f }) => [{ v: 0, c: STATUS.good }, { v: w / 2, c: STATUS.good }, { v: w, c: STATUS.warning }, { v: f, c: STATUS.serious }, { v: f * 1.5, c: STATUS.critical }],
    ticks: ({ retryWarnPct: w, retryFailPct: f }) => [{ v: 0, t: "0%" }, { v: w, t: `${fmt(w)}%` }, { v: f, t: `${fmt(f)}%` }],
    note: ({ retryWarnPct: w, retryFailPct: f }) => `Estimate. Yellow from ${fmt(w)}% (warning), orange to red from ${fmt(f)}%.`,
  },
  rssi: {
    label: "Signal (RSSI)",
    long: "RSSI of the strongest AP (baseline)",
    unit: "dBm",
    baseline: true,
    stops: () => ramp([-85, -75, -67, -60, -50]),
    ticks: () => [{ v: -85, t: "-85" }, { v: -67, t: "-67 dBm" }, { v: -50, t: "-50" }],
    note: () => "Does not change with the number of users. Darker: stronger signal.",
  },
  snr: {
    label: "Signal (SNR)",
    long: "SNR of the strongest AP (baseline)",
    unit: "dB",
    baseline: true,
    stops: () => ramp([5, 15, 25, 32, 40]),
    ticks: () => [{ v: 5, t: "5" }, { v: 25, t: "25 dB" }, { v: 40, t: "40" }],
    note: () => "Does not change with the number of users. Darker: cleaner signal.",
  },
};

// ---------------------------------------------------------------- colour

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function colourAt(stops, v) {
  if (v <= stops[0].v) return [...rgb(stops[0].c), stops[0].a ?? 1];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (v <= b.v) {
      const t = b.v > a.v ? (v - a.v) / (b.v - a.v) : 1;
      const ca = rgb(a.c), cb = rgb(b.c);
      return [0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * t).concat((a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t);
    }
  }
  const last = stops[stops.length - 1];
  return [...rgb(last.c), last.a ?? 1];
}
const css = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

export function HeatLegend({ kpi, limits }) {
  const k = HEAT_KPIS[kpi];
  if (k.categorical) {
    return (
      <div style={{ margin: "6px 0", fontSize: 12 }} aria-label={`${k.long} legend`}>
        <div style={{ fontWeight: 600 }}>{k.long}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", margin: "4px 0" }}>
          {(limits.assocNames || []).map((n, i) => (
            <span key={n + i}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: limits.assocColours[i], verticalAlign: "middle" }} /> {n}</span>
          ))}
        </div>
        <div style={{ color: "#52514e" }}>{k.note(limits)}</div>
      </div>
    );
  }
  const stops = k.stops(limits);
  const lo = stops[0].v, hi = stops[stops.length - 1].v;
  const pos = (v) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 0);
  const gradient = `linear-gradient(to right, ${stops.map((s) => `${css([...rgb(s.c), s.a ?? 1])} ${pos(s.v)}%`).join(", ")})`;
  return (
    <div style={{ margin: "6px 0", fontSize: 12, maxWidth: 460 }} aria-label={`${k.long} legend`}>
      <div style={{ fontWeight: 600 }}>{k.long}{k.estimate ? " (estimate)" : ""}, {k.unit}</div>
      <div style={{ position: "relative", height: 26 }}>
        <div style={{ height: 10, borderRadius: 5, background: gradient, border: "1px solid rgba(11,11,11,0.10)" }} />
        {k.ticks(limits).map((t) => (
          <span key={t.t} style={{ position: "absolute", top: 12, left: `${pos(t.v)}%`, transform: `translateX(${pos(t.v) > 85 ? "-100%" : pos(t.v) < 10 ? "0" : "-50%"})`,
            color: "#52514e", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.t}</span>
        ))}
      </div>
      <div style={{ color: "#52514e" }}>
        {k.note(limits)}{" "}
        {k.empty !== "blank" && <><span style={{ display: "inline-block", width: 10, height: 10, background: NONE, borderRadius: 2, verticalAlign: "middle" }} /> no usable AP.</>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the surface

/** The grid as an image (one pixel per square), small holes filled from their neighbours. */
function surface(grid, vals, stops, blank) {
  if (typeof document === "undefined" || !grid.x.length) return null;
  const s = grid.size;
  const x0 = Math.min(...grid.x), z0 = Math.min(...grid.z);
  const cols = Math.round((Math.max(...grid.x) - x0) / s) + 1;
  const rows = Math.round((Math.max(...grid.z) - z0) / s) + 1;
  // NaN: no square here; null: no usable AP; a number: the value
  const cell = new Array(cols * rows).fill(NaN);
  grid.x.forEach((x, i) => {
    const v = vals[i];
    cell[Math.round((grid.z[i] - z0) / s) * cols + Math.round((x - x0) / s)] = v == null ? (blank ? 0 : null) : v;
  });
  // fill gaps up to two squares wide (walls, edges) so the clipped surface has no holes
  for (let pass = 0; pass < 2; pass++) {
    const next = cell.slice();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!Number.isNaN(cell[r * cols + c])) continue;
        let sum = 0, n = 0, none = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const v = cell[rr * cols + cc];
            if (v === null) none++;
            else if (!Number.isNaN(v)) { sum += v; n++; }
          }
        if (n) next[r * cols + c] = sum / n;
        else if (none) next[r * cols + c] = null;
      }
    for (let i = 0; i < cell.length; i++) cell[i] = next[i];
  }
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(cols, rows);
  const none = rgb(NONE);
  cell.forEach((v, i) => {
    if (Number.isNaN(v)) return;
    const [r, gg, b, a] = v === null ? [...none, 1] : colourAt(stops, v);
    img.data.set([r, gg, b, Math.round(a * 255)], i * 4);
  });
  g.putImageData(img, 0, 0);
  return { href: canvas.toDataURL(), x: x0 - s / 2, z: z0 - s / 2, w: cols * s, h: rows * s, x0, z0, cols, rows, cell };
}

/**
 * grid: the engine's heat-map floor ({ floorId, size, x[], z[], rssi[], snr[], bestAp[] })
 * values: one number (or null) per square; apIds: the AP serving each square (optional)
 */
// user dots (load test): what each simulated user gets
export const DOT_COLOURS = { ok: "#1f8a4c", "below demand": "#d98200", "below minimum": "#c0392b", "no signal": "#0b0b0b", idle: "#a8a6a0" };

export default function KpiHeatmap({ plan, floorId, grid, values, apIds = null, aps, kpi, limits, title = null, marks = [], dots = [], proposal = null, apsById = null, maxHeight = 420 }) {
  const clipId = useId().replace(/:/g, "");
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState(null); // a user dot clicked: its index among this floor's dots
  const k = HEAT_KPIS[kpi];
  const stops = k.stops(limits);
  const vals = values ?? [];
  const img = useMemo(() => (grid ? surface(grid, vals, stops, k.empty === "blank") : null), [grid, vals, kpi, JSON.stringify(stops)]); // eslint-disable-line react-hooks/exhaustive-deps
  // the square under the pointer, by its grid column and row
  const index = useMemo(() => {
    const m = new Map();
    if (grid) grid.x.forEach((x, i) => m.set(`${Math.floor(x / grid.size)},${Math.floor(grid.z[i] / grid.size)}`, i));
    return m;
  }, [grid]);
  if (!grid) return <p className="hint">No heat map for this floor.</p>;

  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const outlines = boundaryAreas(plan, floorId);
  const shapes = [...rooms, ...outlines];
  const walls = (plan.interiorWalls || []).filter((w) => w.floorId === floorId);
  const excluded = rooms.filter((r) => r.receiverGrid === "excluded");
  const half = grid.size / 2;
  const boxes = [...shapes.map(bbox), ...grid.x.map((x, i) => ({ minX: x - half, maxX: x + half, minZ: grid.z[i] - half, maxZ: grid.z[i] + half }))];
  if (!boxes.length) return <p className="hint">Nothing to draw on this floor.</p>;
  const minX = Math.min(...boxes.map((b) => b.minX)) - 1, maxX = Math.max(...boxes.map((b) => b.maxX)) + 1;
  const minZ = Math.min(...boxes.map((b) => b.minZ)) - 1, maxZ = Math.max(...boxes.map((b) => b.maxZ)) + 1;
  const w = maxX - minX, h = maxZ - minZ;
  const unit = Math.max(w, h);
  const floorAps = aps.filter((a) => a.floorId === floorId);
  const poly = (s) => pointsOf(s).map((p) => `${p.x},${p.z}`).join(" ");
  const floorDots = dots.filter((d) => d.floorId === floorId);
  const pick = picked != null ? floorDots[picked] : null;
  const pickAp = pick ? floorAps.find((a) => a.id === pick.apId) : null;

  const onMove = (e) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const i = index.get(`${Math.floor(p.x / grid.size)},${Math.floor(p.y / grid.size)}`);
    if (i == null) return setHover(null);
    const r = svg.getBoundingClientRect();
    setHover({ i, left: e.clientX - r.left, top: e.clientY - r.top });
  };
  const hv = hover ? vals[hover.i] : null;
  const hAp = hover ? apsById?.get(apIds?.[hover.i] ?? grid.bestAp?.[hover.i]) : null;

  return (
    <figure style={{ margin: 0, position: "relative" }}>
      {title && <figcaption style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</figcaption>}
      <svg ref={svgRef} viewBox={`${minX} ${minZ} ${w} ${h}`} style={{ width: "100%", maxHeight, background: "#fcfcfb", border: "1px solid rgba(11,11,11,0.10)", borderRadius: 8, display: "block" }}
        role="img" aria-label={`${k.long}${title ? `, ${title}` : ""}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id={clipId}>
            {shapes.length ? shapes.map((s, i) => <polygon key={i} points={poly(s)} />) : <rect x={minX} y={minZ} width={w} height={h} />}
          </clipPath>
        </defs>
        {/* the building's floor */}
        {shapes.map((s, i) => <polygon key={`f${i}`} points={poly(s)} fill="#f0efec" />)}
        {img ? (
          <image href={img.href} x={img.x} y={img.z} width={img.w} height={img.h} preserveAspectRatio="none" clipPath={`url(#${clipId})`} style={{ imageRendering: "auto" }} />
        ) : (
          // without a canvas (server rendering): one square per value
          <g clipPath={`url(#${clipId})`}>
            {grid.x.map((x, i) => {
              const v = vals[i];
              if (v == null && k.empty === "blank") return null;
              return <rect key={i} x={x - half} y={grid.z[i] - half} width={grid.size} height={grid.size} fill={v == null ? NONE : css(colourAt(stops, v))} />;
            })}
          </g>
        )}
        {excluded.map((r) => (
          <polygon key={`x-${r.id}`} points={poly(r)} fill="#fcfcfb" stroke="#898781" strokeWidth={unit / 700} strokeDasharray={`${unit / 200} ${unit / 300}`}>
            <title>{`${r.name || "Room"}: excluded (nobody there)`}</title>
          </polygon>
        ))}
        {/* the floor drawing over the colour */}
        {shapes.map((s, i) => <polygon key={`o${i}`} fill="none" stroke="#2c2c2a" strokeWidth={unit / 380} strokeLinejoin="round" points={poly(s)} />)}
        {walls.map((wl) => <line key={wl.id} x1={wl.x1} y1={wl.z1} x2={wl.x2} y2={wl.z2} stroke="#2c2c2a" strokeWidth={unit / 420} strokeLinecap="square" />)}
        {rooms.filter((r) => r.name).map((r) => {
          const b = bbox(r);
          const size = Math.min(unit / 34, (b.maxX - b.minX) / Math.max(4, r.name.length) * 1.6);
          if (size < unit / 90) return null;
          // never over an AP's label
          const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
          if (floorAps.some((a) => Math.abs(a.x - cx) < (r.name.length * size) / 2 + unit / 40 && Math.abs(a.z - cz) < unit / 18)) return null;
          return (
            <text key={`n-${r.id}`} x={(b.minX + b.maxX) / 2} y={(b.minZ + b.maxZ) / 2} textAnchor="middle" dominantBaseline="middle" fontSize={size}
              fill="#52514e" stroke="#fcfcfb" strokeWidth={size / 6} paintOrder="stroke" style={{ pointerEvents: "none" }}>{r.name}</text>
          );
        })}
        {marks.filter((m) => m.floorId === floorId).map((m, i) => (
          <circle key={`m${i}`} cx={m.x} cy={m.z} r={Math.max(grid.size * 0.9, unit / 80)} fill="none" stroke="#0b0b0b" strokeWidth={unit / 350}>
            <title>{m.label}</title>
          </circle>
        ))}
        {/* load test: the simulated users of one representative run, coloured by what they get */}
        {/* a clicked user: a line to the AP it is connected to */}
        {pick && pickAp && (
          <g style={{ pointerEvents: "none" }}>
            <line x1={pick.x} y1={pick.z} x2={pickAp.x} y2={pickAp.z} stroke="#0b0b0b" strokeWidth={unit / 400} strokeDasharray={`${unit / 120} ${unit / 220}`} />
            <circle cx={pickAp.x} cy={pickAp.z} r={unit / 40} fill="none" stroke="#2563eb" strokeWidth={unit / 250} />
          </g>
        )}
        {floorDots.map((d, i) => (
          <circle key={`u${i}`} cx={d.x} cy={d.z} r={(d.status === "idle" ? unit / 260 : unit / 170) * (i === picked ? 1.8 : 1)} fill={DOT_COLOURS[d.status] ?? "#898781"}
            stroke={i === picked ? "#0b0b0b" : "#fcfcfb"} strokeWidth={i === picked ? unit / 500 : unit / 1100} style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); setPicked(i === picked ? null : i); }}>
            <title>{d.label}</title>
          </circle>
        ))}
        {floorAps.map((a) => (
          <g key={a.id} style={{ pointerEvents: "none" }}>
            <circle cx={a.x} cy={a.z} r={unit / 70} fill="#fff" stroke="#0b0b0b" strokeWidth={unit / 300} />
            <circle cx={a.x} cy={a.z} r={unit / 220} fill="#0b0b0b" />
            <text x={a.x} y={a.z - unit / 38} textAnchor="middle" fontSize={unit / 30} fontWeight="700" fill="#0b0b0b" stroke="#fcfcfb" strokeWidth={unit / 250} paintOrder="stroke">{a.name}</text>
          </g>
        ))}
        {proposal && proposal.floorId === floorId && (
          <g style={{ pointerEvents: "none" }}>
            <rect x={proposal.x - unit / 90} y={proposal.z - unit / 90} width={unit / 45} height={unit / 45} fill="#fff" stroke="#6250d6" strokeWidth={unit / 250} transform={`rotate(45 ${proposal.x} ${proposal.z})`} />
            <text x={proposal.x} y={proposal.z + unit / 30} textAnchor="middle" fontSize={unit / 55} fontWeight="700" fill="#0b0b0b" stroke="#fcfcfb" strokeWidth={unit / 450} paintOrder="stroke">Proposed AP</text>
          </g>
        )}
      </svg>
      {pick && (
        <div style={{ marginTop: 6, padding: "6px 10px", border: "1px solid rgba(11,11,11,0.12)", borderRadius: 6, background: "#fff", fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ color: DOT_COLOURS[pick.status] ?? "#0b0b0b" }}>User: {pick.status}</strong>
            <button type="button" onClick={() => setPicked(null)} aria-label="Close"
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
          </div>
          {(pick.details || []).map((line, j) => <div key={j}>{line}</div>)}
        </div>
      )}
      {hover && (
        <div style={{ position: "absolute", left: Math.min(hover.left + 12, 9999), top: hover.top + (title ? 30 : 12), background: "#fff", border: "1px solid rgba(11,11,11,0.10)", borderRadius: 6,
          padding: "4px 8px", fontSize: 12, pointerEvents: "none", boxShadow: "0 2px 6px rgba(0,0,0,0.08)", whiteSpace: "nowrap", zIndex: 2 }}>
          <div style={{ fontWeight: 600 }}>
            {hv == null ? (k.empty === "blank" ? "No device there" : "No usable AP") : k.categorical ? `Joins ${limits.assocNames?.[hv] ?? "-"}` : `${fmt(hv)} ${k.unit}`}
          </div>
          <div style={{ color: "#52514e" }}>{fmt(grid.x[hover.i])}, {fmt(grid.z[hover.i])} m{hAp ? ` · ${hAp.name}` : ""}</div>
        </div>
      )}
    </figure>
  );
}
