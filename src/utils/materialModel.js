// Wall material model, the same maths as worker/sionna_worker/materials.py.
// Used to show the default loss of each material and to validate manual values.

// plan material -> ITU-R P.2040 coefficients (eps_r = a f^b, sigma = c f^d, f in GHz)
export const ITU_MATERIALS = {
  drywall: { itu: "itu_plasterboard", a: 2.73, b: 0, c: 0.0085, d: 0.9395 },
  wood: { itu: "itu_wood", a: 1.99, b: 0, c: 0.0047, d: 1.0718 },
  glass: { itu: "itu_glass", a: 6.31, b: 0, c: 0.0036, d: 1.3394 },
  brick: { itu: "itu_brick", a: 3.91, b: 0, c: 0.0238, d: 0.16 },
  concrete: { itu: "itu_concrete", a: 5.24, b: 0, c: 0.0462, d: 0.7822 },
  metal: { itu: "itu_metal", a: 1, b: 0, c: 1e7, d: 0 },
};

export const MATERIAL_NAMES = Object.keys(ITU_MATERIALS);

export function ituProperties(material, freqMHz) {
  const m = ITU_MATERIALS[material];
  const f = freqMHz / 1000;
  return { epsR: m.a * f ** m.b, sigma: m.c * f ** m.d };
}

// Complex helpers on [re, im] pairs.
const mul = ([a, b], [c, d]) => [a * c - b * d, a * d + b * c];
const div = ([a, b], [c, d]) => {
  const q = c * c + d * d;
  return [(a * c + b * d) / q, (b * c - a * d) / q];
};
const sub = ([a, b], [c, d]) => [a - c, b - d];
const sqrt = ([a, b]) => {
  const r = Math.hypot(a, b);
  const re = Math.sqrt((r + a) / 2),
    im = Math.sign(b || 1) * Math.sqrt((r - a) / 2);
  return re < 0 ? [-re, -im] : [re, im];
};
const exp = ([a, b]) => [Math.exp(a) * Math.cos(b), Math.exp(a) * Math.sin(b)];

const EPS0 = 8.8541878128e-12;
const C0 = 299792458;

// Transmission loss (dB) of one slab at normal incidence.
export function slabLossDb(epsR, sigma, thicknessM, freqMHz) {
  const f = freqMHz * 1e6;
  const n = sqrt([epsR, -sigma / (2 * Math.PI * f * EPS0)]);
  const k0 = (2 * Math.PI * f) / C0;
  const r = div(sub([1, 0], n), [1 + n[0], n[1]]);
  const r2 = mul(r, r);
  const e = exp([k0 * n[1] * thicknessM, -k0 * n[0] * thicknessM]);
  const e2 = mul(e, e);
  const t = div(mul(sub([1, 0], r2), e), sub([1, 0], mul(r2, e2)));
  return -20 * Math.log10(Math.hypot(t[0], t[1]));
}

export const defaultLossDb = (material, thicknessM, freqMHz) => {
  const { epsR, sigma } = ituProperties(material, freqMHz);
  return slabLossDb(epsR, sigma, thicknessM, freqMHz);
};

// Manual overrides entered in the planner, cleaned for the export. Returns
// { overrides, errors }. Empty fields mean "keep the ITU default".
export function sanitizeOverrides(raw = {}, wallThicknessM = 0.2) {
  const overrides = {},
    errors = [];
  const num = (v) =>
    v === "" || v === null || v === undefined ? null : Number(v);
  for (const material of MATERIAL_NAMES) {
    const o = raw[material];
    if (!o) continue;
    const thickness = num(o.thicknessM),
      loss = num(o.lossDb),
      eps = num(o.permittivity),
      sigma = num(o.conductivity);
    const bad = (label, v, lo, hi) => {
      if (v !== null && !(Number.isFinite(v) && v >= lo && v <= hi)) {
        errors.push(`${material}: ${label} must be between ${lo} and ${hi}.`);
        return true;
      }
      return false;
    };
    if (
      bad("thickness (m)", thickness, 0.001, 1) ||
      bad("loss (dB)", loss, 0, 200) ||
      bad("permittivity", eps, 1, 100) ||
      bad("conductivity (S/m)", sigma, 0, 1e8)
    )
      continue;
    const out = {};
    if (thickness !== null) out.thicknessM = thickness;
    if (eps !== null && sigma !== null) {
      out.permittivity = eps;
      out.conductivity = sigma;
    } else if (loss !== null) {
      out.lossDb = loss;
      out.referenceThicknessM = thickness ?? wallThicknessM;
    }
    if (Object.keys(out).length) overrides[material] = out;
  }
  return { overrides, errors };
}
