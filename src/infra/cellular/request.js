// The cellular prediction job for one carrier: the antennas that send it (each
// with its position, direction, power at its port and radiation pattern at
// the carrier's frequency), grouped into sectors (cells), and the run settings.
// The building itself goes in a geometry-only scene (sceneExport with
// sources: "none"), so moving an antenna does not change the scene.

import { inside } from "../../utils/geometry.js";
import { rsrpOffsetDb, resourceBlocksFor, carrierLabel } from "./bands.js";
import { patternFor } from "./antennaPattern.js";
import { antennaModels, cellularAntennas, cellularOf, predictionProblems } from "./model.js";

// plan (x, y-up, z) -> Sionna scene (x, -z, y), as in sceneExport.js
const toScene = (x, y, z) => [x, -z, y];
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const CEILING_CLEARANCE_M = 0.05;

// Direction of the antenna's main beam as Sionna (yaw, pitch, roll) in degrees.
// Plan azimuth turns from +x toward +z; in the scene +z is -y, so yaw = -azimuth.
// Pitch is the downtilt (a positive pitch points the beam down).
export function orientationDeg(antenna, model) {
  const omni = model?.type === "omni";
  const tilt = Number(antenna.downtiltDeg) || 0;
  if (omni) return [0, tilt, 0];
  if (antenna.mount === "ceiling") return [round(-(Number(antenna.azimuthDeg) || 0), 3), 90, 0];
  return [round(-(Number(antenna.azimuthDeg) || 0), 3), tilt, 0];
}

// Height of the antenna above its floor, kept just below the ceiling of the room it is in.
function mountingHeight(plan, antenna) {
  const wanted = Number(antenna.heightM) || Number(plan.rf?.newCellHeightM) || 3;
  const room = (plan.rooms || []).find((r) => r.floorId === antenna.floorId && inside(+antenna.x, +antenna.z, r));
  const ceiling = Number(room?.height) || null;
  return ceiling ? Math.min(wanted, ceiling - CEILING_CLEARANCE_M) : wanted;
}

export function buildCellularRequest(plan, carrierId, { floorIds } = {}) {
  const problems = predictionProblems(plan, carrierId);
  if (problems.length) return { problems };
  const c = cellularOf(plan);
  const carrier = c.carriers.find((x) => x.id === carrierId);
  const models = antennaModels(plan);
  const elevation = new Map(plan.floors.map((f) => [f.id, Number(f.elevation) || 0]));
  const sending = (sectorId) => !Array.isArray(carrier.sectorIds) || carrier.sectorIds.includes(sectorId);
  const sectorIds = new Set(c.sectors.map((s) => s.id));
  const sectorOf = (a) => (sectorIds.has(a.sectorId) ? a.sectorId : c.sectors[0].id);
  const antennas = cellularAntennas(plan).filter((a) => elevation.has(a.floorId) && sending(sectorOf(a)));
  if (!antennas.length) return { problems: ["No antenna sends this carrier (check the carrier's sectors)."] };

  const patterns = {};
  const notes = [];
  const out = antennas.map((a) => {
    const model = models[a.antennaModelId];
    const key = `${a.antennaModelId}@${carrier.freqMHz}`;
    if (!patterns[key]) patterns[key] = { ...patternFor(model, carrier.freqMHz), model: model.name || model.id };
    const h = mountingHeight(plan, a);
    if (h < (Number(a.heightM) || 0) - 1e-6)
      notes.push(`${a.name} is placed ${CEILING_CLEARANCE_M * 100} cm under its room's ceiling (${round(h, 2)} m).`);
    return {
      id: a.id,
      name: a.name,
      floorId: a.floorId,
      sectorId: sectorOf(a),
      position: toScene(+a.x, elevation.get(a.floorId) + h, +a.z).map((v) => round(v)),
      orientationDeg: orientationDeg(a, model),
      powerDbm: Number(a.inputPowerDbm),
      pattern: key,
    };
  });
  const used = new Set(out.map((a) => a.sectorId));
  const s = c.settings;
  return {
    problems: [],
    notes,
    request: {
      carrier: {
        id: carrier.id,
        label: carrierLabel(carrier),
        technology: carrier.technology,
        band: carrier.band || null,
        freqMHz: Number(carrier.freqMHz),
        bandwidthMHz: Number(carrier.bandwidthMHz),
        scsKHz: carrier.technology === "LTE" ? 15 : Number(carrier.scsKHz) || 30,
        resourceBlocks: resourceBlocksFor(carrier),
        rsrpOffsetDb: round(rsrpOffsetDb(carrier), 3),
      },
      sectors: c.sectors.filter((x) => used.has(x.id)).map((x) => ({ id: x.id, name: x.name })),
      antennas: out,
      patterns,
      settings: {
        resolutionM: Number(s.resolutionM),
        receiverHeightM: Number(s.receiverHeightM),
        maxDepth: Number(s.maxDepth),
        samplesPerTx: Number(s.samplesPerTx),
        diffraction: Boolean(s.diffraction),
        ueNoiseFigureDb: Number(s.ueNoiseFigureDb),
        floorIds: floorIds || null,
      },
    },
  };
}
