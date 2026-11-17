"""Wall material model: ITU-R P.2040 properties and single-slab loss. Pure NumPy.

The loss of a slab (thickness d, relative permittivity eps_r, conductivity sigma)
at normal incidence in air is the exact single-layer transmission

    n   = sqrt(eps_r - j sigma / (2 pi f eps0))
    r   = (1 - n) / (1 + n)
    t   = (1 - r^2) exp(-j k0 n d) / (1 - r^2 exp(-2 j k0 n d))
    loss = -20 log10 |t|     [dB]

A manual "loss through the wall" is turned into the conductivity that gives that
loss for the wall's thickness at the simulated frequency, with the material's
ITU permittivity. The same formula is used by the planner to show defaults.
"""
from __future__ import annotations

import math

import numpy as np

EPS0 = 8.8541878128e-12
C0 = 299792458.0

# ITU-R P.2040 coefficients (a, b, c, d) used by Sionna RT for 1-100 GHz:
# eps_r = a f_GHz^b, sigma = c f_GHz^d.
ITU = {
    "itu_plasterboard": (2.73, 0.0, 0.0085, 0.9395),
    "itu_wood": (1.99, 0.0, 0.0047, 1.0718),
    "itu_glass": (6.31, 0.0, 0.0036, 1.3394),
    "itu_brick": (3.91, 0.0, 0.0238, 0.16),
    "itu_concrete": (5.24, 0.0, 0.0462, 0.7822),
    "itu_metal": (1.0, 0.0, 1.0e7, 0.0),
}


def itu_properties(itu_type: str, freq_mhz: float) -> tuple[float, float]:
    a, b, c, d = ITU[itu_type]
    f_ghz = freq_mhz / 1000.0
    return a * f_ghz**b, c * f_ghz**d


def slab_loss_db(eps_r, sigma, thickness_m: float, freq_mhz: float):
    """Transmission loss of one slab at normal incidence (scalar or array sigma)."""
    f = freq_mhz * 1e6
    sigma = np.asarray(sigma, dtype=float)
    eps_c = eps_r - 1j * sigma / (2 * math.pi * f * EPS0)
    n = np.sqrt(eps_c)
    n = np.where(n.real < 0, -n, n)
    k0 = 2 * math.pi * f / C0
    r = (1 - n) / (1 + n)
    e = np.exp(-1j * k0 * n * thickness_m)
    t = (1 - r**2) * e / (1 - r**2 * e**2)
    with np.errstate(divide="ignore"):
        loss = -20 * np.log10(np.abs(t))
    return float(loss) if loss.ndim == 0 else loss


def sigma_for_loss(eps_r: float, thickness_m: float, freq_mhz: float, loss_db: float) -> dict:
    """Conductivity giving `loss_db` through the slab (first crossing from the
    lossless end). If the target is below the loss of the lossless slab, or
    above what any conductivity gives, the nearest reachable loss is returned
    with reachable=False."""
    grid = np.logspace(-8, 8, 1600)
    losses = slab_loss_db(eps_r, grid, thickness_m, freq_mhz)
    lossless = slab_loss_db(eps_r, 0.0, thickness_m, freq_mhz)
    if loss_db <= lossless:
        return {"sigma": 0.0, "achievedDb": lossless, "reachable": abs(lossless - loss_db) < 0.05}
    above = np.flatnonzero(losses >= loss_db)
    if not len(above):
        return {"sigma": float(grid[-1]), "achievedDb": float(losses[-1]), "reachable": False}
    i = int(above[0])
    lo, hi = (grid[i - 1] if i else 0.0), grid[i]
    for _ in range(80):
        mid = math.sqrt(lo * hi) if lo > 0 else hi / 2
        if slab_loss_db(eps_r, mid, thickness_m, freq_mhz) < loss_db:
            lo = mid
        else:
            hi = mid
    sigma = hi
    return {"sigma": float(sigma), "achievedDb": slab_loss_db(eps_r, sigma, thickness_m, freq_mhz), "reachable": True}
