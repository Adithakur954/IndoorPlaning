// Riser diagram: the floors stacked by height, each riser as a vertical shaft,
// and how many cables rise or fall through it from each floor, with its fill.
// Built from the design only. Returns { svg, width, height, items } or null when
// no cable uses a riser.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

export function buildRiserSvg({ design, plan, risers = [], racks = [] }) {
  const used = (design.riserUse || []).filter((u) => u.cables > 0);
  if (!used.length) return null;
  const floors = [...(plan.floors || [])].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
  const BAND = 74;
  const LEFT = 210;
  const COL = 190;
  const width = LEFT + used.length * COL + 60;
  const height = 70 + floors.length * BAND + 60;
  const out = [];
  const items = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="20" y="34" font-size="20" font-weight="700">Riser diagram</text>`);
  floors.forEach((f, i) => {
    const y = 60 + i * BAND;
    out.push(`<rect x="20" y="${y}" width="${width - 40}" height="${BAND - 10}" fill="${i % 2 ? "#f8fafc" : "#f1f5f9"}" stroke="#cbd5e1"/>`);
    out.push(`<text x="32" y="${y + 24}" font-size="14" font-weight="700">${esc(f.name || f.id)}</text>`);
    out.push(`<text x="32" y="${y + 42}" font-size="11" fill="#475569">level ${Number(f.elevation || 0).toFixed(1)} m</text>`);
    const rackHere = racks.filter((r) => r.floorId === f.id);
    if (rackHere.length)
      out.push(`<text x="32" y="${y + 58}" font-size="11" fill="#0f172a">rack: ${esc(rackHere.map((r) => r.name || r.id).join(", "))}</text>`);
  });
  used.forEach((u, k) => {
    const riser = risers.find((r) => r.id === u.id) || {};
    const x = LEFT + k * COL + COL / 2;
    const joined = floors.filter((f) => !riser.floorIds || riser.floorIds.includes(f.id));
    const topY = 60 + floors.indexOf(joined[0]) * BAND + 10;
    const botY = 60 + floors.indexOf(joined[joined.length - 1]) * BAND + BAND - 20;
    const over = u.capacityMm2 != null && u.usedMm2 > u.capacityMm2;
    out.push(`<rect x="${x - 9}" y="${topY}" width="18" height="${botY - topY}" fill="${over ? "#fecaca" : "#ddd6fe"}" stroke="${over ? "#b91c1c" : "#7c3aed"}" stroke-width="2"/>`);
    out.push(`<text x="${x}" y="52" font-size="12" font-weight="700" text-anchor="middle" fill="#4c1d95">${esc(u.name)}</text>`);
    const fill = u.fillPct != null ? `${u.fillPct}% full` : "size not recorded";
    out.push(`<text x="${x}" y="${height - 28}" font-size="11" text-anchor="middle" fill="${over ? "#b91c1c" : "#334155"}">${u.cables} cable(s) · ${fill}</text>`);
    items.push({ id: u.id, name: u.name, cables: u.cables, fillPct: u.fillPct, over, floors: joined.map((f) => f.id) });
    for (const f of joined) {
      const n = (design.runs || []).filter((r) => r.riserId === u.id && r.floorId === f.id).length;
      if (!n) continue;
      const y = 60 + floors.indexOf(f) * BAND + 26;
      out.push(`<line x1="${x + 9}" y1="${y}" x2="${x + 70}" y2="${y}" stroke="#1f8a4c" stroke-width="3"/>`);
      out.push(`<circle cx="${x + 78}" cy="${y}" r="9" fill="#2563eb"/>`);
      out.push(`<text x="${x + 92}" y="${y + 4}" font-size="11">${n} AP${n === 1 ? "" : "s"}</text>`);
    }
  });
  out.push(`</svg>`);
  return { svg: out.join("\n"), width, height, items };
}
