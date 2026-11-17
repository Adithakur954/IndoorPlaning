import json
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np

from sionna_worker.materials import ITU, itu_properties, sigma_for_loss, slab_loss_db

SCENE = Path(__file__).resolve().parents[1] / "samples" / "two-floor"

# (eps_r, sigma, thickness m, MHz, expected dB): the same table is checked in
# test/materialModel.test.js so the planner and the worker agree.
PARITY = [
    [5.24, 0.17, 0.2, 5180, 25.713151825],
    [2.73, 0.04, 0.1, 2437, 4.536952843],
    [6.31, 0.02, 0.01, 6175, 0.247833758],
    [3.91, 0.0238, 0.2, 5180, 5.111451889],
]


class MaterialModelTest(unittest.TestCase):
    def test_parity_values(self):
        for eps, sigma, d, f, expected in PARITY:
            self.assertAlmostEqual(slab_loss_db(eps, sigma, d, f), expected, places=6)

    def test_loss_grows_with_thickness_and_conductivity(self):
        eps, sigma = itu_properties("itu_concrete", 5180)
        self.assertGreater(slab_loss_db(eps, sigma, 0.3, 5180), slab_loss_db(eps, sigma, 0.1, 5180))
        self.assertGreater(slab_loss_db(eps, sigma * 3, 0.2, 5180), slab_loss_db(eps, sigma, 0.2, 5180))

    def test_a_loss_target_round_trips(self):
        eps, _ = itu_properties("itu_brick", 5180)
        for target in (3.0, 5.0, 10.0, 20.0, 40.0):
            r = sigma_for_loss(eps, 0.2, 5180, target)
            self.assertTrue(r["reachable"], target)
            self.assertAlmostEqual(r["achievedDb"], target, places=2)
            self.assertAlmostEqual(slab_loss_db(eps, r["sigma"], 0.2, 5180), target, places=2)

    def test_target_below_the_lossless_slab_is_flagged(self):
        eps, _ = itu_properties("itu_concrete", 5180)
        r = sigma_for_loss(eps, 0.2, 5180, 0.1)
        self.assertFalse(r["reachable"])
        self.assertEqual(r["sigma"], 0.0)

    def test_matches_sionnas_own_itu_table(self):
        try:
            import mitsuba as mi

            mi.set_variant("cuda_ad_mono_polarized")
            from sionna.rt.radio_materials import itu
        except Exception:  # noqa: BLE001
            self.skipTest("sionna-rt not available")
        for name, coeffs in ITU.items():
            table = itu.ITU_MATERIALS_PROPERTIES[name.removeprefix("itu_")]
            ours = [v for (lo, hi), v in table.items() if lo <= 5.18 <= hi][0]
            self.assertEqual(tuple(ours), coeffs, name)


try:
    import sionna.rt  # noqa: F401
    READY = SCENE.exists()
except Exception:  # noqa: BLE001
    READY = False


@unittest.skipUnless(READY, "sionna-rt or the sample scene is not available")
class MaterialOverrideTest(unittest.TestCase):
    def run_with(self, overrides, tmp: Path, name: str):
        from sionna_worker.job import JobSettings
        from sionna_worker.simulate import run

        scene = tmp / f"scene-{name}"
        shutil.copytree(SCENE, scene, ignore=shutil.ignore_patterns("opt-*"))
        path = scene / "scene_config.json"
        config = json.loads(path.read_text())
        if overrides:
            config["materialOverrides"] = overrides
        path.write_text(json.dumps(config))
        out = tmp / name
        result = run(JobSettings.from_dict({
            "scene_dir": str(scene), "output_dir": str(out), "resolution_m": 1.0,
            "samples_per_tx": 400_000, "max_depth": 4,
        }))
        grid = json.loads(Path(out, "maps", "f2__5000MHz.json").read_text())["perApDbm"][0]
        return result, np.array(grid, dtype=float)

    def test_wall_loss_override_changes_the_prediction_as_expected(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            default, d = self.run_with(None, t, "default")
            heavy, h = self.run_with({"concrete": {"lossDb": 60, "referenceThicknessM": 0.2}}, t, "heavy")
            light, l = self.run_with({"concrete": {"lossDb": 3, "referenceThicknessM": 0.2}}, t, "light")
            # level-1 AP seen through the concrete slab on level 2; cells that
            # receive nothing count as -200 dBm
            d, h, l = (np.nan_to_num(x, nan=-200.0) for x in (d, h, l))
            self.assertLess(h.mean(), d.mean() - 5)
            self.assertGreater(l.mean(), d.mean() + 3)
            report = {r["material"]: r for r in heavy["materialOverrides"]}
            self.assertAlmostEqual(report["concrete"]["achievedLossDb"], 60, places=1)
            self.assertEqual(default["materialOverrides"], [])

    def test_explicit_permittivity_and_conductivity(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            result, _ = self.run_with({"concrete": {"permittivity": 5.0, "conductivity": 5.0}}, t, "metalish")
            self.assertEqual(result["materialOverrides"][0]["mode"], "permittivity/conductivity")


if __name__ == "__main__":
    unittest.main()
