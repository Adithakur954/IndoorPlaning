// Network architecture of a Wi-Fi cabling design: how APs are packed onto
// switches, how floor rooms (IDF) connect to the main room (MDF) by fibre, how
// oversubscribed an access switch is, and what a rack needs in space, power and
// cooling. Pure functions: the design passes in routes and parts.

// Fibre cables are made in standard strand counts.
export const STANDARD_STRANDS = [4, 6, 8, 12, 24, 48, 72, 96, 144];
export const strandsFor = (n) => STANDARD_STRANDS.find((s) => s >= n) ?? Math.ceil(n / 144) * 144;

// PoE a switch can allocate: its budget (or the budget that remains when one power
// supply fails), less the design margin.
export function usableBudgetW(part, rules) {
  const base =
    rules.psuRedundancy === "N+1"
      ? part.poeBudgetRedundantW ?? part.poeBudgetW * 0.5
      : part.poeBudgetW;
  return base * (1 - (rules.poeMargin || 0));
}

// First-fit decreasing: bins are switches, filled by port count and PoE watts.
export function packSwitches(items, part, rules) {
  const budget = usableBudgetW(part, rules);
  const bins = [];
  for (const it of [...items].sort((a, b) => b.watts - a.watts)) {
    let bin = bins.find((b) => b.ports < part.poePorts && b.watts + it.watts <= budget);
    if (!bin) {
      bin = { ports: 0, watts: 0 };
      bins.push(bin);
    }
    bin.ports += 1;
    bin.watts += it.watts;
  }
  return bins;
}

// The switch model that serves a rack with the fewest switches, then the fewest
// ports in total. Only models that can supply the hungriest AP's port power.
export function chooseSwitch(items, switches, rules) {
  const needW = Math.max(0, ...items.map((i) => i.portPowerW));
  const candidates = Object.values(switches).filter((s) => s.maxPortPowerW >= needW);
  if (!candidates.length) return null;
  let best = null;
  for (const part of candidates) {
    const bins = packSwitches(items, part, rules);
    const score = [bins.length, bins.length * part.poePorts];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]))
      best = { part, bins, score };
  }
  return best;
}

// Access switch capacity against its uplinks.
export function oversubscription({ apCount, apPortGbps, switches, uplinksPerSwitch, uplinkGbps }) {
  const uplink = switches * uplinksPerSwitch * uplinkGbps;
  const access = apCount * apPortGbps;
  return { accessGbps: access, uplinkGbps: uplink, ratio: uplink > 0 ? access / uplink : Infinity };
}

// Rack space, power and heat. Units: switches, patch panels, fibre panels and
// one cable manager for every two devices. Heat: the switches' own draw plus the
// conversion loss of the PoE supplies (15 %).
export function rackEngineering({ rack, switches, switchPart, patchPanels, fibrePanels, poeAllocatedW, rules }) {
  const devices = switches + patchPanels + fibrePanels;
  const managers = Math.ceil(devices / 2);
  const unitsUsed = switches * (switchPart.rackUnits || 1) + patchPanels + fibrePanels + managers;
  const unitsTotal = rack.rackUnits || 42;
  const unitsUsable = Math.floor(unitsTotal * (1 - rules.rackSpareFraction));
  const baseW = switches * (switchPart.baseWatts || 0);
  const powerW = baseW + poeAllocatedW;
  const heatW = baseW + 0.15 * poeAllocatedW;
  const issues = [];
  if (unitsUsed > unitsUsable)
    issues.push(`needs ${unitsUsed} U but only ${unitsUsable} U of ${unitsTotal} U is usable (${Math.round(rules.rackSpareFraction * 100)}% kept spare)`);
  if (Number.isFinite(rack.powerW) && powerW > rack.powerW)
    issues.push(`draws up to ${Math.round(powerW)} W but the room supplies ${rack.powerW} W`);
  if (Number.isFinite(rack.coolingW) && heatW > rack.coolingW)
    issues.push(`gives off ${Math.round(heatW)} W of heat but the cooling is ${rack.coolingW} W`);
  return {
    unitsUsed, unitsTotal, unitsUsable, managers,
    powerW: Math.round(powerW), heatW: Math.round(heatW), heatBtuHr: Math.round(heatW * 3.412),
    issues,
  };
}
