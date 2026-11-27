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
// the built-in parts plus the ones the project imported (same id: the import wins)
export const dasCatalogue = (plan) => {
  const own = cellularOf(plan).catalogue;
  return {
    ...DEFAULT_CATALOGUE,
    antennas: antennaModels(plan),
    splitters: { ...DEFAULT_CATALOGUE.splitters, ...own.splitters },
    couplers: { ...DEFAULT_CATALOGUE.couplers, ...own.couplers },
    inline: { ...DEFAULT_CATALOGUE.inline, ...own.inline },
    risers: { ...DEFAULT_CATALOGUE.risers, ...own.risers },
    cables: { ...DEFAULT_CATALOGUE.cables, ...own.cables },
  };
};

// A new part placed on the plan.
// partId: the type chosen in the tool bar (2/3/4-way, coupler dB, combiner), else the usual one
export function newDasPart(plan, dasType, floorId, { x, z }, id, { partId } = {}) {
  const n = dasParts(plan).filter((s) => s.dasType === dasType).length + 1;
  const part = (fallback) => ({ partId: partId || fallback });
  return {
    id,
    floorId,
    kind: "das",
    dasType,
    name: `${DAS_TYPES[dasType].short}${n}`,
    x,
    z,
    heightM: 3,
    ...(dasType === "splitter" ? part("s2") : {}),
    ...(dasType === "coupler" ? part("c10") : {}),
    ...(dasType === "combiner" ? part("cm21") : {}),
    ...(dasType === "riser" ? part("riser") : {}),
    ...(dasType === "source" ? { powerDbm: {} } : {}),
  };
}

const elevationOf = (plan, floorId) => Number(plan.floors.find((f) => f.id === floorId)?.elevation) || 0;

// The route of a cable: its start, the bends clicked while drawing it
// (points: [{ floorId, x, z }]) and its end.
export function cableRoute(plan, cable) {
  const at = (id) => plan.sources.find((s) => s.id === id);
  const a = at(cable.from);
  const b = at(cable.to);
  if (!a || !b) return [];
  const node = (s) => ({ floorId: s.floorId, x: +s.x, z: +s.z });
  return [node(a), ...(cable.points || []).map((p) => ({ floorId: p.floorId ?? a.floorId, x: +p.x, z: +p.z })), node(b)];
}

// Cable length: the run along its route on the plan, the height between floors
// and any extra length typed (up and down walls, slack). A jumper is its fixed length.
export function cableLengthM(plan, cable) {
  const extra = Number(cable.extraM) || 0;
  const fixed = dasCatalogue(plan).cables[cable.cableId]?.fixedLengthM;
  if (fixed) return fixed + extra;
  const route = cableRoute(plan, cable);
  if (route.length < 2) return extra;
  let flat = 0;
  for (let i = 1; i < route.length; i++)
    if (route[i].floorId === route[i - 1].floorId) flat += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
  const rise = Math.abs(elevationOf(plan, route[0].floorId) - elevationOf(plan, route[route.length - 1].floorId));
  return flat + rise + extra;
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
    const ways = dasCatalogue(plan).splitters[from.partId]?.ways ?? 2;
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
// cableId: the type chosen in the tool bar; "auto" (or none) = 7/8" in the shaft, else 1/2".
// points: the bends clicked while drawing.
// port: the output of the start part (chosen in the port picker), else its first free one.
export function newCable(plan, fromId, toId, id, { cableId = "auto", points = [], port } = {}) {
  const from = plan.sources.find((s) => s.id === fromId);
  const to = plan.sources.find((s) => s.id === toId);
  const free = from ? outputPorts(plan, from).filter((p) => !p.cableId) : [];
  const outPort = free.some((p) => p.id === port) ? port : free[0]?.id;
  // a cable in the shaft (to or from a riser, or between floors) is the riser feeder
  const riser = from?.dasType === "riser" || to?.dasType === "riser" || (from && to && from.floorId !== to.floorId);
  const chosen = dasCatalogue(plan).cables[cableId] ? cableId : riser ? RISER_CABLE_ID : DEFAULT_CABLE_ID;
  return {
    id,
    from: fromId,
    to: toId,
    cableId: chosen,
    ...(points.length ? { points } : {}),
    extraM: 0,
    connectors: 2,
    ...(outPort ? { port: outPort } : {}),
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
        // the engine needs the port of a coupler output (through / tap); other ports are labels
        ...(items.get(c.from)?.dasType === "coupler" ? { port: c.port || "through" } : {}),
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

// How many outputs a part has and how many are used (splitter ways, coupler
// through + tap, one for a riser / combiner / source).
export function partOutputs(plan, part) {
  const ports = outputPorts(plan, part);
  return { total: ports.length, used: ports.filter((p) => p.cableId).length, ports };
}

// The plan without DAS cables whose start or end no longer exists (a deleted
// floor, part or antenna takes its cables with it).
export function withoutLooseCables(plan) {
  const cables = plan.cellular?.cables;
  if (!Array.isArray(cables) || !cables.length) return plan;
  const ids = new Set((plan.sources || []).map((s) => s.id));
  const kept = cables.filter((c) => ids.has(c.from) && ids.has(c.to));
  return kept.length === cables.length ? plan : { ...plan, cellular: { ...plan.cellular, cables: kept } };
}

// The plan with the bends of every cable whose both ends are in `moved` changed by fn(point).
export function moveCableBends(plan, moved, fn) {
  const cables = plan.cellular?.cables;
  if (!Array.isArray(cables) || !cables.some((c) => c.points?.length && moved.has(c.from) && moved.has(c.to))) return plan;
  return {
    ...plan,
    cellular: {
      ...plan.cellular,
      cables: cables.map((c) =>
        c.points?.length && moved.has(c.from) && moved.has(c.to) ? { ...c, points: c.points.map((p) => ({ ...p, ...fn(p) })) } : c,
      ),
    },
  };
}

// ---------- ports ----------
// Connector of each part (datasheets: splitters, couplers, antennas N female;
// combiners 4.3-10 female).
export const connectorOf = (item) => (item?.dasType === "combiner" ? "4.3-10 female" : "N female");

const portLabel = (id) =>
  ({ in: "In", through: "Through", tap: "Tap", out: "Out", ant: "Ant" })[id] || id.replace(/^out(\d+)$/, "Out $1");

// The output ports of a part, each with the cable that uses it (if any).
// Cables saved before ports existed take the free ports in drawing order.
export function outputPorts(plan, part) {
  if (!part || part.kind !== "das") return [];
  const cables = cellularOf(plan).cables.filter((c) => c.from === part.id);
  const ids =
    part.dasType === "splitter"
      ? Array.from({ length: dasCatalogue(plan).splitters[part.partId]?.ways ?? 2 }, (_, i) => `out${i + 1}`)
      : part.dasType === "coupler"
        ? ["through", "tap"]
        : part.dasType === "source"
          ? Array.from({ length: Math.max(1, cables.length + 1) }, (_, i) => `out${i + 1}`) // a source feeds as many trunks as needed
          : ["out"];
  const ports = ids.map((id) => ({ id, label: portLabel(id), cableId: null }));
  const unplaced = [];
  for (const c of cables) {
    const p = ports.find((x) => x.id === c.port && !x.cableId);
    if (p) p.cableId = c.id;
    else unplaced.push(c);
  }
  for (const c of unplaced) {
    const p = ports.find((x) => !x.cableId);
    if (p) p.cableId = c.id;
  }
  return ports;
}

// Every port of a part or antenna with what it connects to, for the tooltip:
// [{ id, label, dir: "in" | "out", other: name | null, otherPort }]
export function portsOf(plan, item) {
  const cables = cellularOf(plan).cables;
  const name = (id) => plan.sources.find((s) => s.id === id)?.name || "?";
  const input = cables.find((c) => c.to === item.id);
  const inPort = item.kind === "cellular" ? "ant" : "in";
  const list = [];
  if (item.dasType !== "source")
    list.push({ id: inPort, label: portLabel(inPort), dir: "in", other: input ? name(input.from) : null, otherPort: input ? cablePortLabel(plan, input) : null });
  for (const p of outputPorts(plan, item)) {
    const c = p.cableId ? cables.find((x) => x.id === p.cableId) : null;
    const end = c ? plan.sources.find((s) => s.id === c.to) : null;
    list.push({ id: p.id, label: p.label, dir: "out", other: c ? name(c.to) : null, otherPort: c ? (end?.kind === "cellular" ? "Ant" : "In") : null });
  }
  return list;
}

// The output port a cable leaves from, as a label ("Out 2", "Tap").
export function cablePortLabel(plan, cable) {
  const from = plan.sources.find((s) => s.id === cable.from);
  const p = outputPorts(plan, from).find((x) => x.cableId === cable.id);
  return p ? p.label : "";
}

// ---------- drawing a cable in either order ----------
// True when the part is a source or gets its signal from one through cables.
function fedFromSource(plan, id) {
  const cables = cellularOf(plan).cables;
  const seen = new Set();
  for (let at = id; at && !seen.has(at); ) {
    seen.add(at);
    const item = plan.sources.find((s) => s.id === at);
    if (item?.dasType === "source") return true;
    at = cables.find((c) => c.to === at)?.from;
  }
  return false;
}

// The direction of a cable between the two clicked items: the signal flows
// from the source side toward the antennas. Returns { from, to } or { problem }.
export function orientCable(plan, firstId, secondId) {
  const a = plan.sources.find((s) => s.id === firstId);
  const b = plan.sources.find((s) => s.id === secondId);
  if (!a || !b) return { problem: "A cable joins two DAS parts or antennas." };
  if (a.kind === "cellular" && b.kind === "cellular") return { problem: "A cable cannot join two antennas: put a splitter or coupler between them." };
  if (b.kind === "cellular") return { from: a.id, to: b.id };
  if (a.kind === "cellular") return { from: b.id, to: a.id };
  if (a.dasType === "source") return { from: a.id, to: b.id };
  if (b.dasType === "source") return { from: b.id, to: a.id };
  const fa = fedFromSource(plan, a.id);
  const fb = fedFromSource(plan, b.id);
  if (fb && !fa) return { from: b.id, to: a.id };
  return { from: a.id, to: b.id };
}
