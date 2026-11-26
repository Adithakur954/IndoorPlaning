// A cellular radio map (one floor, one carrier) as heatmap cells for the
// floor's rooms. Cells outside every room, and in rooms left out of the
// receiver grid, are dropped so the statistics describe the building only.
import { inside } from "../../utils/geometry.js";

const NO_SIGNAL = { rsrp: -150, sinr: -20 };

export function cellularCells(map, areas, skip, { metric = "rsrp", threshold }) {
  const grid = metric === "sinr" ? map.bestSinrDb : map.bestDbm;
  const cells = [];
  map.zCentersM.forEach((z, iy) =>
    map.xCentersM.forEach((x, ix) => {
      if (!areas.some((a) => inside(x, z, a))) return;
      if (skip.some((a) => inside(x, z, a))) return;
      const raw = grid?.[iy]?.[ix];
      const value = raw === null || raw === undefined ? NO_SIGNAL[metric] : raw;
      cells.push({
        x,
        z,
        step: map.cellSizeM,
        dbm: value,
        thresholdDbm: threshold,
        covered: value >= threshold,
        sourceName: map.sectors?.[map.bestApIndex?.[iy]?.[ix]]?.name,
      });
    }),
  );
  return cells;
}

// Share of the cells at or above the target, and the median value.
export function cellStats(cells) {
  if (!cells.length) return null;
  const values = cells.map((c) => c.dbm).sort((a, b) => a - b);
  return {
    cells: cells.length,
    coveredPct: (100 * cells.filter((c) => c.covered).length) / cells.length,
    median: values[Math.floor(values.length / 2)],
    min: values[0],
    max: values[values.length - 1],
  };
}
