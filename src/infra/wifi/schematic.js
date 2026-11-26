// Wi-Fi cabling schematic: the network drawn as a tree, the way an IBS design
// shows its cable tree. Core / router, then each rack, then the physical route
// tree out of the rack: a trunk, branches where the cables separate, and each AP
// at the end of its own branch, in the order the APs lie on the floor.
//
// Every AP still has its own cable to the rack (labelled under the AP). The
// lengths on the branches are route lengths of the shared sections. Nothing is
// typed in by hand: change the plan and the drawing changes. Returns an SVG.
import { buildPathwayTree } from "./pathwayTree.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const COLOUR = { ok: "#1f8a4c", "near limit": "#d98200", PoE: "#c0392b", "too long": "#c0392b" };
const SEVERITY = { ok: 0, "near limit": 1, PoE: 2, "too long": 2 };
const AP_W = 96;
const AP_GAP = 28;
const BLOCK_PAD = 28;
const LEFT_W = 300;
const LEVEL_H = 56; // vertical distance between branch points
const HEAD_H = 62 + 44; // title lines and the rack box

const worst = (checks) => checks.reduce((w, c) => ((SEVERITY[c] ?? 0) > (SEVERITY[w] ?? 0) ? c : w), "ok");
const checksBelow = (n) => (n.run ? [n.run.check] : n.children.flatMap((c) => checksBelow(c.node)));

// Left-to-right order of the branches follows where the APs lie on the floor.
function centreOf(n) {
  if (n.run) return { x: n.x, z: n.z, count: 1 };
  const parts = n.children.map((c) => centreOf(c.node));
  const count = parts.reduce((s, p) => s + p.count, 0) || 1;
  return {
    x: parts.reduce((s, p) => s + p.x * p.count, 0) / count,
    z: parts.reduce((s, p) => s + p.z * p.count, 0) / count,
    count,
  };
}
function sortByPosition(node) {
  for (const c of node.children) sortByPosition(c.node);
  node.children.sort((a, b) => {
    const ca = centreOf(a.node);
    const cb = centreOf(b.node);
    return ca.x - cb.x || ca.z - cb.z || String(a.node.id).localeCompare(String(b.node.id));
  });
}

// Places every node: leaves in one row in order, branch points above them.
function layout(root) {
  let slot = 0;
  let maxDepth = 0;
  const place = (n, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    n.depth = depth;
    if (n.run) {
      n.slot = slot++;
      return;
    }
    for (const c of n.children) place(c.node, depth + 1);
    n.slot = n.children.reduce((s, c) => s + c.node.slot, 0) / Math.max(1, n.children.length);
  };
  place(root, 0);
  return { leafCount: slot, maxDepth };
}

// design: result of designWifiCabling; plan: for floor names; racks: rack list
export function buildWifiSchematic({
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
      runs: design.runs.filter((r) => r.rackId === rack.id),
      summary: design.racks.find((r) => r.rackId === rack.id),
    }))
    .filter((b) => b.runs.length)
    .sort((a, b) => (a.rack.floorId + a.rack.name).localeCompare(b.rack.floorId + b.rack.name))
    .map((b) => {
      const tree = buildPathwayTree(b.runs);
      sortByPosition(tree.root);
      return { ...b, tree, grid: layout(tree.root) };
    });

  // each block: head, the branch levels, then the AP row and its labels
  const blockH = (b) => HEAD_H + 40 + Math.max(1, b.grid.maxDepth) * LEVEL_H + 62 + 76;
  const widths = blocks.map((b) => Math.max(620, b.grid.leafCount * (AP_W + AP_GAP) + 2 * BLOCK_PAD));
  const maxW = Math.max(620, ...widths);
  const width = LEFT_W + maxW + 40;
  const total = blocks.reduce((s, b) => s + blockH(b), 0);
  const height = 110 + Math.max(1, total) + 110;
  const nodes = [];
  const out = [];
  const add = (s) => out.push(s);

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`);
  add(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  add(`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#334155" stroke-width="2"/>`);
  add(`<rect x="20" y="16" width="340" height="44" fill="#fde047" stroke="#334155"/>`);
  add(`<text x="190" y="46" font-size="24" font-weight="700" text-anchor="middle">WI-FI NETWORK</text>`);
  if (projectName) add(`<text x="${width - 20}" y="40" font-size="16" text-anchor="end" fill="#334155">${esc(projectName)}</text>`);

  // core / router, aligned with the first rack so its uplink leaves from the side
  const coreY = 110 + 62 + 22 - 35;
  add(`<rect x="30" y="${coreY}" width="220" height="70" fill="#e2e8f0" stroke="#334155"/>`);
  add(`<text x="140" y="${coreY + 30}" font-size="16" font-weight="700" text-anchor="middle">Core switch / router</text>`);
  add(`<text x="140" y="${coreY + 52}" font-size="12" text-anchor="middle" fill="#475569">Internet / campus network</text>`);
  nodes.push({ type: "core", label: "Core switch / router" });

  let y0 = 110;
  blocks.forEach((b, i) => {
    const w = widths[i];
    const h = blockH(b);
    const x0 = LEFT_W;
    const cx = x0 + w / 2;
    const rackLabel = b.rack.name || b.rack.id;
    const status = b.rack.suggested && !/suggested/i.test(rackLabel) ? " (suggested, to confirm)" : "";

    add(`<rect x="${x0}" y="${y0}" width="${w}" height="${h - 20}" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 4"/>`);
    add(`<text x="${x0 + 14}" y="${y0 + 24}" font-size="16" font-weight="700">${esc(floorName(b.rack.floorId))} · ${esc(rackLabel)}${esc(status)}</text>`);
    const sub = b.summary
      ? `${b.summary.switches} × ${esc(switchPart?.name || "switch")} · ${b.summary.poeAllocatedW} W PoE allocated · ${b.summary.patchPanels} patch panel(s) · ${b.summary.apCount} AP(s)`
      : "";
    add(`<text x="${x0 + 14}" y="${y0 + 44}" font-size="12" fill="#475569">${sub}</text>`);

    // uplink: the first leaves the side of the core box, the others branch off a trunk below it
    const rackBoxY = y0 + 62;
    const upY = rackBoxY + 22;
    const startX = i === 0 ? 250 : 140;
    add(`<polyline points="${startX},${upY} ${cx - 120},${upY}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`);
    add(`<text x="${(startX + cx - 120) / 2}" y="${upY - 8}" font-size="11" text-anchor="middle" fill="#1e3a8a">uplink (not sized)</text>`);
    if (i === blocks.length - 1 && blocks.length > 1)
      add(`<polyline points="140,${coreY + 70} 140,${upY}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`);

    add(`<rect x="${cx - 120}" y="${rackBoxY}" width="240" height="44" fill="#0f172a"/>`);
    add(`<text x="${cx}" y="${rackBoxY + 19}" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(rackLabel)}</text>`);
    add(`<text x="${cx}" y="${rackBoxY + 35}" font-size="11" fill="#cbd5e1" text-anchor="middle">${b.summary?.switches ?? 1} × ${esc(switchPart?.name || "switch")}</text>`);
    nodes.push({ type: "rack", id: b.rack.id, label: rackLabel });

    // ---- the route tree: trunk out of the rack, branches, APs in one row ------
    const { root } = b.tree;
    const leafSpan = (w - 2 * BLOCK_PAD - AP_W) / Math.max(1, b.grid.leafCount - 1);
    const firstX = x0 + BLOCK_PAD + AP_W / 2;
    const xOf = (n) => (n === root ? cx : b.grid.leafCount === 1 ? cx : firstX + n.slot * leafSpan);
    const levelY = (depth) => rackBoxY + 44 + 18 + depth * LEVEL_H;
    const apRowY = levelY(Math.max(1, b.grid.maxDepth)) + 46;

    add(`<polyline points="${cx},${rackBoxY + 44} ${cx},${levelY(0)}" fill="none" stroke="#334155" stroke-width="2.5"/>`);
    const draw = (n, parent, lengthM) => {
      n.px = n === root ? cx : xOf(n);
      n.py = n.run ? apRowY : levelY(n.depth);
      if (parent) {
        const colour = COLOUR[worst(checksBelow(n))] || COLOUR.ok;
        const busY = parent.py;
        add(`<polyline points="${parent.px},${busY} ${n.px},${busY} ${n.px},${n.py}" fill="none" stroke="${colour}" stroke-width="2.5"/>`);
        if (lengthM > 0.05)
          add(`<text x="${n.px + 6}" y="${busY + (n.py - busY) / 2 + 4}" font-size="11" fill="#14532d">${Math.round(lengthM * 10) / 10} m</text>`);
      }
      if (!n.run && n.children.length > 1) add(`<circle cx="${n.px}" cy="${n.py}" r="4" fill="#334155"/>`);
      for (const c of n.children) draw(c.node, n, c.lengthM);
      if (n.run) {
        const run = n.run;
        add(`<circle cx="${n.px}" cy="${n.py + 14}" r="14" fill="#2563eb"/>`);
        add(`<path d="M ${n.px - 8} ${n.py + 10} a 11 11 0 0 1 16 0 M ${n.px - 4} ${n.py + 15} a 6 6 0 0 1 8 0" fill="none" stroke="#fff" stroke-width="2"/>`);
        add(`<text x="${n.px}" y="${n.py + 44}" font-size="13" font-weight="700" fill="#7f1d1d" text-anchor="middle">${esc(run.apName)}</text>`);
        add(`<text x="${n.px}" y="${n.py + 59}" font-size="10.5" fill="#475569" text-anchor="middle">${run.portPowerW} W · ${esc(run.cablePartId === "cat6a" ? "Cat6A" : run.cablePartId === "cat6" ? "Cat6" : run.cableName)}</text>`);
        add(`<text x="${n.px}" y="${n.py + 74}" font-size="11" font-weight="700" fill="${COLOUR[run.check] || COLOUR.ok}" text-anchor="middle">cable ${run.permanentLinkM} m</text>`);
        nodes.push({ type: "ap", id: run.apId, label: run.apName, lengthM: run.permanentLinkM, check: run.check });
      }
    };
    draw(root, null, 0);
    y0 += h;
  });

  if (!blocks.length)
    add(`<text x="${LEFT_W}" y="170" font-size="16" fill="#7f1d1d">No cable runs yet: place APs and a rack.</text>`);

  const ly = height - 90;
  add(`<text x="30" y="${ly}" font-size="12" font-weight="700">Cable colour</text>`);
  [["ok", "within the 90 m limit"], ["near limit", "close to the limit"], ["too long", "over the limit"]].forEach(([k, t], i) => {
    add(`<line x1="${30 + i * 210}" y1="${ly + 18}" x2="${60 + i * 210}" y2="${ly + 18}" stroke="${COLOUR[k]}" stroke-width="3"/>`);
    add(`<text x="${68 + i * 210}" y="${ly + 22}" font-size="12">${t}</text>`);
  });
  add(`<text x="30" y="${ly + 44}" font-size="11" fill="#475569">Branch lengths are the shared route sections. The number under each AP is that AP's own cable to the rack.</text>`);
  add(`<text x="30" y="${ly + 62}" font-size="11" fill="#7f1d1d">${esc(design.status)}${date ? ` · ${esc(date)}` : ""}</text>`);
  add(`</svg>`);
  return { svg: out.join("\n"), width, height, nodes };
}
