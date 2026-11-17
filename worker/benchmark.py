"""Benchmarks the worker on an exported scene; each run is a fresh process.

    python benchmark.py samples/benchmark-4floor [--out out/benchmark.json]

CPU runs are limited with cpu_threads to approximate a small server. That
limits threads only; it does not limit RAM or reproduce a real 4 vCPU host.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CASES = [
    # (device, cpu_threads, resolution_m, max_depth, samples_per_tx)
    ("gpu", None, 1.0, 3, 1_000_000),
    ("gpu", None, 0.5, 5, 1_000_000),
    ("gpu", None, 0.5, 5, 4_000_000),
    ("cpu", 4, 1.0, 3, 1_000_000),
    ("cpu", 4, 1.0, 5, 1_000_000),
    ("cpu", 4, 0.5, 5, 1_000_000),
    ("cpu", 4, 0.5, 5, 4_000_000),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scene")
    parser.add_argument("--out", default="out/benchmark.json")
    args = parser.parse_args()

    rows = []
    for device, threads, resolution, depth, samples in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            job = {
                "scene_dir": args.scene,
                "output_dir": tmp,
                "device": device,
                "cpu_threads": threads,
                "resolution_m": resolution,
                "max_depth": depth,
                "samples_per_tx": samples,
            }
            job_path = Path(tmp, "job.json")
            job_path.write_text(json.dumps(job))
            started = time.time()
            proc = subprocess.run(
                [sys.executable, "-m", "sionna_worker", str(job_path)],
                capture_output=True, text=True,
            )
            wall = time.time() - started
            result_file = Path(tmp, "result.json")
            result = json.loads(result_file.read_text()) if result_file.exists() else {}
        row = {
            "device": device, "cpuThreads": threads, "resolutionM": resolution,
            "maxDepth": depth, "samplesPerTx": samples,
            "ok": proc.returncode == 0, "processWallSeconds": round(wall, 2),
        }
        if proc.returncode == 0:
            res = result["resources"]
            row.update({
                "workerWallSeconds": res["wallSeconds"],
                "solveSecondsTotal": round(sum(f["solveSeconds"] for f in result["floors"]), 2),
                "peakProcessRssMb": res["peakProcessRssMb"],
                "gpuMemoryUsedMbAfter": res["gpuMemoryUsedMbAfter"],
                "cellsPerFloor": result["floors"][0]["cells"],
                "medianBestDbm": round(result["floors"][0]["bestDbmMedian"], 1),
            })
        else:
            row["error"] = result.get("error") or proc.stderr[-300:]
        rows.append(row)
        print(json.dumps(row), flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
