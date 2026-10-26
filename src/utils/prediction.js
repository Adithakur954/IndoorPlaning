import { bbox, inside, wallsBetween, materialLoss } from "./geometry.js";

const angleDelta = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
export function predict(plan, floorId) {
  const rooms = plan.rooms.filter((r) => r.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId),
    doors = plan.doors.filter((d) => d.floorId === floorId),
    iw = plan.interiorWalls.filter((w) => w.floorId === floorId);
  if (!rooms.length || !sources.length) return [];
  const step = Math.max(0.4, Math.min(4, Number(plan.rf.gridStepM) || 1)),
    threshold = Number(plan.rf.thresholdDbm) || -95,
    out = [];
  const bounds = rooms.map(bbox);
  const minX = Math.min(...bounds.map((b) => b.minX)),
    maxX = Math.max(...bounds.map((b) => b.maxX)),
    minZ = Math.min(...bounds.map((b) => b.minZ)),
    maxZ = Math.max(...bounds.map((b) => b.maxZ));
  for (let x = minX + step / 2; x < maxX; x += step)
    for (let z = minZ + step / 2; z < maxZ; z += step) {
      if (!rooms.some((r) => inside(x, z, r))) continue;
      let best = null;
      for (const source of sources) {
        const sectors =
          source.antennaPattern === "directional" && source.sectors?.length
            ? source.sectors
            : [source];
        for (const sector of sectors) {
          const dx = x - source.x,
            dz = z - source.z,
            distance = Math.max(
              1,
              Math.hypot(dx, dz, Number(source.heightM || 2) - 1.5),
            );
          const freq = Number(sector.freqMHz || source.freqMHz || 2400),
            fspl =
              32.44 + 20 * Math.log10(freq) + 20 * Math.log10(distance / 1000);
          const crossed = wallsBetween(
            { x: source.x, z: source.z },
            { x, z },
            rooms,
            iw,
            doors,
            plan.wallTypes,
          );
          const wallLoss = crossed.reduce(
            (sum, w) =>
              sum +
              (w.door
                ? Number(plan.rf.doorLossDb)
                : (materialLoss[w.material] ?? Number(plan.rf.wallLossDb))),
            0,
          );
          const directionLoss =
            source.antennaPattern === "directional"
              ? Math.min(
                  35,
                  Math.max(
                    0,
                    (angleDelta(
                      (Math.atan2(dz, dx) * 180) / Math.PI,
                      Number(sector.azimuthDeg || source.azimuthDeg || 0),
                    ) -
                      Number(sector.beamwidthDeg || 120) / 2) *
                      0.55,
                  ),
                )
              : 0;
          const dbm =
            Number(sector.txPowerDbm ?? source.txPowerDbm ?? 20) +
            Number(sector.antennaGainDbi ?? source.antennaGainDbi ?? 0) +
            Number(plan.rf.rxGainDbi || 0) -
            fspl -
            wallLoss -
            directionLoss;
          if (!best || dbm > best.dbm)
            best = {
              dbm,
              sourceId: source.id,
              sourceName: source.name,
              fspl,
              wallLoss,
              directionLoss,
              distance,
            };
        }
      }
      out.push({ x, z, step, ...best, covered: best.dbm >= threshold });
    }
  return out;
}
export function colorFor(value, threshold = -95) {
  if (value >= threshold + 25) return "#2563eb";
  if (value >= threshold + 15) return "#16a34a";
  if (value >= threshold + 5) return "#eab308";
  if (value >= threshold) return "#f97316";
  return "#dc2626";
}
