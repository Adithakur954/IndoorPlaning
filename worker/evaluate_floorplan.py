"""Accuracy evaluation and benchmark of the floor-plan reconstruction.

  python evaluate_floorplan.py --synthetic [--out report.md]
      runs the drawn-by-code office plans (clean, skewed, noisy, double-line,
      PDF, large) and prints / writes a Markdown report
  python evaluate_floorplan.py --image plan.png --truth truth.json --px-per-m 40
      evaluates one real drawing against a manually verified reference
  python evaluate_floorplan.py --result out/result.json --truth truth.json
      evaluates an existing result

Reference format: see floorplan/evaluate.py. Results on synthetic drawings
say the pipeline works; they say nothing about real drawings. Add verified
real plans under worker/samples/floorplan/real/ and run with --image.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import cv2

from floorplan.evaluate import evaluate
from floorplan.pipeline import reconstruct
from floorplan.synthetic import PX_PER_M, make_office


def row(name: str, result: dict, scores: dict) -> list:
    w, r, o, t = scores["walls"], scores["rooms"], scores["openings"], scores["topology"]
    m = result["metrics"]
    return [
        name,
        f"{w['precision']:.2f} / {w['recall']:.2f}",
        f"{(w['meanCentrelineDeviationM'] or 0) * 100:.1f}",
        f"{r['meanIoU']:.2f}",
        f"{r['precision']:.2f} / {r['recall']:.2f}",
        f"{o['precision']:.2f} / {o['recall']:.2f}",
        f"{o['kindAccuracyOfFound']:.2f}",
        str(t["danglingEnds"]),
        f"{m['totalSeconds']:.1f}",
        f"{m['peakRamMB']:.0f}",
    ]


HEADER = ["case", "wall P / R", "centre-line dev (cm)", "room IoU", "room P / R",
          "opening P / R", "door-vs-window", "dangling ends", "seconds", "peak RAM (MB)"]


def table(rows: list[list]) -> str:
    out = ["| " + " | ".join(HEADER) + " |", "|" + "|".join(["---"] * len(HEADER)) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def synthetic() -> str:
    cases = {
        "clean office": {},
        "skewed 3 deg": {"skew_deg": 3.0},
        "noisy + skewed": {"skew_deg": -2.0, "noise": 0.1},
        "double-line walls": {"double_lines": True},
        "no furniture": {"furniture": False},
    }
    rows = []
    tmp = Path(tempfile.mkdtemp())
    for name, kw in cases.items():
        image, truth = make_office(**kw)
        src = tmp / "p.png"
        cv2.imwrite(str(src), image)
        result = reconstruct(src, tmp / "out", scale={"pxPerM": PX_PER_M}, options={"ocr": False})
        rows.append(row(name, result, evaluate(result, truth)))
    # PDF input
    from PIL import Image

    image, truth = make_office()
    Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).save(tmp / "p.pdf", resolution=72)
    result = reconstruct(tmp / "p.pdf", tmp / "out", scale={"imageWidthM": truth["imageWidthM"]},
                         options={"ocr": False})
    rows.append(row("same plan as PDF", result, evaluate(result, truth)))
    # a large drawing: 4x the pixels, normalised to 4000 px on the long side
    big = cv2.resize(image, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(str(tmp / "big.png"), big)
    result = reconstruct(tmp / "big.png", tmp / "out", scale={"pxPerM": PX_PER_M * 4}, options={"ocr": False})
    rows.append(row("large 7360x4800 px", result, evaluate(result, truth)))
    # with OCR on (adds model start-up and inference time)
    result = reconstruct(tmp / "p.pdf", tmp / "out", scale={"imageWidthM": truth["imageWidthM"]},
                         options={"ocr": True})
    rows.append(row("clean + OCR", result, evaluate(result, truth)))
    return table(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--image")
    ap.add_argument("--result")
    ap.add_argument("--truth")
    ap.add_argument("--px-per-m", type=float)
    ap.add_argument("--out")
    args = ap.parse_args()
    if args.synthetic:
        text = "## Synthetic office plans (known geometry, CPU only)\n\n" + synthetic() + "\n"
    elif args.truth and (args.image or args.result):
        truth = json.loads(Path(args.truth).read_text(encoding="utf-8"))
        if args.image:
            scale = {"pxPerM": args.px_per_m} if args.px_per_m else None
            result = reconstruct(args.image, Path(tempfile.mkdtemp()), scale=scale)
        else:
            result = json.loads(Path(args.result).read_text(encoding="utf-8"))
        scores = evaluate(result, truth)
        text = json.dumps(scores, indent=2) + "\n"
    else:
        ap.print_help()
        return 2
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
