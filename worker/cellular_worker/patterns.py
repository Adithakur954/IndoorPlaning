"""Antenna patterns of the job as Sionna RT antenna patterns.

A pattern is a gain (dBi) and two attenuation tables: 360 values over azimuth
(counter-clockwise from boresight) and 181 over the zenith angle (0 up, 90 the
horizon, 180 down). Gain toward (zenith, azimuth) = gain - min(h + v, maxAtt).
The antenna's own frame has its boresight on +x; the transmitter orientation
turns it in the scene.
"""
from __future__ import annotations

import itertools
import math

import numpy as np

from .job import Pattern

_IDS = itertools.count(1)  # registry names must stay unique within a process


def gain_dbi(p: Pattern, zenith_deg: float, azimuth_deg: float) -> float:
    """Same rule as the worker kernel, for tests and checks."""
    t = int(min(180, max(0, math.floor(zenith_deg + 0.5))))
    a = int(math.floor(azimuth_deg + 0.5)) % 360
    return p.gain_dbi - min(p.h[a] + p.v[t], p.max_att_db)


def register(p: Pattern) -> str:
    """Registers the pattern with Sionna and returns its name (Mitsuba variant must be set)."""
    import drjit as dr
    import mitsuba as mi
    from sionna.rt.antenna_pattern import PolarizedAntennaPattern, register_antenna_pattern

    h_tab = mi.Float(np.asarray(p.h, dtype=np.float32))
    v_tab = mi.Float(np.asarray(p.v, dtype=np.float32))
    gain, max_att = float(p.gain_dbi), float(p.max_att_db)
    to_deg = 180.0 / math.pi

    def v_pattern(theta, phi):
        az = phi * to_deg
        az = az - dr.floor(az / 360.0) * 360.0  # [0, 360)
        ia = mi.UInt32(dr.floor(az + 0.5))
        ia = dr.select(ia >= 360, ia - 360, ia)
        it = mi.UInt32(dr.clip(dr.floor(theta * to_deg + 0.5), 0.0, 180.0))
        att = dr.minimum(dr.gather(mi.Float, h_tab, ia) + dr.gather(mi.Float, v_tab, it), max_att)
        amplitude = dr.sqrt(dr.power(10.0, (gain - att) / 10.0))
        return mi.Complex2f(amplitude, 0)

    name = f"cellular_pattern_{next(_IDS)}"

    def factory(*, polarization, polarization_model="tr38901_2"):
        return PolarizedAntennaPattern(v_pattern=v_pattern, polarization=polarization,
                                       polarization_model=polarization_model)

    register_antenna_pattern(name, factory)
    return name
