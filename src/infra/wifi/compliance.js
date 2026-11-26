// A compliance table for a design: each requirement, its limit, what the design
// reaches, and whether it passes. Built from the design only; it shows what the
// planning calculation found, not what an installed system measures.
const num = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function complianceRows(design) {
  const rows = [];
  const add = (area, requirement, limit, actual, ok, note = "") => rows.push({ area, requirement, limit, actual, status: ok ? "pass" : "FAIL", note });
  const r = design.rules;
  const runs = design.runs;

  if (runs.length) {
    const longest = runs.reduce((a, b) => (b.permanentLinkM > a.permanentLinkM ? b : a));
    add("Ethernet", "Permanent link length", `<= ${r.maxPermanentLinkM} m`, `${longest.permanentLinkM} m (${longest.apName})`, longest.permanentLinkM <= r.maxPermanentLinkM);
    const widest = runs.reduce((a, b) => (b.channelM > a.channelM ? b : a));
    add("Ethernet", "Channel length (with patch cords)", `<= ${r.maxChannelM} m`, `${widest.channelM} m (${widest.apName})`, widest.channelM <= r.maxChannelM);
    const poe = runs.filter((x) => x.pdVoltageV != null);
    if (poe.length) {
      const worst = poe.reduce((a, b) => (b.pdVoltageV < a.pdVoltageV ? b : a));
      add("PoE", "Every AP receives enough voltage", "above each AP's minimum", `lowest ${worst.pdVoltageV} V (${worst.apName})`, !runs.some((x) => x.check === "PoE"));
    }
    add("Pathway", "Every route is permitted", "no route through a wall that may not be crossed", `${runs.filter((x) => x.crossings > 0).length} route(s) rest on an unconfirmed crossing`, runs.every((x) => x.crossings === 0), "an unconfirmed crossing is an estimate: confirm the ceiling and wall settings");
  }
  for (const rack of design.network?.racks || []) {
    add("Rack", `${rack.name}: space`, `<= ${rack.unitsUsable} U usable`, `${rack.unitsUsed} U`, rack.unitsUsed <= rack.unitsUsable);
    if (rack.oversubscription)
      add("Network", `${rack.name}: oversubscription`, `<= ${r.maxOversubscription}:1`, `${rack.oversubscription.ratio}:1`, rack.oversubscription.ratio <= r.maxOversubscription);
  }
  for (const u of design.network?.uplinks || [])
    add("Fibre", `${u.fromName} to ${u.toName}`, "within the fibre's length limit", `${u.lengthM} m, ${u.strands} strands`, !design.violations.some((v) => v.severity === "error" && /fibre uplink/.test(v.message) && v.item === u.fromName));
  if (design.trayFill)
    add("Pathway", "Tray fill, busiest section", `<= ${design.trayFill.limitPct}%`, `${design.trayFill.fillPct}% (${design.trayFill.maxCables} cables)`, design.trayFill.fillPct <= design.trayFill.limitPct, design.trayFill.fillPct > design.trayFill.limitPct ? `use a tray at least ${design.trayFill.requiredWidthMm} mm wide` : "");
  for (const u of design.riserUse || [])
    if (u.capacityMm2 != null) add("Pathway", `Riser ${u.name}: fill`, "<= 40% of its cross-section", `${u.fillPct}%`, u.usedMm2 <= u.capacityMm2);
  add("Pathway", "Power and data kept apart", `>= ${r.powerSeparationM * 1000} mm`, design.powerSeparationM > 0 ? `${design.powerSeparationM} m of data route too close` : "no close run drawn", design.powerSeparationM === 0, "only power cabling you drew on the map is checked");
  return rows;
}

// What the tool does not check, in plain words, for the report.
export const NOT_CHECKED = [
  "Ethernet signal quality (return loss, crosstalk): needs a cable certifier.",
  "Cable bundle heating: only a warning when many PoE cables share a tray section.",
  "Bend radius, pulling tension and fire-stopping workmanship.",
  "The real ceiling space, walls and trays unless you confirmed them on the Cabling tab.",
];
