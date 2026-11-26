// Wi-Fi capacity planning: how many people each AP serves, how busy its air is,
// what each client can expect, which APs are overloaded, how many more are needed,
// and which channel each AP should use.
//
// This is separate from the RF coverage simulation. Coverage says where the signal
// is strong enough; capacity says whether the APs can carry the traffic. It uses
// simple, stated assumptions (people per square metre, devices per person, how many
// are active, the traffic each generates, what an AP can carry). They are inputs,
// not measurements: replace them with the client's figures.
//
// People are assigned to the nearest AP on their floor, by sampling each room on a
// 1 m grid. When the RF prediction is available, pass `bestServer(x, z, floorId)` to
// assign by the strongest signal instead.
import { areaOf, bbox, inside, pointsOf } from "../../utils/geometry.js";

export const DEFAULT_CAPACITY = {
  usersPerM2: 0.2, // people per square metre of room
  devicesPerUser: 1.5,
  activeFraction: 0.6, // share of devices that are sending or receiving at a time
  demandMbpsPerActive: 5, // average traffic of an active device
  apCapacityMbps: 400, // what one AP can carry (illustrative: replace with the model's real figure)
  maxClientsPerAp: 100, // most devices one AP should hold (illustrative)
  targetUtilisation: 0.5, // keep the air at most this busy
  interferenceM: 25, // APs closer than this on the same channel interfere
  channels: [36, 40, 44, 48, 149, 153, 157, 161, 165], // 20 MHz channels, 5 GHz
  roomUsers: {}, // { [roomId]: number } people in a room, overriding usersPerM2
};

const contains = (room, rooms) =>
  rooms.some(
    (o) => o.id !== room.id && pointsOf(o).every((p) => inside(p.x, p.z, room)) && areaOf(o) < areaOf(room),
  );

export function planCapacity({ plan, settings = {}, bestServer = null }) {
  const cfg = { ...DEFAULT_CAPACITY, ...settings };
  const aps = (plan.sources || []).filter((s) => s.kind === "wifi");
  const floorRooms = (floorId) => (plan.rooms || []).filter((r) => r.floorId === floorId);

  const load = new Map(aps.map((a) => [a.id, 0])); // people per AP
  const roomRows = [];
  const unserved = [];

  for (const floor of plan.floors || []) {
    const rooms = floorRooms(floor.id);
    const here = aps.filter((a) => a.floorId === floor.id);
    for (const room of rooms) {
      if (contains(room, rooms)) continue; // the open area around other rooms is counted through them
      const area = areaOf(room);
      const users = Number.isFinite(cfg.roomUsers[room.id]) ? cfg.roomUsers[room.id] : area * cfg.usersPerM2;
      // sample the room on a 1 m grid and give each sample to its AP
      const box = bbox(room);
      const samples = [];
      for (let x = box.minX + 0.5; x < box.maxX; x += 1)
        for (let z = box.minZ + 0.5; z < box.maxZ; z += 1) if (inside(x, z, room)) samples.push({ x, z });
      if (!samples.length) samples.push({ x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 });
      const share = new Map();
      for (const s of samples) {
        let target = null;
        if (bestServer) target = bestServer(s.x, s.z, floor.id) ?? null;
        if (!target && here.length)
          target = here.reduce((best, a) => (Math.hypot(a.x - s.x, a.z - s.z) < Math.hypot(best.x - s.x, best.z - s.z) ? a : best)).id;
        if (target) share.set(target, (share.get(target) || 0) + 1);
      }
      if (!share.size) {
        unserved.push({ roomId: room.id, name: room.name || room.id, users: Math.round(users * 10) / 10, floorId: floor.id });
      } else
        for (const [apId, count] of share) load.set(apId, (load.get(apId) || 0) + users * (count / samples.length));
      roomRows.push({ roomId: room.id, name: room.name || room.id, floorId: floor.id, areaM2: Math.round(area * 10) / 10, users: Math.round(users * 10) / 10, aps: [...share.keys()] });
    }
  }

  const rows = aps.map((ap) => {
    const users = load.get(ap.id) || 0;
    const clients = users * cfg.devicesPerUser;
    const active = clients * cfg.activeFraction;
    const demandMbps = active * cfg.demandMbpsPerActive;
    const utilisation = demandMbps / cfg.apCapacityMbps;
    const byClients = clients / cfg.maxClientsPerAp;
    const byAirtime = utilisation / cfg.targetUtilisation;
    const overloadedBy = clients > cfg.maxClientsPerAp ? "clients" : utilisation > cfg.targetUtilisation ? "airtime" : null;
    const extraApsNeeded = Math.max(0, Math.ceil(Math.max(byClients, byAirtime) - 1e-9) - 1);
    return {
      id: ap.id, name: ap.name || ap.id, floorId: ap.floorId,
      users: Math.round(users * 10) / 10, clients: Math.round(clients), activeClients: Math.round(active * 10) / 10,
      demandMbps: Math.round(demandMbps * 10) / 10, utilisationPct: Math.round(utilisation * 1000) / 10,
      // what each active client can expect if the air is shared equally at the target utilisation
      perClientMbps: active > 0 ? Math.round(((cfg.apCapacityMbps * cfg.targetUtilisation) / active) * 10) / 10 : null,
      overloadedBy, extraApsNeeded,
    };
  });

  const channels = planChannels(aps, cfg);
  for (const r of rows) r.channel = channels.assignment.get(r.id) ?? null;

  const summary = {
    totalUsers: Math.round(rows.reduce((s, r) => s + r.users, 0) * 10) / 10 + unserved.reduce((s, r) => s + r.users, 0),
    totalDemandMbps: Math.round(rows.reduce((s, r) => s + r.demandMbps, 0) * 10) / 10,
    overloaded: rows.filter((r) => r.overloadedBy).length,
    extraApsNeeded: rows.reduce((s, r) => s + r.extraApsNeeded, 0) + (unserved.length ? unserved.length : 0),
    unservedUsers: Math.round(unserved.reduce((s, r) => s + r.users, 0) * 10) / 10,
    coChannelPairs: channels.conflicts.length,
  };
  return { settings: cfg, aps: rows, rooms: roomRows, unserved, channels: { plan: Object.fromEntries(channels.assignment), conflicts: channels.conflicts }, summary };
}

// Channels by greedy colouring: the most crowded APs first, each takes the channel its
// neighbours use least. APs on the same floor within the interference distance are
// neighbours; so are APs on the next floor up or down that are close in plan.
export function planChannels(aps, cfg) {
  const near = (a, b) => {
    const dz = Math.hypot(a.x - b.x, a.z - b.z);
    if (a.floorId === b.floorId) return dz < cfg.interferenceM;
    return dz < cfg.interferenceM * 0.4; // another floor: the slab absorbs most of it
  };
  const neighbours = new Map(aps.map((a) => [a.id, aps.filter((b) => b.id !== a.id && near(a, b)).map((b) => b.id)]));
  const order = [...aps].sort((a, b) => neighbours.get(b.id).length - neighbours.get(a.id).length || String(a.id).localeCompare(String(b.id)));
  const assignment = new Map();
  for (const ap of order) {
    const used = new Map(cfg.channels.map((c) => [c, 0]));
    for (const n of neighbours.get(ap.id)) if (assignment.has(n)) used.set(assignment.get(n), used.get(assignment.get(n)) + 1);
    const best = cfg.channels.reduce((b, c) => (used.get(c) < used.get(b) ? c : b), cfg.channels[0]);
    assignment.set(ap.id, best);
  }
  const conflicts = [];
  for (const ap of aps)
    for (const nid of neighbours.get(ap.id))
      if (ap.id < nid && assignment.get(ap.id) === assignment.get(nid)) conflicts.push({ a: ap.id, b: nid, channel: assignment.get(ap.id) });
  return { assignment, conflicts, neighbours };
}
