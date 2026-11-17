"""Scene loading rules for prediction and planning a network from scratch."""
import json
import tempfile
import unittest
from pathlib import Path

from sionna_worker.job import JobError, JobSettings
from sionna_worker.simulate import load_export, run


class SceneLoadingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.scene = Path(self.tmp.name)
        (self.scene / "scene.xml").write_text("<scene version='3.0.0'/>")
        self.config = {"exportVersion": 1, "accessPoints": []}
        self.write_config()

    def write_config(self):
        (self.scene / "scene_config.json").write_text(json.dumps(self.config))

    def test_prediction_still_rejects_a_scene_without_aps(self):
        settings = JobSettings.from_dict({
            "scene_dir": str(self.scene), "output_dir": str(self.scene / "out"),
        })
        with self.assertRaisesRegex(JobError, "The scene export has no access points"):
            run(settings)

    def test_optimization_can_load_geometry_without_aps(self):
        self.assertEqual(load_export(self.scene, require_access_points=False), self.config)

    def test_existing_aps_load_in_both_modes(self):
        self.config["accessPoints"] = [{"id": "ap1"}]
        self.write_config()
        self.assertEqual(load_export(self.scene), self.config)
        self.assertEqual(load_export(self.scene, require_access_points=False), self.config)

    def test_optimization_still_requires_scene_files_and_export_version(self):
        self.config["exportVersion"] = 99
        self.write_config()
        with self.assertRaisesRegex(JobError, "Unsupported export version"):
            load_export(self.scene, require_access_points=False)
        (self.scene / "scene.xml").unlink()
        with self.assertRaisesRegex(JobError, "is not a scene export"):
            load_export(self.scene, require_access_points=False)


if __name__ == "__main__":
    unittest.main()
