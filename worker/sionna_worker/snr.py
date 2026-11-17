"""Signal-to-noise ratio of a predicted radio map (no Sionna import, cheap to test).

SNR = strongest AP's received power - noise floor of that AP's channel.

The noise floor is a planning assumption, set per band for a 20 MHz channel
(it depends on the RF environment, so it is configurable and should be replaced
by a measured value when one is available). A wider channel collects more
noise: +3 dB at 40 MHz, +6 dB at 80 MHz, +9 dB at 160 MHz.
Interference from other APs is not part of SNR: Wi-Fi shares a channel by taking
turns, so co-channel APs cost airtime, not SNR.
"""
from __future__ import annotations

import math

import numpy as np

REFERENCE_BANDWIDTH_MHZ = 20.0
DEFAULT_BANDWIDTH_MHZ = 20.0


def noise_floor_dbm(floor_20mhz_dbm: float, bandwidth_mhz: float) -> float:
    """Noise floor of a channel of `bandwidth_mhz`, from the floor at 20 MHz."""
    return floor_20mhz_dbm + 10.0 * math.log10(bandwidth_mhz / REFERENCE_BANDWIDTH_MHZ)


def ap_bandwidth_mhz(ap: dict) -> tuple[float, bool]:
    """(bandwidth, assumed): an AP without a usable width is taken as 20 MHz."""
    try:
        value = float(ap.get("bandwidthMHz"))
        if math.isfinite(value) and value > 0:
            return value, False
    except (TypeError, ValueError):
        pass
    return DEFAULT_BANDWIDTH_MHZ, True


def snr_grid(best_dbm: np.ndarray, best_index: np.ndarray, noise_dbm: np.ndarray) -> np.ndarray:
    """SNR in dB per cell: the best AP's power minus the noise floor of its channel."""
    return best_dbm - np.asarray(noise_dbm, dtype=float)[best_index]


def strongest_snr(rows: np.ndarray, noise_dbm: np.ndarray, floor_dbm: float = -200.0) -> np.ndarray:
    """SNR for AP-by-cell power rows, retaining the no-signal sentinel."""
    if not len(rows):
        return np.full(rows.shape[1], floor_dbm, np.float32)
    best = rows.argmax(axis=0)
    power = rows[best, np.arange(rows.shape[1])].astype(np.float32)
    return np.where(power > floor_dbm, power - np.asarray(noise_dbm)[best], floor_dbm)
