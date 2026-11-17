// Smooth heatmap rendering: interpolates grid cells (x, z, step, dbm) into a
// continuous colour image clipped to the rooms. The pure part has no DOM use.
import { pointsOf } from "./geometry.js";
import { openEndedBands } from "./logOverlay.js";

const GREY = [128, 128, 128];
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : GREY;
};

// Colour of a dBm value from the same threshold bands the measurement logs
// use ({ min, max, color }), so a log dot and the map beneath it agree.
export function rangesColorFn(ranges) {
  const bands = openEndedBands(ranges).map((r) => ({
    min: Number(r.min ?? -Infinity),
    max: Number(r.max ?? Infinity),
    rgb: hexToRgb(r.color),
  }));
  return (dbm) =>
    bands.find((band) => dbm >= band.min && dbm < band.max)?.rgb ?? GREY;
}

// Returns { width, height, data (RGBA), x, z, widthM, heightM } or null.
export function interpolateHeatmap(
  cells,
  colorAt,
  pxPerM = 24,
  maxSide = 2048,
) {
  if (!cells.length) return null;
  const step = cells[0].step;
  const x0 = Math.min(...cells.map((c) => c.x)),
    z0 = Math.min(...cells.map((c) => c.z));
  const nx = Math.round((Math.max(...cells.map((c) => c.x)) - x0) / step) + 1,
    nz = Math.round((Math.max(...cells.map((c) => c.z)) - z0) / step) + 1;
  const grid = new Float32Array(nx * nz).fill(NaN);
  for (const c of cells)
    grid[Math.round((c.z - z0) / step) * nx + Math.round((c.x - x0) / step)] =
      c.dbm;
  const x = x0 - step / 2,
    z = z0 - step / 2,
    widthM = nx * step,
    heightM = nz * step;
  const scale = Math.min(pxPerM, maxSide / Math.max(widthM, heightM));
  const width = Math.max(1, Math.round(widthM * scale)),
    height = Math.max(1, Math.round(heightM * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let py = 0; py < height; py++) {
    const fz = Math.min(Math.max((py + 0.5) / scale / step - 0.5, 0), nz - 1);
    const j0 = Math.floor(fz),
      j1 = Math.min(j0 + 1, nz - 1),
      tz = smooth(fz - j0);
    for (let px = 0; px < width; px++) {
      const fx = Math.min(Math.max((px + 0.5) / scale / step - 0.5, 0), nx - 1);
      const i0 = Math.floor(fx),
        i1 = Math.min(i0 + 1, nx - 1),
        tx = smooth(fx - i0);
      // Weighted mean of the four neighbours; cells outside the rooms (NaN)
      // are skipped so colour does not bleed in from empty space.
      let sum = 0,
        weight = 0;
      for (const [i, j, w] of [
        [i0, j0, (1 - tx) * (1 - tz)],
        [i1, j0, tx * (1 - tz)],
        [i0, j1, (1 - tx) * tz],
        [i1, j1, tx * tz],
      ]) {
        const v = grid[j * nx + i];
        if (v === v && w > 0) {
          sum += v * w;
          weight += w;
        }
      }
      if (!weight) continue;
      const [r, g, b] = colorAt(sum / weight);
      const o = (py * width + px) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width, height, data, x, z, widthM, heightM };
}

// Browser only: the interpolated image clipped to the room outlines.
export function heatmapCanvas(cells, rooms, ranges, pxPerM) {
  const image = interpolateHeatmap(cells, rangesColorFn(ranges), pxPerM);
  if (!image) return null;
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  source
    .getContext("2d")
    .putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  const sx = image.width / image.widthM,
    sz = image.height / image.heightM;
  ctx.beginPath();
  for (const room of rooms) {
    const points = pointsOf(room);
    points.forEach((p, i) => {
      const px = (p.x - image.x) * sx,
        py = (p.z - image.z) * sz;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
  }
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.filter = `blur(${Math.round(image.width / image.widthM / 6)}px)`;
  ctx.drawImage(source, 0, 0);
  return {
    canvas,
    x: image.x,
    z: image.z,
    widthM: image.widthM,
    heightM: image.heightM,
  };
}
