"""Cellular prediction job: validation only (no Sionna import, cheap to load).

The job is written by the simulation service from the planner's request:
  { mode: "cellular", scene_dir, output_dir, device?, carrier, sectors, antennas, patterns, settings }
Every radio number in it (powers, gains, patterns, frequency, bandwidth) comes
from the project; nothing here is a default for one client.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


class CellularJobError(ValueError):
    """Invalid cellular job."""


MAX_ANTENNAS = 2000
MAX_CELLS_PER_MAP = 1_000_000


def _num(raw, name, low, high):
    value = raw.get(name)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise CellularJobError(f"'{name}' must be a finite number")
    if not low <= value <= high:
        raise CellularJobError(f"'{name}' must be between {low} and {high}")
    return float(value)


def _table(values, length, name):
    if not isinstance(values, list) or len(values) != length:
        raise CellularJobError(f"pattern '{name}' needs {length} values")
    out = []
    for v in values:
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < -1e-6 or v > 200:
            raise CellularJobError(f"pattern '{name}' values must be attenuations between 0 and 200 dB")
        out.append(max(0.0, float(v)))
    return out


@dataclass
class Carrier:
    id: str
    label: str
    technology: str
    freq_mhz: float
    bandwidth_mhz: float
    scs_khz: float
    resource_blocks: int
    rsrp_offset_db: float
    band: str | None = None


@dataclass
class Pattern:
    gain_dbi: float
    h: list
    v: list
    max_att_db: float
    source: str = ""
    model: str = ""


@dataclass
class Antenna:
    id: str
    name: str
    floor_id: str
    sector_id: str
    position: list
    orientation_deg: list
    power_dbm: float
    pattern: str


@dataclass
class CellularJob:
    scene_dir: str
    output_dir: str
    carrier: Carrier
    sectors: list
    antennas: list
    patterns: dict
    device: str = "auto"
    resolution_m: float = 1.0
    receiver_height_m: float = 1.5
    max_depth: int = 5
    samples_per_tx: int = 1_000_000
    diffraction: bool = False
    ue_noise_figure_db: float = 7.0
    floor_ids: list | None = None
    seed: int = 42
    cpu_threads: int | None = None
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict) -> "CellularJob":
        if raw.get("mode") != "cellular":
            raise CellularJobError("not a cellular job")
        for required in ("scene_dir", "output_dir"):
            if not raw.get(required):
                raise CellularJobError(f"'{required}' is required")
        device = raw.get("device") or "auto"
        if device not in ("auto", "gpu", "cpu"):
            raise CellularJobError("'device' must be auto, gpu or cpu")

        c = raw.get("carrier")
        if not isinstance(c, dict):
            raise CellularJobError("'carrier' is required")
        if c.get("technology") not in ("LTE", "NR"):
            raise CellularJobError("carrier technology must be LTE or NR")
        carrier = Carrier(
            id=str(c.get("id") or "carrier"), label=str(c.get("label") or ""), technology=c["technology"],
            band=c.get("band"),
            freq_mhz=_num(c, "freqMHz", 400, 7125), bandwidth_mhz=_num(c, "bandwidthMHz", 1.4, 100),
            scs_khz=_num(c, "scsKHz", 15, 60), resource_blocks=int(_num(c, "resourceBlocks", 6, 275)),
            rsrp_offset_db=_num(c, "rsrpOffsetDb", 0, 40),
        )
        expected = 10 * math.log10(12 * carrier.resource_blocks)
        if abs(expected - carrier.rsrp_offset_db) > 0.01:
            raise CellularJobError("carrier rsrpOffsetDb does not match its resource blocks")

        sectors = raw.get("sectors")
        if not isinstance(sectors, list) or not sectors:
            raise CellularJobError("at least one sector is required")
        sector_ids = [str(s.get("id")) for s in sectors]
        if len(set(sector_ids)) != len(sector_ids):
            raise CellularJobError("sector ids must be unique")

        patterns = {}
        for key, p in (raw.get("patterns") or {}).items():
            if not isinstance(p, dict):
                raise CellularJobError(f"pattern '{key}' is invalid")
            patterns[key] = Pattern(
                gain_dbi=_num(p, "gainDbi", -10, 30), h=_table(p.get("h"), 360, key), v=_table(p.get("v"), 181, key),
                max_att_db=_num(p, "maxAttDb", 1, 200), source=str(p.get("source") or ""), model=str(p.get("model") or ""),
            )

        items = raw.get("antennas")
        if not isinstance(items, list) or not items:
            raise CellularJobError("at least one antenna is required")
        if len(items) > MAX_ANTENNAS:
            raise CellularJobError(f"at most {MAX_ANTENNAS} antennas per run")
        antennas = []
        for a in items:
            if a.get("sectorId") not in sector_ids:
                raise CellularJobError(f"antenna {a.get('name')}: unknown sector")
            if a.get("pattern") not in patterns:
                raise CellularJobError(f"antenna {a.get('name')}: unknown pattern")
            pos, ori = a.get("position"), a.get("orientationDeg")
            for vec, label in ((pos, "position"), (ori, "orientationDeg")):
                if (not isinstance(vec, list) or len(vec) != 3
                        or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vec)):
                    raise CellularJobError(f"antenna {a.get('name')}: '{label}' needs three numbers")
            antennas.append(Antenna(
                id=str(a.get("id")), name=str(a.get("name") or a.get("id")), floor_id=str(a.get("floorId")),
                sector_id=str(a["sectorId"]), position=[float(x) for x in pos],
                orientation_deg=[float(x) for x in ori], power_dbm=_num(a, "powerDbm", -30, 60), pattern=a["pattern"],
            ))

        s = raw.get("settings") or {}
        floor_ids = s.get("floorIds")
        if floor_ids is not None and (not isinstance(floor_ids, list) or not all(isinstance(x, str) for x in floor_ids)):
            raise CellularJobError("'floorIds' must be a list of floor ids")
        cpu = raw.get("cpu_threads")
        return cls(
            scene_dir=raw["scene_dir"], output_dir=raw["output_dir"], device=device,
            carrier=carrier, sectors=[{"id": str(x["id"]), "name": str(x.get("name") or x["id"])} for x in sectors],
            antennas=antennas, patterns=patterns,
            resolution_m=_num(s, "resolutionM", 0.1, 10) if "resolutionM" in s else 1.0,
            receiver_height_m=_num(s, "receiverHeightM", 0, 20) if "receiverHeightM" in s else 1.5,
            max_depth=int(_num(s, "maxDepth", 0, 20)) if "maxDepth" in s else 5,
            samples_per_tx=int(_num(s, "samplesPerTx", 10_000, 100_000_000)) if "samplesPerTx" in s else 1_000_000,
            diffraction=bool(s.get("diffraction", False)),
            ue_noise_figure_db=_num(s, "ueNoiseFigureDb", 0, 20) if "ueNoiseFigureDb" in s else 7.0,
            floor_ids=floor_ids,
            cpu_threads=int(cpu) if isinstance(cpu, int) and cpu > 0 else None,
        )
