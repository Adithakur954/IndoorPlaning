// Radiation patterns of DAS antennas, built from the catalogue entry of the
// antenna model at the carrier's frequency. Two sources, best first:
//   1. a measured pattern file (Planet .msi, the format vendors and iBwave use)
//      whose frequency is close to the carrier's;
//   2. the datasheet numbers of the band: gain, horizontal and vertical
//      beamwidth and front-to-back ratio, shaped like the antenna element of
//      3GPP TR 38.901 (Table 7.3-1), which is how planning tools model an
//      antenna that has no pattern file.
// Nothing here is specific to a vendor or a project: every number comes from
// the catalogue, which the user imports or edits.
//
// A pattern sent to the simulation worker:
//   { gainDbi, h: [360 attenuations, dB, azimuth 0..359 deg counter-clockwise
//     from boresight], v: [181 attenuations, dB, zenith angle 0 (up) .. 180
//     (down); 90 is the horizon], maxAttDb, source }
// Gain toward (zenith, azimuth) = gainDbi - min(h[azimuth] + v[zenith], maxAttDb).

const SIDE_LOBE_DB = 30; // TR 38.901 SLA_V and A_max
const PATTERN_FILE_TOLERANCE = 0.15; // a pattern file is used within ±15 % of its frequency
const round2 = (v) => Math.round(v * 100) / 100;

// The datasheet row of the band that contains the frequency.
export function bandEntry(antenna, freqMHz) {
  const f = Number(freqMHz);
  const rows = (antenna?.bands || []).filter((b) => f >= Number(b.fromMHz) && f <= Number(b.toMHz));
  // overlapping rows (a datasheet with 1710-2170 and 2170-2700): the narrower one is the more specific
  rows.sort((a, b) => a.toMHz - a.fromMHz - (b.toMHz - b.fromMHz));
  return rows[0] || null;
}

export function bandProblems(antenna, freqMHz) {
  if (!antenna) return ["no antenna model chosen"];
  if (bandEntry(antenna, freqMHz) || patternFileFor(antenna, freqMHz)) return [];
  const ranges = (antenna.bands || []).map((b) => `${b.fromMHz}-${b.toMHz}`).join(", ") || "none";
  return [`${antenna.name || antenna.id} has no datasheet values at ${freqMHz} MHz (its bands: ${ranges} MHz)`];
}

// TR 38.901 element shape from datasheet numbers.
export function parametricPattern({ gainDbi, hBeamwidthDeg, vBeamwidthDeg, frontToBackDb }) {
  const g = Number(gainDbi);
  const hbw = Number(hBeamwidthDeg);
  const vbw = Number(vBeamwidthDeg);
  if (!Number.isFinite(g)) throw new RangeError("the antenna gain is missing");
  if (!(vbw > 0 && vbw <= 360)) throw new RangeError("the vertical beamwidth is missing");
  const omni = !(hbw > 0) || hbw >= 360;
  const fb = Number(frontToBackDb);
  const maxAttDb = omni ? SIDE_LOBE_DB : Number.isFinite(fb) && fb > 0 ? fb : SIDE_LOBE_DB;
  const h = Array.from({ length: 360 }, (_, a) => {
    if (omni) return 0;
    const phi = a > 180 ? a - 360 : a;
    return round2(Math.min(12 * (phi / hbw) ** 2, maxAttDb));
  });
  const v = Array.from({ length: 181 }, (_, theta) =>
    round2(Math.min(12 * ((theta - 90) / vbw) ** 2, SIDE_LOBE_DB)),
  );
  return {
    gainDbi: g,
    h,
    v,
    maxAttDb,
    source: omni
      ? `datasheet: ${g} dBi, omni, vertical ${vbw}°`
      : `datasheet: ${g} dBi, ${hbw}° x ${vbw}°, front-to-back ${Number.isFinite(fb) ? `${fb} dB` : "not given (30 dB)"}`,
  };
}

// Planet .msi pattern file. Horizontal angles run clockwise seen from above;
// vertical angles start at the horizon in front and grow downward (90 = down,
// 270 = up). Values are attenuation in dB below the gain.
export function parseMsi(text, name = "pattern.msi") {
  const lines = String(text).split(/\r?\n/);
  const out = { name: "", freqMHz: null, gainDbi: null, horizontal: [], vertical: [], file: name };
  let mode = null,
    left = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (left > 0) {
      const [a, v] = line.split(/\s+/).map(Number);
      if (Number.isFinite(a) && Number.isFinite(v)) (mode === "h" ? out.horizontal : out.vertical).push([a, v]);
      left--;
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const k = key.toUpperCase();
    if (k === "NAME") out.name = rest.join(" ");
    else if (k === "FREQUENCY") out.freqMHz = Number(rest[0]);
    else if (k === "GAIN") {
      const g = Number(rest[0]);
      const unit = (rest[1] || "dBi").toLowerCase();
      out.gainDbi = unit === "dbd" ? g + 2.15 : g;
    } else if (k === "HORIZONTAL" || k === "VERTICAL") {
      mode = k === "HORIZONTAL" ? "h" : "v";
      left = Number(rest[0]) || 360;
    }
  }
  if (!Number.isFinite(out.gainDbi)) throw new RangeError(`${name}: no GAIN line`);
  if (!(out.freqMHz > 0)) throw new RangeError(`${name}: no FREQUENCY line`);
  if (out.horizontal.length < 4 || out.vertical.length < 4)
    throw new RangeError(`${name}: the horizontal and vertical patterns are missing or incomplete`);
  return out;
}

// value of a cut at an angle (degrees), linear between the listed angles, wrapping at 360
function cutAt(points, angle) {
  const pts = points.map(([a, v]) => [((a % 360) + 360) % 360, v]).sort((p, q) => p[0] - q[0]);
  const x = ((angle % 360) + 360) % 360;
  const lerp = ([a0, v0], [a1, v1], t) => (a1 === a0 ? v0 : v0 + ((v1 - v0) * (t - a0)) / (a1 - a0));
  for (let i = 0; i + 1 < pts.length; i++)
    if (x >= pts[i][0] && x <= pts[i + 1][0]) return lerp(pts[i], pts[i + 1], x);
  // between the last listed angle and the first one, across 360
  const last = pts[pts.length - 1],
    first = [pts[0][0] + 360, pts[0][1]];
  return lerp(last, first, x < pts[0][0] ? x + 360 : x);
}

// A parsed .msi file as a worker pattern.
export function msiPattern(msi) {
  const h = Array.from({ length: 360 }, (_, phi) => round2(cutAt(msi.horizontal, (360 - phi) % 360)));
  // zenith 0 (up) = vertical 270, zenith 90 = vertical 0 (horizon), zenith 180 (down) = vertical 90
  const v = Array.from({ length: 181 }, (_, theta) => round2(cutAt(msi.vertical, (theta - 90 + 360) % 360)));
  const maxAttDb = Math.min(60, Math.max(SIDE_LOBE_DB, ...h, ...v));
  return { gainDbi: msi.gainDbi, h, v, maxAttDb, source: `pattern file ${msi.file} (${msi.freqMHz} MHz)` };
}

// The stored pattern file closest in frequency, within the tolerance.
export function patternFileFor(antenna, freqMHz) {
  const f = Number(freqMHz);
  let best = null;
  for (const p of antenna?.patternFiles || []) {
    const d = Math.abs(p.freqMHz - f) / f;
    if (d <= PATTERN_FILE_TOLERANCE && (!best || d < best.d)) best = { p, d };
  }
  return best?.p || null;
}

// The pattern of an antenna model at a frequency; throws when the catalogue
// has nothing for that frequency (no guessing outside the datasheet).
export function patternFor(antenna, freqMHz) {
  const file = patternFileFor(antenna, freqMHz);
  if (file) return msiPattern(file);
  const row = bandEntry(antenna, freqMHz);
  if (!row) throw new RangeError(bandProblems(antenna, freqMHz)[0]);
  return parametricPattern(row);
}

// Gain toward a direction, for checks and the report (same rule as the worker).
export function patternGainDbi(pattern, zenithDeg, azimuthDeg) {
  const t = Math.max(0, Math.min(180, Math.round(zenithDeg)));
  const p = ((Math.round(azimuthDeg) % 360) + 360) % 360;
  return pattern.gainDbi - Math.min(pattern.h[p] + pattern.v[t], pattern.maxAttDb);
}

export const isOmni = (antenna) =>
  antenna?.type === "omni" || (antenna?.bands || []).every((b) => !(b.hBeamwidthDeg > 0) || b.hBeamwidthDeg >= 360);
