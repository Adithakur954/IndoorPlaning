"""Simulation job settings and validation (no Sionna import: cheap to use from an API)."""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

MAX_CELLS_PER_MAP = 1_000_000


class JobError(ValueError):
    """Invalid job settings or scene export."""


@dataclass
class JobSettings:
    scene_dir: str
    output_dir: str
    device: str = "auto"  # auto | gpu | cpu
    resolution_m: float = 1.0
    max_depth: int = 5
    samples_per_tx: int = 1_000_000
    receiver_height_m: float | None = None  # None: use the export's plane height
    weak_threshold_dbm: float = -75.0
    refraction: bool = True
    diffraction: bool = False
    diffuse_reflection: bool = False
    seed: int = 42
    floor_ids: list[str] | None = None
    cpu_threads: int | None = None
    receiver_gain_dbi: float = 0.0
    # noise floor (dBm) of a 20 MHz channel per band, for the SNR map: planning
    # assumptions for a fairly noisy office, to be replaced by measured values
    noise_floor_24_dbm: float = -86.0
    noise_floor_5_dbm: float = -88.0
    noise_floor_6_dbm: float = -88.0

    @classmethod
    def from_dict(cls, raw: dict) -> "JobSettings":
        unknown = set(raw) - set(cls.__dataclass_fields__)
        if unknown:
            raise JobError(f"Unknown job settings: {sorted(unknown)}")
        for required in ("scene_dir", "output_dir"):
            if not raw.get(required):
                raise JobError(f"'{required}' is required")
        settings = cls(**raw)
        settings.validate()
        return settings

    def validate(self) -> None:
        def number(name, low, high):
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise JobError(f"'{name}' must be a finite number")
            if not low <= value <= high:
                raise JobError(f"'{name}' must be between {low} and {high}")

        if self.device not in ("auto", "gpu", "cpu"):
            raise JobError("'device' must be auto, gpu or cpu")
        number("resolution_m", 0.1, 10)
        number("max_depth", 0, 20)
        number("samples_per_tx", 10_000, 100_000_000)
        number("weak_threshold_dbm", -150, 0)
        number("seed", 0, 2**31 - 1)
        if self.receiver_height_m is not None:
            number("receiver_height_m", 0, 20)
        if self.cpu_threads is not None:
            number("cpu_threads", 1, 256)
        number("receiver_gain_dbi", -20, 30)
        for name in ("noise_floor_24_dbm", "noise_floor_5_dbm", "noise_floor_6_dbm"):
            number(name, -110, -60)

    def to_dict(self) -> dict:
        return asdict(self)


BANDS = {"2.4": (2400, 2500), "5": (5150, 5895), "6": (5925, 7125)}


def band_of(freq_mhz: float) -> str | None:
    for name, (low, high) in BANDS.items():
        if low <= freq_mhz <= high:
            return name
    return None


@dataclass
class OptimizeJob:
    """Settings of an AP placement optimisation job (mode "optimize")."""

    scene_dir: str
    output_dir: str
    candidates: list
    profile: dict                      # {txPowerDbm, gainDbi, freqMHz}
    band: str = "5"
    cache_dir: str | None = None
    cache_max_mb: int = 500
    device: str = "auto"
    cpu_threads: int | None = None
    threshold_dbm: float = -67.0
    target_coverage_pct: float | None = 95.0   # None: maximise coverage for the budget
    budget: int | None = None                  # max number of NEW APs
    # fixed: keep every existing AP and add new ones | reuse: choose which existing
    # APs are enough (keep, move or remove them) | ignore: start from an empty plan
    existing_handling: str = "fixed"
    locked_ap_ids: list = field(default_factory=list)   # reuse: never touched
    keep_ap_ids: list = field(default_factory=list)     # reuse: may move, not be removed
    allow_new_aps: bool = False                         # reuse: may add APs when they are not enough
    redundancy: int = 1                        # distinct APs required per cell
    receiver_height_m: float | None = None
    resolution_m: float = 1.0
    screening_resolution_m: float = 2.0
    samples_per_tx: int = 1_000_000
    screening_samples: int = 100_000
    max_depth: int = 5
    screening_depth: int = 3
    seed: int = 42
    shortlist_max: int = 120
    shortlist_per_room: int = 3
    batch_size: int = 16
    min_ap_separation_m: float = 3.0
    # an AP is only added when it covers at least this share of the target area (or fixes a weak zone's worst
    # part): a budget of 50 is a maximum, not a quota, and no AP is added for a crumb of coverage
    min_ap_gain_pct: float = 1.0
    room_overrides: dict = field(default_factory=dict)
    include_common_area: bool = True
    refraction: bool = True
    diffraction: bool = False
    diffuse_reflection: bool = False
    receiver_gain_dbi: float = 0.0
    floor_ids: list | None = None
    refresh_cache: bool = False                # ignore cached rows (still writes them)
    noise_floor_24_dbm: float = -86.0
    noise_floor_5_dbm: float = -88.0
    noise_floor_6_dbm: float = -88.0
    mode: str = "optimize"

    MAX_CANDIDATES = 5000

    @classmethod
    def from_dict(cls, raw: dict) -> "OptimizeJob":
        raw = dict(raw)
        unknown = set(raw) - set(cls.__dataclass_fields__)
        if unknown:
            raise JobError(f"Unknown optimisation settings: {sorted(unknown)}")
        for required in ("scene_dir", "output_dir", "candidates", "profile"):
            if not raw.get(required):
                raise JobError(f"'{required}' is required")
        job = cls(**raw)
        job.validate()
        return job

    def validate(self) -> None:
        def number(name, low, high):
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise JobError(f"'{name}' must be a finite number")
            if not low <= value <= high:
                raise JobError(f"'{name}' must be between {low} and {high}")

        if self.band not in BANDS:
            raise JobError("'band' must be 2.4, 5 or 6")
        if self.device not in ("auto", "gpu", "cpu"):
            raise JobError("'device' must be auto, gpu or cpu")
        if self.existing_handling not in ("fixed", "reuse", "ignore"):
            raise JobError("'existing_handling' must be fixed, reuse or ignore")
        for name in ("locked_ap_ids", "keep_ap_ids"):
            value = getattr(self, name)
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise JobError(f"'{name}' must be a list of access point ids")
        if not isinstance(self.allow_new_aps, bool):
            raise JobError("'allow_new_aps' must be true or false")
        if not isinstance(self.candidates, list) or not 1 <= len(self.candidates) <= self.MAX_CANDIDATES:
            raise JobError(f"'candidates' must hold 1 to {self.MAX_CANDIDATES} entries")
        for c in self.candidates:
            for key in ("id", "floorId", "x", "z", "heightM"):
                if key not in c:
                    raise JobError(f"candidate is missing '{key}'")
            if not all(math.isfinite(float(c[k])) for k in ("x", "z", "heightM")):
                raise JobError(f"candidate {c['id']} has non-finite coordinates")
        for key in ("txPowerDbm", "gainDbi", "freqMHz"):
            if key not in self.profile or not math.isfinite(float(self.profile[key])):
                raise JobError(f"profile.{key} is required")
        if band_of(float(self.profile["freqMHz"])) != self.band:
            raise JobError("profile.freqMHz is not in the selected band")
        number("threshold_dbm", -120, 0)
        for name in ("noise_floor_24_dbm", "noise_floor_5_dbm", "noise_floor_6_dbm"):
            number(name, -110, -60)
        width = self.profile.get("bandwidthMHz", 20)
        if not isinstance(width, (int, float)) or isinstance(width, bool) or not math.isfinite(width) or not 1 <= width <= 320:
            raise JobError("profile.bandwidthMHz must be between 1 and 320")
        if self.target_coverage_pct is not None:
            number("target_coverage_pct", 1, 100)
        if self.target_coverage_pct is None and self.budget is None:
            raise JobError("Give a target coverage, a budget, or both")
        if self.budget is not None:
            number("budget", 0, 500)
        number("redundancy", 1, 4)
        number("resolution_m", 0.25, 5)
        number("screening_resolution_m", 0.5, 10)
        number("samples_per_tx", 10_000, 100_000_000)
        number("screening_samples", 10_000, 100_000_000)
        number("max_depth", 0, 20)
        number("screening_depth", 0, 20)
        number("seed", 0, 2**31 - 1)
        number("shortlist_max", 1, 2000)
        number("shortlist_per_room", 0, 50)
        number("batch_size", 1, 256)
        number("min_ap_separation_m", 0, 50)
        number("min_ap_gain_pct", 0, 50)
        number("receiver_gain_dbi", -20, 30)
        number("cache_max_mb", 0, 100_000)
        if self.receiver_height_m is not None:
            number("receiver_height_m", 0, 20)
        if self.cpu_threads is not None:
            number("cpu_threads", 1, 256)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["candidates"] = f"{len(self.candidates)} candidates"
        return d
