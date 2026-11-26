// Browser only: draws one floor as a PNG for the report: rooms, the heatmap,
// walls, the access points and a legend of the dBm bands.
import { bbox, boundaryAreas, pointsOf } from "./geometry.js";
import { buildWalls } from "./wallGraph.js";
import { heatmapCanvas } from "./heatmapImage.js";
import { materialColors, materialLabels } from "../config/materialColors.js";

const PX_PER_M = 40;
const MARGIN_M = 1;
const LEGEND_PX = 56;

const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "");
export const bandLabel = (r) =>
  !Number.isFinite(r.min)
    ? `< ${fmt(r.max)}`
    : !Number.isFinite(r.max)
      ? `≥ ${fmt(r.min)}`
      : `${fmt(r.min)} to ${fmt(r.max)}`;

// aps: [{ name, x, z, color? }]; cells: heatmap cells or [].
export async function renderFloorImage({
  plan,
  floorId,
  cells = [],
  ranges = [],
  aps = [],
  title = "",
  flat = false, // draw each cell as a flat square coloured by cell.fill
  legend = null, // [{ color, label }] replaces the dBm legend
  legendTitle = "Signal (dBm):",
  marks = [], // [{ x, z, r, color }] circles, e.g. weak zones
  dimensions = false, // draw the overall width and depth and the length of each partition wall
}) {
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const areas = [...rooms, ...boundaryAreas(plan, floorId)];
  const walls = buildWalls(plan, floorId);
  const points = [
    ...areas.flatMap((a) => pointsOf(a)),
    ...aps.map((a) => ({ x: a.x, z: a.z })),
  ];
  if (!points.length) return null;
  const minX = Math.min(...points.map((p) => p.x)) - MARGIN_M,
    maxX = Math.max(...points.map((p) => p.x)) + MARGIN_M,
    minZ = Math.min(...points.map((p) => p.z)) - MARGIN_M,
    maxZ = Math.max(...points.map((p) => p.z)) + MARGIN_M;
  const scale = Math.min(PX_PER_M, 1800 / Math.max(maxX - minX, maxZ - minZ));
  const width = Math.round((maxX - minX) * scale),
    plotHeight = Math.round((maxZ - minZ) * scale),
    titleHeight = title ? 36 : 0,
    usedMaterials = [
      ...new Set([
        ...walls.map((w) => w.material || "drywall"),
        ...(plan.interiorWalls || [])
          .filter((w) => w.floorId === floorId)
          .map((w) => w.material || "drywall"),
      ]),
    ].filter((m) => materialLabels[m]),
    legendCount = legend ? legend.length : ranges.length,
    legendPx = LEGEND_PX + (legendCount > 6 ? 26 * Math.ceil((legendCount - 6) / 6) : 0),
    materialRowPx = usedMaterials.length ? 28 : 0,
    height = titleHeight + plotHeight + legendPx + materialRowPx;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const X = (x) => (x - minX) * scale,
    Z = (z) => titleHeight + (z - minZ) * scale;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (title) {
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 20px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(title, 10, titleHeight / 2);
  }

  // room fill
  ctx.fillStyle = "#eef5f2";
  for (const area of areas) {
    ctx.beginPath();
    pointsOf(area).forEach((p, i) =>
      i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z)),
    );
    ctx.closePath();
    ctx.fill();
  }
  // heatmap
  if (flat && cells.length) {
    ctx.save();
    ctx.beginPath();
    for (const area of areas) {
      // same direction for every outline, so a room inside another is not cut out as a hole (nonzero rule)
      let pts = pointsOf(area);
      const twice = pts.reduce((t, p, i) => t + p.x * pts[(i + 1) % pts.length].z - pts[(i + 1) % pts.length].x * p.z, 0);
      if (twice < 0) pts = [...pts].reverse();
      pts.forEach((p, i) =>
        i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z)),
      );
      ctx.closePath();
    }
    ctx.clip();
    ctx.globalAlpha = 0.85;
    for (const c of cells) {
      ctx.fillStyle = c.fill;
      ctx.fillRect(
        X(c.x - c.step / 2),
        Z(c.z - c.step / 2),
        c.step * scale + 0.5,
        c.step * scale + 0.5,
      );
    }
    ctx.restore();
  }
  const heat = !flat && cells.length && ranges.length
    ? heatmapCanvas(cells, areas, ranges, scale)
    : null;
  if (heat) {
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      heat.canvas,
      X(heat.x),
      Z(heat.z),
      heat.widthM * scale,
      heat.heightM * scale,
    );
    ctx.globalAlpha = 1;
  }
  // walls: a dark outline with the core in the wall's material colour, as in the editor
  const core = Math.max(3, (plan.wallThickness || 0.15) * scale);
  const stroke = (a, b, outline, width, colour) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.z);
    ctx.lineTo(b.x, b.z);
    ctx.lineWidth = width;
    ctx.strokeStyle = outline ? outline : colour;
    ctx.stroke();
  };
  ctx.lineCap = "square";
  for (const w of walls) {
    const a = { x: X(w.a.x), z: Z(w.a.z) },
      b = { x: X(w.b.x), z: Z(w.b.z) },
      boundary = w.owners?.some((o) => o.type === "boundary");
    stroke(a, b, boundary ? "#1f3f3a" : "#435b60", core * (boundary ? 1.9 : 1.35));
    stroke(a, b, null, core, materialColors[w.material] || materialColors.drywall);
  }
  // interior (partition) walls: stored apart from room edges, but the ray tracer uses them
  const interior = (plan.interiorWalls || []).filter((w) => w.floorId === floorId);
  for (const w of interior) {
    if (![w.x1, w.z1, w.x2, w.z2].every((v) => Number.isFinite(+v))) continue;
    const a = { x: X(+w.x1), z: Z(+w.z1) },
      b = { x: X(+w.x2), z: Z(+w.z2) };
    stroke(a, b, "#435b60", core * 1.35);
    stroke(a, b, null, core, materialColors[w.material] || materialColors.drywall);
  }
  ctx.lineCap = "round";
  // columns and other obstructions (furniture boxes)
  const boxes = (plan.furniture || []).filter((f) => f.floorId === floorId && Number.isFinite(+f.x) && Number.isFinite(+f.z));
  for (const f of boxes) {
    const w = Math.max(+f.width || 0, 0.2) * scale,
      d = Math.max(+f.depth || 0, 0.2) * scale;
    ctx.fillStyle = f.kind === "column" ? "#a9855c" : "#c9b79c";
    ctx.strokeStyle = "#5b4630";
    ctx.lineWidth = 1;
    ctx.fillRect(X(+f.x), Z(+f.z), w, d);
    ctx.strokeRect(X(+f.x), Z(+f.z), w, d);
  }
  // room names
  ctx.fillStyle = "#1f3f3a";
  ctx.font = "600 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const room of rooms) {
    const b = bbox(room);
    if (!room.name || !b) continue;
    ctx.fillText(
      room.name,
      X((b.minX + b.maxX) / 2),
      Z((b.minZ + b.maxZ) / 2),
      Math.max(20, (b.maxX - b.minX) * scale - 6),
    );
  }
  // measurements: overall width / depth in the margin, partition wall lengths on the walls
  if (dimensions) {
    const outline = areas.flatMap((a) => pointsOf(a));
    const x0 = Math.min(...outline.map((p) => p.x)),
      x1 = Math.max(...outline.map((p) => p.x)),
      z0 = Math.min(...outline.map((p) => p.z)),
      z1 = Math.max(...outline.map((p) => p.z));
    const tag = (text, x, y, rot = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.font = "600 13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(-w / 2, -9, w, 18);
      ctx.fillStyle = "#b45309";
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    const arrow = (ax, ay, bx, by) => {
      ctx.strokeStyle = "#b45309";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const ang = Math.atan2(by - ay, bx - ax);
      for (const [px, py, dir] of [[ax, ay, 1], [bx, by, -1]]) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + dir * 9 * Math.cos(ang - 0.4), py + dir * 9 * Math.sin(ang - 0.4));
        ctx.moveTo(px, py);
        ctx.lineTo(px + dir * 9 * Math.cos(ang + 0.4), py + dir * 9 * Math.sin(ang + 0.4));
        ctx.stroke();
      }
    };
    const top = Z(z0) - 16,
      left = X(x0) - 16;
    arrow(X(x0), top, X(x1), top);
    tag(`${(x1 - x0).toFixed(1)} m`, (X(x0) + X(x1)) / 2, top);
    arrow(left, Z(z0), left, Z(z1));
    tag(`${(z1 - z0).toFixed(1)} m`, left, (Z(z0) + Z(z1)) / 2, -Math.PI / 2);
    for (const w of interior) {
      const len = Math.hypot(+w.x2 - +w.x1, +w.z2 - +w.z1);
      if (!(len >= 1)) continue;
      tag(`${len.toFixed(1)} m`, X((+w.x1 + +w.x2) / 2), Z((+w.z1 + +w.z2) / 2) - 12);
    }
    for (const room of rooms) {
      const b = bbox(room);
      if (!b || !room.name) continue;
      tag(`${(b.maxX - b.minX).toFixed(1)} × ${(b.maxZ - b.minZ).toFixed(1)} m`, X((b.minX + b.maxX) / 2), Z((b.minZ + b.maxZ) / 2) + 14);
    }
  }
  // marked zones
  for (const m of marks) {
    ctx.beginPath();
    ctx.arc(X(m.x), Z(m.z), Math.max(10, m.r * scale), 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = m.color || "#dc2626";
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.font = "700 13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.strokeText(m.label, X(m.x), Z(m.z));
      ctx.fillStyle = m.color || "#dc2626";
      ctx.fillText(m.label, X(m.x), Z(m.z));
    }
  }
  // access points
  for (const ap of aps) {
    const cx = X(ap.x),
      cy = Z(ap.z);
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = ap.color || "#111827";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.font = "700 12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeText(ap.name, cx + 12, cy);
    ctx.fillStyle = "#111827";
    ctx.fillText(ap.name, cx + 12, cy);
  }
  // legend
  const legendItems = legend || (ranges.length ? ranges.map((r) => ({ color: r.color, label: bandLabel(r) })) : []);
  if (legendItems.length) {
    let y = titleHeight + plotHeight + 14;
    let x = 10;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#35504a";
    ctx.fillText(legendTitle, x, y + 8);
    x += ctx.measureText(legendTitle).width + 12;
    for (const r of legendItems) {
      const label = r.label;
      if (x + 22 + ctx.measureText(label).width > width - 10) {
        x = 10;
        y += 26;
      }
      ctx.fillStyle = r.color || "#808080";
      ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = "#35504a";
      ctx.fillText(label, x + 22, y + 8);
      x += 22 + ctx.measureText(label).width + 16;
    }
  }
  if (usedMaterials.length) {
    let x = 10;
    const y = height - materialRowPx + 6;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#35504a";
    ctx.fillText("Walls:", x, y + 8);
    x += ctx.measureText("Walls:").width + 12;
    for (const m of usedMaterials) {
      ctx.fillStyle = materialColors[m];
      ctx.fillRect(x, y, 16, 16);
      ctx.strokeStyle = "#435b60";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, 16, 16);
      ctx.fillStyle = "#35504a";
      ctx.fillText(materialLabels[m], x + 22, y + 8);
      x += 22 + ctx.measureText(materialLabels[m]).width + 16;
    }
  }
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("Could not draw a report image."))),
      "image/png",
    ),
  );
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
  };
}

const CDF_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#ea580c", "#7c3aed",
  "#0891b2", "#be185d", "#a16207", "#475569", "#65a30d",
];

// Browser only: cumulative distribution curves. series: [{ label, values (dBm) }].
export async function renderCdfChart({ series, thresholdDbm, thresholds, title = "" }) {
  const lines = (thresholds && thresholds.length ? thresholds : [thresholdDbm]).filter(Number.isFinite);
  const lists = series
    .map((s) => ({ ...s, sorted: s.values.filter(Number.isFinite).sort((a, b) => a - b) }))
    .filter((s) => s.sorted.length);
  if (!lists.length) return null;
  const xMin = -120;
  const xMax = Math.max(
    -20,
    Math.ceil((Math.max(...lists.map((s) => s.sorted[s.sorted.length - 1])) + 5) / 10) * 10,
  );
  const rows = lists.length;
  const W = 1400,
    H = 720 + rows * 30,
    L = 90,
    R = 40,
    T = title ? 70 : 30,
    B = 90 + rows * 30,
    pw = W - L - R,
    ph = H - T - B;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const X = (v) => L + ((Math.min(Math.max(v, xMin), xMax) - xMin) / (xMax - xMin)) * pw,
    Y = (p) => T + ph - p * ph;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (title) {
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, L, 34);
  }
  ctx.font = "18px sans-serif";
  ctx.strokeStyle = "#e3ece8";
  ctx.fillStyle = "#35504a";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let p = 0; p <= 1.0001; p += 0.2) {
    ctx.beginPath();
    ctx.moveTo(L, Y(p));
    ctx.lineTo(L + pw, Y(p));
    ctx.stroke();
    ctx.fillText(`${Math.round(p * 100)}%`, L - 10, Y(p));
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let v = xMin; v <= xMax; v += 10) {
    ctx.beginPath();
    ctx.moveTo(X(v), T);
    ctx.lineTo(X(v), T + ph);
    ctx.stroke();
    ctx.fillText(String(v), X(v), T + ph + 8);
  }
  ctx.strokeStyle = "#35504a";
  ctx.lineWidth = 2;
  ctx.strokeRect(L, T, pw, ph);
  ctx.fillText("Predicted signal (dBm)", L + pw / 2, T + ph + 40);
  ctx.save();
  ctx.translate(26, T + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillText("Share of area at or below the level", 0, 0);
  ctx.restore();
  lines.forEach((line, li) => {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(line), T);
    ctx.lineTo(X(line), T + ph);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#111827";
    ctx.font = "600 18px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${line} dBm`, X(line) + 8, T + 8 + li * 24);
  });
  lists.forEach((s, i) => {
    const n = s.sorted.length;
    ctx.strokeStyle = CDF_COLORS[i % CDF_COLORS.length];
    ctx.lineWidth = 3;
    ctx.beginPath();
    const every = Math.max(1, Math.floor(n / 600));
    ctx.moveTo(X(xMin), Y(0));
    for (let j = 0; j < n; j += every) ctx.lineTo(X(s.sorted[j]), Y((j + 1) / n));
    ctx.lineTo(X(s.sorted[n - 1]), Y(1));
    ctx.lineTo(X(xMax), Y(1));
    ctx.stroke();
  });
  ctx.font = "18px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lists.forEach((s, i) => {
    const y = T + ph + 80 + i * 30;
    ctx.fillStyle = CDF_COLORS[i % CDF_COLORS.length];
    ctx.fillRect(L, y - 5, 34, 10);
    ctx.fillStyle = "#35504a";
    ctx.fillText(s.label, L + 46, y);
  });
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error("Could not draw the CDF chart."))), "image/png"),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
}

// Browser only: coverage (%) as access points are added. points: [{ label, pct }].
// X labels are drawn tilted so long names such as "AP1+AP2+AP3" never overlap.
export async function renderCoverageBuildChart({ points, title = "", thresholdDbm, targetPct }) {
  if (!points?.length) return null;
  const longest = Math.max(...points.map((p) => String(p.label).length));
  const labelPx = Math.min(420, 40 + longest * 11); // room for tilted labels
  const W = 1400,
    H = 620 + labelPx,
    L = 100,
    R = 50,
    T = title ? 80 : 40,
    B = labelPx + 70,
    pw = W - L - R,
    ph = H - T - B;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const n = points.length;
  const X = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw * 0.96 + pw * 0.02),
    Y = (p) => T + ph - (Math.min(Math.max(p, 0), 100) / 100) * ph;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (title) {
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, L, 38);
  }
  ctx.font = "18px sans-serif";
  ctx.strokeStyle = "#e3ece8";
  ctx.fillStyle = "#35504a";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let p = 0; p <= 100; p += 10) {
    ctx.beginPath();
    ctx.moveTo(L, Y(p));
    ctx.lineTo(L + pw, Y(p));
    ctx.stroke();
    ctx.fillText(`${p}%`, L - 10, Y(p));
  }
  ctx.strokeStyle = "#35504a";
  ctx.lineWidth = 2;
  ctx.strokeRect(L, T, pw, ph);
  ctx.save();
  ctx.translate(30, T + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(`Area covered${Number.isFinite(thresholdDbm) ? ` at ≥ ${thresholdDbm} dBm` : ""} (%)`, 0, 0);
  ctx.restore();
  if (Number.isFinite(targetPct)) {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "#dc2626";
    ctx.beginPath();
    ctx.moveTo(L, Y(targetPct));
    ctx.lineTo(L + pw, Y(targetPct));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#dc2626";
    ctx.textAlign = "left";
    ctx.fillText(`target ${targetPct}%`, L + 10, Y(targetPct) - 12);
  }
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 4;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.pct)) : ctx.moveTo(X(i), Y(p.pct))));
  ctx.stroke();
  points.forEach((p, i) => {
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    ctx.arc(X(i), Y(p.pct), 7, 0, Math.PI * 2);
    ctx.fill();
    // value above the point; alternate nothing fancy, small font avoids clashes
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 17px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${p.pct.toFixed(1)}%`, X(i), Y(p.pct) - 12);
    // tilted x label
    ctx.save();
    ctx.translate(X(i) + 6, T + ph + 14);
    ctx.rotate(-Math.PI / 3);
    ctx.font = "17px sans-serif";
    ctx.fillStyle = "#35504a";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(p.label), 0, 0);
    ctx.restore();
  });
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error("Could not draw the coverage chart."))), "image/png"),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
}


// Coverage as access points are switched on, one line per band:
// x = number of Wi-Fi APs on, y = share of the target area at or above the threshold.
// series: [{ label, color, points: [{ pct }] }] (same number of points in each).
export async function renderCoverageCompareChart({ series, title = "", thresholdDbm }) {
  const n = Math.max(0, ...series.map((s) => s.points.length));
  if (!n) return null;
  const W = 1400,
    H = 760,
    L = 100,
    R = 50,
    T = title ? 120 : 80,
    B = 110,
    pw = W - L - R,
    ph = H - T - B;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const X = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw * 0.96 + pw * 0.02),
    Y = (p) => T + ph - (Math.min(Math.max(p, 0), 100) / 100) * ph;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (title) {
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, L, 38);
  }
  // legend
  ctx.font = "20px sans-serif";
  ctx.textBaseline = "middle";
  let lx = L;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 70, 34, 6);
    ctx.fillStyle = "#35504a";
    ctx.textAlign = "left";
    ctx.fillText(s.label, lx + 44, 73);
    lx += 44 + ctx.measureText(s.label).width + 40;
  }
  ctx.font = "18px sans-serif";
  ctx.strokeStyle = "#e3ece8";
  ctx.fillStyle = "#35504a";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  for (let p = 0; p <= 100; p += 10) {
    ctx.beginPath();
    ctx.moveTo(L, Y(p));
    ctx.lineTo(L + pw, Y(p));
    ctx.stroke();
    ctx.fillText(`${p}%`, L - 10, Y(p));
  }
  ctx.strokeStyle = "#35504a";
  ctx.lineWidth = 2;
  ctx.strokeRect(L, T, pw, ph);
  ctx.save();
  ctx.translate(30, T + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(`Area covered${Number.isFinite(thresholdDbm) ? ` at ≥ ${thresholdDbm} dBm` : ""} (%)`, 0, 0);
  ctx.restore();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < n; i += 1) ctx.fillText(String(i + 1), X(i), T + ph + 12);
  ctx.fillText("Wi-Fi access points switched on", L + pw / 2, T + ph + 52);
  const labelAll = n <= 14;
  series.forEach((s, k) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.pct)) : ctx.moveTo(X(i), Y(p.pct))));
    ctx.stroke();
    s.points.forEach((p, i) => {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(X(i), Y(p.pct), 7, 0, Math.PI * 2);
      ctx.fill();
      if (labelAll || i === 0 || i === s.points.length - 1) {
        // the first line's values go above its points, the second line's below
        ctx.font = "600 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = k % 2 ? "top" : "bottom";
        ctx.fillText(`${p.pct.toFixed(1)}%`, X(i), Y(p.pct) + (k % 2 ? 12 : -12));
      }
    });
  });
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error("Could not draw the coverage chart."))), "image/png"),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
}
