// Default equipment catalogue. THESE VALUES ARE ILLUSTRATIVE PLACEHOLDERS so the
// engine can run before the client's datasheets arrive. Replace them with the
// manufacturer values; every entry carries its source so a report can say which
// numbers came from a datasheet and which did not.

const ILLUSTRATIVE = "illustrative default - replace with the datasheet value";

const table = (pairs) => pairs.map(([freqMHz, loss]) => ({ freqMHz, loss }));

export const DEFAULT_CATALOGUE = {
  version: 1,
  antennas: {
    omni2: { id: "omni2", name: "2 dBi omni ceiling antenna", gainDbi: 2, pattern: "omni", source: ILLUSTRATIVE },
    patch7: { id: "patch7", name: "7 dBi directional patch antenna", gainDbi: 7, pattern: "patch", source: ILLUSTRATIVE },
  },
  cables: {
    "7/8": {
      id: "7/8",
      name: '7/8" low-loss cable',
      maxPowerW: 500,
      lossDbPer100m: table([[700, 2.2], [900, 2.5], [1800, 3.6], [2100, 3.9], [2600, 4.5], [3500, 5.4], [3800, 5.7]]),
      source: ILLUSTRATIVE,
    },
    "1/2": {
      id: "1/2",
      name: '1/2" low-loss cable',
      maxPowerW: 250,
      lossDbPer100m: table([[700, 3.7], [900, 4.2], [1800, 6.0], [2100, 6.6], [2600, 7.6], [3500, 9.0], [3800, 9.4]]),
      source: ILLUSTRATIVE,
    },
  },
  couplers: Object.fromEntries(
    [5, 7, 10, 15].map((c) => [
      `c${c}`,
      { id: `c${c}`, name: `${c} dB coupler`, couplingDb: c, excessLossDb: 0.3, maxPowerW: 200, source: ILLUSTRATIVE },
    ]),
  ),
  splitters: {
    s2: { id: "s2", name: "2-way splitter", ways: 2, excessLossDb: 0.3, maxPowerW: 200, source: ILLUSTRATIVE },
    s3: { id: "s3", name: "3-way splitter", ways: 3, excessLossDb: 0.3, maxPowerW: 200, source: ILLUSTRATIVE },
    s4: { id: "s4", name: "4-way splitter", ways: 4, excessLossDb: 0.4, maxPowerW: 200, source: ILLUSTRATIVE },
  },
  inline: {
    combiner: { id: "combiner", name: "combiner (series loss)", lossDb: 0.5, maxPowerW: 200, source: ILLUSTRATIVE },
  },
  connector: { id: "n-male", name: "N connector", lossDb: 0.1, source: ILLUSTRATIVE },
};
