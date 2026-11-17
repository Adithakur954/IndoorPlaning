// Calculations behind the planning report. Pure functions on the saved
// prediction maps and the plan: no DOM and no drawing, so every number in the
// report can be tested. Nothing here re-runs ray tracing; it only reads the
// per-AP signal grids the simulation already produced.
import { inside } from "./geometry.js";

export const FLOOR_DBM = -150;

// Planning profiles are editable assumptions, not standards.
export const DEFAULT_PROFILES = [
  { id: "strict", label: "Strict planning target", thresholdDbm: -67 },
  { id: "standard", label: "Standard planning target", thresholdDbm: -70 },
  { id: "minimum", label: "Minimum usable signal", thresholdDbm: -75 },
];
// An AP counts as "visible" above this level (assumption, see the report).
export const DEFAULT_DETECT_DBM = -82;

export const bandOfMHz = (mhz) =>
  mhz < 3000 ? "2.4" : mhz < 5925 ? "5" : "6";

export const median = (values) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const dbmOf = (v) => (v === null || v === undefined ? FLOOR_DBM : v);

// ---- bands ----------------------------------------------------------------

// entries: [{ floorId, freqMHz, raw }] (one raw map per floor and frequency).
// Maps of the same floor and band (different channels) are merged into one
// raw map holding every AP of that band. Returns bands sorted by frequency:
// [{ band, freqs, floors: [{ floorId, raw }], aps: [{ id, name }] }].
export function groupByBand(entries) {
  const bands = new Map();
  for (const e of entries) {
    const band = bandOfMHz(e.freqMHz);
    if (!bands.has(band))
      bands.set(band, { band, freqs: new Set(), byFloor: new Map() });
    const b = bands.get(band);
    b.freqs.add(e.freqMHz);
    if (!b.byFloor.has(e.floorId)) b.byFloor.set(e.floorId, []);
    b.byFloor.get(e.floorId).push(e.raw);
  }
  return [...bands.values()]
    .map((b) => {
      const floors = [...b.byFloor.entries()].map(([floorId, raws]) => ({
        floorId,
        raw: mergeRawMaps(raws),
      }));
      const aps = [];
      for (const f of floors)
        for (const ap of f.raw.accessPoints)
          if (!aps.some((a) => a.id === ap.id)) aps.push({ id: ap.id, name: ap.name });
      return { band: b.band, freqs: [...b.freqs].sort((a, c) => a - c), floors, aps };
    })
    .sort((a, b) => a.freqs[0] - b.freqs[0]);
}

// Several maps of one floor (same grid, different APs) -> one map.
export function mergeRawMaps(raws) {
  if (raws.length === 1) return withBest(raws[0]);
  const base = raws[0];
  const same = raws.every(
    (r) => r.shape[0] === base.shape[0] && r.shape[1] === base.shape[1],
  );
  if (!same) return withBest(base); // different grids cannot be merged
  // the noise floor of each AP travels with it, so SNR can be worked out for the merged map
  const noise = raws.every((r) => r.snr?.noiseFloorDbm?.length === r.perApDbm.length)
    ? {
        ...base.snr,
        noiseFloorDbm: raws.flatMap((r) => r.snr.noiseFloorDbm),
        bandwidthMHz: raws.flatMap((r) => r.snr.bandwidthMHz || []),
        bandwidthAssumed: raws.flatMap((r) => r.snr.bandwidthAssumed || []),
      }
    : undefined;
  return withBest({
    ...base,
    snr: noise,
    accessPoints: raws.flatMap((r) => r.accessPoints),
    perApDbm: raws.flatMap((r) => r.perApDbm),
  });
}

function withBest(raw) {
  const bestDbm = [],
    bestApIndex = [];
  raw.perApDbm[0].forEach((row, iy) => {
    const outRow = [],
      idxRow = [];
    row.forEach((_, ix) => {
      let best = null,
        which = 0;
      raw.perApDbm.forEach((grid, i) => {
        const v = grid[iy][ix];
        if (v !== null && (best === null || v > best)) {
          best = v;
          which = i;
        }
      });
      outRow.push(best);
      idxRow.push(which);
    });
    bestDbm.push(outRow);
    bestApIndex.push(idxRow);
  });
  return { ...raw, bestDbm, bestApIndex };
}

// ---- per-cell ranking ---------------------------------------------------------

// Cells inside `areas` (and outside `skip`) with the three strongest APs.
// -> [{ x, z, step, best, top: [{ i, dbm }] }] (top sorted strongest first)
export function rankedCells(raw, areas, skip = [], topN = 3) {
  const cells = [];
  const n = raw.perApDbm.length;
  raw.zCentersM.forEach((z, iy) =>
    raw.xCentersM.forEach((x, ix) => {
      if (!areas.some((a) => inside(x, z, a))) return;
      if (skip.some((a) => inside(x, z, a))) return;
      const all = [];
      for (let i = 0; i < n; i += 1)
        all.push({ i, dbm: dbmOf(raw.perApDbm[i][iy][ix]) });
      all.sort((a, b) => b.dbm - a.dbm);
      const top = all.slice(0, topN);
      // SNR (dB) of the strongest AP: its signal minus that AP's noise floor; null when the
      // run has no SNR data (older prediction) or no signal reaches the cell
      const noiseFloor = raw.snr?.noiseFloorDbm?.[top[0].i];
      const snr = Number.isFinite(noiseFloor) && top[0].dbm > FLOOR_DBM ? top[0].dbm - noiseFloor : null;
      cells.push({ x, z, step: raw.cellSizeM, best: top[0].dbm, snr, top });
    }),
  );
  return cells;
}

// ---- statistics ------------------------------------------------------------------

// SNR design target (dB): a common planning value for data and voice, an editable assumption.
export const DEFAULT_SNR_TARGET_DB = 25;

// Does any cell carry an SNR value (the run was made with the SNR map)?
export const hasSnr = (cells) => cells.some((c) => Number.isFinite(c.snr));

// Min / median / max SNR of the cells that have one.
export function snrStats(cells) {
  const values = cells.map((c) => c.snr).filter(Number.isFinite);
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : NaN,
    median: median(values),
    max: values.length ? Math.max(...values) : NaN,
  };
}

// Share of the area in each SNR colour band, lowest band first. Cells no AP reaches
// count in the lowest band. `ranges`: [{ min, max, color }] (the legend bands).
export function snrBandShares(cells, ranges) {
  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min));
  const step = cells[0]?.step || 1;
  return sorted.map((r, i) => {
    const lo = i === 0 ? -Infinity : Number(r.min);
    const hi = i === sorted.length - 1 ? Infinity : Number(r.max);
    const inBand = cells.filter((c) => {
      const v = Number.isFinite(c.snr) ? c.snr : -Infinity;
      return v >= lo && v < hi;
    }).length;
    const label = !Number.isFinite(lo) ? `below ${hi} dB` : !Number.isFinite(hi) ? `${lo} dB and above` : `${lo} to ${hi} dB`;
    return { label, color: r.color, count: inBand, m2: inBand * step * step, pct: cells.length ? (100 * inBand) / cells.length : NaN };
  });
}

// Coverage at an SNR target: cells whose SNR reaches `targetDb`.
export function snrCoverage(cells, targetDb) {
  const step = cells[0]?.step || 1;
  const covered = cells.filter((c) => Number.isFinite(c.snr) && c.snr >= targetDb).length;
  return {
    targetDb,
    pct: cells.length ? (100 * covered) / cells.length : NaN,
    coveredM2: covered * step * step,
    totalM2: cells.length * step * step,
  };
}

// The noise assumptions a map was made with: [{ band, floor20, aps: [{ index, width, floor, assumed }] }]
export function noiseAssumptions(raw) {
  const info = raw?.snr;
  if (!info?.noiseFloorDbm) return null;
  return {
    floor20: info.noiseFloor20MHzDbm,
    aps: raw.accessPoints.map((a, i) => ({
      name: a.name,
      width: info.bandwidthMHz?.[i],
      floor: info.noiseFloorDbm[i],
      assumed: Boolean(info.bandwidthAssumed?.[i]),
    })),
  };
}

export function signalStats(values) {
  const heard = values.filter((v) => v > FLOOR_DBM);
  return {
    count: values.length,
    min: heard.length ? Math.min(...heard) : NaN,
    median: median(heard),
    max: heard.length ? Math.max(...heard) : NaN,
  };
}

// Coverage of `cells` (their .best) at each threshold.
export function coverageAt(cells, thresholds) {
  const step = cells[0]?.step || 1;
  return thresholds.map((thresholdDbm) => {
    const covered = cells.filter((c) => c.best >= thresholdDbm).length;
    return {
      thresholdDbm,
      pct: cells.length ? (100 * covered) / cells.length : NaN,
      coveredM2: covered * step * step,
      totalM2: cells.length * step * step,
    };
  });
}

// Share of the area by how many APs reach `thresholdDbm`.
export function overlapClasses(cells, thresholdDbm) {
  const counts = { none: 0, one: 0, two: 0, threePlus: 0 };
  for (const c of cells) {
    const n = c.top.filter((t) => t.dbm >= thresholdDbm).length;
    if (n === 0) counts.none += 1;
    else if (n === 1) counts.one += 1;
    else if (n === 2) counts.two += 1;
    else counts.threePlus += 1;
  }
  const step = cells[0]?.step || 1;
  const total = cells.length;
  const out = {};
  for (const [key, value] of Object.entries(counts))
    out[key] = {
      pct: total ? (100 * value) / total : NaN,
      m2: value * step * step,
    };
  return out;
}

// Difference between the strongest and the second-strongest AP where both
// are heard (dB), summarised.
export function primarySecondaryGap(cells) {
  const gaps = cells
    .filter((c) => c.top[1] && c.top[1].dbm > FLOOR_DBM)
    .map((c) => c.top[0].dbm - c.top[1].dbm);
  return {
    count: gaps.length,
    median: median(gaps),
    withinDb: (db) =>
      gaps.length ? (100 * gaps.filter((g) => g <= db).length) / gaps.length : NaN,
  };
}

// Strongest and second AP of the cells that fall in each room.
export function roomRows(rooms, cells, apNames, thresholdDbm) {
  const rows = [];
  for (const room of rooms) {
    const inRoom = cells.filter((c) => inside(c.x, c.z, room));
    if (!inRoom.length) continue;
    const best = inRoom.map((c) => c.best);
    const stats = signalStats(best);
    const cover = coverageAt(inRoom, [thresholdDbm])[0];
    const share = (rank) => {
      const tally = new Map();
      for (const c of inRoom) {
        const t = c.top[rank];
        if (t && t.dbm >= thresholdDbm)
          tally.set(t.i, (tally.get(t.i) || 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? apNames[top[0]] : "–";
    };
    const usable = new Set();
    for (const c of inRoom)
      for (const t of c.top) if (t.dbm >= thresholdDbm) usable.add(t.i);
    rows.push({
      roomId: room.id,
      name: room.name || room.id,
      snrMedian: snrStats(inRoom).median,
      areaM2: cover.totalM2,
      best: stats.max,
      median: stats.median,
      worst: Math.min(...best),
      coveragePct: cover.pct,
      usableAps: usable.size,
      primary: share(0),
      secondary: share(1),
    });
  }
  return rows;
}

// Connected patches of cells below `thresholdDbm` (4-neighbourhood).
export function weakClusters(cells, thresholdDbm, { minCells = 2, limit = 10 } = {}) {
  if (!cells.length) return [];
  const step = cells[0].step;
  const key = (x, z) => `${Math.round(x / step)},${Math.round(z / step)}`;
  const weak = new Map();
  for (const c of cells) if (c.best < thresholdDbm) weak.set(key(c.x, c.z), c);
  const seen = new Set();
  const clusters = [];
  for (const [k, start] of weak) {
    if (seen.has(k)) continue;
    const stack = [start];
    seen.add(k);
    const members = [];
    while (stack.length) {
      const c = stack.pop();
      members.push(c);
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const nk = key(c.x + dx, c.z + dz);
        if (weak.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(weak.get(nk));
        }
      }
    }
    if (members.length < minCells) continue;
    clusters.push({
      cells: members.length,
      areaM2: members.length * step * step,
      centroid: {
        x: members.reduce((s, c) => s + c.x, 0) / members.length,
        z: members.reduce((s, c) => s + c.z, 0) / members.length,
      },
      minDbm: Math.min(...members.map((c) => c.best)),
      noSignal: members.every((c) => c.best <= FLOOR_DBM),
    });
  }
  return clusters.sort((a, b) => b.areaM2 - a.areaM2).slice(0, limit);
}

// ---- channels ------------------------------------------------------------------------

// Span (MHz) an AP occupies. Needs the AP's centre frequency and width.
const spanOf = (s) => {
  const f = Number(s.freqMHz),
    w = Number(s.bandwidthMHz) || 20;
  return Number.isFinite(f) ? { lo: f - w / 2, hi: f + w / 2, centre: f } : null;
};

// Pairs of Wi-Fi APs in the same band whose channels overlap. "co-channel"
// means the same centre frequency; "overlapping" different centres whose
// spans overlap. Pure frequency arithmetic, no signal levels.
export function channelPairs(sources) {
  const aps = sources.filter((s) => s.kind === "wifi" && spanOf(s));
  const pairs = [];
  for (let i = 0; i < aps.length; i += 1)
    for (let j = i + 1; j < aps.length; j += 1) {
      const a = aps[i],
        b = aps[j];
      if (String(a.band) !== String(b.band)) continue;
      const sa = spanOf(a),
        sb = spanOf(b);
      if (sa.centre === sb.centre)
        pairs.push({ a, b, kind: "co-channel" });
      else if (sa.lo < sb.hi && sb.lo < sa.hi)
        pairs.push({ a, b, kind: "overlapping" });
    }
  return pairs;
}

// Share of the target area where both APs of a pair reach `detectDbm`
// (an indicator of where they can hear each other, not an SINR).
export function pairOverlap(raw, areas, skip, indexA, indexB, detectDbm) {
  let total = 0,
    both = 0;
  raw.zCentersM.forEach((z, iy) =>
    raw.xCentersM.forEach((x, ix) => {
      if (!areas.some((a) => inside(x, z, a))) return;
      if (skip.some((a) => inside(x, z, a))) return;
      total += 1;
      if (
        dbmOf(raw.perApDbm[indexA][iy][ix]) >= detectDbm &&
        dbmOf(raw.perApDbm[indexB][iy][ix]) >= detectDbm
      )
        both += 1;
    }),
  );
  return {
    pct: total ? (100 * both) / total : NaN,
    m2: both * raw.cellSizeM * raw.cellSizeM,
  };
}

// ---- validation -----------------------------------------------------------------------

// Predicted best-server signal against measured values at log positions.
// pairs: [{ predicted, measured }]
export function errorStats(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const err = pairs.map((p) => p.predicted - p.measured);
  const mean = err.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    bias: mean,
    mae: err.reduce((a, b) => a + Math.abs(b), 0) / n,
    rmse: Math.sqrt(err.reduce((a, b) => a + b * b, 0) / n),
  };
}

// Prediction at a plan point from a raw map (nearest cell within one cell).
export function predictedAt(raw, x, z) {
  const xs = raw.xCentersM,
    zs = raw.zCentersM,
    step = raw.cellSizeM;
  const ix = Math.round((x - xs[0]) / step),
    iz = Math.round((z - zs[0]) / (zs[1] - zs[0] || step));
  if (ix < 0 || ix >= xs.length || iz < 0 || iz >= zs.length) return null;
  if (Math.abs(xs[ix] - x) > step || Math.abs(zs[iz] - z) > step) return null;
  const v = raw.bestDbm[iz][ix];
  return v === null || v === undefined ? null : v;
}

// ---- area consistency -------------------------------------------------------------------

// Rows comparing every way the report measures "the building area".
export function areaChecks({ geometryM2, boundaryM2, carpetM2, predictionM2, optimisationM2 }) {
  const rows = [];
  const add = (label, value, note) => {
    if (Number.isFinite(value) && value > 0) rows.push({ label, value, note });
  };
  add("Room polygons (geometry)", geometryM2, "Sum of room areas drawn in the plan");
  add("Building boundary (geometry)", boundaryM2, "Outline drawn as a boundary");
  add("Carpet area (project property)", carpetM2, "Value entered in the project");
  add("Prediction grid (cells x cell area)", predictionM2, "Cells inside rooms and boundary, minus rooms marked as not a receiver area");
  add("Optimisation target (cells x cell area)", optimisationM2, "Cells the optimiser had to cover");
  const flags = [];
  if (Number.isFinite(predictionM2) && Number.isFinite(optimisationM2) && predictionM2 > 0) {
    const diff = (100 * (optimisationM2 - predictionM2)) / predictionM2;
    if (Math.abs(diff) > 1)
      flags.push(
        `The optimisation target area differs from the prediction grid area by ${diff.toFixed(1)}%. The two use different grids and target masks (the optimiser may include or exclude common areas and uses its own resolution), so coverage percentages from the two sections are not directly comparable.`,
      );
  }
  return { rows, flags };
}
