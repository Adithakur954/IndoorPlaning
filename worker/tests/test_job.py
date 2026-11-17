import unittest

from sionna_worker.job import JobError, JobSettings

BASE = {"scene_dir": "s", "output_dir": "o"}


class JobSettingsTest(unittest.TestCase):
    def test_defaults_are_valid(self):
        self.assertEqual(JobSettings.from_dict(BASE).max_depth, 5)

    def test_rejects_bad_values(self):
        for bad in (
            {"resolution_m": 0.01},
            {"resolution_m": float("nan")},
            {"max_depth": -1},
            {"samples_per_tx": 5},
            {"device": "tpu"},
            {"weak_threshold_dbm": 10},
            {"seed": True},
            {"unknown": 1},
        ):
            with self.subTest(bad=bad), self.assertRaises(JobError):
                JobSettings.from_dict({**BASE, **bad})

    def test_requires_paths(self):
        with self.assertRaises(JobError):
            JobSettings.from_dict({"scene_dir": "s"})


if __name__ == "__main__":
    unittest.main()
