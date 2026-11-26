// Losses of passive DAS parts. Pure functions; every value that comes from a
// datasheet is read from the catalogue, never typed in here.

// Interpolates a datasheet table [{ freqMHz, loss }] linearly in log(frequency).
// It refuses to extrapolate: a band outside the datasheet needs a new entry,
// not a guess.
export function lossAtFrequency(table, freqMHz, label = "part") {
  if (!Array.isArray(table) || table.length === 0)
    throw new RangeError(`${label} has no loss table`);
  const rows = [...table].sort((a, b) => a.freqMHz - b.freqMHz);
  const lo = rows[0].freqMHz;
  const hi = rows[rows.length - 1].freqMHz;
  if (freqMHz < lo || freqMHz > hi)
    throw new RangeError(
      `${label} has no datasheet loss for ${freqMHz} MHz (table covers ${lo}-${hi} MHz)`,
    );
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (freqMHz >= a.freqMHz && freqMHz <= b.freqMHz) {
      if (b.freqMHz === a.freqMHz) return a.loss;
      const t =
        (Math.log(freqMHz) - Math.log(a.freqMHz)) /
        (Math.log(b.freqMHz) - Math.log(a.freqMHz));
      return a.loss + t * (b.loss - a.loss);
    }
  }
  return rows[rows.length - 1].loss;
}

// Cable loss in dB for a length in metres.
export function cableLossDb(cable, lengthM, freqMHz) {
  if (!(lengthM >= 0)) throw new RangeError("cable length must be zero or more");
  const per100 = lossAtFrequency(
    cable.lossDbPer100m,
    freqMHz,
    `cable ${cable.name || cable.id}`,
  );
  return (per100 * lengthM) / 100;
}

// Power that continues out of the through port of an ideal coupler: with a
// coupling loss of C dB the tap takes 10^(-C/10) of the power.
export function couplerIdealThroughLossDb(couplingDb) {
  const tapFraction = 10 ** (-couplingDb / 10);
  if (!(couplingDb > 0) || tapFraction >= 1)
    throw new RangeError("coupling loss must be above 0 dB");
  return -10 * Math.log10(1 - tapFraction);
}

// Datasheet excess loss is the heat and mismatch loss on top of the ideal split.
const excess = (part) => Number(part.excessLossDb ?? part.insertionLossDb ?? 0);

export const couplerTapLossDb = (coupler) =>
  coupler.couplingDb + excess(coupler);

export const couplerThroughLossDb = (coupler) =>
  couplerIdealThroughLossDb(coupler.couplingDb) + excess(coupler);

// Equal splitter with n outputs: each output gets 1/n of the power.
export const splitterLossDb = (splitter) =>
  10 * Math.log10(splitter.ways) + excess(splitter);
