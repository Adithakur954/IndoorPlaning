import json
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np

from sionna_worker import version as version_module
from sionna_worker.version import code_hash, model_info, model_version

SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "two-floor"
JOB = SAMPLE / "optimize-job.json"


class ModelVersionTest(unittest.TestCase):
    def test_version_is_stable_and_has_the_engine_versions(self):
        info = model_info()
        self.assertEqual(info["modelVersion"], model_version())
        for key in ("code", "sionna-rt", "mitsuba", "drjit"):
            self.assertIn(key, info)

    def test_changing_the_worker_code_changes_the_version(self):
        with tempfile.TemporaryDirectory() as t:
            pkg = Path(t) / "sionna_worker"
            shutil.copytree(version_module.PACKAGE_DIR, pkg, ignore=shutil.ignore_patterns("__pycache__"))
            before = model_version(pkg)
            self.assertEqual(before, model_version(pkg))
            (pkg / "simulate.py").write_text((pkg / "simulate.py").read_text() + "\n# a model change\n")
            self.assertNotEqual(before, model_version(pkg))
            self.assertNotEqual(code_hash(pkg), code_hash(version_module.PACKAGE_DIR))


class RowCacheVersionTest(unittest.TestCase):
    def test_other_versions_are_removed_and_never_read(self):
        from sionna_worker.optimize import RowCache

        with tempfile.TemporaryDirectory() as t:
            old = RowCache(t, 100, version="aaaa")
            old.put("k", np.zeros(4, dtype=np.float16))
            self.assertIsNotNone(RowCache(t, 100, version="aaaa").get("k", 4))
            new = RowCache(t, 100, version="bbbb")
            self.assertIsNone(new.get("k", 4), "rows of another version must not be reused")
            self.assertEqual(new.removed_old_versions, 1)
            self.assertFalse((Path(t) / "rows" / "aaaa").exists())

    def test_refresh_ignores_stored_rows_but_still_writes(self):
        from sionna_worker.optimize import RowCache

        with tempfile.TemporaryDirectory() as t:
            RowCache(t, 100, version="v").put("k", np.ones(3, dtype=np.float16))
            fresh = RowCache(t, 100, version="v", refresh=True)
            self.assertIsNone(fresh.get("k", 3))
            fresh.put("k", np.full(3, 2, dtype=np.float16))
            self.assertEqual(float(RowCache(t, 100, version="v").get("k", 3)[0]), 2.0)


try:
    import sionna.rt  # noqa: F401
    READY = JOB.exists()
except Exception:  # noqa: BLE001
    READY = False


@unittest.skipUnless(READY, "sionna-rt or the sample optimisation job is not available")
class RefreshTest(unittest.TestCase):
    def test_refresh_recomputes_everything_and_gives_the_same_answer(self):
        from sionna_worker.job import OptimizeJob
        from sionna_worker.optimize import run_optimize

        with tempfile.TemporaryDirectory() as t:
            base = json.loads(JOB.read_text())
            job = {**base, "scene_dir": str(SAMPLE), "cache_dir": str(Path(t) / "cache"),
                   "samples_per_tx": 300_000, "max_depth": 4}
            first = run_optimize(OptimizeJob.from_dict({**job, "output_dir": str(Path(t) / "a")}))
            cached = run_optimize(OptimizeJob.from_dict({**job, "output_dir": str(Path(t) / "b")}))
            fresh = run_optimize(OptimizeJob.from_dict({**job, "output_dir": str(Path(t) / "c"), "refresh_cache": True}))
            self.assertEqual(cached["cache"]["rowMisses"], 0)
            self.assertEqual(fresh["cache"]["rowHits"], 0)
            self.assertGreater(fresh["cache"]["rowMisses"], 0)
            ids = lambda r: [x["candidateId"] for x in r["recommendations"]]  # noqa: E731
            self.assertEqual(ids(first), ids(fresh))
            self.assertEqual(fresh["model"]["modelVersion"], model_version())


if __name__ == "__main__":
    unittest.main()
