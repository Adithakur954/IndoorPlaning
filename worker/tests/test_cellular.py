"""Cellular worker: job checks, RSRP/SINR maths, patterns, and a real Sionna run on the sample scene."""
import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from cellular_worker.job import CellularJob, CellularJobError, Pattern
from cellular_worker.kpi import FLOOR_DBM, cell_grids, noise_per_re_dbm, to_dbm
from cellular_worker.patterns import gain_dbi

SCENE = Path(__file__).resolve().parents[1] / "samples" / "two-floor"
try:
    import sionna.rt  # noqa: F401
    HAVE_SIONNA = SCENE.exists()
except Exception:  # noqa: BLE001
    HAVE_SIONNA = False


def parametric(gain, hbw, vbw, fb=None):
    """The same shape as src/infra/cellular/antennaPattern.js parametricPattern."""
    omni = not hbw or hbw >= 360
    max_att = 30.0 if omni or not fb else float(fb)
    h = [0.0 if omni else min(12 * (((a - 360) if a > 180 else a) / hbw) ** 2, max_att) for a in range(360)]
    v = [min(12 * ((t - 90) / vbw) ** 2, 30.0) for t in range(181)]
    return {"gainDbi": gain, "h": h, "v": v, "maxAttDb": max_att, "source": "test", "model": "test"}


def carrier(rb=100):
    return {"id": "c1", "label": "test", "technology": "LTE", "freqMHz": 2350, "bandwidthMHz": 20,
            "scsKHz": 15, "resourceBlocks": rb, "rsrpOffsetDb": 10 * math.log10(12 * rb)}


def job_dict(out, antennas, patterns, sectors=None, **settings):
    return {
        "mode": "cellular", "scene_dir": str(SCENE), "output_dir": out, "carrier": carrier(),
        "sectors": sectors or [{"id": "s1", "name": "Sector 1"}],
        "antennas": antennas, "patterns": patterns,
        "settings": {"resolutionM": 1.0, "receiverHeightM": 1.5, "maxDepth": 3, "samplesPerTx": 400_000, **settings},
    }


def antenna(aid, pos, power=10.0, sector="s1", pattern="omni", ori=(0, 0, 0), floor="f1"):
    return {"id": aid, "name": aid, "floorId": floor, "sectorId": sector, "position": list(pos),
            "orientationDeg": list(ori), "powerDbm": power, "pattern": pattern}


class JobChecks(unittest.TestCase):
    def test_valid_job(self):
        job = CellularJob.from_dict(job_dict("o", [antenna("a", (4, -4, 2.7))], {"omni": parametric(5, 360, 70)}))
        self.assertEqual(job.carrier.resource_blocks, 100)
        self.assertEqual(len(job.patterns["omni"].h), 360)

    def test_rejects_bad_input(self):
        good = job_dict("o", [antenna("a", (4, -4, 2.7))], {"omni": parametric(5, 360, 70)})
        for change, message in [
            (lambda j: j["antennas"][0].update(sectorId="nope"), "unknown sector"),
            (lambda j: j["antennas"][0].update(pattern="nope"), "unknown pattern"),
            (lambda j: j["antennas"][0].update(position=[1, 2]), "three numbers"),
            (lambda j: j["carrier"].update(rsrpOffsetDb=20), "does not match"),
            (lambda j: j["patterns"]["omni"].update(h=[0] * 10), "needs 360"),
            (lambda j: j.update(antennas=[]), "at least one antenna"),
            (lambda j: j.update(mode="optimize"), "not a cellular job"),
        ]:
            raw = json.loads(json.dumps(good))
            change(raw)
            with self.assertRaisesRegex(CellularJobError, message):
                CellularJob.from_dict(raw)


class Maths(unittest.TestCase):
    def test_sector_power_adds_and_rsrp_offset(self):
        # two antennas of one sector, 1 mW each: 2 mW = 3.01 dBm; RSRP = 3.01 - 10log10(1200)
        rss = np.full((2, 1, 1), 1e-3)
        g = cell_grids(rss, np.array([0, 0]), 1, 10 * math.log10(1200), -200)
        self.assertAlmostEqual(float(g["bestRsrpDbm"][0, 0]), 10 * math.log10(2) - 10 * math.log10(1200), 4)

    def test_sinr_against_the_other_sector(self):
        # sector 0 gets 4x the power of sector 1, negligible noise: SINR = 6.02 dB
        rss = np.array([[[4e-6]], [[1e-6]]])
        g = cell_grids(rss, np.array([0, 1]), 2, 0.0, -300)
        self.assertEqual(int(g["bestSector"][0, 0]), 0)
        self.assertAlmostEqual(float(g["sinrDb"][0, 0]), 10 * math.log10(4), 4)

    def test_noise_per_resource_element(self):
        # 15 kHz, 7 dB: -174 + 41.76 + 7
        self.assertAlmostEqual(noise_per_re_dbm(15, 7), -174 + 10 * math.log10(15e3) + 7, 6)

    def test_no_power_is_the_floor(self):
        self.assertEqual(float(to_dbm(np.array([0.0]))[0]), FLOOR_DBM)

    def test_pattern_rule(self):
        p = Pattern(**{"gain_dbi": 8, "h": parametric(8, 65, 60, 15)["h"], "v": parametric(8, 65, 60, 15)["v"],
                       "max_att_db": 15})
        self.assertAlmostEqual(gain_dbi(p, 90, 0), 8)
        self.assertAlmostEqual(gain_dbi(p, 90, 180), 8 - 15)
        self.assertAlmostEqual(gain_dbi(p, 120, 0), 8 - 3, 6)


@unittest.skipUnless(HAVE_SIONNA, "sionna-rt or the sample scene is not available")
class SionnaRun(unittest.TestCase):
    """The sample is two 20 x 8 m floors; floor f1's plane is at 1.5 m."""

    @classmethod
    def setUpClass(cls):
        from cellular_worker.predict import run

        cls.run_job = staticmethod(run)

    def predict(self, antennas, patterns, sectors=None, **settings):
        with tempfile.TemporaryDirectory() as out:
            result = self.run_job(CellularJob.from_dict(job_dict(out, antennas, patterns, sectors, floorIds=["f1"], **settings)))
            maps = {f["floorId"]: json.loads(Path(out, f["file"]).read_text()) for f in result["floors"]}
            return result, maps

    @staticmethod
    def at(m, x, z, key="bestDbm"):
        ix = int(np.argmin(np.abs(np.array(m["xCentersM"]) - x)))
        iz = int(np.argmin(np.abs(np.array(m["zCentersM"]) - z)))
        return m[key][iz][ix]

    def test_rsrp_near_an_omni_matches_free_space(self):
        # antenna at plan (4, 4) 2.7 m high, 10 dBm, 5 dBi; receiver 3 m away along x at 1.5 m
        result, maps = self.predict([antenna("a", (4, -4, 2.7))], {"omni": parametric(5, 360, 70)})
        m = maps["f1"]
        x = 7.5 if any(abs(v - 7.5) < 0.01 for v in m["xCentersM"]) else 7.0
        d = math.hypot(x - 4, 2.7 - 1.5)
        zen = 90 + math.degrees(math.atan2(1.2, x - 4))
        gain = 5 - min(12 * ((zen - 90) / 70) ** 2, 30)
        fspl = 20 * math.log10(d) + 20 * math.log10(2350) - 27.55
        expected = 10 + gain - fspl - 10 * math.log10(1200)
        got = self.at(m, x, 4.5 if any(abs(v - 4.5) < 0.01 for v in m["zCentersM"]) else 4.0)
        # line of sight plus reflections from the floor/walls and the cell averaging: within 3 dB
        self.assertLess(abs(got - expected), 3.0, (got, expected))
        self.assertEqual(result["network"], "cellular")
        self.assertEqual(m["accessPoints"], [{"id": "s1", "name": "Sector 1"}])

    def test_a_panel_is_stronger_in_front_than_behind(self):
        # panel at x = 10 facing +x (yaw 0) vs facing -x (yaw 180): the +x side gets more in the first case
        pats = {"panel": parametric(8, 65, 60, 15)}
        _, front = self.predict([antenna("a", (10, -4, 2.7), pattern="panel", ori=(0, 0, 0))], pats)
        _, back = self.predict([antenna("a", (10, -4, 2.7), pattern="panel", ori=(180, 0, 0))], pats)
        self.assertGreater(self.at(front["f1"], 16, 4) - self.at(back["f1"], 16, 4), 8)

    def test_a_ceiling_panel_facing_down_is_strongest_below(self):
        pats = {"panel": parametric(8, 65, 60, 25)}
        _, down = self.predict([antenna("a", (10, -4, 2.7), pattern="panel", ori=(0, 90, 0))], pats)
        _, up = self.predict([antenna("a", (10, -4, 2.7), pattern="panel", ori=(0, -90, 0))], pats)
        self.assertGreater(self.at(down["f1"], 10, 4) - self.at(up["f1"], 10, 4), 10)

    def test_two_sectors_give_best_server_and_sinr(self):
        sectors = [{"id": "s1", "name": "Sector 1"}, {"id": "s2", "name": "Sector 2"}]
        # both in the 12 x 8 m hall (a concrete wall stands at x = 12), 9 m apart
        ants = [antenna("a", (2, -4, 2.7), sector="s1"), antenna("b", (11, -4, 2.7), sector="s2")]
        _, maps = self.predict(ants, {"omni": parametric(5, 360, 70)}, sectors)
        m = maps["f1"]
        self.assertEqual(self.at(m, 2, 4, "bestApIndex"), 0)
        self.assertEqual(self.at(m, 11, 4, "bestApIndex"), 1)
        # beside an antenna its own cell dominates (not straight under it, where a ceiling omni's
        # vertical pattern dips); half-way the two cells are about equal
        self.assertGreater(self.at(m, 0.5, 4, "bestSinrDb"), 6)
        self.assertLess(abs(self.at(m, 6.5, 4, "bestSinrDb")), 4)
        # behind the wall, sector 2 (nearer the wall) serves the office
        self.assertEqual(self.at(m, 16, 4, "bestApIndex"), 1)


if __name__ == "__main__":
    unittest.main()
