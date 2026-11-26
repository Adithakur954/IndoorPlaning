// A floor with its cabling as a standalone SVG string (for reports and slides).
// The on-screen map is interactive; this is the same drawing, without the UI.
import { floorRoutingInput } from "../core/planGeometry.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const COLOUR = { ok: "#1f8a4c", "near limit": "#d98200", PoE: "#c0392b", "too long": "#c0392b" };
const WALL = { blocked: ["#9a3412", 2.6, false], permitted: ["#16a34a", 1.8, true], penalty: ["#7a8794", 1.6, false] };

export function buildFloorSvg({ plan, floorId, design, racks = [], risers = [], pathway = {}, title = "" }) {
  const input = floorRoutingInput(plan, floorId, pathway);
  if (!input) return null;
  const { bounds } = input;
  const pad = 2;
  const x0 = bounds.minX - pad;
  const z0 = bounds.minZ - pad - (title ? 2 : 0);
  const w = bounds.maxX - bounds.minX + 2 * pad;
  const h = bounds.maxZ - bounds.minZ + 2 * pad + (title ? 2 : 0);
  const k = Math.max(w, h) / 400; // one unit of line width
  const pxW = 1000;
  const pxH = Math.round((pxW * h) / w);

  const walls = input.walls;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${z0} ${w} ${h}" width="${pxW}" height="${pxH}" font-family="Arial, Helvetica, sans-serif">`);
  out.push(`<rect x="${x0}" y="${z0}" width="${w}" height="${h}" fill="#ffffff"/>`);
  if (title) out.push(`<text x="${x0 + 1}" y="${z0 + 2}" font-size="${k * 14}" font-weight="700">${esc(title)}</text>`);
  for (const poly of input.noGo)
    out.push(`<polygon points="${poly.map((p) => `${p.x},${p.z}`).join(" ")}" fill="#dc2626" fill-opacity="0.16" stroke="#dc2626" stroke-width="${k * 1.4}" stroke-dasharray="${k * 5} ${k * 3}"/>`);
  for (const tray of input.trays)
    out.push(`<polyline fill="none" points="${tray.points.map((p) => `${p.x},${p.z}`).join(" ")}" stroke="#1d4ed8" stroke-width="${k * 3.4}" stroke-opacity="0.45" stroke-linejoin="round"${tray.status === "confirmed" ? "" : ` stroke-dasharray="${k * 8} ${k * 4}"`}/>`);
  for (const wall of walls) {
    const [stroke, width, dashed] = WALL[wall.policy] || WALL.penalty;
    out.push(`<line x1="${wall.a.x}" y1="${wall.a.z}" x2="${wall.b.x}" y2="${wall.b.z}" stroke="${stroke}" stroke-width="${k * width}"${dashed ? ` stroke-dasharray="${k * 6} ${k * 3}"` : ""}/>`);
  }
  for (const run of design?.runs || [])
    for (const path of run.paths.filter((p) => p.floorId === floorId)) {
      out.push(`<polyline fill="none" points="${path.points.map((p) => `${p.x},${p.z}`).join(" ")}" stroke="${COLOUR[run.check] || COLOUR.ok}" stroke-width="${k * 2}" stroke-linejoin="round"${run.pathwayStatus === "estimated" ? ` stroke-dasharray="${k * 8} ${k * 4}"` : ""}/>`);
      for (const c of (run.crossingPoints || []).filter((x) => x.floorId === floorId)) {
        if (c.kind === "penetration")
          out.push(`<rect x="${c.x - k * 4}" y="${c.z - k * 4}" width="${k * 8}" height="${k * 8}" transform="rotate(45 ${c.x} ${c.z})" fill="#7c3aed"/>`);
        else if (c.kind === "ceiling")
          out.push(`<rect x="${c.x - k * 3}" y="${c.z - k * 3}" width="${k * 6}" height="${k * 6}" fill="#16a34a"/>`);
        else out.push(`<circle cx="${c.x}" cy="${c.z}" r="${k * 4.5}" fill="none" stroke="#d97706" stroke-width="${k * 1.8}"/>`);
      }
      const end = path.points[path.points.length - 1];
      out.push(`<text x="${end.x - k * 4}" y="${end.z - k * 7}" font-size="${k * 8}" fill="#14532d" text-anchor="end">${run.permanentLinkM} m</text>`);
    }
  for (const ap of (plan.sources || []).filter((s) => s.kind === "wifi" && s.floorId === floorId))
    out.push(`<circle cx="${ap.x}" cy="${ap.z}" r="${k * 5}" fill="#2563eb"/><text x="${ap.x + k * 7}" y="${ap.z + k * 3}" font-size="${k * 9}" fill="#1e293b">${esc(ap.name || "AP")}</text>`);
  for (const r of risers.filter((x) => !x.floorIds || x.floorIds.includes(floorId)))
    out.push(`<rect x="${r.x - k * 5}" y="${r.z - k * 5}" width="${k * 10}" height="${k * 10}" transform="rotate(45 ${r.x} ${r.z})" fill="#7c3aed"/><text x="${r.x + k * 8}" y="${r.z}" font-size="${k * 9}" fill="#4c1d95">${esc(r.name || "Riser")}</text>`);
  for (const r of racks.filter((x) => x.floorId === floorId))
    out.push(`<rect x="${r.x - k * 6}" y="${r.z - k * 6}" width="${k * 12}" height="${k * 12}" fill="${r.needsRoom ? "#b45309" : "#0f172a"}"/><text x="${r.x + k * 8}" y="${r.z}" font-size="${k * 9}" fill="#0f172a">${esc(r.name || "Rack")}</text>`);
  out.push("</svg>");
  return { svg: out.join("\n"), width: pxW, height: pxH };
}
