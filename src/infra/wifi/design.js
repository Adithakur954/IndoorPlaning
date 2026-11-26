// Wi-Fi cabling design: from the placed APs, the racks and the risers to cable
// runs, switches, a bill of quantities and a list of checks.
//
// Every AP gets one home-run cable. The candidate racks are every rack on the
// AP's own floor, plus (when risers exist) every rack on another floor, reached
// through a riser. The cheapest candidate with spare capacity wins. Pure
// function of its inputs: the same plan and options give the same design.
import { Boq } from "../core/boq.js";
import { floorRoutingInput } from "../core/planGeometry.js";
import {
  buildRoutingGrid,
  joinRoutes,
  markRoute,
  newUsage,
  pathTo,
  shortestFrom,
  trayBreakdown,
  trayLengthM,
} from "../core/routing.js";
import { floorPowerRoutes, pathwayStated, roomCeiling, withDefaults } from "../core/pathway.js";
import { areaOf, inside } from "../../utils/geometry.js";
import { STATUS_TEXT, approvalSummary } from "./approval.js";
import { DEFAULT_WIFI_CATALOGUE, DEFAULT_WIFI_RULES } from "./catalogue.js";
import { POE_TYPES, loopResistanceOhm, poeLink } from "./ethernet.js";
import { STANDARD_STRANDS, chooseSwitch, oversubscription, packSwitches, rackEngineering, strandsFor, usableBudgetW } from "./network.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---- incremental recalculation ------------------------------------------------------
// The routing grid of a floor (and the shortest-path trees from a rack) depend only
// on the building geometry and the pathway settings, not on where APs are. They are
// kept between calculations, so moving an AP or a rack does not rebuild the floor.
const MAX_CACHED_FLOORS = 24;
const routingCache = new Map(); // signature -> { input, grid, trees }
const cacheStats = { hits: 0, misses: 0 };
export const routingCacheStats = () => ({ ...cacheStats, size: routingCache.size });
export const clearRoutingCache = () => {
  routingCache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
};

// FNV-1a hash of a string: a short, stable signature of what a floor's routing depends on.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
const onFloor = (list, floorId) => (list || []).filter((x) => x.floorId === floorId);
function floorSignature(plan, floorId, pathway, cellM) {
  const p = withDefaults(pathway);
  return hash(
    JSON.stringify([
      floorId, cellM,
      onFloor(plan.rooms, floorId), onFloor(plan.doors, floorId), onFloor(plan.windows, floorId),
      onFloor(plan.interiorWalls, floorId), onFloor(plan.boundaries, floorId),
      onFloor(plan.furniture, floorId).filter((f) => /column|pillar/i.test(f.kind || "")),
      plan.wallTypes || null,
      p.ceiling, p.roomOverrides, p.wallOverrides, p.columnsBlock,
      onFloor(p.trays, floorId), onFloor(p.noGo, floorId), onFloor(p.powerRoutes, floorId),
    ]),
  );
}
const label = (x) => x.name || x.id;

// Permanent link: the route and drops, the fixed allowances at both ends, and
// the slack. One formula, used by the design and by the rack suggestion.
export const permanentLinkLengthM = (horizontalM, verticalM, rules) =>
  (horizontalM + verticalM + rules.rackDropM + rules.apLoopM + rules.rackLoopM) *
  (1 + rules.slackFraction);

// racks:  [{ id, name?, floorId, x, z, maxAps? }]
// risers: [{ id, name?, x, z, floorIds? }]   a vertical shaft at x, z
export function designWifiCabling({
  plan,
  racks = [],
  risers = [],
  pathway = {}, // ceiling and wall settings: what the cable may pass (see core/pathway.js)
  catalogue = DEFAULT_WIFI_CATALOGUE,
  rules: overrides = {},
}) {
  const rules = { ...DEFAULT_WIFI_RULES, ...overrides };
  const stated = pathwayStated(pathway);
  const violations = [];
  const boq = new Boq();

  const cable = catalogue.cables[rules.cablePartId];
  const autoSwitch = rules.switchPartId === "auto";
  const switchPart = autoSwitch ? Object.values(catalogue.switches)[0] : catalogue.switches[rules.switchPartId];
  if (!cable) throw new Error(`cable part "${rules.cablePartId}" is not in the catalogue`);
  if (!switchPart) throw new Error(`switch part "${rules.switchPartId}" is not in the catalogue`);

  const floors = plan.floors || [];
  const floorById = new Map(floors.map((f) => [f.id, f]));
  const elevationOf = (id) => Number(floorById.get(id)?.elevation) || 0;
  const aps = (plan.sources || []).filter((s) => s.kind === "wifi" && floorById.has(s.floorId));
  const apPartOf = (ap) => {
    const part = catalogue.accessPoints[ap.apPartId || rules.apPartId];
    if (!part)
      throw new Error(`AP part "${ap.apPartId || rules.apPartId}" is not in the catalogue`);
    return part;
  };

  // ---- routing data per floor, built once -----------------------------------
  const floorData = new Map();
  const dataOf = (floorId) => {
    if (!floorData.has(floorId)) {
      const signature = floorSignature(plan, floorId, pathway, rules.cellM);
      let entry = routingCache.get(signature);
      if (entry) {
        cacheStats.hits++;
        routingCache.delete(signature); // most recently used last
        routingCache.set(signature, entry);
      } else {
        cacheStats.misses++;
        const input = floorRoutingInput(plan, floorId, pathway);
        entry = input ? { input, grid: buildRoutingGrid({ ...input, cellM: rules.cellM }), trees: new Map() } : null;
        if (entry) {
          routingCache.set(signature, entry);
          while (routingCache.size > MAX_CACHED_FLOORS) routingCache.delete(routingCache.keys().next().value);
        }
      }
      floorData.set(floorId, entry);
    }
    return floorData.get(floorId);
  };
  // trees depend on the routing costs as well as on where the rack is
  const costKey = `${rules.crossPenaltyM}|${rules.permitPenaltyM}|${rules.turnPenaltyM}|${rules.trayFactor}`;
  // shortest-path tree from a point on a floor (cached by point)
  const treeFrom = (floorId, point) => {
    const data = dataOf(floorId);
    if (!data) return null;
    const key = `${point.x},${point.z}|${costKey}`;
    if (data.trees.size >= 64) data.trees.delete(data.trees.keys().next().value); // bound the memory
    if (!data.trees.has(key))
      data.trees.set(
        key,
        shortestFrom(data.grid, point, {
          crossPenaltyM: rules.crossPenaltyM,
          permitPenaltyM: rules.permitPenaltyM,
          trayFactor: rules.trayFactor,
          turnPenaltyM: rules.turnPenaltyM,
        }),
      );
    return data.trees.get(key);
  };
  const routeOnFloor = (floorId, from, to) => {
    const data = dataOf(floorId);
    const tree = treeFrom(floorId, from);
    return data && tree ? pathTo(data.grid, tree, from, to) : null;
  };
  const pointsOf = (floorId, route) => {
    const { grid } = dataOf(floorId);
    return route.cells.map((c) => ({
      x: grid.centerX(c % grid.nx),
      z: grid.centerZ(Math.floor(c / grid.nx)),
    }));
  };
  const trayHeightOf = (floorId) =>
    dataOf(floorId).input.ceilingM - rules.trayBelowCeilingM;

  // ---- every AP: its candidate routes, cheapest first ----------------------
  const candidatesFor = (ap) => {
    const out = [];
    const apFloorHasData = dataOf(ap.floorId);
    if (!apFloorHasData) return out;
    const apDropM = Math.max(0, trayHeightOf(ap.floorId) - (Number(ap.heightM) || 0));
    for (const rack of racks) {
      if (!floorById.has(rack.floorId) || !dataOf(rack.floorId)) continue;
      if (rack.floorId === ap.floorId) {
        const route = routeOnFloor(ap.floorId, rack, ap);
        if (route)
          out.push({
            rack,
            riser: null,
            legs: [{ floorId: ap.floorId, route, from: rack, to: ap }],
            horizontalM: route.horizontalM,
            verticalM: apDropM,
          });
        continue;
      }
      for (const riser of risers) {
        if (riser.floorIds && !(riser.floorIds.includes(ap.floorId) && riser.floorIds.includes(rack.floorId)))
          continue;
        const apLeg = routeOnFloor(ap.floorId, riser, ap);
        const rackLeg = routeOnFloor(rack.floorId, rack, riser);
        if (!apLeg || !rackLeg) continue;
        out.push({
          rack,
          riser,
          legs: [
            { floorId: ap.floorId, route: apLeg, from: riser, to: ap },
            { floorId: rack.floorId, route: rackLeg, from: rack, to: riser },
          ],
          horizontalM: apLeg.horizontalM + rackLeg.horizontalM,
          // up or down the shaft between the two trays
          verticalM:
            apDropM +
            Math.abs(elevationOf(rack.floorId) - elevationOf(ap.floorId)),
        });
      }
    }
    for (const c of out) {
      c.fixedM = rules.rackDropM + rules.apLoopM + rules.rackLoopM;
      c.permanentLinkM = permanentLinkLengthM(c.horizontalM, c.verticalM, rules);
      c.slackM = c.permanentLinkM - (c.horizontalM + c.verticalM + c.fixedM);
    }
    return out.sort((a, b) => a.permanentLinkM - b.permanentLinkM);
  };

  const options = new Map(aps.map((ap) => [ap.id, candidatesFor(ap)]));

  // ---- assign APs to racks, respecting rack capacity -----------------------
  const left = new Map(racks.map((r) => [r.id, Number.isFinite(r.maxAps) ? r.maxAps : Infinity]));
  const regret = (ap) => {
    const c = options.get(ap.id);
    return c.length > 1 ? c[1].permanentLinkM - c[0].permanentLinkM : Infinity;
  };
  const order = [...aps].sort((a, b) => regret(b) - regret(a) || label(a).localeCompare(label(b)));
  const chosen = new Map();
  const noRackFloors = new Set();
  for (const ap of order) {
    const candidates = options.get(ap.id);
    if (!candidates.length) {
      const floor = floorById.get(ap.floorId);
      const onFloor = racks.some((r) => r.floorId === ap.floorId);
      if (!dataOf(ap.floorId))
        violations.push({ severity: "error", item: label(ap), message: "the floor has no rooms or boundary to route in" });
      else if (!onFloor && !noRackFloors.has(ap.floorId)) {
        noRackFloors.add(ap.floorId);
        violations.push({
          severity: "error",
          item: label(floor),
          message: risers.length
            ? "no rack can be reached from this floor. Place a rack on the floor or a riser that connects to one."
            : "APs on this floor have no rack. Place a rack on the floor, or add a riser to a rack on another floor.",
        });
      } else if (!onFloor) {
        /* already reported for the floor */
      } else
        violations.push({
          severity: "error",
          item: label(ap),
          message:
            "no permitted cable route to any rack: the walls and ceiling settings leave no way through. Mark a wall as an opening or approved sleeve, allow ceiling routing in the ceiling settings, or move the rack.",
        });
      continue;
    }
    const pick = candidates.find((c) => left.get(c.rack.id) > 0);
    if (!pick) {
      violations.push({
        severity: "error",
        item: label(ap),
        message: "every rack that can reach this AP is full (rack capacity)",
      });
      continue;
    }
    left.set(pick.rack.id, left.get(pick.rack.id) - 1);
    chosen.set(ap.id, pick);
  }

  // ---- routes a person has edited ---------------------------------------------
  // A route with waypoints must pass them in order. It is fixed: the shared-trunk
  // step does not change it.
  const refresh = (pick) => {
    pick.horizontalM = pick.legs.reduce((sum, leg) => sum + leg.route.horizontalM, 0);
    pick.permanentLinkM = permanentLinkLengthM(pick.horizontalM, pick.verticalM, rules);
    pick.slackM = pick.permanentLinkM - (pick.horizontalM + pick.verticalM + pick.fixedM);
  };
  const edits = withDefaults(pathway).routeEdits;
  for (const ap of aps) {
    const edit = edits[ap.id];
    const pick = chosen.get(ap.id);
    if (!pick || !edit?.waypoints?.length || pick.riser) continue;
    const stops = [pick.rack, ...edit.waypoints, ap];
    const parts = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const part = routeOnFloor(ap.floorId, stops[i], stops[i + 1]);
      if (!part) {
        parts.length = 0;
        break;
      }
      parts.push(part);
    }
    if (!parts.length) {
      violations.push({ severity: "warning", item: label(ap), message: "the edited route cannot be followed (a waypoint cannot be reached): the automatic route is used" });
      continue;
    }
    pick.legs[0].route = joinRoutes(parts);
    pick.legs[0].fixed = true;
    pick.edited = true;
    refresh(pick);
  }

  // ---- shared trunks ----------------------------------------------------------
  // Longest cables first; every later cable finds the edges already used cheaper,
  // so cables follow a common trunk. A shared route is kept only if it is not
  // much longer than the cable's own shortest route; the cable length is always
  // the real length of the route, never the discounted cost.
  if (rules.trayShareFactor < 1) {
    const usage = new Map();
    const usageOf = (floorId) =>
      usage.get(floorId) || usage.set(floorId, newUsage(dataOf(floorId).grid)).get(floorId);
    const legs = [...chosen.values()].flatMap((pick) => pick.legs.map((leg) => ({ pick, leg })));
    legs.sort((a, b) => b.leg.route.horizontalM - a.leg.route.horizontalM);
    for (const { leg } of legs) {
      const { grid } = dataOf(leg.floorId);
      if (leg.fixed) {
        markRoute(grid, usageOf(leg.floorId), leg.route);
        continue;
      }
      const tree = shortestFrom(grid, leg.from, {
        crossPenaltyM: rules.crossPenaltyM,
        permitPenaltyM: rules.permitPenaltyM,
        trayFactor: rules.trayFactor,
        turnPenaltyM: rules.turnPenaltyM,
        used: usageOf(leg.floorId),
        usedFactor: rules.trayShareFactor,
      });
      const shared = pathTo(grid, tree, leg.from, leg.to);
      if (shared && shared.horizontalM <= leg.route.horizontalM * (1 + rules.maxDetourFraction) + 1e-9)
        leg.route = shared;
      markRoute(grid, usageOf(leg.floorId), leg.route);
    }
    for (const pick of chosen.values()) {
      pick.horizontalM = pick.legs.reduce((sum, leg) => sum + leg.route.horizontalM, 0);
      pick.permanentLinkM = permanentLinkLengthM(pick.horizontalM, pick.verticalM, rules);
      pick.slackM = pick.permanentLinkM - (pick.horizontalM + pick.verticalM + pick.fixedM);
    }
  }

  // ---- which part of a route is conduit, tray, penetration or ceiling --------
  // Surface conduit is needed where the ceiling void cannot be used (solid ceiling,
  // restricted or no access): cable there must be carried on the surface.
  const roomsByFloor = new Map();
  const roomAt = (floorId, x, z) => {
    if (!roomsByFloor.has(floorId))
      roomsByFloor.set(floorId, (plan.rooms || []).filter((r) => r.floorId === floorId).sort((a, b) => areaOf(a) - areaOf(b)));
    return roomsByFloor.get(floorId).find((r) => inside(x, z, r)) || null;
  };
  const noVoid = (roomId) => {
    const c = roomCeiling(pathway, roomId);
    return c.type === "solid" || c.voidAccess === "restricted" || c.voidAccess === "none";
  };
  const conduitEdges = new Set(); // unique conduit edges (shared conduit is counted once)
  const conduitOf = (floorId, route) => {
    const { grid } = dataOf(floorId);
    let metres = 0;
    for (const key of route.edges) {
      const [a, b] = key.split("-").map(Number);
      const x = (grid.centerX(a % grid.nx) + grid.centerX(b % grid.nx)) / 2;
      const z = (grid.centerZ(Math.floor(a / grid.nx)) + grid.centerZ(Math.floor(b / grid.nx))) / 2;
      const room = roomAt(floorId, x, z);
      if (room && noVoid(room.id)) {
        metres += grid.cellM;
        conduitEdges.add(`${floorId}:${key}`);
      }
    }
    return metres;
  };

  // ---- runs and length checks ----------------------------------------------
  const runs = [];
  const routesByFloor = new Map();
  for (const ap of aps) {
    const pick = chosen.get(ap.id);
    if (!pick) continue;
    const permanentLinkM = pick.permanentLinkM;
    const channelM = permanentLinkM + 2 * rules.patchCordM;
    let check = "ok";
    if (permanentLinkM > rules.maxPermanentLinkM) {
      check = "too long";
      violations.push({ severity: "error", item: label(ap), message: `permanent link ${round(permanentLinkM, 1)} m is above the ${rules.maxPermanentLinkM} m limit` });
    } else if (channelM > rules.maxChannelM) {
      check = "too long";
      violations.push({ severity: "error", item: label(ap), message: `channel ${round(channelM, 1)} m is above the ${rules.maxChannelM} m limit` });
    } else if (permanentLinkM > rules.maxPermanentLinkM * rules.nearLimitFraction) {
      check = "near limit";
      violations.push({ severity: "warning", item: label(ap), message: `permanent link ${round(permanentLinkM, 1)} m is close to the ${rules.maxPermanentLinkM} m limit` });
    }
    // PoE: what the AP receives after the copper's resistance (worst case: the
    // class power, or the AP's typical draw when allocation is "actual")
    const apPart = apPartOf(ap);
    const poeType = POE_TYPES[apPart.poeType];
    let poe = null;
    if (poeType && Number.isFinite(cable.dcResistanceOhmPer100m)) {
      const draw =
        rules.poeAllocation === "actual" && Number.isFinite(Number(ap.drawW ?? apPart.typicalDrawW))
          ? Number(ap.drawW ?? apPart.typicalDrawW)
          : poeType.pdPowerW;
      poe = poeLink({
        pdPowerW: draw,
        pseVoltageV: poeType.pseVoltageV,
        psePowerW: poeType.psePowerW,
        pdMinVoltageV: poeType.pdMinVoltageV,
        loopOhm: loopResistanceOhm({
          channelM,
          resistancePer100m: cable.dcResistanceOhmPer100m,
          pairs: poeType.pairs,
          tempC: rules.cableTempC,
        }),
      });
      if (!poe.ok) {
        if (check === "ok" || check === "near limit") check = "PoE";
        violations.push({ severity: "error", item: label(ap), message: `PoE over ${round(channelM, 1)} m: ${poe.reason}` });
      }
    }
    const crossings = pick.legs.reduce((s, l) => s + l.route.crossings, 0);
    const permittedCrossings = pick.legs.reduce((s, l) => s + (l.route.permittedCrossings || 0), 0);
    const penetrations = pick.legs.reduce((s, l) => s + (l.route.penetrations || 0), 0);
    const conduitM = pick.legs.reduce((s, l) => s + conduitOf(l.floorId, l.route), 0);
    const edit = edits[ap.id];
    if (crossings > 0)
      violations.push({
        severity: "warning",
        item: label(ap),
        message: `the route passes ${crossings} wall(s) on the assumption that cable can go over them. Ceiling access is not confirmed: set the ceiling settings or mark the wall (opening, sleeve, not permitted).`,
      });
    for (const leg of pick.legs) {
      const list = routesByFloor.get(leg.floorId) || [];
      list.push(leg.route);
      routesByFloor.set(leg.floorId, list);
    }
    runs.push({
      apId: ap.id,
      apName: label(ap),
      floorId: ap.floorId,
      rackId: pick.rack.id,
      riserId: pick.riser?.id ?? null,
      apPartId: ap.apPartId || rules.apPartId,
      portPowerW: apPartOf(ap).portPowerW,
      cablePartId: cable.id,
      cableName: cable.name,
      // signal loss of the cable at 100 MHz, only when the datasheet value is in the catalogue
      insertionLossDb: Number.isFinite(cable.insertionLossDbPer100m100MHz)
        ? round((cable.insertionLossDbPer100m100MHz * channelM) / 100, 1)
        : null,
      pdVoltageV: poe?.pdVoltageV != null ? round(poe.pdVoltageV, 1) : null,
      poeCableLossW: poe?.cableLossW != null ? round(poe.cableLossW, 2) : null,
      horizontalM: round(pick.horizontalM),
      verticalM: round(pick.verticalM + pick.fixedM),
      slackM: round(pick.slackM),
      permanentLinkM: round(permanentLinkM),
      channelM: round(channelM),
      crossings,
      permittedCrossings,
      penetrations,
      onTrayM: round(pick.legs.reduce((s, l) => s + (l.route.onTrayM || 0), 0)),
      // what the route is made of, in metres and counts
      layers: {
        trayM: round(pick.legs.reduce((s, l) => s + (l.route.onTrayM || 0), 0)),
        conduitM: round(conduitM),
        penetrations,
        ceilingCrossings: permittedCrossings,
        estimatedCrossings: crossings,
      },
      crossingPoints: pick.legs.flatMap((l) => (l.route.crossingPoints || []).map((c) => ({ ...c, floorId: l.floorId }))),
      edited: Boolean(pick.edited),
      // "stated": built only on facts you gave (ceiling settings, openings, sleeves);
      // "estimated": the route depends on an unconfirmed assumption
      pathwayStatus: edit?.confirmed ? "confirmed" : stated && crossings === 0 ? "stated" : "estimated",
      check,
      // one polyline per floor the cable passes through
      paths: pick.legs.map((leg) => ({ floorId: leg.floorId, points: pointsOf(leg.floorId, leg.route) })),
    });
  }

  // ---- cables sharing a tray section --------------------------------------------
  const perEdge = new Map();
  for (const pick of chosen.values())
    for (const leg of pick.legs)
      for (const edge of leg.route.edges) {
        const key = `${leg.floorId}:${edge}`;
        perEdge.set(key, (perEdge.get(key) || 0) + 1);
      }
  const maxCablesPerSection = Math.max(0, ...perEdge.values());

  // ---- tray fill: the busiest section against the tray's cross-section ---------
  const trayPart = catalogue.passive.tray;
  const cableMm2 = Math.PI * ((cable.outerDiameterMm || 7.5) / 2) ** 2;
  const STANDARD_TRAY_WIDTHS = [100, 150, 200, 300, 450, 600, 900];
  let trayFill = null;
  if (maxCablesPerSection && trayPart?.widthMm && trayPart?.depthMm) {
    const areaNeeded = maxCablesPerSection * cableMm2;
    const fillPct = (areaNeeded / (trayPart.widthMm * trayPart.depthMm)) * 100;
    const needWidth = areaNeeded / (rules.trayFillLimit * trayPart.depthMm);
    const requiredWidthMm = STANDARD_TRAY_WIDTHS.find((w) => w >= needWidth) ?? Math.ceil(needWidth / 100) * 100;
    trayFill = { maxCables: maxCablesPerSection, fillPct: round(fillPct, 1), limitPct: rules.trayFillLimit * 100, requiredWidthMm, trayWidthMm: trayPart.widthMm };
    if (fillPct > rules.trayFillLimit * 100)
      violations.push({ severity: "error", item: "Cable tray", message: `the busiest tray section carries ${maxCablesPerSection} cables: ${round(fillPct, 0)}% of a ${trayPart.widthMm} x ${trayPart.depthMm} mm tray, above the ${rules.trayFillLimit * 100}% limit. Use a tray at least ${requiredWidthMm} mm wide.` });
  }

  // ---- power and data: keep the cable away from power cabling ----------------------
  let separationM = 0;
  const segDist = (px, pz, a, b) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2)) : 0;
    return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
  };
  const closeEdges = new Set();
  for (const key of perEdge.keys()) {
    const [floorId, edge] = key.split(":");
    const powers = floorPowerRoutes(pathway, floorId);
    if (!powers.length) continue;
    const { grid } = dataOf(floorId);
    const [a, b] = edge.split("-").map(Number);
    const x = (grid.centerX(a % grid.nx) + grid.centerX(b % grid.nx)) / 2;
    const z = (grid.centerZ(Math.floor(a / grid.nx)) + grid.centerZ(Math.floor(b / grid.nx))) / 2;
    if (powers.some((pr) => pr.points.slice(1).some((q, i) => segDist(x, z, pr.points[i], q) <= rules.powerSeparationM))) closeEdges.add(key);
  }
  separationM = closeEdges.size * rules.cellM;
  if (separationM > 0)
    violations.push({ severity: "warning", item: "Power and data", message: `${round(separationM, 1)} m of data route runs within ${rules.powerSeparationM * 1000} mm of power cabling. Move the route or add a divider or separate tray.` });

  // ---- fire-stopped sleeves: one kit per crossed wall piece (and per 12 cables) ----
  const fireWalls = new Map(); // key -> { a, b, floorId, cables }
  for (const [floorId, data] of floorData)
    if (data)
      for (const w of data.input.walls)
        if (withDefaults(pathway).wallOverrides[w.key] === "fire-stopped") fireWalls.set(w.key, { a: w.a, b: w.b, floorId, cables: 0 });
  for (const run of runs)
    for (const c of run.crossingPoints || [])
      if (c.kind === "penetration")
        for (const fw of fireWalls.values())
          if (fw.floorId === c.floorId && segDist(c.x, c.z, fw.a, fw.b) <= 0.35) fw.cables += 1;
  const fireStopKits = [...fireWalls.values()].reduce((n, fw) => n + (fw.cables ? Math.ceil(fw.cables / (catalogue.passive.fireStop?.cablesPer || 12)) : 0), 0);
  if (maxCablesPerSection > rules.bundleWarnCount)
    violations.push({
      severity: "warning",
      item: "Cable bundles",
      message: `up to ${maxCablesPerSection} cables share one tray section (planning threshold ${rules.bundleWarnCount}). Large PoE bundles heat up: check the cable's temperature derating (TIA TSB-184-A / the manufacturer) and tray fill.`,
    });

  // ---- switches: pack by port count and PoE allocation ----------------------
  const allocationOf = (ap) => {
    const part = apPartOf(ap);
    const actual = Number(ap.drawW ?? part.typicalDrawW);
    return rules.poeAllocation === "actual" && Number.isFinite(actual)
      ? actual
      : part.portPowerW;
  };
  const byRack = new Map();
  for (const run of runs) {
    const ap = aps.find((a) => a.id === run.apId);
    (byRack.get(run.rackId) || byRack.set(run.rackId, []).get(run.rackId)).push({ ap, run });
  }
  const rackSummary = [];
  for (const [rackId, items] of byRack) {
    const packItems = items.map((it) => ({ watts: allocationOf(it.ap), portPowerW: apPartOf(it.ap).portPowerW }));
    // "auto": the model with the fewest switches for this rack; otherwise the chosen model
    let rackSwitch = switchPart;
    if (autoSwitch) {
      const best = chooseSwitch(packItems, catalogue.switches, rules);
      rackSwitch = best ? best.part : Object.values(catalogue.switches).reduce((a, b) => (b.maxPortPowerW > a.maxPortPowerW ? b : a));
    }
    for (const it of items) {
      const part = apPartOf(it.ap);
      if (part.portPowerW > rackSwitch.maxPortPowerW)
        violations.push({
          severity: "error",
          item: it.run.apName,
          message: `needs ${part.portPowerW} W per port but ${rackSwitch.name} supplies at most ${rackSwitch.maxPortPowerW} W`,
        });
    }
    const bins = packSwitches(packItems, rackSwitch, rules);
    rackSummary.push({
      rackId,
      apCount: items.length,
      switches: bins.length,
      switchPartId: rackSwitch.id,
      switchName: rackSwitch.name,
      usableBudgetW: round(usableBudgetW(rackSwitch, rules), 1),
      poeAllocatedW: round(bins.reduce((s, b) => s + b.watts, 0), 1),
      patchPanels: Math.ceil(items.length / catalogue.passive.patchPanel.ports),
    });
  }
  for (const r of racks) {
    const cap = r.maxAps;
    if (Number.isFinite(cap) && (byRack.get(r.id)?.length || 0) > cap)
      violations.push({ severity: "error", item: label(r), message: "rack capacity exceeded" });
  }

  // ---- network: main room, floor rooms, fibre uplinks, rack space and power -------
  const fibre = catalogue.fibre;
  const roleOf = new Map();
  const marked = racks.filter((r) => r.role === "mdf");
  const mdfs = marked.length ? marked : racks.slice(0, 1);
  if (racks.length > 1 && !marked.length)
    violations.push({ severity: "warning", item: label(racks[0]), message: `no rack is marked as the main room (MDF): ${label(racks[0])} is treated as the MDF. Mark one in its settings.` });
  for (const r of racks) roleOf.set(r.id, mdfs.includes(r) ? "mdf" : "idf");
  const uplinks = [];
  const strandsAt = new Map();
  const addStrands = (id, n) => strandsAt.set(id, (strandsAt.get(id) || 0) + n);
  if (fibre)
    for (const idf of racks.filter((r) => roleOf.get(r.id) === "idf")) {
      const s = rackSummary.find((x) => x.rackId === idf.id);
      if (!s?.switches) continue; // a floor room with no APs needs no uplink
      let best = null;
      for (const mdf of mdfs) {
        if (mdf.floorId === idf.floorId) {
          const r = routeOnFloor(idf.floorId, idf, mdf);
          if (r && (!best || r.horizontalM < best.horizontalM)) best = { mdf, riser: null, horizontalM: r.horizontalM, verticalM: 0 };
        } else
          for (const riser of risers) {
            if (riser.floorIds && !(riser.floorIds.includes(idf.floorId) && riser.floorIds.includes(mdf.floorId))) continue;
            const a = routeOnFloor(idf.floorId, idf, riser);
            const b = routeOnFloor(mdf.floorId, riser, mdf);
            if (!a || !b) continue;
            const total = a.horizontalM + b.horizontalM + Math.abs(elevationOf(idf.floorId) - elevationOf(mdf.floorId));
            if (!best || total < best.horizontalM + best.verticalM)
              best = { mdf, riser, horizontalM: a.horizontalM + b.horizontalM, verticalM: Math.abs(elevationOf(idf.floorId) - elevationOf(mdf.floorId)) };
          }
      }
      if (!best) {
        violations.push({ severity: "error", item: label(idf), message: `no route for the fibre uplink to the main room: add a riser that joins ${floorById.get(idf.floorId)?.name || idf.floorId} to the main room's floor, or move the main room` });
        continue;
      }
      const lengthM = (best.horizontalM + best.verticalM + 2 * rules.rackDropM + 2 * rules.rackLoopM) * (1 + rules.slackFraction);
      const strands = strandsFor(Math.ceil(s.switches * rules.uplinksPerSwitch * 2 * (1 + rules.fibreSpareFraction)));
      if (lengthM > fibre.cable.maxLengthM)
        violations.push({ severity: "error", item: label(idf), message: `fibre uplink ${round(lengthM, 0)} m is longer than ${fibre.cable.maxLengthM} m, the limit for ${fibre.cable.name}` });
      const swPart = catalogue.switches[s.switchPartId];
      uplinks.push({
        from: idf.id, fromName: label(idf), to: best.mdf.id, toName: label(best.mdf), riserId: best.riser?.id ?? null,
        lengthM: round(lengthM), strands, links: s.switches * rules.uplinksPerSwitch, speedGbps: swPart.uplinkSpeedGbps || 10,
      });
      addStrands(idf.id, strands);
      addStrands(best.mdf.id, strands);
    }
  const networkRacks = racks.map((rack) => {
    const s = rackSummary.find((x) => x.rackId === rack.id);
    const swPart = (s && catalogue.switches[s.switchPartId]) || switchPart;
    const fibrePanels = fibre ? Math.ceil((strandsAt.get(rack.id) || 0) / fibre.panel.strands) : 0;
    const eng = rackEngineering({ rack, switches: s?.switches || 0, switchPart: swPart, patchPanels: s?.patchPanels || 0, fibrePanels, poeAllocatedW: s?.poeAllocatedW || 0, rules });
    for (const issue of eng.issues) violations.push({ severity: "error", item: label(rack), message: issue });
    let over = null;
    if (s) {
      const items = byRack.get(rack.id) || [];
      const accessGbps = items.reduce((sum, it) => sum + (apPartOf(it.ap).portSpeedGbps || 1), 0);
      over = oversubscription({ apCount: items.length, apPortGbps: accessGbps / Math.max(1, items.length), switches: s.switches, uplinksPerSwitch: rules.uplinksPerSwitch, uplinkGbps: swPart.uplinkSpeedGbps || 10 });
      if (over.ratio > rules.maxOversubscription)
        violations.push({ severity: "warning", item: label(rack), message: `access capacity ${round(over.accessGbps, 1)} Gbit/s over ${round(over.uplinkGbps, 0)} Gbit/s of uplink is ${round(over.ratio, 1)}:1, above the ${rules.maxOversubscription}:1 limit` });
    }
    return { rackId: rack.id, name: label(rack), role: roleOf.get(rack.id), floorId: rack.floorId, fibreStrands: strandsAt.get(rack.id) || 0, fibrePanels, ...eng, oversubscription: over ? { ...over, ratio: round(over.ratio, 2) } : null };
  });
  const network = { mdf: mdfs.map(label), uplinks, racks: networkRacks };
  if (fibre && uplinks.length) {
    const byStrands = new Map();
    for (const u of uplinks) byStrands.set(u.strands, (byStrands.get(u.strands) || 0) + u.lengthM);
    for (const [strands, metres] of byStrands)
      boq.add({ group: "Backbone", partId: `${fibre.cable.id}-${strands}`, name: `${fibre.cable.name}, ${strands}-strand (metres)`, unit: "m", qty: metres, basis: `fibre uplinks from the floor rooms to the main room, including drops, loops and ${rules.slackFraction * 100}% slack`, source: fibre.cable.source });
    boq.add({ group: "Backbone", partId: fibre.sfp.id, name: fibre.sfp.name, qty: uplinks.reduce((n, u) => n + u.links * 2, 0), basis: "2 per fibre uplink (one at each end); the main room's aggregation ports are not sized", source: fibre.sfp.source });
    boq.add({ group: "Backbone", partId: fibre.cord.id, name: fibre.cord.name, qty: uplinks.reduce((n, u) => n + u.links * 2, 0), basis: "2 per fibre uplink", source: fibre.cord.source });
  }
  if (fibre) {
    boq.add({ group: "Rack", partId: fibre.panel.id, name: fibre.panel.name, qty: networkRacks.reduce((n, r) => n + r.fibrePanels, 0), basis: `${fibre.panel.strands} strands per panel, for the strands that end in each room`, source: fibre.panel.source });
    boq.add({ group: "Rack", partId: fibre.manager.id, name: fibre.manager.name, qty: networkRacks.reduce((n, r) => n + r.managers, 0), basis: "1 per 2 devices in a rack", source: fibre.manager.source });
  }

  // ---- tray: every grid edge used on a floor counts once ----------------------
  const trayM = [...routesByFloor].reduce(
    (s, [floorId, routes]) => s + trayLengthM(dataOf(floorId).grid, routes),
    0,
  );
  // a drawn existing tray is not bought; everything else the cables run along is new tray
  const trayParts = [...routesByFloor].reduce(
    (t, [floorId, routes]) => {
      const part = trayBreakdown(dataOf(floorId).grid, routes);
      return { newM: t.newM + part.newM, existingM: t.existingM + part.existingM };
    },
    { newM: 0, existingM: 0 },
  );

  // ---- bill of quantities ----------------------------------------------------
  const p = catalogue.passive;
  const nRuns = runs.length;
  const cableM = runs.reduce((s, r) => s + r.permanentLinkM, 0);
  const perPart = runs.reduce((m, r) => {
    const ap = aps.find((a) => a.id === r.apId);
    const id = ap.apPartId || rules.apPartId;
    m[id] = (m[id] || 0) + 1;
    return m;
  }, {});
  for (const [partId, count] of Object.entries(perPart))
    boq.add({ group: "Active equipment", partId, name: catalogue.accessPoints[partId].name, qty: count, basis: `${count} AP(s) placed in the plan`, source: catalogue.accessPoints[partId].source });
  for (const r of rackSummary) {
    const part = catalogue.switches[r.switchPartId];
    boq.add({ group: "Active equipment", partId: part.id, name: part.name, qty: r.switches, basis: `${part.poePorts} ports and ${round(r.usableBudgetW, 0)} W usable PoE per switch (${rules.poeAllocation} allocation${rules.poeMargin ? `, ${Math.round(rules.poeMargin * 100)}% margin` : ""}${rules.psuRedundancy === "N+1" ? ", N+1 power supply" : ""})`, source: part.source });
  }
  boq.add({ group: "Cabling", partId: cable.id, name: `${cable.name} (metres)`, unit: "m", qty: cableM, basis: `sum of ${nRuns} permanent links incl. drops, loops, risers and ${rules.slackFraction * 100}% slack`, source: cable.source });
  boq.add({ group: "Cabling", partId: `${cable.id}-box`, name: `${cable.name} (${cable.boxM} m box)`, qty: cableM / cable.boxM, basis: `${round(cableM, 1)} m / ${cable.boxM} m per box, rounded up`, source: cable.source });
  boq.add({ group: "Rack", partId: p.patchPanel.id, name: p.patchPanel.name, qty: rackSummary.reduce((s, r) => s + r.patchPanels, 0), basis: `${p.patchPanel.ports} ports per panel, per rack`, source: p.patchPanel.source });
  boq.add({ group: "Outlets", partId: p.jack.id, name: p.jack.name, qty: nRuns, basis: "1 per run", source: p.jack.source });
  boq.add({ group: "Outlets", partId: p.outletBox.id, name: p.outletBox.name, qty: nRuns, basis: "1 per run", source: p.outletBox.source });
  boq.add({ group: "Patching", partId: p.patchCord.id, name: `${p.patchCord.name} ${rules.patchCordM} m`, qty: nRuns * 2, basis: "1 at the rack and 1 at the AP per run", source: p.patchCord.source });
  boq.add({ group: "Mounting", partId: p.mountKit.id, name: p.mountKit.name, qty: nRuns, basis: "1 per AP", source: p.mountKit.source });
  boq.add({ group: "Consumables", partId: p.label.id, name: p.label.name, qty: nRuns * rules.labelsPerRun, basis: `${rules.labelsPerRun} labels per run`, source: p.label.source });
  boq.add({ group: "Consumables", partId: p.ties.id, name: p.ties.name, qty: cableM / p.ties.coverM, basis: `1 pack per ${p.ties.coverM} m of cable`, source: p.ties.source });
  if (rules.useTray)
    boq.add({ group: "Pathway", partId: p.tray.id, name: p.tray.name, qty: trayParts.newM / p.tray.sectionM, basis: `${round(trayParts.newM, 1)} m of new tray / ${p.tray.sectionM} m sections (a shared trunk is counted once)${trayParts.existingM ? `; ${round(trayParts.existingM, 1)} m runs on existing trays you drew and is not bought` : ""}`, source: p.tray.source });

  // ---- risers: cables through each shaft against its capacity -----------------
  const cableAreaMm2 = Math.PI * ((cable.outerDiameterMm || 7.5) / 2) ** 2;
  const riserUse = risers
    .map((r) => {
      const cables = runs.filter((run) => run.riserId === r.id).length;
      if (!cables && !r.areaMm2) return null;
      const used = cables * cableAreaMm2;
      const capacity = r.areaMm2 > 0 ? r.areaMm2 * (r.fillLimit ?? 0.4) : null;
      return { id: r.id, name: label(r), cables, usedMm2: round(used, 0), capacityMm2: capacity == null ? null : round(capacity, 0), fillPct: capacity ? round((used / capacity) * 100, 0) : null };
    })
    .filter(Boolean);
  for (const u of riserUse)
    if (u.capacityMm2 != null && u.usedMm2 > u.capacityMm2)
      violations.push({ severity: "error", item: u.name, message: `${u.cables} cables need ${u.usedMm2} mm2 but the riser holds ${u.capacityMm2} mm2 at its fill limit` });

  // surface conduit where the ceiling void cannot be used
  const conduitM = conduitEdges.size * rules.cellM;
  if (conduitM > 0 && p.conduit)
    boq.add({ group: "Pathway", partId: p.conduit.id, name: p.conduit.name, qty: conduitM / p.conduit.sectionM, basis: `${round(conduitM, 1)} m of route in rooms without a usable ceiling void / ${p.conduit.sectionM} m sections (shared conduit counted once)`, source: p.conduit.source });

  if (fireStopKits > 0 && p.fireStop)
    boq.add({ group: "Pathway", partId: p.fireStop.id, name: p.fireStop.name, qty: fireStopKits, basis: "1 per fire-rated wall crossed through an approved sleeve, and per 12 cables through it", source: p.fireStop.source });

  const approval = approvalSummary({ runs, racks, pathway });

  const assumptions = [
    stated
      ? "Ceiling and wall settings were given: a cable passes a wall only through an opening or sleeve, or over a partition whose ceiling void is accessible and which stops below the slab. Other walls are not crossed."
      : "Ceiling access is unknown: cable is assumed to run above the ceiling and to pass walls away from doors at a routing cost. This is an estimate until the ceiling and wall settings are given.",
    `Routing grid ${rules.cellM} m; wall-crossing penalty ${rules.crossPenaltyM} m (a steering cost only, not added to the cable length).`,
    `Tray ${rules.trayBelowCeilingM} m below the ceiling; rack drop ${rules.rackDropM} m; service loops ${rules.apLoopM} m (AP) and ${rules.rackLoopM} m (rack); slack ${rules.slackFraction * 100}%.`,
    `Limits: permanent link ${rules.maxPermanentLinkM} m, channel ${rules.maxChannelM} m (structured-cabling standards).`,
    `PoE is allocated by ${rules.poeAllocation === "actual" ? "the AP's typical draw" : "the AP's PoE class (worst case)"}. The AP class is ${rules.apPartId} unless an AP sets apPartId; the plan does not carry the AP's PoE class.`,
    risers.length
      ? `Risers: ${risers.map(label).join(", ")}. A cable between floors runs up or down the shaft by the difference in floor elevation, at the riser position on both floors.`
      : "No risers defined: a rack serves only the floor it is on.",
    `Bend radius: keep every bend at least ${round(4 * (cable.outerDiameterMm || 7.5), 0)} mm (4 x the cable diameter); tray corners and drops must allow it. The tool does not model bends.`,
    "Cable bundle heating is not calculated: a warning is raised when many PoE cables share a tray section (check the cable's temperature derating).",
    "Routes are computed from the plan geometry only. Ceiling access, inaccessible areas and real wall penetrations are not known to the tool.",
    "Ethernet signal loss (insertion loss) is shown only where the cable's datasheet value is entered in the catalogue; it limits how long a cable may be and does not change the Wi-Fi signal strength the AP radiates.",
    "Part values in the catalogue are illustrative defaults until replaced with the project's parts.",
  ];

  return {
    status: STATUS_TEXT[approval.level],
    approval,
    riserUse,
    trayFill,
    powerSeparationM: round(separationM),
    fireStopKits,
    conduitM: round(conduitM),
    runs,
    racks: rackSummary,
    boq: boq.toLines(),
    violations,
    assumptions,
    rules,
    trayM: round(trayM),
    existingTrayM: round(trayParts.existingM),
    network,
    maxCablesPerSection,
  };
}

// Cabling check for positions that are not in the plan yet (the optimiser's
// recommended APs). Returns, per position, the permanent link to the best
// rack and whether it meets the length limit. It does not change the plan.
export function checkPositionsCabling({
  plan,
  racks = [],
  risers = [],
  pathway = {},
  positions,
  catalogue = DEFAULT_WIFI_CATALOGUE,
  rules: overrides = {},
}) {
  const probe = {
    ...plan,
    sources: positions.map((p, i) => ({
      id: p.id ?? `pos-${i}`,
      name: p.name ?? `Position ${i + 1}`,
      kind: "wifi",
      floorId: p.floorId,
      x: p.x,
      z: p.z,
      heightM: p.heightM ?? 2.5,
    })),
  };
  const design = designWifiCabling({ plan: probe, racks, risers, pathway, catalogue, rules: overrides });
  const limit = design.rules.maxPermanentLinkM;
  return probe.sources.map((s) => {
    const run = design.runs.find((r) => r.apId === s.id);
    return {
      id: s.id,
      name: s.name,
      routed: Boolean(run),
      permanentLinkM: run?.permanentLinkM ?? null,
      rackId: run?.rackId ?? null,
      feasible: Boolean(run) && run.permanentLinkM <= limit,
    };
  });
}
