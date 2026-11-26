// 3GPP operating bands and resource-block tables for the cellular module.
//
// These are values from the standards (TS 36.101 for LTE, TS 38.101-1 for NR),
// not from any one project: a carrier's real centre frequency, bandwidth and
// power are entered by the user per project. The band list only offers a
// starting point (the middle of the downlink range) and checks that a typed
// frequency sits inside the band.

// downlink range in MHz; duplex "FDD" or "TDD"
export const BANDS = {
  LTE: {
    B1: { dl: [2110, 2170], duplex: "FDD", name: "2100" },
    B3: { dl: [1805, 1880], duplex: "FDD", name: "1800" },
    B5: { dl: [869, 894], duplex: "FDD", name: "850" },
    B7: { dl: [2620, 2690], duplex: "FDD", name: "2600" },
    B8: { dl: [925, 960], duplex: "FDD", name: "900" },
    B20: { dl: [791, 821], duplex: "FDD", name: "800" },
    B28: { dl: [758, 803], duplex: "FDD", name: "700" },
    B38: { dl: [2570, 2620], duplex: "TDD", name: "2600 TDD" },
    B40: { dl: [2300, 2400], duplex: "TDD", name: "2300 TDD" },
    B41: { dl: [2496, 2690], duplex: "TDD", name: "2500 TDD" },
    B42: { dl: [3400, 3600], duplex: "TDD", name: "3500 TDD" },
  },
  NR: {
    n1: { dl: [2110, 2170], duplex: "FDD", name: "2100" },
    n3: { dl: [1805, 1880], duplex: "FDD", name: "1800" },
    n5: { dl: [869, 894], duplex: "FDD", name: "850" },
    n7: { dl: [2620, 2690], duplex: "FDD", name: "2600" },
    n8: { dl: [925, 960], duplex: "FDD", name: "900" },
    n20: { dl: [791, 821], duplex: "FDD", name: "800" },
    n28: { dl: [758, 803], duplex: "FDD", name: "700" },
    n40: { dl: [2300, 2400], duplex: "TDD", name: "2300 TDD" },
    n41: { dl: [2496, 2690], duplex: "TDD", name: "2500 TDD" },
    n77: { dl: [3300, 4200], duplex: "TDD", name: "3700 TDD" },
    n78: { dl: [3300, 3800], duplex: "TDD", name: "3500 TDD" },
    n79: { dl: [4400, 5000], duplex: "TDD", name: "4700 TDD" },
  },
};

export const TECHNOLOGIES = Object.keys(BANDS);

// LTE transmission bandwidth configuration (TS 36.101 Table 5.6-1)
const LTE_RB = { 1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100 };
// NR FR1 maximum transmission bandwidth configuration (TS 38.101-1 Table 5.3.2-1)
const NR_RB = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 40: 216, 50: 270 },
  30: { 5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 40: 106, 50: 133, 60: 162, 70: 189, 80: 217, 90: 245, 100: 273 },
  60: { 10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 40: 51, 50: 65, 60: 79, 70: 93, 80: 107, 90: 121, 100: 135 },
};

export const bandwidthsFor = (technology, scsKHz = 30) =>
  technology === "LTE"
    ? Object.keys(LTE_RB).map(Number)
    : Object.keys(NR_RB[scsKHz] || {}).map(Number);

export const subcarrierSpacingsFor = (technology) => (technology === "LTE" ? [15] : [15, 30, 60]);

// Resource blocks of a carrier; throws when the combination is not in the standard.
export function resourceBlocksFor({ technology, bandwidthMHz, scsKHz }) {
  const bw = Number(bandwidthMHz);
  const n = technology === "LTE" ? LTE_RB[bw] : NR_RB[Number(scsKHz) || 30]?.[bw];
  if (!n)
    throw new RangeError(
      technology === "LTE"
        ? `LTE has no ${bw} MHz carrier (use ${bandwidthsFor("LTE").join(", ")} MHz)`
        : `NR at ${scsKHz} kHz has no ${bw} MHz carrier (use ${bandwidthsFor("NR", scsKHz).join(", ")} MHz)`,
    );
  return n;
}

// RSRP is the power of one reference-signal resource element. With the carrier
// power spread equally over every subcarrier (12 per resource block) it is the
// carrier power less this many dB.
export const rsrpOffsetDb = (carrier) => 10 * Math.log10(12 * resourceBlocksFor(carrier));

export const bandInfo = (technology, band) => BANDS[technology]?.[band] || null;

// The band whose downlink range contains the frequency (first match), or null.
export function bandOfFrequency(technology, freqMHz) {
  const f = Number(freqMHz);
  for (const [band, info] of Object.entries(BANDS[technology] || {}))
    if (f >= info.dl[0] && f <= info.dl[1]) return band;
  return null;
}

export const bandCentreMHz = (technology, band) => {
  const info = bandInfo(technology, band);
  return info ? (info.dl[0] + info.dl[1]) / 2 : null;
};

// Problems with a carrier as the user entered it (empty when it is usable).
export function carrierProblems(carrier) {
  const out = [];
  if (!TECHNOLOGIES.includes(carrier?.technology)) out.push("choose LTE or NR");
  const f = Number(carrier?.freqMHz);
  if (!(f >= 400 && f <= 7125)) out.push("enter a downlink frequency between 400 and 7125 MHz");
  else if (carrier.band) {
    const info = bandInfo(carrier.technology, carrier.band);
    if (info && (f < info.dl[0] || f > info.dl[1]))
      out.push(`${f} MHz is outside ${carrier.band} (${info.dl[0]}-${info.dl[1]} MHz)`);
  }
  try {
    resourceBlocksFor(carrier);
  } catch (e) {
    out.push(e.message);
  }
  return out;
}

export function carrierLabel(c) {
  const parts = [c.operator, c.name || (c.band ? `${c.technology} ${c.band}` : c.technology), `${c.freqMHz} MHz`];
  return parts.filter(Boolean).join(" · ");
}
