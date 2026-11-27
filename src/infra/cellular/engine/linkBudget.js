// Link budget of a passive DAS tree. Pure functions.
//
// network = {
//   rootId: "bts",
//   nodes: { id: { type: "bts" | "coupler" | "splitter" | "inline" | "riser" | "antenna",
//                  partId, ... } },
//   edges: [{ from, to, cableId, lengthM, port?: "through" | "tap",
//             connectors?: number }]
// }
// A coupler has at most one "through" and one "tap" child. A splitter has as
// many children as it has ways. An edge is one cable run plus its connectors.

import {
  cableLossDb,
  couplerTapLossDb,
  couplerThroughLossDb,
  splitterLossDb,
} from "./passive.js";
import { dbmToMw, mwToDbm, thermalNoiseDbm, wattsToDbm } from "./rf.js";

function childrenOf(network) {
  const map = new Map();
  const parents = new Map();
  for (const edge of network.edges) {
    if (!network.nodes[edge.from] || !network.nodes[edge.to])
      throw new Error(`edge ${edge.from} -> ${edge.to} uses an unknown node`);
    if (parents.has(edge.to))
      throw new Error(`node ${edge.to} has two parents; the network must be a tree`);
    parents.set(edge.to, edge.from);
    (map.get(edge.from) || map.set(edge.from, []).get(edge.from)).push(edge);
  }
  return map;
}

function part(catalogue, group, id, nodeId) {
  const found = catalogue[group]?.[id];
  if (!found) throw new Error(`node ${nodeId}: ${group} part "${id}" is not in the catalogue`);
  return found;
}

// Loss a node adds to the branch leaving through the given edge.
function nodeLossDb(node, nodeId, edge, edgeCount, catalogue) {
  switch (node.type) {
    case "bts":
    case "antenna":
    case "riser": // a point where the cable changes floor: no loss of its own
      return 0;
    case "coupler": {
      const coupler = part(catalogue, "couplers", node.partId, nodeId);
      if (edge.port === "tap") return couplerTapLossDb(coupler);
      if (edge.port === "through") return couplerThroughLossDb(coupler);
      throw new Error(`coupler ${nodeId}: each outgoing edge needs port "through" or "tap"`);
    }
    case "splitter": {
      const splitter = part(catalogue, "splitters", node.partId, nodeId);
      if (edgeCount > splitter.ways)
        throw new Error(`splitter ${nodeId} has ${edgeCount} outputs but is a ${splitter.ways}-way part`);
      return splitterLossDb(splitter);
    }
    case "inline":
      return part(catalogue, "inline", node.partId, nodeId).lossDb;
    default:
      throw new Error(`node ${nodeId} has unknown type "${node.type}"`);
  }
}

function ratingOf(node, nodeId, catalogue) {
  const group = { coupler: "couplers", splitter: "splitters", inline: "inline" }[node.type];
  if (!group) return null;
  const watts = part(catalogue, group, node.partId, nodeId).maxPowerW;
  return Number.isFinite(watts) ? wattsToDbm(watts) : null;
}

export function edgeLossDb(edge, catalogue, freqMHz) {
  const cable = part(catalogue, "cables", edge.cableId, `${edge.from}->${edge.to}`);
  const connectors = edge.connectors ?? 2;
  return {
    cableDb: cableLossDb(cable, edge.lengthM, freqMHz),
    connectorsDb: connectors * (catalogue.connector?.lossDb ?? 0),
  };
}

// Downlink: power at every antenna port for one band.
//   btsPowerDbm = total power the BTS delivers to the network for this band.
// Returns antennas[id] = { powerDbm, pathLossDb, steps[] } plus warnings.
export function computeDownlink({ network, catalogue, freqMHz, btsPowerDbm }) {
  const edgesFrom = childrenOf(network);
  const antennas = {};
  const nodeInputDbm = {};
  const warnings = [];
  const seen = new Set();

  const walk = (nodeId, powerDbm, steps) => {
    if (seen.has(nodeId)) throw new Error(`node ${nodeId} is reached twice`);
    seen.add(nodeId);
    const node = network.nodes[nodeId];
    nodeInputDbm[nodeId] = powerDbm;
    const rating = ratingOf(node, nodeId, catalogue);
    if (rating !== null && powerDbm > rating)
      warnings.push(
        `${nodeId}: input ${powerDbm.toFixed(1)} dBm is above the part's rating of ${rating.toFixed(1)} dBm`,
      );
    const out = edgesFrom.get(nodeId) || [];
    if (node.type === "antenna") {
      const antenna = part(catalogue, "antennas", node.partId, nodeId);
      antennas[nodeId] = {
        powerDbm,
        pathLossDb: btsPowerDbm - powerDbm,
        gainDbi: antenna.gainDbi,
        eirpDbm: powerDbm + antenna.gainDbi,
        steps,
      };
      if (out.length) throw new Error(`antenna ${nodeId} cannot have outgoing cables`);
      return;
    }
    for (const edge of out) {
      let p = powerDbm;
      const next = [...steps];
      const nodeLoss = nodeLossDb(node, nodeId, edge, out.length, catalogue);
      if (nodeLoss) {
        p -= nodeLoss;
        next.push({ kind: node.type, id: nodeId, port: edge.port ?? null, lossDb: nodeLoss, powerAfterDbm: p });
      }
      const { cableDb, connectorsDb } = edgeLossDb(edge, catalogue, freqMHz);
      p -= cableDb;
      next.push({ kind: "cable", id: `${edge.from}->${edge.to}`, cableId: edge.cableId, lengthM: edge.lengthM, lossDb: cableDb, powerAfterDbm: p });
      if (connectorsDb) {
        p -= connectorsDb;
        next.push({ kind: "connectors", id: `${edge.from}->${edge.to}`, lossDb: connectorsDb, powerAfterDbm: p });
      }
      walk(edge.to, p, next);
    }
  };

  if (!network.nodes[network.rootId] || network.nodes[network.rootId].type !== "bts")
    throw new Error("the network root must be a BTS node");
  walk(network.rootId, btsPowerDbm, []);
  const unreached = Object.keys(network.nodes).filter((id) => !seen.has(id));
  if (unreached.length)
    throw new Error(`nodes not connected to the BTS: ${unreached.join(", ")}`);
  return { antennas, nodeInputDbm, warnings };
}

// Uplink: the passive network is reciprocal, so each antenna's uplink loss to
// the BTS equals its downlink loss. This is a simplified check (thermal noise
// only; no external interference or active equipment).
//   mobileEirpDbm      : what a handset radiates (for example 23 dBm)
//   bts.bandwidthMHz   : uplink channel bandwidth
//   bts.noiseFigureDb  : BTS receiver noise figure
//   bts.requiredSnrDb  : SNR the receiver needs
export function computeUplink({ downlink, mobileEirpDbm = 23, bts }) {
  const bandwidthHz = bts.bandwidthMHz * 1e6;
  const kTB = thermalNoiseDbm(bandwidthHz);
  const btsNoise = kTB + bts.noiseFigureDb;
  const sensitivity = btsNoise + bts.requiredSnrDb;

  // Every antenna also collects thermal noise, which reaches the BTS through
  // that antenna's own path loss. More antennas, more noise ("noise funnelling").
  let funnelledMw = 0;
  const antennas = {};
  for (const [id, a] of Object.entries(downlink.antennas)) {
    funnelledMw += dbmToMw(kTB - a.pathLossDb);
    antennas[id] = {
      dasLossDb: a.pathLossDb,
      // Largest radio-path loss between a handset and this antenna that still
      // lets the BTS hear it: handset EIRP + antenna gain - DAS loss - sensitivity.
      maxAirLossDb: mobileEirpDbm + a.gainDbi - a.pathLossDb - sensitivity,
    };
  }
  const noiseRiseDb = 10 * Math.log10(1 + funnelledMw / dbmToMw(btsNoise));
  return {
    btsNoiseDbm: btsNoise,
    sensitivityDbm: sensitivity,
    funnelledNoiseDbm: funnelledMw > 0 ? mwToDbm(funnelledMw) : -Infinity,
    noiseRiseDb,
    antennas,
  };
}
