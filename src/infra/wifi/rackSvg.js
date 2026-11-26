// Rack elevation (the front of each rack, unit by unit) and the MDF / IDF topology
// (main room, floor rooms and the fibre between them). Built from the design only.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const COLOUR = { switch: "#1d4ed8", patch: "#475569", fibre: "#7c3aed", manager: "#94a3b8", spare: "#f1f5f9" };

// The devices in a rack, top to bottom: fibre panels, switches, patch panels, with a
// cable manager after every two devices. Returns [{ kind, label, units }].
export function rackDevices(entry, design) {
  const summary = design.racks.find((r) => r.rackId === entry.rackId);
  const devices = [];
  for (let i = 0; i < entry.fibrePanels; i++) devices.push({ kind: "fibre", label: `Fibre patch panel ${i + 1}`, units: 1 });
  const sw = summary ? summary.switchName : "Switch";
  for (let i = 0; i < (summary?.switches || 0); i++) devices.push({ kind: "switch", label: `${sw} ${i + 1}`, units: 1 });
  for (let i = 0; i < (summary?.patchPanels || 0); i++) devices.push({ kind: "patch", label: `Patch panel ${i + 1}`, units: 1 });
  const out = [];
  devices.forEach((d, i) => {
    out.push(d);
    if (i % 2 === 1 || i === devices.length - 1) out.push({ kind: "manager", label: "Cable manager", units: 1 });
  });
  return out;
}

export function buildRackElevationSvg({ design, racks = [] }) {
  const entries = (design.network?.racks || []).filter((e) => e.unitsUsed > 0);
  if (!entries.length) return null;
  const U = 22;
  const W = 300;
  const tallest = Math.max(...entries.map((e) => e.unitsTotal));
  const height = 110 + tallest * U + 60;
  const width = 40 + entries.length * (W + 60);
  const out = [];
  const items = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="20" y="32" font-size="20" font-weight="700">Rack elevation (front, unit 1 at the bottom)</text>`);
  entries.forEach((e, k) => {
    const x = 40 + k * (W + 60);
    const top = 90;
    const devices = rackDevices(e, design);
    out.push(`<text x="${x}" y="70" font-size="14" font-weight="700">${esc(e.name)} · ${e.role === "mdf" ? "main room" : "floor room"}</text>`);
    out.push(`<rect x="${x}" y="${top}" width="${W}" height="${e.unitsTotal * U}" fill="#ffffff" stroke="#0f172a" stroke-width="3"/>`);
    // unit numbers
    for (let u = 1; u <= e.unitsTotal; u++) {
      const y = top + (e.unitsTotal - u) * U;
      out.push(`<line x1="${x}" y1="${y + U}" x2="${x + W}" y2="${y + U}" stroke="#e2e8f0"/>`);
      if (u % 5 === 0 || u === 1) out.push(`<text x="${x - 6}" y="${y + U - 6}" font-size="10" text-anchor="end" fill="#64748b">${u}</text>`);
    }
    let unit = e.unitsTotal; // the top unit
    let used = 0;
    const placed = [];
    for (const d of devices) {
      const y = top + (e.unitsTotal - unit) * U;
      out.push(`<rect x="${x + 4}" y="${y + 2}" width="${W - 8}" height="${d.units * U - 4}" fill="${COLOUR[d.kind]}" rx="2"/>`);
      out.push(`<text x="${x + 12}" y="${y + U - 7}" font-size="11" fill="#ffffff">${esc(d.label)}</text>`);
      placed.push({ kind: d.kind, label: d.label, unit: unit });
      unit -= d.units;
      used += d.units;
    }
    const spare = e.unitsTotal - used;
    if (spare > 0) out.push(`<text x="${x + W / 2}" y="${top + (e.unitsTotal - unit) * U + 18}" font-size="11" text-anchor="middle" fill="#64748b">${spare} U spare (${e.unitsUsable - used >= 0 ? `${e.unitsUsable - used} U usable` : "over the usable space"})</text>`);
    out.push(`<text x="${x}" y="${top + e.unitsTotal * U + 22}" font-size="11" fill="#334155">${e.unitsUsed} U used of ${e.unitsUsable} U usable · ${e.powerW} W · ${e.heatBtuHr} BTU/h</text>`);
    items.push({ rackId: e.rackId, name: e.name, devices: placed, unitsUsed: used, spare });
  });
  out.push("</svg>");
  return { svg: out.join("\n"), width, height, items };
}

export function buildTopologySvg({ design }) {
  const net = design.network;
  if (!net?.racks?.length) return null;
  const mdfs = net.racks.filter((r) => r.role === "mdf");
  const idfs = net.racks.filter((r) => r.role !== "mdf");
  const width = Math.max(640, 80 + Math.max(idfs.length, 1) * 230);
  const height = 140 + 170 + (idfs.length ? 150 : 0);
  const out = [];
  const nodes = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="20" y="32" font-size="20" font-weight="700">MDF / IDF topology</text>`);
  out.push(`<rect x="${width / 2 - 100}" y="56" width="200" height="40" fill="#e2e8f0" stroke="#334155"/>`);
  out.push(`<text x="${width / 2}" y="80" font-size="13" font-weight="700" text-anchor="middle">Core / router (not sized)</text>`);
  const mx = width / 2;
  mdfs.forEach((m, i) => {
    const y = 150;
    out.push(`<line x1="${width / 2}" y1="96" x2="${mx}" y2="${y}" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="5 3"/>`);
    out.push(`<rect x="${mx - 120}" y="${y}" width="240" height="70" fill="#0f172a"/>`);
    out.push(`<text x="${mx}" y="${y + 24}" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">${esc(m.name)} (main room)</text>`);
    out.push(`<text x="${mx}" y="${y + 44}" font-size="11" fill="#cbd5e1" text-anchor="middle">${m.fibreStrands} fibre strands · ${m.unitsUsed} U · ${m.powerW} W</text>`);
    if (m.oversubscription) out.push(`<text x="${mx}" y="${y + 60}" font-size="11" fill="#cbd5e1" text-anchor="middle">oversubscription ${m.oversubscription.ratio}:1</text>`);
    nodes.push({ id: m.rackId, role: "mdf" });
  });
  idfs.forEach((r, i) => {
    const x = 40 + i * 230 + 100;
    const y = 330;
    const up = net.uplinks.find((u) => u.from === r.rackId);
    out.push(`<line x1="${mx}" y1="220" x2="${x}" y2="${y}" stroke="#7c3aed" stroke-width="3"/>`);
    if (up) out.push(`<text x="${(mx + x) / 2}" y="${(220 + y) / 2 - 4}" font-size="11" fill="#4c1d95" text-anchor="middle" style="paint-order:stroke" stroke="#fff" stroke-width="4">${up.strands}-strand · ${up.lengthM} m</text>`);
    out.push(`<rect x="${x - 100}" y="${y}" width="200" height="70" fill="#334155"/>`);
    out.push(`<text x="${x}" y="${y + 24}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">${esc(r.name)}</text>`);
    out.push(`<text x="${x}" y="${y + 44}" font-size="11" fill="#cbd5e1" text-anchor="middle">${r.unitsUsed} U · ${r.powerW} W${r.oversubscription ? ` · ${r.oversubscription.ratio}:1` : ""}</text>`);
    nodes.push({ id: r.rackId, role: "idf", uplink: up ? { strands: up.strands, lengthM: up.lengthM } : null });
  });
  out.push("</svg>");
  return { svg: out.join("\n"), width, height, nodes };
}
