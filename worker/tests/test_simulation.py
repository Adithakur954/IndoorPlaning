"""End-to-end checks against the exported sample scene (uses the GPU when usable)."""
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCENE = Path(__file__).resolve().parents[1] / "samples" / "two-floor"

try:
    import sionna.rt  # noqa: F401
    HAVE_SIONNA = SCENE.exists()
except Exception:  # noqa: BLE001
    HAVE_SIONNA = False


def run_job(out: str, **overrides):
    from sionna_worker.job import JobSettings
    from sionna_worker.simulate import run

    settings = JobSettings.from_dict({
        "scene_dir": str(SCENE), "output_dir": out, "resolution_m": 1.0,
        "samples_per_tx": 500_000, "max_depth": 4, **overrides,
    })
    return run(settings)


def load_map(out: str, floor: str):
    return json.loads(Path(out, "maps", f"{floor}__5000MHz.json").read_text())


@unittest.skipUnless(HAVE_SIONNA, "sionna-rt or the sample scene is not available")
class SimulationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.result = run_job(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_result_metadata(self):
        r = self.result
        self.assertEqual(r["status"], "ok")
        self.assertEqual(len(r["floors"]), 2)
        self.assertIn(r["backend"]["device"], ("gpu", "cpu"))
        self.assertTrue(r["assumptions"])

    def test_maps_have_consistent_shape(self):
        m = load_map(self.tmp.name, "f1")
        ny, nx = m["shape"]
        self.assertEqual((len(m["zCentersM"]), len(m["xCentersM"])), (ny, nx))
        self.assertEqual(np.array(m["bestDbm"], dtype=float).shape, (ny, nx))
        self.assertEqual(len(m["perApDbm"]), len(m["accessPoints"]))

    def test_same_seed_is_reproducible(self):
        with tempfile.TemporaryDirectory() as other:
            run_job(other)
            a = load_map(self.tmp.name, "f1")["bestDbm"]
            b = load_map(other, "f1")["bestDbm"]
        self.assertEqual(a, b)

    def test_slab_attenuates_the_other_floor(self):
        # ap0 sits on level 1. Straight above it on level 2 the signal must be
        # much weaker than the same distance away on level 1.
        near = load_map(self.tmp.name, "f1")["perApDbm"][0]
        above = load_map(self.tmp.name, "f2")["perApDbm"][0]
        ny, nx = np.array(near, dtype=float).shape
        iy, ix = ny // 2, 4  # AP-L1 is at x=4, z=4 (mid-row)
        n = np.array(near, dtype=float)[iy, ix]
        a = np.array(above, dtype=float)[iy, ix]
        a = -200.0 if np.isnan(a) else a
        self.assertGreater(n - a, 10.0, f"level1={n} dBm, level2={a} dBm")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_SIONNA, "sionna-rt or the sample scene is not available")
class GainTest(unittest.TestCase):
    def test_antenna_and_receiver_gain_shift_the_map_by_exactly_their_value(self):
        import shutil

        with tempfile.TemporaryDirectory() as tmp:
            scene = Path(tmp, "scene")
            shutil.copytree(SCENE, scene)
            config_path = scene / "scene_config.json"
            config = json.loads(config_path.read_text())
            base_out, gain_out, rx_out = (str(Path(tmp, n)) for n in ("a", "b", "c"))
            run_job(base_out, scene_dir=str(scene))
            for ap in config["accessPoints"]:
                ap["antennaGainDbi"] = 4.5
            config_path.write_text(json.dumps(config))
            run_job(gain_out, scene_dir=str(scene))
            run_job(rx_out, scene_dir=str(scene), receiver_gain_dbi=-3.0)
            a = np.array(load_map(base_out, "f1")["bestDbm"], dtype=float)
            b = np.array(load_map(gain_out, "f1")["bestDbm"], dtype=float)
            c = np.array(load_map(rx_out, "f1")["bestDbm"], dtype=float)
            ok = ~np.isnan(a) & ~np.isnan(b) & ~np.isnan(c)
            self.assertTrue(np.allclose(b[ok] - a[ok], 4.5, atol=0.11))
            # c: same AP gain as a (scene copy now has 4.5), receiver gain -3 vs b
            self.assertTrue(np.allclose(c[ok] - b[ok], -3.0, atol=0.11))
