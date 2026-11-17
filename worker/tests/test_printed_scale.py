"""Scale from the overall size printed on blue dimension lines, and the stretch correction."""
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from floorplan import printed_scale as ps

FONT = next((p for p in ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") if Path(p).exists()), None)


def drawing(px_per_m_x, px_per_m_y, length_m=30.0, width_m=20.0):
    """A plain plan with a blue dimension line along the top (with the text on it) and one down the left."""
    w, h = int(length_m * px_per_m_x) + 240, int(width_m * px_per_m_y) + 240
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 30)
    x0, y0, x1, y1 = 120, 120, 120 + int(length_m * px_per_m_x), 120 + int(width_m * px_per_m_y)
    d.rectangle([x0, y0, x1, y1], outline="black", width=6)
    blue = (0, 51, 153)
    d.line([(x0, 60), (x1, 60)], fill=blue, width=3)
    d.rectangle([(x0 + x1) // 2 - 70, 40, (x0 + x1) // 2 + 70, 80], fill="white")
    d.text(((x0 + x1) // 2 - 60, 42), f"{length_m:.2f} m", fill=blue, font=f)
    d.line([(60, y0), (60, y1)], fill=blue, width=3)
    tmp = Image.new("RGBA", (160, 44), (255, 255, 255, 255))
    ImageDraw.Draw(tmp).text((10, 4), f"{width_m:.2f} m", fill=blue, font=f)
    img.paste(tmp.rotate(90, expand=True), (30, (y0 + y1) // 2 - 80))
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def texts_for(img, length_m=30.0, width_m=20.0):
    """The two printed sizes as the OCR would report them (boxes around where `drawing` put the text)."""
    h, w = img.shape[:2]
    cx = (120 + (w - 120)) / 2
    return [
        {"kind": "dimension", "how": "m", "text": f"{length_m:.2f} m", "metres": length_m,
         "box": [[cx - 60, 40], [cx + 60, 40], [cx + 60, 80], [cx - 60, 80]]},
        {"kind": "dimension", "how": "m", "text": f"{width_m:.2f} m", "metres": width_m,
         "box": [[30, h / 2 - 80], [74, h / 2 - 80], [74, h / 2 + 80], [30, h / 2 + 80]]},
    ]


@unittest.skipUnless(FONT, "no TrueType font to draw the test text")
class PrintedScaleTest(unittest.TestCase):
    def test_square_pixels_agree(self):
        img = drawing(40, 40)
        r = ps.estimate(img, texts_for(img))
        self.assertIsNotNone(r["pxPerM"])
        self.assertAlmostEqual(r["pxPerM"], 40, delta=1.5)
        self.assertGreaterEqual(r["confidence"], 0.9)
        self.assertFalse(r["stretched"])

    def test_a_stretched_picture_is_recognised(self):
        img = drawing(40, 46)                        # 15 % taller than wide
        r = ps.estimate(img, texts_for(img))
        self.assertTrue(r["stretched"])
        self.assertAlmostEqual(r["aspect"], 40 / 46, delta=0.03)
        self.assertIsNone(r["pxPerM"])               # not trusted until the aspect is corrected

    def test_one_printed_size_gives_a_cautious_scale(self):
        img = drawing(40, 40)
        r = ps.estimate(img, texts_for(img)[:1])
        self.assertAlmostEqual(r["pxPerM"], 40, delta=1.5)
        self.assertLess(r["confidence"], 0.9)

    def test_no_printed_size_gives_no_scale(self):
        r = ps.estimate(np.full((400, 400, 3), 255, np.uint8), [])
        self.assertIsNone(r["pxPerM"])


if __name__ == "__main__":
    unittest.main()
