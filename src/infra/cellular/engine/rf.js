// Radio helpers for the cellular IBS/DAS module. Pure functions, no UI.

export const dbmToMw = (dbm) => 10 ** (dbm / 10);
export const mwToDbm = (mw) => 10 * Math.log10(mw);
export const wattsToDbm = (watts) => 10 * Math.log10(watts * 1000);

// Resource blocks of an LTE carrier by channel bandwidth (MHz).
export const RESOURCE_BLOCKS = { 1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100 };

export function resourceBlocks(bandwidthMHz) {
  const n = RESOURCE_BLOCKS[bandwidthMHz];
  if (!n)
    throw new RangeError(
      `Unsupported LTE bandwidth ${bandwidthMHz} MHz (use ${Object.keys(RESOURCE_BLOCKS).join(", ")})`,
    );
  return n;
}

// Power of one resource element when the carrier power is spread equally over
// every subcarrier (12 per resource block). This is only the default: when the
// operator states the real reference-signal power, use that value instead (see
// referenceSignalAtPort).
export function perResourceElementDbm(carrierDbm, bandwidthMHz) {
  return carrierDbm - 10 * Math.log10(12 * resourceBlocks(bandwidthMHz));
}

// Reference-signal power per resource element at the BTS port. A stated value
// wins over the equal-split default.
export function referenceSignalAtPort({
  carrierPowerDbm,
  bandwidthMHz,
  referenceSignalPowerDbm,
}) {
  if (Number.isFinite(referenceSignalPowerDbm)) {
    return { dbm: referenceSignalPowerDbm, source: "stated" };
  }
  return {
    dbm: perResourceElementDbm(carrierPowerDbm, bandwidthMHz),
    source: "equal-power assumption",
  };
}

// Free-space path loss in dB (distance in metres, frequency in MHz).
export const freeSpaceLossDb = (distanceM, freqMHz) =>
  20 * Math.log10(distanceM) + 20 * Math.log10(freqMHz) - 27.55;

// Thermal noise power in dBm for a bandwidth in Hz at 290 K.
export const thermalNoiseDbm = (bandwidthHz) =>
  -174 + 10 * Math.log10(bandwidthHz);
