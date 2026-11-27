// The passive DAS network of a cellular project, as drawn in the editor:
//   parts  = plan sources of kind "das" (dasType "source" | "splitter" | "coupler" | "combiner" | "riser")
//   cables = plan.cellular.cables: [{ id, from, to, cableId, extraM, connectors, port? }]
// and the cellular antennas (kind "cellular") at the ends. Each source (BTS or
// repeater, one output power per band) feeds a tree; every connected antenna
// gets its port power from engine/linkBudget.js instead of a typed value.

import { computeDownlink, edgeLossDb } from "./engine/linkBudget.js";
import { DEFAULT_CATALOGUE } from "./engine/catalogue.js";
import { antennaModels, cellularOf } from "./model.js";

export const DAS_TYPES = {
  source: { label: "Source (BTS / repeater)", short: "S", engine: "bts" },
  splitter: { label: "Splitter", short: "SP", engine: "splitter" },
  coupler: { label: "Coupler", short: "C", engine: "coupler" },
  combiner: { label: "Combiner", short: "CB", engine: "inline" },
  riser: { label: "Riser", short: "R", engine: "riser" },
};
export const DEFAULT_SOURCE_POWER_DBM = 43;
// horizontal runs: the 1/2" superflex feeder of the supplied design; the riser
// (shaft, between floors): 7/8" low-loss feeder, as usual for long vertical runs
export const DEFAULT_CABLE_ID = "1/2";
export const RISER_CABLE_ID = "7/8";

export const dasParts = (plan, floorId) =>
  (plan?.sources || []).filter((s) => s.kind === "das" && (!floorId || s.floorId === floorId));

// Parts and cables: the datasheet values of engine/catalogue.js; antennas: the project's models.
export const dasCatalogue = (plan) => ({ ...DEFAULT_CATALOGUE, antennas: antennaModels(plan) });

// A new part placed on the plan.
export function newDasPart(plan, dasType, floorId, { x, z }, id) {
  const n = dasParts(plan).filter((s) => s.dasType === dasType).length + 1;
  return {
    id,
    floorId,
    kind: "das",
    dasType,
    name: `${DAS_TYPES[dasType].short}${n}`,
    x,
    z,
    heightM: 3,
    ...(dasType === "splitter" ? { partId: "s2" } : {}),
    ...(dasType === "coupler" ? { partId: "c10" } : {}),
    ...(dasType === "combiner" ? { partId: "cm21" } : {}),
    ...(dasType === "source" ? { powerDbm: {} } : {}),
  };
}

const elevationOf = (plan, floorId) => Number(plan.floors.find((f) => f.id === floorId)?.elevation) || 0;

// Cable length: the run on the plan, the height between floors and any extra
// length typed for the route (up and down walls, around obstacles).
export function cableLengthM(plan, cable) {
  const at = (id) => plan.sources.find((s) => s.id === id);
  const a = at(cable.from);
  const b = at(cable.to);
  if (!a || !b) return Number(cable.extraM) || 0;
  const flat = Math.hypot(+a.x - +b.x, +a.z - +b.z);
  const rise = Math.abs(elevationOf(plan, a.floorId) - elevationOf(plan, b.floorId));
  return flat + rise + (Number(cable.extraM) || 0);
}

// Why a new cable from -> to cannot be drawn, or null when it can.
export function cableProblem(plan, fromId, toId) {
  const nodes = new Map(plan.sources.filter((s) => s.kind === "das" || s.kind === "cellular").map((s) => [s.id, s]));
  const from = nodes.get(fromId);
  const to = nodes.get(toId);
  if (!from || !to) return "A cable joins two DAS parts or antennas.";
  if (fromId === toId) return "A cable needs two different ends.";
  if (from.kind === "cellular") return `${from.name} is an antenna: a cable starts at a source, splitter, coupler or riser.`;
  if (to.dasType === "source") return `${to.name} is a source: it can only feed cables, not receive one.`;
  const cables = cellularOf(plan).cables;
  if (cables.some((c) => c.to === toId)) return `${to.name} is already fed by a cable.`;
  const out = cables.filter((c) => c.from === fromId).length;
  if (from.dasType === "coupler" && out >= 2) return `${from.name} already has its through and tap outputs.`;
  if (from.dasType === "splitter") {
    const ways = DEFAULT_CATALOGUE.splitters[from.partId]?.ways ?? 2;
    if (out >= ways) return `${from.name} is a ${ways}-way splitter and all its outputs are used.`;
  }
  if ((from.dasType === "riser" || from.dasType === "combiner") && out >= 1)
    return `${from.name} already continues to another part.`;
  // no loops: the new end must not lead back to the start
  const below = new Set([toId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of cables)
      if (below.has(c.from) && !below.has(c.to)) {
        below.add(c.to);
        grew = true;
      }
  }
  if (below.has(fromId)) return "That cable would close a loop.";
  return null;
}

// The cable record for a new connection; a coupler's first output is "through", its second "tap".
export function newCable(plan, fromId, toId, id) {
  const from = plan.sources.find((s) => s.id === fromId);
  const to = plan.sources.find((s) => s.id === toId);
  const used = cellularOf(plan).cables.filter((c) => c.from === fromId).map((c) => c.port);
  // a cable in the shaft (to or from a riser, or between floors) is the riser feeder
  const riser = from?.dasType === "riser" || to?.dasType === "riser" || (from && to && from.floorId !== to.floorId);
  return {
    id,
    from: fromId,
    to: toId,
    cableId: riser ? RISER_CABLE_ID : DEFAULT_CABLE_ID,
    extraM: 0,
    connectors: 2,
    ...(from?.dasType === "coupler" ? { port: used.includes("through") ? "tap" : "through" } : {}),
  };
}

// Port power of every antenna fed by a source, for one band (carrier).
// { antennas: { id: { powerDbm, pathLossDb, steps, sourceId } }, nodeInputDbm, warnings, errors }
export function dasPowers(plan, carrier) {
  const out = { antennas: {}, nodeInputDbm: {}, warnings: [], errors: [] };
  if (!carrier) return out;
  const parts = dasParts(plan);
  const cables = cellularOf(plan).cables;
  const items = new Map(plan.sources.filter((s) => s.kind === "das" || s.kind === "cellular").map((s) => [s.id, s]));
  const catalogue = dasCatalogue(plan);
  const nameOf = (id) => items.get(id)?.name || id;
  for (const source of parts.filter((s) => s.dasType === "source")) {
    // the tree below this source
    const ids = new Set([source.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cables)
        if (ids.has(c.from) && !ids.has(c.to) && items.has(c.to)) {
          ids.add(c.to);
          grew = true;
        }
    }
    const nodes = {};
    for (const id of ids) {
      const s = items.get(id);
      nodes[id] =
        s.kind === "cellular"
          ? { type: "antenna", partId: s.antennaModelId }
          : { type: DAS_TYPES[s.dasType]?.engine || "inline", partId: s.partId };
    }
    const edges = cables
      .filter((c) => ids.has(c.from) && ids.has(c.to))
      .map((c) => ({
        from: c.from,
        to: c.to,
        cableId: c.cableId || DEFAULT_CABLE_ID,
        lengthM: cableLengthM(plan, c),
        connectors: Number.isFinite(Number(c.connectors)) ? Number(c.connectors) : 2,
        ...(c.port ? { port: c.port } : {}),
      }));
    const power = Number(source.powerDbm?.[carrier.id] ?? source.defaultPowerDbm ?? DEFAULT_SOURCE_POWER_DBM);
    try {
      const r = computeDownlink({
        network: { rootId: source.id, nodes, edges },
        catalogue,
        freqMHz: Number(carrier.freqMHz),
        btsPowerDbm: power,
      });
      for (const [id, a] of Object.entries(r.antennas)) out.antennas[id] = { ...a, sourceId: source.id };
      Object.assign(out.nodeInputDbm, r.nodeInputDbm);
      out.warnings.push(...r.warnings.map((w) => w.replace(/^(\S+):/, (_, id) => `${nameOf(id)}:`)));
    } catch (e) {
      out.errors.push(`${source.name}: ${String(e.message).replace(/\b([0-9a-f-]{36})\b/g, (id) => nameOf(id))}`);
    }
  }
  return out;
}

// Loss of one cable at a frequency (for its inspector).
export function cableLossAt(plan, cable, freqMHz) {
  try {
    const { cableDb, connectorsDb } = edgeLossDb(
      { ...cable, cableId: cable.cableId || DEFAULT_CABLE_ID, lengthM: cableLengthM(plan, cable) },
      dasCatalogue(plan),
      Number(freqMHz),
    );
    return { cableDb, connectorsDb, totalDb: cableDb + connectorsDb };
  } catch (e) {
    return { error: e.message };
  }
}
