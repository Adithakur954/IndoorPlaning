"""The learned segmentation stage: marker bridging, label-based door/window typing, and the model engine end to end.

Scores here are on synthetic drawings and a loosely traced real plan; they guard against regressions and are not a
measure of accuracy on real drawings (see worker/models/README.md for the measured comparison).
"""
import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from floorplan import model as net
from floorplan.evaluate import evaluate
from floorplan.openings import classify_gaps_labels
from floorplan.pipeline import reconstruct
from floorplan.synthetic import PX_PER_M, make_office
from floorplan.walls import Wall

needs_model = unittest.skipUnless(net.available(), "model file or onnxruntime not present")


class MarkerBridgeTest(unittest.TestCase):
    def test_wall_under_a_marker_is_made_continuous(self):
        wall = np.zeros((60, 200), bool)
        wall[28:33, :] = True
        wall[:, 98:112] = False            # the marker hides the wall here
        ap = np.zeros_like(wall)
        ap[20:40, 98:112] = True
        blobs = net.blobs(ap, 10)
        self.assertEqual(len(blobs), 1)
        out = net.bridge_markers(wall, blobs)
        self.assertTrue(out[28:33, :].all())

    def test_marker_on_open_floor_adds_no_wall(self):
        wall = np.zeros((60, 200), bool)
        ap = np.zeros_like(wall)
        ap[20:40, 98:112] = True
        self.assertFalse(net.bridge_markers(wall, net.blobs(ap, 10)).any())


class LabelGapTest(unittest.TestCase):
    def test_gap_type_comes_from_the_network_labels(self):
        labels = np.zeros((100, 300), np.uint8)
        wall = Wall(a=(10, 50), b=(290, 50), thickness=6, orientation="h", gaps=[(60, 100), (150, 200), (230, 250)])
        labels[46:55, 60:100] = net.DOOR
        labels[46:55, 150:200] = net.WINDOW
        ink = np.zeros_like(labels)
        kinds = [o.kind for o in classify_gaps_labels([wall], labels, ink, 6, 10, 120)]
        self.assertEqual(kinds, ["door", "window", "opening"])   # the last gap has no label and no drawing evidence


@needs_model
class ModelEngineTest(unittest.TestCase):
    def test_segment_returns_a_label_map_of_the_same_size(self):
        image, _ = make_office()
        labels, meta = net.segment(image)
        self.assertEqual(labels.shape, image.shape[:2])
        self.assertEqual(labels.dtype, np.uint8)
        self.assertLess(int(labels.max()), len(net.CLASSES))
        self.assertGreater(float((labels == net.WALL).mean()), 0.005)

    def test_model_engine_reconstructs_a_synthetic_office(self):
        image, truth = make_office()
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "p.png"), image)
        result = reconstruct(tmp / "p.png", tmp / "o", scale={"pxPerM": PX_PER_M}, options={"ocr": False, "engine": "model"})
        self.assertEqual(result["engine"], "model")
        self.assertTrue((tmp / "o" / "model_overlay.png").exists())
        scores = evaluate(result, truth)
        self.assertGreaterEqual(scores["walls"]["recall"], 0.95)
        self.assertGreaterEqual(scores["rooms"]["recall"], 0.9)

    def test_classical_engine_is_still_available(self):
        image, _ = make_office()
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "p.png"), image)
        result = reconstruct(tmp / "p.png", tmp / "o", scale={"pxPerM": PX_PER_M}, options={"ocr": False, "engine": "classical"})
        self.assertEqual(result["engine"], "classical")
        self.assertFalse((tmp / "o" / "model_overlay.png").exists())

    def test_real_coworking_plan_finds_the_markers_and_most_walls(self):
        # Loose guard only: on this one traced real plan the classical method scores higher (see models/README.md).
        sample = Path(__file__).resolve().parents[1] / "samples" / "floorplan"
        image, truth_file = sample / "real_coworking.jpg", sample / "real_coworking.truth.json"
        if not image.exists():
            self.skipTest("real sample not present")
        truth = json.loads(truth_file.read_text(encoding="utf-8"))
        result = reconstruct(image, tempfile.mkdtemp(), scale={"pxPerM": 45.6}, options={"ocr": False, "engine": "model"})
        self.assertGreaterEqual(len(result["markers"]), 6)
        self.assertGreaterEqual(evaluate(result, truth, tol_m=0.35)["walls"]["recall"], 0.75)


if __name__ == "__main__":
    unittest.main()


class FurnitureTest(unittest.TestCase):
    def test_boxes_are_sized_from_the_scale_and_merged_chairs_are_split(self):
        import numpy as np
        from floorplan import model as net

        labels = np.zeros((300, 400), np.uint8)
        labels[50:90, 50:170] = net.DESK            # 120 x 40 px
        for x in (200, 260, 320):                   # three separate chairs, 24 px
            labels[50:74, x:x + 24] = net.CHAIR
        labels[150:174, 100:172] = net.CHAIR        # three touching chairs in one region
        items = net.furniture(labels, 100.0)
        desk = [f for f in items if f["kind"] == "desk"]
        self.assertEqual(len(desk), 1)
        self.assertAlmostEqual(desk[0]["widthM"], 1.2, places=1)
        self.assertAlmostEqual(desk[0]["depthM"], 0.4, places=1)
        self.assertEqual(len([f for f in items if f["kind"] == "chair"]), 6)
        self.assertNotIn("widthM", net.furniture(labels, None)[0])
