// Antenna models built into the cellular module, typed from the vendor datasheets
// supplied with the project (Frog Cellsat FROG-IBS, received 2026-11-25). Every
// project has them; a catalogue file can add other models. One entry per model,
// one row per datasheet band (e.g. 700/900, 1800-2600 incl. 2300, 3500 MHz); the
// prediction uses the row of the carrier's frequency. Two models, as the
// supplied 5G SISO design uses: an omni (ceiling) and a panel (wall); other
// models (high-gain panel, MIMO) can be imported when a design needs them.
import { validateAntenna } from "./catalogueImport.js";

export const BUILT_IN_ANTENNA_LIST = [
  {
    "id": "frog-FR-AOF0740-25-NF-1C-IS",
    "name": "Omni SISO",
    "vendor": "Frog Cellsat",
    "model": "FR-AO(F)0740-25-NF-1C-IS",
    "type": "omni",
    "polarization": "Horizontal (datasheet)",
    "maxPowerW": 50,
    "source": "Frog Omni Antenna SISO datasheet",
    "bands": [
      {
        "fromMHz": 698,
        "toMHz": 960,
        "gainDbi": 2.5,
        "hBeamwidthDeg": 360,
        "vBeamwidthDeg": 116
      },
      {
        "fromMHz": 1425,
        "toMHz": 1710,
        "gainDbi": 3.5,
        "hBeamwidthDeg": 360,
        "vBeamwidthDeg": 90
      },
      {
        "fromMHz": 1710,
        "toMHz": 2170,
        "gainDbi": 4,
        "hBeamwidthDeg": 360,
        "vBeamwidthDeg": 78
      },
      {
        "fromMHz": 2170,
        "toMHz": 2700,
        "gainDbi": 5,
        "hBeamwidthDeg": 360,
        "vBeamwidthDeg": 70
      },
      {
        "fromMHz": 3300,
        "toMHz": 3800,
        "gainDbi": 4,
        "hBeamwidthDeg": 360,
        "vBeamwidthDeg": 65
      }
    ]
  },
  {
    "id": "frog-FR-AP0740-58-NF-1C-IS",
    "name": "Panel SISO",
    "vendor": "Frog Cellsat",
    "model": "FR-AP0740-58-NF-1C-IS",
    "type": "panel",
    "polarization": "Vertical",
    "maxPowerW": 50,
    "source": "Frog Panel Antenna SISO datasheet",
    "bands": [
      {
        "fromMHz": 698,
        "toMHz": 806,
        "gainDbi": 5.5,
        "hBeamwidthDeg": 100,
        "vBeamwidthDeg": 90,
        "frontToBackDb": 9
      },
      {
        "fromMHz": 806,
        "toMHz": 960,
        "gainDbi": 6.5,
        "hBeamwidthDeg": 85,
        "vBeamwidthDeg": 82,
        "frontToBackDb": 10
      },
      {
        "fromMHz": 1710,
        "toMHz": 2700,
        "gainDbi": 8,
        "hBeamwidthDeg": 65,
        "vBeamwidthDeg": 60,
        "frontToBackDb": 15
      },
      {
        "fromMHz": 3300,
        "toMHz": 3800,
        "gainDbi": 7,
        "hBeamwidthDeg": 50,
        "vBeamwidthDeg": 45,
        "frontToBackDb": 11
      }
    ]
  }
];

// { id: entry }, checked like an imported catalogue
export const BUILT_IN_ANTENNAS = Object.fromEntries(
  BUILT_IN_ANTENNA_LIST.map((raw, i) => {
    const { entry, errors } = validateAntenna(raw, i);
    if (errors.length) throw new Error(`Built-in antenna catalogue: ${errors.join("; ")}`);
    return [entry.id, { ...entry, builtIn: true }];
  }),
);
