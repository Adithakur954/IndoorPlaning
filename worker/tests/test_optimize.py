"""Integration tests of the optimisation pipeline on the exported sample scene
(needs worker/samples/two-floor/optimize-job.json; see scripts/export-scene.mjs)."""
import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path

SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "two-floor"
JOB = SAMPLE / "optimize-job.json"

try:
    import sionna.rt  # noqa: F401
    READY = JOB.exists()
except Exception:  # noqa: BLE001
    READY = False


def run_job(tmp: Path, scene: Path | None = None, **overrides):
    from sionna_worker.job import OptimizeJob
    from sionna_worker.optimize import run_optimize

    base = json.loads(JOB.read_text())
    job = {
        **base,
        "scene_dir": str(scene or SAMPLE),
        "output_dir": str(tmp / "out"),
        "cache_dir": str(tmp / "cache"),
        "samples_per_tx": 300_000,
        "max_depth": 4,
        **overrides,
    }
    return run_optimize(OptimizeJob.from_dict(job))


def scene_with_band_aps(tmp: Path) -> Path:
    """Copy of the sample whose two existing APs are on a real 5 GHz channel."""
    scene = tmp / "scene"
    shutil.copytree(SAMPLE, scene, ignore=shutil.ignore_patterns("opt-*"))
    path = scene / "scene_config.json"
    config = json.loads(path.read_text())
    for ap in config["accessPoints"]:
        ap["frequencyMHz"] = 5180
        ap["txPowerDbm"] = -6
    path.write_text(json.dumps(config))
    return scene


@unittest.skipUnless(READY, "sionna-rt or the sample optimisation job is not available")
class OptimizeTest(unittest.TestCase):
    def test_new_network_without_existing_aps(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            scene = scene_with_band_aps(t)
            path = scene / "scene_config.json"
            config = json.loads(path.read_text())
            config["accessPoints"] = []
            path.write_text(json.dumps(config))
            for band, frequency in (("2.4", 2437), ("5", 5180)):
                for objective in ("target", "budget"):
                    with self.subTest(band=band, objective=objective):
                        r = run_job(
                            t / f"{band}-{objective}", scene=scene, band=band,
                            profile={"txPowerDbm": 20, "gainDbi": 4.5, "freqMHz": frequency, "bandwidthMHz": 40},
                            existing_handling="fixed",
                            target_coverage_pct=95 if objective == "target" else None,
                            budget=None if objective == "target" else 1,
                        )
                        self.assertEqual(r["outcome"]["existingApCount"], 0)
                        self.assertEqual(r["before"]["coveragePct"], 0)
                        self.assertTrue(r["recommendations"])
                        self.assertTrue(all(rec["action"] == "new" for rec in r["recommendations"]))
                        self.assertGreater(r["after"]["coveragePct"], 0)
                        if objective == "target":
                            self.assertTrue(r["outcome"]["targetAchieved"])
                        else:
                            self.assertEqual(r["outcome"]["newApCount"], 1)
                        for m in r["maps"]:
                            payload = json.loads((t / f"{band}-{objective}" / "out" / m["file"]).read_text())
                            self.assertEqual(payload["frequencyMHz"], frequency)
                            self.assertTrue(all(v is None for row in payload["beforeDbm"] for v in row))
                            self.assertTrue(any(v is not None for row in payload["afterDbm"] for v in row))
                            self.assertTrue(all(v is None for row in payload["beforeSnrDb"] for v in row))
                            noise = (-86 if band == "2.4" else -88) + 10 * math.log10(2)
                            self.assertAlmostEqual(payload["snr"]["newApNoiseFloorDbm"], noise)
                            for signal_row, snr_row in zip(payload["afterDbm"], payload["afterSnrDb"]):
                                for signal, snr in zip(signal_row, snr_row):
                                    if signal is not None:
                                        self.assertAlmostEqual(snr, signal - noise, delta=0.11)

    def test_custom_noise_changes_snr_but_not_signal(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            run_job(t / "default", target_coverage_pct=None, budget=1)
            run_job(t / "custom", target_coverage_pct=None, budget=1, noise_floor_5_dbm=-92)
            a = json.loads((t / "default/out/maps/opt-f1.json").read_text())
            b = json.loads((t / "custom/out/maps/opt-f1.json").read_text())
            self.assertEqual(a["afterDbm"], b["afterDbm"])
            for old, new in zip(a["afterSnrDb"], b["afterSnrDb"]):
                for x, y in zip(old, new):
                    if x is not None:
                        self.assertAlmostEqual(y - x, 4, delta=0.11)

    def test_target_met_with_valid_recommendations(self):
        with tempfile.TemporaryDirectory() as t:
            r = run_job(Path(t))
            self.assertEqual(r["outcome"]["status"], "target-met")
            self.assertGreaterEqual(r["outcome"]["achievedCoveragePct"], 95)
            ids = {c["id"] for c in json.loads(JOB.read_text())["candidates"]}
            self.assertTrue(r["recommendations"])
            for rec in r["recommendations"]:
                self.assertIn(rec["candidateId"], ids)  # only real mounting candidates
            marg = sum(x["marginalCoveragePct"] for x in r["recommendations"])
            self.assertAlmostEqual(marg + r["before"]["coveragePct"], r["after"]["coveragePct"], places=3)
            self.assertIn("screening", r["provenance"])
            maps = list(Path(t, "out", "maps").glob("opt-*.json"))
            self.assertEqual(len(maps), 2)

    def test_second_run_is_served_from_the_row_cache(self):
        with tempfile.TemporaryDirectory() as t:
            first = run_job(Path(t))
            second = run_job(Path(t))
            self.assertGreater(first["cache"]["rowMisses"], 0)
            self.assertEqual(second["cache"]["rowMisses"], 0)
            self.assertEqual(
                [x["candidateId"] for x in first["recommendations"]],
                [x["candidateId"] for x in second["recommendations"]],
            )

    def test_threshold_change_reuses_cached_rows(self):
        with tempfile.TemporaryDirectory() as t:
            run_job(Path(t))
            again = run_job(Path(t), threshold_dbm=-72, target_coverage_pct=90)
            self.assertEqual(again["cache"]["rowMisses"], 0)

    def test_existing_aps_fixed_reposition_and_ignore(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            scene = scene_with_band_aps(t)
            fixed = run_job(t / "a", scene=scene, existing_handling="fixed")
            ignore = run_job(t / "b", scene=scene, existing_handling="ignore")
            moved = run_job(t / "c", scene=scene, existing_handling="reuse")
            self.assertEqual(fixed["outcome"]["existingApCount"], 2)
            self.assertGreater(fixed["before"]["coveragePct"], 0)
            # before is always the original configuration, whatever the mode
            self.assertAlmostEqual(fixed["before"]["coveragePct"], ignore["before"]["coveragePct"], places=3)
            # keeping the existing APs can only help
            self.assertLessEqual(fixed["outcome"]["newApCount"], ignore["outcome"]["newApCount"])
            self.assertEqual(moved["candidates"]["existingAddedAsCandidates"], 2)
            acts = {a["id"]: a["action"] for a in moved["existingActions"]}
            self.assertEqual(len(acts), 2)
            self.assertTrue(set(acts.values()) <= {"keep", "move", "remove"})
            # without "allow new", nothing is added and nothing exceeds the 2 APs
            self.assertEqual(moved["outcome"]["newApCount"], 0)
            self.assertLessEqual(moved["outcome"]["finalApCount"], 2)
            self.assertTrue(fixed["outcome"]["targetAchieved"] and moved["outcome"]["targetAchieved"])

    def test_budget_mode_never_exceeds_the_budget(self):
        with tempfile.TemporaryDirectory() as t:
            r = run_job(Path(t), target_coverage_pct=None, budget=1)
            self.assertLessEqual(r["outcome"]["newApCount"], 1)
            self.assertEqual(len(r["recommendations"]), r["outcome"]["newApCount"])

    def test_unreachable_target_is_reported_not_claimed(self):
        with tempfile.TemporaryDirectory() as t:
            r = run_job(Path(t), threshold_dbm=-20, target_coverage_pct=100)
            self.assertFalse(r["outcome"]["targetAchieved"])
            self.assertEqual(r["outcome"]["status"], "infeasible")
            self.assertLess(r["outcome"]["achievedCoveragePct"], 100)
            self.assertIn("cannot be reached", r["outcome"]["message"])

    def test_excluded_room_is_not_part_of_the_target(self):
        with tempfile.TemporaryDirectory() as t:
            overrides = {"room_overrides": {"a2": {"include": False}}}
            r = run_job(Path(t), **overrides)
            names = [x["room"] for x in r["after"]["perRoom"]]
            self.assertNotIn("Open space", names)

    def test_bad_input_is_rejected(self):
        from sionna_worker.job import JobError, OptimizeJob

        base = json.loads(JOB.read_text())
        for bad in (
            {"candidates": [{"id": "x"}]},
            {"band": "7"},
            {"threshold_dbm": 10},
            {"target_coverage_pct": None, "budget": None},
            {"profile": {"txPowerDbm": 20, "gainDbi": 4, "freqMHz": 2437}},  # not in band 5
            {"existing_handling": "delete"},
            {"existing_handling": "reposition"},
            {"locked_ap_ids": "a"},
            {"noise_floor_5_dbm": -120},
            {"profile": {"txPowerDbm": 20, "gainDbi": 4, "freqMHz": 5180, "bandwidthMHz": 0}},
        ):
            with self.subTest(bad=bad), self.assertRaises(JobError):
                OptimizeJob.from_dict({**base, **bad})


if __name__ == "__main__":
    unittest.main()
