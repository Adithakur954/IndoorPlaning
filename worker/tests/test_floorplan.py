"""Floor-plan reconstruction on drawn-by-code office plans with known geometry.

These are synthetic drawings: they prove the pipeline works and guard against
regressions. They are not a measure of accuracy on real drawings.
"""
import json
import tempfile
import unittest
from pathlib import Path

import cv2

from floorplan.evaluate import evaluate
from floorplan.ocr import parse_dimension
from floorplan.pipeline import reconstruct
from floorplan.synthetic import PX_PER_M, make_office


class FloorplanTest(unittest.TestCase):
    def run_case(self, scale=None, ocr=False, options=None, **kw):
        image, truth = make_office(**kw)
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "plan.png"
        cv2.imwrite(str(src), image)
        opts = {"ocr": ocr, "engine": "classical", **(options or {})}   # these tests guard the classical method
        result = reconstruct(src, tmp / "out", scale=scale or {"pxPerM": PX_PER_M}, options=opts)
        return result, truth, tmp

    def check_scores(self, result, truth, wall=0.95, room=0.9, opening=0.9):
        scores = evaluate(result, truth)
        self.assertGreaterEqual(scores["walls"]["precision"], wall)
        self.assertGreaterEqual(scores["walls"]["recall"], wall)
        self.assertLess(scores["walls"]["meanCentrelineDeviationM"], 0.1)
        self.assertGreaterEqual(scores["rooms"]["recall"], room)
        self.assertGreaterEqual(scores["rooms"]["precision"], room)
        self.assertGreaterEqual(scores["rooms"]["meanIoU"], 0.9)
        self.assertGreaterEqual(scores["openings"]["recall"], opening)
        self.assertGreaterEqual(scores["openings"]["precision"], opening)
        self.assertEqual(scores["topology"]["danglingEnds"], 0)
        self.assertEqual(scores["topology"]["invalidRooms"], 0)
        return scores

    def test_clean_plan_furniture_and_dimensions_are_ignored(self):
        result, truth, _ = self.run_case()
        scores = self.check_scores(result, truth)
        self.assertEqual(scores["openings"]["kindAccuracyOfFound"], 1.0)
        self.assertEqual(len(result["walls"]), 12)       # 12 true walls, no furniture lines
        self.assertEqual(len(result["rooms"]), 9)
        self.assertEqual(len(result["columns"]), 3)      # the columns are not walls
        self.assertEqual(result["scale"]["source"], "user")

    def test_skew_and_noise(self):
        result, truth, _ = self.run_case(skew_deg=-2.0, noise=0.1)
        self.assertAlmostEqual(result["image"]["deskewDeg"], 2.0, delta=0.4)
        self.check_scores(result, truth)

    def test_double_line_walls(self):
        result, truth, _ = self.run_case(double_lines=True)
        self.assertEqual(result["wallThickness"]["style"], "double-line")
        self.check_scores(result, truth, wall=0.95)

    def test_two_point_scale_and_width_scale(self):
        image, truth = make_office()
        a, b = [3 * PX_PER_M, 3 * PX_PER_M], [43 * PX_PER_M, 3 * PX_PER_M]   # a 40 m dimension
        result, _, _ = self.run_case(scale={"pointA": a, "pointB": b, "lengthM": 40.0})
        self.assertAlmostEqual(result["scale"]["pxPerM"], PX_PER_M, delta=0.01)
        self.assertEqual(result["scale"]["source"], "user (two points)")
        result, _, _ = self.run_case(scale={"imageWidthM": 46.0})
        self.assertAlmostEqual(result["scale"]["pxPerM"], PX_PER_M, delta=0.5)

    def test_scale_in_original_pixels_survives_a_resized_image(self):
        # a 4x larger drawing is shrunk to the working size; the scale the user
        # gave for the original pixels must follow
        image, truth = make_office()
        big = cv2.resize(image, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_NEAREST)
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "big.png"), big)
        result = reconstruct(tmp / "big.png", tmp / "o", scale={"pxPerM": PX_PER_M * 4},
                             options={"ocr": False, "engine": "classical"})
        self.assertLess(result["image"]["resizeFactor"], 1.0)
        self.check_scores(result, truth)

    def test_without_scale_no_metres_are_invented(self):
        image, _ = make_office()
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "p.png"), image)
        result = reconstruct(tmp / "p.png", tmp / "o", scale=None, options={"ocr": False, "engine": "classical"})
        self.assertIsNone(result["scale"]["pxPerM"])
        self.assertIsNone(result["rooms"][0]["areaM2"])
        self.assertIsNone(result["walls"][0]["aM"])
        self.assertTrue(any("no scale" in w for w in result["warnings"]))
        self.assertEqual(len(result["rooms"]), 9)

    def test_pdf_input(self):
        from PIL import Image

        image, _ = make_office()
        tmp = Path(tempfile.mkdtemp())
        Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).save(tmp / "p.pdf", resolution=72)
        result = reconstruct(tmp / "p.pdf", tmp / "o", scale={"imageWidthM": 46.0}, options={"ocr": False, "engine": "classical"})
        self.assertEqual(len(result["walls"]), 12)
        self.assertEqual(len(result["rooms"]), 9)

    def test_outputs_overlay_and_json(self):
        result, _, tmp = self.run_case()
        out = tmp / "out"
        for name in ("overlay.png", "walls_mask.png", "deskewed.png", "result.json"):
            self.assertTrue((out / name).exists(), name)
        self.assertEqual(json.loads((out / "result.json").read_text())["version"], result["version"])
        self.assertGreater(result["metrics"]["totalSeconds"], 0)
        self.assertIn("peakRamMB", result["metrics"])

    def test_every_uncertain_item_has_a_reason_to_review(self):
        # a drawing cut off at the border must be flagged, not silently accepted
        image, _ = make_office()
        cropped = image[: int(image.shape[0] * 0.55), :]
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "c.png"), cropped)
        result = reconstruct(tmp / "c.png", tmp / "o", scale={"pxPerM": PX_PER_M}, options={"ocr": False, "engine": "classical"})
        self.assertTrue(result["uncertain"] or any(r["notes"] for r in result["rooms"]))

    def test_ocr_reads_labels_and_dimensions(self):
        result, _, _ = self.run_case(ocr=True)
        labels = [r["label"] for r in result["rooms"] if r["label"]]
        self.assertGreaterEqual(len(labels), 6)
        self.assertIn("CORRIDOR", labels)
        dims = [t for t in result["texts"] if t["kind"] == "dimension"]
        self.assertTrue(any(abs(t["metres"] - 40.0) < 0.01 for t in dims))

    def test_real_coworking_plan(self):
        """The first real drawing (colour-coded CAD export, furniture-heavy, hatched
        outer walls, AP markers drawn on it). The reference was traced by eye, so
        the bounds are loose; the point is that the building structure is found
        and the furniture, planters and markers are not turned into walls."""
        sample = Path(__file__).resolve().parents[1] / "samples" / "floorplan"
        image, truth_file = sample / "real_coworking.jpg", sample / "real_coworking.truth.json"
        if not image.exists():
            self.skipTest("real sample not present")
        truth = json.loads(truth_file.read_text(encoding="utf-8"))
        result = reconstruct(image, tempfile.mkdtemp(), scale={"pxPerM": 45.6}, options={"ocr": False, "engine": "classical"})
        scores = evaluate(result, truth, tol_m=0.35)
        self.assertGreaterEqual(scores["walls"]["recall"], 0.9)
        self.assertGreaterEqual(scores["walls"]["precision"], 0.75)
        self.assertGreaterEqual(scores["rooms"]["recall"], 0.75)
        self.assertGreaterEqual(scores["rooms"]["meanIoU"], 0.7)
        self.assertTrue(any("colour-coded" in w for w in result["warnings"]))
        self.assertGreaterEqual(len(result["markers"]), 6)       # the AP markers drawn on the plan
        # with a scale that is not given, nothing metric is claimed
        no_scale = reconstruct(image, tempfile.mkdtemp(), scale=None, options={"ocr": False, "engine": "classical"})
        self.assertTrue(no_scale["scale"]["needsInput"])
        self.assertIsNone(no_scale["rooms"][0]["areaM2"])

    def test_plan_drawn_in_thin_lines(self):
        """Presentation plans draw every wall as a thin line. The thick-stroke reading drops
        such lines on purpose, so the thin-line reading must find the rooms, and the choice
        between the two must fall on it. Stair treads and desks must not become walls."""
        import numpy as np

        ppm = 20
        img = np.full((560, 860, 3), 255, np.uint8)
        grey = (90, 90, 90)
        # a 40 x 24 m building, 3 x 2 rooms: a thick outer wall, every partition a 2 px line
        # (with 1 m door gaps), as in a presentation plan
        x0, y0, x1, y1 = 30, 30, 830, 510
        cv2.rectangle(img, (x0, y0), (x1, y1), grey, 6)
        for x in (297, 563):
            cv2.line(img, (x, y0), (x, 250), grey, 2)
            cv2.line(img, (x, 270), (x, y1), grey, 2)
        cv2.line(img, (x0, 270), (400, 270), grey, 2)
        cv2.line(img, (420, 270), (x1, 270), grey, 2)
        for k in range(10):                                   # a stair: close parallel treads
            cv2.line(img, (60, 300 + 6 * k), (140, 300 + 6 * k), grey, 1)
        for k in range(6):                                    # desks: small boxes
            cv2.rectangle(img, (620 + 30 * k, 80), (645 + 30 * k, 95), grey, 1)
        tmp = Path(tempfile.mkdtemp())
        cv2.imwrite(str(tmp / "thin.png"), img)
        base = {"ocr": False, "engine": "classical"}
        thick = reconstruct(tmp / "thin.png", tmp / "a", scale={"pxPerM": ppm}, options=base)
        thin = reconstruct(tmp / "thin.png", tmp / "b", scale={"pxPerM": ppm}, options={**base, "thin_lines": True})
        self.assertGreaterEqual(len(thin["rooms"]), 6, "the six rooms close")
        self.assertGreater(len(thin["rooms"]), len(thick["rooms"]))
        # no wall from the stair treads or the desks
        for w in thin["walls"]:
            mx, my = (w["a"][0] + w["b"][0]) / 2, (w["a"][1] + w["b"][1]) / 2
            self.assertFalse(55 <= mx <= 145 and 295 <= my <= 360, f"stair read as wall: {w}")
            self.assertFalse(615 <= mx <= 800 and 75 <= my <= 100, f"desk read as wall: {w}")
        from floorplan.pipeline import _quality, _wall_lengths
        ref = max(_wall_lengths(thin)[0], _wall_lengths(thick)[0])
        self.assertGreater(_quality(thin, ref), _quality(thick, ref), "auto would choose the thin-line reading")

    def test_open_corner_is_closed(self):
        from floorplan.walls import Wall, close_corners

        h = Wall((0.0, 0.0), (95.0, 0.0), 4, orientation="h")      # stops 5 px short of the corner
        v = Wall((100.0, 6.0), (100.0, 80.0), 4, orientation="v")  # starts 6 px below it
        self.assertEqual(close_corners([h, v], tol=4, max_gap=20), 1)
        self.assertEqual(h.b, (100.0, 0.0))
        self.assertEqual(v.a, (100.0, 0.0))
        far = Wall((100.0, 60.0), (100.0, 80.0), 4, orientation="v")   # 60 px away: not a corner gap
        h2 = Wall((0.0, 0.0), (95.0, 0.0), 4, orientation="h")
        self.assertEqual(close_corners([h2, far], tol=4, max_gap=20), 0)

    def test_dimension_parsing(self):
        self.assertEqual(parse_dimension("5.20 m"), (5.2, "m"))
        self.assertEqual(parse_dimension("4200"), (4.2, "assumed mm"))
        self.assertAlmostEqual(parse_dimension("12'-6\"")[0], 3.81, places=2)
        self.assertIsNone(parse_dimension("OFFICE 4"))


if __name__ == "__main__":
    unittest.main()
