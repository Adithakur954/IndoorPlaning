// Suggests where racks (the rooms that hold the switches) could go.
//
// For each floor with APs it scores candidate locations by the cable they
// would need, and picks racks greedily: the location that brings the most APs
// inside the permanent-link limit, then the one with the shortest total cable;
// then another for the APs still out of reach. A suggestion is only a starting
// point: the plan carries no data on power, ventilation, security or space, so
// every rack is marked "to confirm".
import { floorRoutingInput } from "../core/planGeometry.js";
import { buildRoutingGrid, pathTo, shortestFrom } from "../core/routing.js";
import { areaOf, inside, pointsOf } from "../../utils/geometry.js";
import { DEFAULT_WIFI_RULES } from "./catalogue.js";
import { permanentLinkLengthM } from "./design.js";

// Rooms we would not put switches in, and rooms that suit them.
const UNSUITABLE = /bath|toilet|wc|restroom|shower|kitchen|lift|elevator|stair|garage|parking/i;
const PREFERRED = /server|comms?\b|data|network|rack|it room|electrical|utility|riser|store/i;
const MIN_ROOM_AREA_M2 = 3;

const containsAnother = (room, rooms) =>
  rooms.some(
    (other) =>
      other.id !== room.id &&
      pointsOf(other).every((p) => inside(p.x, p.z, room)) &&
      areaOf(other) < areaOf(room),
  );

function centreOf(room) {
  const pts = pointsOf(room);
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  if (inside(x, z, room)) return { x, z };
  // a bent room whose average point falls outside it: nearest inside point
  let best = null;
  for (const p of pts)
    for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      const q = { x: p.x + dx, z: p.z + dz };
      if (inside(q.x, q.z, room)) {
        const d = Math.hypot(q.x - x, q.z - z);
        if (!best || d < best.d) best = { ...q, d };
      }
    }
  return best ? { x: best.x, z: best.z } : null;
}

const WALL_SETBACK_M = 0.6; // a rack stands against a wall, not in it
const NEAR_WALL_M = 0.4;

const distToSegment = (p, a, b) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

// Points a short way in from the middle of each edge of a polygon, on the side
// that is inside the shape.
function insetEdgePoints(points, isInside, setback) {
  const out = [];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1.5) return;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    for (const side of [1, -1]) {
      const q = { x: mid.x + side * nx * setback, z: mid.z + side * nz * setback };
      if (isInside(q.x, q.z)) out.push(q);
    }
  });
  return out;
}

function candidatesOnFloor(plan, floorId, input, floorAps, rules) {
  const rooms = (plan.rooms || []).filter((r) => r.floorId === floorId);
  const clear = (p) =>
    floorAps.every((ap) => Math.hypot(ap.x - p.x, ap.z - p.z) >= rules.rackClearanceM);
  const offWalls = (p) =>
    input.walls.every((w) => distToSegment(p, w.a, w.b) >= NEAR_WALL_M);
  const out = [];
  for (const room of rooms) {
    if (UNSUITABLE.test(room.name || "")) continue;
    if (areaOf(room) < MIN_ROOM_AREA_M2) continue;
    if (containsAnother(room, rooms)) continue; // an open floor around other rooms
    const roomName = room.name || "Room";
    const preferred = PREFERRED.test(room.name || "");
    // the centre, and points against the room's own walls
    const points = [centreOf(room), ...insetEdgePoints(pointsOf(room), (x, z) => inside(x, z, room), WALL_SETBACK_M)];
    for (const p of points)
      if (p && inside(p.x, p.z, room) && clear(p))
        out.push({ ...p, roomName, preferred, fallback: false });
  }
  if (out.length) return out;

  // No suitable room has a free spot (or there are none): points against the
  // building's walls. These are fallbacks and are flagged for confirmation.
  const seen = new Set();
  for (const w of input.walls) {
    const pts = insetEdgePoints([w.a, w.b], input.footprint, WALL_SETBACK_M);
    for (const p of pts)
      if (clear(p) && offWalls(p)) {
        const key = `${Math.round(p.x)},${Math.round(p.z)}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ ...p, roomName: "Along a wall", preferred: false, fallback: true });
        }
      }
  }
  return out;
}

// ---- choosing racks ----------------------------------------------------------------
// A set of racks is feasible when every AP is within the cable limit of a rack that
// still has room (capacity). Its cost is the total cable of the assignment; a rack
// in a room that suits equipment counts half.
const MAX_COMBINATIONS = 60000;

// Assign each AP to the cheapest rack in the set that has room. null if one cannot be served.
function assign(set, nAps, limit, capacity) {
  const left = new Map(set.map((c) => [c, capacity]));
  const options = [];
  for (let i = 0; i < nAps; i++) {
    const o = set
      .filter((c) => c.links[i] <= limit)
      .map((c) => ({ c, cost: c.links[i] * (c.preferred ? 0.5 : 1) }))
      .sort((a, b) => a.cost - b.cost);
    if (!o.length) return null;
    options.push({ i, o });
  }
  // the APs with the fewest choices, then the most to lose, go first
  options.sort((a, b) => a.o.length - b.o.length || (b.o[1]?.cost ?? 1e9) - (b.o[0].cost) - ((a.o[1]?.cost ?? 1e9) - a.o[0].cost));
  const of = new Map();
  let cost = 0;
  for (const { i, o } of options) {
    const pick = o.find((x) => left.get(x.c) > 0);
    if (!pick) return null;
    left.set(pick.c, left.get(pick.c) - 1);
    of.set(i, pick.c);
    cost += pick.cost;
  }
  return { cost, of };
}

function* combinations(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

const binomial = (n, k) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

// The fewest racks that serve every AP, then the least cable. Exact when the number of
// combinations is small; otherwise a greedy start improved by swapping racks. Returns
// null when no set of at most maxRacks racks serves every AP.
export function solveRacks(candidates, nAps, { limit, maxRacks, capacity = Infinity }) {
  const n = candidates.length;
  if (!n || !nAps) return null;
  for (let k = 1; k <= Math.min(maxRacks, n); k++) {
    let best = null;
    if (binomial(n, k) <= MAX_COMBINATIONS) {
      for (const comb of combinations(n, k)) {
        const set = comb.map((i) => candidates[i]);
        const r = assign(set, nAps, limit, capacity);
        if (r && (!best || r.cost < best.cost - 1e-9)) best = { set, ...r };
      }
    } else {
      // too many to try: greedy cover of k racks, then improve by swapping one rack at a time
      let set = [];
      for (let step = 0; step < k; step++) {
        let pick = null;
        for (const c of candidates) {
          if (set.includes(c)) continue;
          const reach = [...Array(nAps).keys()].filter((i) => c.links[i] <= limit && !set.some((s) => s.links[i] <= limit)).length;
          if (!pick || reach > pick.reach) pick = { c, reach };
        }
        set = [...set, pick.c];
      }
      let current = assign(set, nAps, limit, capacity);
      for (let round = 0; round < 6; round++) {
        let improved = false;
        for (let s = 0; s < set.length; s++)
          for (const c of candidates) {
            if (set.includes(c)) continue;
            const trial = set.map((x, i) => (i === s ? c : x));
            const r = assign(trial, nAps, limit, capacity);
            if (r && (!current || r.cost < current.cost - 1e-9)) {
              set = trial;
              current = r;
              improved = true;
            }
          }
        if (!improved) break;
      }
      if (current) best = { set, ...current };
    }
    if (best) {
      const counts = new Map(best.set.map((c) => [c, { reach: 0, linkM: 0 }]));
      for (const [i, c] of best.of) {
        counts.get(c).reach += 1;
        counts.get(c).linkM += c.links[i];
      }
      return best.set.map((c) => ({ ...c, reach: counts.get(c).reach, linkM: counts.get(c).linkM }));
    }
  }
  return null;
}

// racksPerFloor: the most racks to suggest on one floor.
export function suggestRacks({
  plan,
  rules: overrides = {},
  pathway = {},
  maxRacksPerFloor = 3,
  floorIds,
}) {
  const rules = { ...DEFAULT_WIFI_RULES, ...overrides };
  const racks = [];
  const notes = [];
  const uncovered = [];
  const aps = (plan.sources || []).filter((s) => s.kind === "wifi");

  for (const floor of plan.floors || []) {
    if (floorIds && !floorIds.includes(floor.id)) continue;
    const floorAps = aps.filter((a) => a.floorId === floor.id);
    if (!floorAps.length) continue;
    const input = floorRoutingInput(plan, floor.id, pathway);
    if (!input) {
      notes.push(`${floor.name || floor.id}: no rooms or boundary to place a rack in.`);
      continue;
    }
    const grid = buildRoutingGrid({ ...input, cellM: rules.cellM });
    const trayHeightM = input.ceilingM - rules.trayBelowCeilingM;
    const candidates = candidatesOnFloor(plan, floor.id, input, floorAps, rules);

    // permanent link from each candidate to each AP
    const scored = candidates.map((c) => {
      const tree = shortestFrom(grid, c, {
        crossPenaltyM: rules.crossPenaltyM,
        permitPenaltyM: rules.permitPenaltyM,
        trayFactor: rules.trayFactor,
        turnPenaltyM: rules.turnPenaltyM,
      });
      const links = floorAps.map((ap) => {
        const route = pathTo(grid, tree, c, ap);
        if (!route) return Infinity;
        const apDropM = Math.max(0, trayHeightM - (Number(ap.heightM) || 0));
        return permanentLinkLengthM(route.horizontalM, apDropM, rules);
      });
      return { ...c, links };
    });

    let remaining = new Set(floorAps.map((_, i) => i));
    const chosen = [];
    // first try to serve every AP with the fewest racks (and room in each rack)
    const solved = solveRacks(scored, floorAps.length, {
      limit: rules.maxPermanentLinkM,
      maxRacks: maxRacksPerFloor,
      capacity: Number.isFinite(rules.maxApsPerRack) ? rules.maxApsPerRack : Infinity,
    });
    if (solved) {
      chosen.push(...solved);
      remaining = new Set();
    }
    while (!solved && remaining.size && chosen.length < maxRacksPerFloor) {
      let best = null;
      for (const c of scored) {
        if (chosen.includes(c)) continue;
        const reach = [...remaining].filter((i) => c.links[i] <= rules.maxPermanentLinkM);
        if (!reach.length) continue;
        const total = reach.reduce((s, i) => s + c.links[i], 0) * (c.preferred ? 0.5 : 1);
        if (
          !best ||
          reach.length > best.reach.length ||
          (reach.length === best.reach.length && total < best.total)
        )
          best = { c, reach, total };
      }
      if (!best) break;
      chosen.push(best.c);
      best.c.reach = best.reach.length;
      best.c.linkM = best.reach.reduce((s, i) => s + best.c.links[i], 0);
      for (const i of best.reach) remaining.delete(i);
    }

    chosen.forEach((c, i) =>
      racks.push({
        id: `suggested-${floor.id}-${i + 1}`,
        name: `Rack ${racks.filter((r) => r.floorId === floor.id).length + 1} (suggested)`,
        floorId: floor.id,
        x: Math.round(c.x * 100) / 100,
        z: Math.round(c.z * 100) / 100,
        roomName: c.roomName,
        covers: c.reach,
        suggested: true,
        needsRoom: c.fallback,
      }),
    );
    if (!candidates.length)
      notes.push(
        `${floor.name || floor.id}: no spot keeps ${rules.rackClearanceM} m clear of the APs. Place a rack by hand.`,
      );
    if (chosen.some((c) => c.fallback))
      notes.push(
        `${floor.name || floor.id}: no suitable room was found, so the rack is placed along a wall. Confirm a real equipment room, or place it by hand.`,
      );
    if (chosen.length > 1)
      notes.push(
        `${floor.name || floor.id}: one rack leaves some APs beyond ${rules.maxPermanentLinkM} m, so ${chosen.length} racks are suggested.`,
      );
    for (const i of remaining) {
      uncovered.push({ apId: floorAps[i].id, apName: floorAps[i].name || floorAps[i].id, floorId: floor.id });
    }
    if (remaining.size)
      notes.push(
        `${floor.name || floor.id}: ${remaining.size} AP(s) cannot be reached within ${rules.maxPermanentLinkM} m from any candidate (up to ${maxRacksPerFloor} racks tried). Add a rack by hand, a riser, or move the APs.`,
      );
  }
  if (racks.length)
    notes.push(
      "Confirm each rack with the client: the plan has no data on electrical supply, ventilation, security or free space.",
    );
  return { racks, uncovered, notes };
}
