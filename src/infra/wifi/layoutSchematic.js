// Wi-Fi layout schematic: the cabling drawn the way it lies on the floor, without
// the walls. The rack is a box where it stands, one main line runs away from it,
// branches split off where the cables separate, and every AP sits where it really
// is. Lengths are written on the route sections; at each AP are its own cable
// length and the PoE loss in that cable (and the signal loss, when the cable's
// datasheet value is known).
//
// Labels never overlap. Every text is measured and placed only where it touches
// no other text, no cable, no symbol. Each AP tries a full label, then a shorter
// one, then just its name, then its name with a leader line; if the drawing is
// still too crowded it gets more room (a larger drawing) before any label is
// degraded. A table under every drawing lists the complete details of every AP,
// so nothing is lost when a label is shortened.
//
// Everything is drawn from the design: change the plan and the drawing changes.
// Returns { svg, width, height, nodes, labels, shapes }.
import { buildPathwayTree } from "./pathwayTree.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const COLOUR = { ok: "#1f8a4c", "near limit": "#d98200", PoE: "#c0392b", "too long": "#c0392b" };
const SEVERITY = { ok: 0, "near limit": 1, PoE: 2, "too long": 2 };
const MARGIN_X = 260; // room for the AP labels at both ends
const MARGIN_TOP = 120;
const MARGIN_BOTTOM = 70;
const MAX_SCALE = 60; // pixels per metre
const HEADER_H = 84; // title lines at the top of a panel
const ROWS_PER_COLUMN = 18;
const ROW_H = 17;
const FONT = { name: 13, line: 10.5, branch: 11, small: 11 };

// More room is tried before any label is shortened: [panel width, drawing height].
const ROOM = [[1400, 640], [1400, 1000], [2000, 900], [2000, 1400], [2800, 1300], [3600, 1800]];

const worst = (checks) => checks.reduce((w, c) => ((SEVERITY[c] ?? 0) > (SEVERITY[w] ?? 0) ? c : w), "ok");
const checksBelow = (n) => (n.run ? [n.run.check] : n.children.flatMap((c) => checksBelow(c.node)));
const f1 = (n) => Math.round(n * 10) / 10;
const anyEstimated = (n) => (n.run ? n.run.pathwayStatus === "estimated" : n.children.some((c) => anyEstimated(c.node)));

// Text size estimate (Arial): good enough to keep texts apart.
const textWidth = (text, size, bold = false) => text.length * size * (bold ? 0.6 : 0.54);
const touches = (a, b, pad = 1.5) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

// The text lines of an AP label, longest form first.
function labelLevels(run) {
  const type = run.cablePartId === "cat6a" ? "Cat6A" : run.cablePartId === "cat6" ? "Cat6" : run.cableName;
  const colour = COLOUR[run.check] || COLOUR.ok;
  const full = [
    { text: run.apName, size: FONT.name, bold: true, fill: "#7f1d1d" },
    { text: `cable ${run.permanentLinkM} m · ${run.portPowerW} W · ${type}`, size: FONT.line, bold: true, fill: colour },
  ];
  if (run.pdVoltageV != null)
    full.push({ text: `PoE: ${run.pdVoltageV} V at the AP · ${run.poeCableLossW} W lost`, size: FONT.line, fill: "#334155" });
  if (run.insertionLossDb != null)
    full.push({ text: `signal loss ${run.insertionLossDb} dB @100 MHz`, size: FONT.line, fill: "#334155" });
  const compact = [
    { text: run.apName, size: FONT.name, bold: true, fill: "#7f1d1d" },
    { text: `${run.permanentLinkM} m${run.pdVoltageV != null ? ` · ${run.pdVoltageV} V · ${run.poeCableLossW} W lost` : ""}`, size: FONT.line, bold: true, fill: colour },
  ];
  const tag = [{ text: run.apName, size: FONT.name, bold: true, fill: "#7f1d1d" }];
  return [
    { level: "full", lines: full },
    { level: "compact", lines: compact },
    { level: "tag", lines: tag },
  ];
}

const boxOf = (lines) => ({
  w: Math.max(...lines.map((l) => textWidth(l.text, l.size, l.bold))),
  h: lines.reduce((s, l) => s + l.size + 3, 0),
});

// Candidate boxes around a point, the side opposite the incoming cable first.
function aroundPoint(p, w, h, prev, gap) {
  const right = { x0: p.x + gap, y0: p.y - h / 2, anchor: "start" };
  const left = { x0: p.x - gap - w, y0: p.y - h / 2, anchor: "end" };
  const above = { x0: p.x - w / 2, y0: p.y - gap - h, anchor: "middle" };
  const below = { x0: p.x - w / 2, y0: p.y + gap, anchor: "middle" };
  const corners = [
    { x0: p.x + gap - 4, y0: p.y - gap - h + 4, anchor: "start" },
    { x0: p.x - gap + 4 - w, y0: p.y - gap - h + 4, anchor: "end" },
    { x0: p.x + gap - 4, y0: p.y + gap - 4, anchor: "start" },
    { x0: p.x - gap + 4 - w, y0: p.y + gap - 4, anchor: "end" },
  ];
  let order;
  if (!prev) order = [above, below, right, left];
  else if (Math.abs(prev.x - p.x) > Math.abs(prev.y - p.y))
    order = prev.x < p.x ? [right, above, below, left] : [left, above, below, right];
  else order = prev.y < p.y ? [below, right, left, above] : [above, right, left, below];
  return [...order, ...corners].map((c) => ({ ...c, x1: c.x0 + w, y1: c.y0 + h }));
}

// One drawing (one rack) at the given room. Returns the shapes and how many
// labels had to be shortened or moved away.
function layoutPanel(b, tree, { panelW, drawMaxH, top }) {
  const incoming = new Map();
  const all = [{ x: b.rack.x, z: b.rack.z }];
  const walk = (n) => {
    all.push({ x: n.x, z: n.z });
    for (const c of n.children) {
      all.push(...c.points);
      if (c.node.run) incoming.set(c.node, c.points);
      walk(c.node);
    }
  };
  walk(tree.root);
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minZ = Math.min(...all.map((p) => p.z));
  const maxZ = Math.max(...all.map((p) => p.z));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxZ - minZ);
  const scale = Math.min((panelW - 2 * MARGIN_X) / bw, (drawMaxH - MARGIN_TOP - MARGIN_BOTTOM) / bh, MAX_SCALE);
  const planH = bh * scale + MARGIN_TOP + MARGIN_BOTTOM;
  const at = (x, z) => ({ x: 20 + MARGIN_X + (x - minX) * scale, y: top + MARGIN_TOP + (z - minZ) * scale });
  const panel = { x0: 28, y0: top + HEADER_H, x1: 12 + panelW, y1: top + planH - 14 };

  // ---- things that must stay clear ------------------------------------------
  const lines = []; // cable segments (inflated a little)
  const symbols = [];
  const placed = []; // label boxes already placed
  let branchId = 0;
  const branches = [];
  const collect = (n) => {
    for (const c of n.children) {
      const id = branchId++;
      const pts = c.points.map((p) => at(p.x, p.z));
      branches.push({ id, c, pts });
      for (let i = 1; i < pts.length; i++)
        lines.push({
          x0: Math.min(pts[i - 1].x, pts[i].x) - 3, y0: Math.min(pts[i - 1].y, pts[i].y) - 3,
          x1: Math.max(pts[i - 1].x, pts[i].x) + 3, y1: Math.max(pts[i - 1].y, pts[i].y) + 3, owner: id,
        });
      collect(c.node);
    }
  };
  collect(tree.root);
  const junctions = [];
  const dots = (n) => {
    if (!n.run && n.children.length > 1) junctions.push(at(n.x, n.z));
    n.children.forEach((c) => dots(c.node));
  };
  dots(tree.root);
  for (const j of junctions) symbols.push({ x0: j.x - 6, y0: j.y - 6, x1: j.x + 6, y1: j.y + 6 });
  for (const leaf of tree.leaves) {
    const p = at(leaf.x, leaf.z);
    symbols.push({ x0: p.x - 17, y0: p.y - 17, x1: p.x + 17, y1: p.y + 17 });
  }

  // the rack, and the uplink stub on a side where no cable leaves
  const rp = at(b.rack.x, b.rack.z);
  const used = new Set(
    tree.root.children
      .filter((c) => c.points.length > 1)
      .map((c) => {
        const dx = c.points[1].x - c.points[0].x;
        const dz = c.points[1].z - c.points[0].z;
        return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? "right" : "left") : dz > 0 ? "down" : "up";
      }),
  );
  const side = ["right", "up", "down", "left"].find((d) => !used.has(d)) || "up";
  const upW = textWidth(b.uplinkText, FONT.small);
  const stub = {
    right: { x1: rp.x + 50, y1: rp.y, x2: rp.x + 92, y2: rp.y, tx: rp.x + 98, ty: rp.y + 4, anchor: "start", box: { x0: rp.x + 96, y0: rp.y - 8, x1: rp.x + 100 + upW, y1: rp.y + 8 } },
    left: { x1: rp.x - 50, y1: rp.y, x2: rp.x - 92, y2: rp.y, tx: rp.x - 98, ty: rp.y + 4, anchor: "end", box: { x0: rp.x - 100 - upW, y0: rp.y - 8, x1: rp.x - 96, y1: rp.y + 8 } },
    up: { x1: rp.x, y1: rp.y - 19, x2: rp.x, y2: rp.y - 44, tx: rp.x, ty: rp.y - 50, anchor: "middle", box: { x0: rp.x - upW / 2, y0: rp.y - 62, x1: rp.x + upW / 2, y1: rp.y - 46 } },
    down: { x1: rp.x, y1: rp.y + 19, x2: rp.x, y2: rp.y + 44, tx: rp.x, ty: rp.y + 60, anchor: "middle", box: { x0: rp.x - upW / 2, y0: rp.y + 48, x1: rp.x + upW / 2, y1: rp.y + 64 } },
  }[side];
  symbols.push({ x0: rp.x - 56, y0: rp.y - 25, x1: rp.x + 56, y1: rp.y + 25 });
  symbols.push(stub.box);
  const header = { x0: panel.x0 - 10, y0: top, x1: panel.x1 + 10, y1: panel.y0 };

  const free = (box, ignoreOwner = null) =>
    box.x0 >= panel.x0 && box.x1 <= panel.x1 && box.y0 >= panel.y0 && box.y1 <= panel.y1 &&
    !touches(box, header, 0) &&
    !symbols.some((s) => touches(box, s)) &&
    !lines.some((l) => l.owner !== ignoreOwner && touches(box, l, 0)) &&
    !placed.some((l) => touches(box, l.box));

  // ---- AP labels: most crowded first -----------------------------------------
  const apPoints = tree.leaves.map((leaf) => ({ leaf, p: at(leaf.x, leaf.z) }));
  const crowd = (e) => apPoints.filter((o) => o !== e && Math.hypot(o.p.x - e.p.x, o.p.y - e.p.y) < 220).length;
  const order = [...apPoints].sort((a, c) => crowd(c) - crowd(a) || a.leaf.run.apName.localeCompare(c.leaf.run.apName));
  const apLabels = new Map();
  let degraded = 0;
  for (const e of order) {
    const pts = (incoming.get(e.leaf) || []).map((q) => at(q.x, q.z));
    const prev = pts.length > 1 ? pts[pts.length - 2] : null;
    let result = null;
    for (const { level, lines: text } of labelLevels(e.leaf.run)) {
      const { w, h } = boxOf(text);
      const hit = aroundPoint(e.p, w, h, prev, 20).find((c) => free(c));
      if (hit) { result = { level, text, box: hit }; break; }
    }
    if (!result) {
      // the name only, a little further away, joined by a leader line
      const tagText = labelLevels(e.leaf.run)[2].lines;
      const { w, h } = boxOf(tagText);
      for (const r of [40, 60, 90, 130, 180]) {
        for (let k = 0; k < 16 && !result; k++) {
          const a = (k * Math.PI) / 8;
          const cx = e.p.x + Math.cos(a) * r;
          const cy = e.p.y + Math.sin(a) * r;
          const box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, anchor: "middle" };
          if (free(box)) result = { level: "leader", text: tagText, box, leader: { x: cx, y: cy } };
        }
        if (result) break;
      }
    }
    if (!result) result = { level: "table", text: [], box: null };
    if (result.level !== "full") degraded++;
    if (result.box) placed.push({ id: e.leaf.run.apId, kind: "ap", box: result.box });
    apLabels.set(e.leaf, result);
  }

  // ---- route lengths: on the longest stretch where a label fits ----------------
  const lengthLabels = [];
  for (const br of [...branches].sort((a, c) => c.c.lengthM - a.c.lengthM)) {
    if (br.c.lengthM <= 0.05 || br.pts.length < 2) continue;
    const text = `${f1(br.c.lengthM)} m`;
    const w = textWidth(text, FONT.branch);
    const h = FONT.branch + 2;
    const segs = br.pts
      .slice(1)
      .map((q, i) => [br.pts[i], q])
      .sort((s, t) => Math.hypot(t[1].x - t[0].x, t[1].y - t[0].y) - Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y));
    let spot = null;
    for (const [a, c] of segs) {
      if (spot) break;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const x = a.x + (c.x - a.x) * t;
        const y = a.y + (c.y - a.y) * t;
        const vertical = Math.abs(c.y - a.y) > Math.abs(c.x - a.x);
        const options = vertical
          ? [{ x0: x + 6, y0: y - h / 2, anchor: "start" }, { x0: x - 6 - w, y0: y - h / 2, anchor: "end" }]
          : [{ x0: x - w / 2, y0: y - 6 - h, anchor: "middle" }, { x0: x - w / 2, y0: y + 6, anchor: "middle" }];
        const hit = options.map((o) => ({ ...o, x1: o.x0 + w, y1: o.y0 + h })).find((o) => free(o, br.id));
        if (hit) { spot = hit; break; }
      }
    }
    if (spot) {
      placed.push({ id: `branch-${br.id}`, kind: "length", box: spot });
      lengthLabels.push({ text, box: spot });
    }
  }

  return {
    scale, planH, at, panel, rp, stub, side, junctions, branches, apLabels, lengthLabels, degraded,
    symbolsList: symbols, linesList: lines,
  };
}

// The details of every AP, so nothing depends on a label having fitted.
function tableRows(runs) {
  return [...runs].sort((a, c) => String(a.apName).localeCompare(String(c.apName))).map((r) => ({
    name: r.apName,
    cable: `${r.permanentLinkM}`,
    volts: r.pdVoltageV != null ? `${r.pdVoltageV}` : "-",
    watts: r.poeCableLossW != null ? `${r.poeCableLossW}` : "-",
    signal: r.insertionLossDb != null ? `${r.insertionLossDb}` : "-",
    check: r.check,
  }));
}

// design: result of designWifiCabling; plan: for floor names; racks: rack list
export function buildWifiLayoutSchematic({
  design,
  plan,
  racks = [],
  catalogue,
  projectName = "",
  date = "",
}) {
  const floorName = (id) => (plan.floors || []).find((f) => f.id === id)?.name || id;
  const switchPart = catalogue?.switches?.[design.rules.switchPartId];
  const blocks = racks
    .map((rack) => ({
      rack,
      runs: design.runs.filter((r) => r.rackId === rack.id && !r.riserId),
      // APs on other floors reach this rack through a riser: they cannot be placed on this floor's drawing
      riserRuns: design.runs.filter((r) => r.rackId === rack.id && r.riserId),
      summary: design.racks.find((r) => r.rackId === rack.id),
      // a floor room reaches the main room by fibre; the main room's own uplink is not sized
      uplinkText: (() => {
        const up = design.network?.uplinks?.find((u) => u.from === rack.id);
        return up ? `fibre uplink to ${up.toName} · ${up.strands}-strand · ${up.lengthM} m` : "uplink to core (not sized)";
      })(),
    }))
    .filter((b) => b.runs.length || b.riserRuns.length)
    .sort((a, b) => (a.rack.floorId + a.rack.name).localeCompare(b.rack.floorId + b.rack.name));

  // ---- lay out each drawing with as much room as it needs ---------------------
  const drawings = [];
  let y = 90;
  for (const b of blocks) {
    const tree = b.runs.length
      ? buildPathwayTree(b.runs)
      : { root: { x: b.rack.x, z: b.rack.z, run: null, children: [] }, leaves: [] };
    let pick = null;
    for (const [panelW, drawMaxH] of ROOM) {
      const attempt = layoutPanel(b, tree, { panelW, drawMaxH, top: y });
      pick = { ...attempt, panelW, drawMaxH };
      if (attempt.degraded === 0) break; // every label fits in full
    }
    const rows = tableRows(b.runs);
    const cols = Math.max(1, Math.min(Math.floor(pick.panelW / 600), Math.ceil(rows.length / ROWS_PER_COLUMN)));
    const perCol = Math.ceil(rows.length / cols);
    const tableH = rows.length ? 40 + perCol * ROW_H + 16 : 0;
    drawings.push({ b, tree, ...pick, rows, cols, perCol, tableH, top: y, height: pick.planH + tableH });
    y += pick.planH + tableH + 30;
  }

  const panelMax = Math.max(1400, ...drawings.map((d) => d.panelW));
  const width = 20 + panelMax + 20;
  const height = Math.max(220, y) + 130;
  const out = [];
  const add = (s) => out.push(s);
  const nodes = [];
  const labels = [];
  const halo = 'stroke="#ffffff" stroke-width="4" paint-order="stroke" stroke-linejoin="round"';

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`);
  add(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  add(`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#334155" stroke-width="2"/>`);
  add(`<rect x="20" y="16" width="340" height="44" fill="#fde047" stroke="#334155"/>`);
  add(`<text x="190" y="46" font-size="24" font-weight="700" text-anchor="middle">WI-FI NETWORK</text>`);
  if (projectName) add(`<text x="${width - 20}" y="40" font-size="16" text-anchor="end" fill="#334155">${esc(projectName)}</text>`);

  const shapes = { lines: [], symbols: [] };
  for (const d of drawings) {
    const { b, tree, at, rp, stub, side, junctions, branches, apLabels, lengthLabels, top } = d;
    const rackLabel = b.rack.name || b.rack.id;
    const status = b.rack.suggested && !/suggested/i.test(rackLabel) ? " (suggested, to confirm)" : "";
    add(`<rect x="20" y="${top}" width="${d.panelW}" height="${d.height}" fill="#ffffff" stroke="#cbd5e1" stroke-dasharray="6 4"/>`);
    add(`<text x="38" y="${top + 28}" font-size="17" font-weight="700">${esc(floorName(b.rack.floorId))} · ${esc(rackLabel)}${esc(status)}</text>`);
    const sub = b.summary
      ? `${b.summary.switches} × ${esc(switchPart?.name || "switch")} · ${b.summary.poeAllocatedW} W PoE allocated · ${b.summary.patchPanels} patch panel(s) · ${b.summary.apCount} AP(s)`
      : "";
    add(`<text x="38" y="${top + 50}" font-size="12" fill="#475569">${sub}</text>`);
    if (b.riserRuns.length) {
      const listed = b.riserRuns.slice(0, 5).map((r) => `${esc(r.apName)} (${r.permanentLinkM} m${r.pdVoltageV != null ? `, ${r.pdVoltageV} V, ${r.poeCableLossW} W lost` : ""})`).join("; ");
      add(`<text x="38" y="${top + 68}" font-size="11" fill="#4c1d95">Via riser from other floors: ${listed}${b.riserRuns.length > 5 ? ` and ${b.riserRuns.length - 5} more` : ""}</text>`);
    }

    // cables first, then dots, rack, APs and labels on top
    for (const br of branches) {
      const colour = COLOUR[worst(checksBelow(br.c.node))] || COLOUR.ok;
      if (br.pts.length > 1)
        add(`<polyline points="${br.pts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${colour}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"${anyEstimated(br.c.node) ? ' stroke-dasharray="10 6"' : ""}/>`);
    }
    shapes.lines.push(...d.linesList);
    shapes.symbols.push(...d.symbolsList);
    for (const j of junctions) add(`<circle cx="${j.x}" cy="${j.y}" r="4.5" fill="#334155"/>`);
    for (const l of lengthLabels) {
      const x = l.box.anchor === "middle" ? (l.box.x0 + l.box.x1) / 2 : l.box.anchor === "end" ? l.box.x1 : l.box.x0;
      add(`<text x="${x}" y="${l.box.y1 - 3}" font-size="${FONT.branch}" fill="#14532d" text-anchor="${l.box.anchor}" ${halo}>${l.text}</text>`);
      labels.push({ kind: "length", text: l.text, box: l.box });
    }

    add(`<line x1="${stub.x1}" y1="${stub.y1}" x2="${stub.x2}" y2="${stub.y2}" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="5 3"/>`);
    add(`<text x="${stub.tx}" y="${stub.ty}" font-size="11" fill="#1e3a8a" text-anchor="${stub.anchor}" ${halo}>${esc(b.uplinkText)}</text>`);
    add(`<rect x="${rp.x - 50}" y="${rp.y - 19}" width="100" height="38" fill="#ffffff" stroke="#2563eb" stroke-width="3.5"/>`);
    add(`<text x="${rp.x}" y="${rp.y - 2}" font-size="13" font-weight="700" text-anchor="middle">${esc(rackLabel.replace(/\s*\(suggested\)/i, ""))}</text>`);
    add(`<text x="${rp.x}" y="${rp.y + 13}" font-size="10" fill="#475569" text-anchor="middle">${b.summary?.switches ?? 1} switch · ${b.summary?.apCount ?? b.runs.length} AP</text>`);
    nodes.push({ type: "rack", id: b.rack.id, label: rackLabel, x: rp.x, y: rp.y, uplink: side });

    let index = 0;
    for (const leaf of [...tree.leaves].sort((a, c) => String(a.run.apName).localeCompare(String(c.run.apName)))) {
      const run = leaf.run;
      const p = at(leaf.x, leaf.z);
      const lab = apLabels.get(leaf);
      index += 1;
      add(`<circle cx="${p.x}" cy="${p.y}" r="13" fill="#2563eb"/>`);
      if (lab.level === "table")
        add(`<text x="${p.x}" y="${p.y + 4}" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">${index}</text>`);
      else add(`<path d="M ${p.x - 8} ${p.y - 3} a 11 11 0 0 1 16 0 M ${p.x - 4} ${p.y + 2} a 6 6 0 0 1 8 0" fill="none" stroke="#fff" stroke-width="2"/>`);
      if (lab.box) {
        if (lab.leader)
          add(`<line x1="${p.x}" y1="${p.y}" x2="${lab.leader.x}" y2="${lab.leader.y}" stroke="#94a3b8" stroke-width="1.2"/>`);
        let ty = lab.box.y0;
        for (const line of lab.text) {
          ty += line.size + 1;
          const tx = lab.box.anchor === "middle" ? (lab.box.x0 + lab.box.x1) / 2 : lab.box.anchor === "end" ? lab.box.x1 : lab.box.x0;
          add(`<text x="${tx}" y="${ty}" text-anchor="${lab.box.anchor}" font-size="${line.size}"${line.bold ? ' font-weight="700"' : ""} fill="${line.fill}" ${halo}>${esc(line.text)}</text>`);
          ty += 2;
        }
        labels.push({ kind: "ap", id: run.apId, level: lab.level, box: lab.box });
      }
      nodes.push({ type: "ap", id: run.apId, label: run.apName, lengthM: run.permanentLinkM, check: run.check, x: p.x, y: p.y, pdVoltageV: run.pdVoltageV, poeCableLossW: run.poeCableLossW, labelLevel: lab.level, index });
    }

    // the table of full details
    if (d.rows.length) {
      const ty0 = top + d.planH + 6;
      add(`<text x="38" y="${ty0 + 14}" font-size="12" font-weight="700">AP details (all values for every AP)</text>`);
      const colW = 580;
      d.rows.forEach((r, i) => {
        const col = Math.floor(i / d.perCol);
        const row = i % d.perCol;
        const x = 38 + col * colW;
        const yy = ty0 + 52 + row * ROW_H;
        if (row === 0) {
          add(`<text x="${x}" y="${yy - ROW_H}" font-size="10.5" font-weight="700" fill="#475569">AP</text>`);
          [[170, "Cable (m)"], [250, "AP volts"], [320, "W lost"], [390, "Signal dB"], [470, "Check"]].forEach(([dx, t]) =>
            add(`<text x="${x + dx}" y="${yy - ROW_H}" font-size="10.5" font-weight="700" fill="#475569">${t}</text>`),
          );
        }
        add(`<text x="${x}" y="${yy}" font-size="10.5">${esc(r.name)}</text>`);
        [[170, r.cable], [250, r.volts], [320, r.watts], [390, r.signal]].forEach(([dx, t]) => add(`<text x="${x + dx}" y="${yy}" font-size="10.5">${esc(t)}</text>`));
        add(`<text x="${x + 470}" y="${yy}" font-size="10.5" fill="${COLOUR[r.check] || COLOUR.ok}">${esc(r.check)}</text>`);
      });
    }
  }

  if (!blocks.length)
    add(`<text x="38" y="150" font-size="16" fill="#7f1d1d">No cable runs yet: place APs and a rack.</text>`);

  const ly = height - 112;
  add(`<text x="30" y="${ly}" font-size="12" font-weight="700">Cable colour</text>`);
  [["ok", "within the 90 m limit"], ["near limit", "close to the limit"], ["too long", "over a limit"]].forEach(([k, t], i) => {
    add(`<line x1="${30 + i * 210}" y1="${ly + 18}" x2="${60 + i * 210}" y2="${ly + 18}" stroke="${COLOUR[k]}" stroke-width="3"/>`);
    add(`<text x="${68 + i * 210}" y="${ly + 22}" font-size="12">${t}</text>`);
  });
  add(`<line x1="${30 + 3 * 210}" y1="${ly + 18}" x2="${60 + 3 * 210}" y2="${ly + 18}" stroke="#475569" stroke-width="3" stroke-dasharray="10 6"/>`);
  add(`<text x="${68 + 3 * 210}" y="${ly + 22}" font-size="12">route rests on an unconfirmed assumption</text>`);
  add(`<text x="30" y="${ly + 44}" font-size="11" fill="#475569">Numbers on the lines are route lengths of the shared sections. At each AP: its own cable to the rack, and the loss in that cable. The table lists every value.</text>`);
  add(`<text x="30" y="${ly + 60}" font-size="11" fill="#475569">PoE loss = voltage and power lost in the copper before the AP. Signal loss is shown when the cable's datasheet value is entered; it does not change the Wi-Fi signal the AP radiates.</text>`);
  add(`<text x="30" y="${ly + 78}" font-size="11" fill="#7f1d1d">${esc(design.status)}${date ? ` · ${esc(date)}` : ""}</text>`);
  add(`</svg>`);
  return { svg: out.join("\n"), width, height, nodes, labels, shapes };
}
