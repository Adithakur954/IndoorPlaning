"""RSRP and SINR from the received power of every antenna (pure numpy).

All antennas of one sector send the same cell, so a sector's received power is
the sum of its antennas' powers (a DAS: one signal through many antennas).
RSRP is the power of one reference-signal resource element: the cell's power
less 10*log10(12 * resource blocks), with the power spread equally over the
subcarriers. SINR on a resource element: the best cell's RSRP over the other
cells on the same carrier (taken as fully loaded) plus the thermal noise of one
subcarrier and the handset's noise figure.
"""
from __future__ import annotations

import numpy as np

FLOOR_DBM = -200.0  # no received power


def to_dbm(watts: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore"):
        dbm = 10.0 * np.log10(watts) + 30.0
    return np.where(np.isfinite(dbm), np.maximum(dbm, FLOOR_DBM), FLOOR_DBM)


def noise_per_re_dbm(scs_khz: float, noise_figure_db: float) -> float:
    return -174.0 + 10.0 * np.log10(scs_khz * 1e3) + noise_figure_db


def cell_grids(rss_w: np.ndarray, sector_of: np.ndarray, n_sectors: int, rsrp_offset_db: float,
               noise_re_dbm: float) -> dict:
    """rss_w: (antennas, ny, nx) received carrier power in watts; sector_of: (antennas,) sector index."""
    shape = rss_w.shape[1:]
    per_sector_w = np.zeros((n_sectors, *shape))
    for i, s in enumerate(sector_of):
        per_sector_w[s] += rss_w[i]
    re_scale = 10.0 ** (-rsrp_offset_db / 10.0)
    per_sector_re_w = per_sector_w * re_scale
    best = per_sector_re_w.argmax(axis=0)
    best_w = np.take_along_axis(per_sector_re_w, best[None], 0)[0]
    others_w = per_sector_re_w.sum(axis=0) - best_w
    noise_w = 10.0 ** ((noise_re_dbm - 30.0) / 10.0)
    with np.errstate(divide="ignore"):
        sinr = 10.0 * np.log10(best_w / (others_w + noise_w))
    reached = best_w > 0
    best_antenna = rss_w.argmax(axis=0) if rss_w.shape[0] else np.zeros(shape, dtype=int)
    return {
        "perSectorRsrpDbm": to_dbm(per_sector_re_w),
        "bestSector": best,
        "bestRsrpDbm": to_dbm(best_w),
        "sinrDb": np.where(reached, sinr, np.nan),
        "bestAntenna": best_antenna,
    }
