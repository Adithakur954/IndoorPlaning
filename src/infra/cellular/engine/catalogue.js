// Default equipment catalogue of the cellular DAS, from manufacturer datasheets.
// Every entry carries its source, so a report can say where each number came from.
//   Frog Cellsat FROG-IBS datasheets supplied with the project (received 2026-11):
//     splitters FR-SP0740-NF-6C-2W/3W/4W, couplers FR-CP0740-NF-6C-05..20dB,
//     1/2" superflex feeder FR-FC4000-12-XX-XS, adaptor FR-AD0040-NMRA-NFXX-XC,
//     combiners FR-CM0740-4F-2C-21/22/44, jumpers FRJ1 (1 m of the 1/2" superflex).
//   RFS LCF78-50JA 7/8" CELLFLEX (public datasheet, rev A 19 Oct 2026): the riser feeder.
// A project with other parts replaces these with its own datasheet values.

const ILLUSTRATIVE = "illustrative default - replace with the datasheet value";
const FROG = (doc) => `Frog Cellsat datasheet: ${doc}`;

const table = (pairs) => pairs.map(([freqMHz, loss]) => ({ freqMHz, loss }));
// datasheet "insertion loss" of an n-way splitter is the whole loss per output:
// the equal split 10*log10(n) plus the part's own (excess) loss
const splitter = (id, ways, insertionLossDb, model) => ({
  id,
  name: `${ways}-way splitter`,
  ways,
  excessLossDb: insertionLossDb - 10 * Math.log10(ways),
  datasheetInsertionLossDb: insertionLossDb,
  maxPowerW: 300,
  model,
  source: FROG(`RF Splitters ${model} (insertion loss <= ${insertionLossDb} dB, 698-3800 MHz)`),
});
// coupler: the tap output loses the coupler value, the through output the datasheet insertion loss
const coupler = (couplingDb, throughLossDb, model) => ({
  id: `c${couplingDb}`,
  name: `${couplingDb} dB coupler`,
  couplingDb,
  tapLossDb: couplingDb,
  throughLossDb,
  maxPowerW: 300,
  model,
  source: FROG(`RF Couplers ${model} (insertion loss <= ${throughLossDb} dB, 698-3800 MHz)`),
});

export const DEFAULT_CATALOGUE = {
  version: 2,
  antennas: {
    omni2: { id: "omni2", name: "2 dBi omni ceiling antenna", gainDbi: 2, pattern: "omni", source: ILLUSTRATIVE },
    patch7: { id: "patch7", name: "7 dBi directional patch antenna", gainDbi: 7, pattern: "patch", source: ILLUSTRATIVE },
  },
  cables: {
    "1/2": {
      id: "1/2",
      name: '1/2" superflex feeder',
      model: "FR-FC4000-12-XX-XS",
      lossDbPer100m: table([
        [150, 4.2], [450, 7.6], [800, 10.2], [900, 10.8], [1800, 16.0],
        [2000, 17.0], [2500, 19.0], [3000, 21.5], [3800, 25.0],
      ]),
      source: FROG('1/2" Superflex Feeder Cable FR-FC4000-12-XX-XS (attenuation @ 20 °C)'),
    },
    "7/8": {
      id: "7/8",
      name: '7/8" low-loss feeder (riser)',
      model: "RFS LCF78-50JA",
      lossDbPer100m: table([
        [450, 2.57], [700, 3.25], [800, 3.49], [870, 3.65], [900, 3.72], [960, 3.85],
        [1800, 5.45], [2000, 5.78], [2200, 6.09], [2400, 6.4], [2600, 6.7], [2700, 6.84],
        [3000, 7.27], [3500, 7.94], [4000, 8.58],
      ]),
      maxPowerW: 1720, // average power rating at 2000 MHz, 40 °C
      source: 'RFS LCF78-50JA 7/8" CELLFLEX datasheet rev A (attenuation @ 20 °C)',
    },
  },
  couplers: Object.fromEntries(
    [
      coupler(5, 2.2, "FR-CP0740-NF-6C-05dB"),
      coupler(7, 1.4, "FR-CP0740-NF-6C-07dB"),
      coupler(10, 1.1, "FR-CP0740-NF-6C-10dB"),
      coupler(15, 0.6, "FR-CP0740-NF-6C-15dB"),
      coupler(20, 0.4, "FR-CP0740-NF-6C-20dB"),
    ].map((c) => [c.id, c]),
  ),
  splitters: {
    s2: splitter("s2", 2, 3.4, "FR-SP0740-NF-6C-2W"),
    s3: splitter("s3", 3, 5.4, "FR-SP0740-NF-6C-3W"),
    s4: splitter("s4", 4, 6.6, "FR-SP0740-NF-6C-4W"),
  },
  inline: {
    cm21: { id: "cm21", name: "Combiner 2x1", lossDb: 3.8, maxPowerW: 100, model: "FR-CM0740-4F-2C-21", source: FROG("Combiner 2x1 FR-CM0740-4F-2C-21 (insertion loss 3.8 ± 0.5 dB)") },
    cm22: { id: "cm22", name: "Combiner 2x2", lossDb: 3.9, maxPowerW: 100, model: "FR-CM0740-4F-2C-22", source: FROG("Combiner 2x2 FR-CM0740-4F-2C-22 (insertion loss 3.9 ± 0.2 dB)") },
    cm44: { id: "cm44", name: "Combiner 4x4", lossDb: 7.0, maxPowerW: 100, model: "FR-CM0740-4F-2C-44", source: FROG("Combiner 4x4 FR-CM0740-4F-2C-44 (insertion loss 7.0 ± 0.2 dB)") },
    combiner: { id: "combiner", name: "combiner (series loss)", lossDb: 0.5, maxPowerW: 200, source: ILLUSTRATIVE },
  },
  // each cable end: an N connector / adaptor
  connector: { id: "n-adaptor", name: "N connector / adaptor", lossDb: 0.1, model: "FR-AD0040-NMRA-NFXX-XC", source: FROG("RF Adaptor FR-AD0040-NMRA-NFXX-XC (insertion loss <= 0.1 dB)") },
};
