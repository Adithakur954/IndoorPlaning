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
// Bands marked `smooth` (the cellular map by default) blend instead: each band's
// colour sits at its lower edge and values in between mix the two neighbours.
export function rangesColorFn(ranges) {
  const bands = openEndedBands(ranges).map((r) => ({
    min: Number(r.min ?? -Infinity),
    max: Number(r.max ?? Infinity),
    rgb: hexToRgb(r.color),
  }));
  if ((ranges || []).some((r) => r?.smooth)) return gradientColorFn(bands);
  return (dbm) =>
    bands.find((band) => dbm >= band.min && dbm < band.max)?.rgb ?? GREY;
}

export function gradientStops(bands) {
  return bands
    .filter((b) => Number.isFinite(b.min))
    .sort((a, b) => a.min - b.min)
    .map((b) => ({ value: b.min, rgb: b.rgb ?? hexToRgb(b.color) }));
}

function gradientColorFn(bands) {
  const stops = gradientStops(bands);
  const below = bands.find((b) => !Number.isFinite(b.min))?.rgb ?? stops[0]?.rgb ?? GREY;
  return (dbm) => {
    if (!stops.length || !Number.isFinite(dbm)) return GREY;
    if (dbm < stops[0].value) return below;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1],
        b = stops[i];
      if (dbm < b.value) {
        const t = (dbm - a.value) / (b.value - a.value);
        return a.rgb.map((v, k) => Math.round(v + (b.rgb[k] - v) * t));
      }
    }
    return stops[stops.length - 1].rgb;
  };
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
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (const c of cells) {
    if (c.x < x0) x0 = c.x;
    if (c.x > x1) x1 = c.x;
    if (c.z < z0) z0 = c.z;
    if (c.z > z1) z1 = c.z;
  }
  const nx = Math.round((x1 - x0) / step) + 1,
    nz = Math.round((z1 - z0) / step) + 1;
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
  // Column lookups are the same for every row: compute them once.
  const ix0 = new Int32Array(width),
    ix1 = new Int32Array(width),
    txs = new Float32Array(width);
  for (let px = 0; px < width; px++) {
    const fx = Math.min(Math.max((px + 0.5) / scale / step - 0.5, 0), nx - 1);
    ix0[px] = Math.floor(fx);
    ix1[px] = Math.min(ix0[px] + 1, nx - 1);
    txs[px] = smooth(fx - ix0[px]);
  }
  // Colour lookups are memoised per 0.1 dB, so the band search runs once per
  // distinct level instead of once per pixel.
  const colourCache = new Map();
  const colour = (v) => {
    const key = Math.round(v * 10);
    let rgb = colourCache.get(key);
    if (!rgb) colourCache.set(key, (rgb = colorAt(key / 10)));
    return rgb;
  };
  for (let py = 0; py < height; py++) {
    const fz = Math.min(Math.max((py + 0.5) / scale / step - 0.5, 0), nz - 1);
    const j0 = Math.floor(fz),
      j1 = Math.min(j0 + 1, nz - 1),
      tz = smooth(fz - j0);
    const row0 = j0 * nx,
      row1 = j1 * nx;
    for (let px = 0; px < width; px++) {
      const i0 = ix0[px],
        i1 = ix1[px],
        tx = txs[px];
      // Weighted mean of the four neighbours; cells outside the rooms (NaN)
      // are skipped so colour does not bleed in from empty space.
      let sum = 0,
        weight = 0,
        v,
        w;
      v = grid[row0 + i0];
      w = (1 - tx) * (1 - tz);
      if (v === v && w > 0) (sum += v * w), (weight += w);
      v = grid[row0 + i1];
      w = tx * (1 - tz);
      if (v === v && w > 0) (sum += v * w), (weight += w);
      v = grid[row1 + i0];
      w = (1 - tx) * tz;
      if (v === v && w > 0) (sum += v * w), (weight += w);
      v = grid[row1 + i1];
      w = tx * tz;
      if (v === v && w > 0) (sum += v * w), (weight += w);
      if (!weight) continue;
      const rgb = colour(sum / weight);
      const o = (py * width + px) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
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
  // The heatmap is cut to the union of all rooms. Every outline is drawn in the same direction: with one path
  // and the default "nonzero" rule, a room drawn clockwise inside one drawn anticlockwise (an imported polygon
  // room inside the rectangular "Floor") cancels out and becomes a hole with no heatmap.
  ctx.beginPath();
  for (const room of rooms) {
    let points = pointsOf(room);
    let twice = 0;
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      twice += p.x * q.z - q.x * p.z;
    });
    if (twice < 0) points = [...points].reverse();
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
