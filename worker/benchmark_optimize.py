"""Benchmarks the AP optimisation end to end, one fresh process per case.

    python benchmark_optimize.py samples/benchmark-4floor [--out out/benchmark-optimize.json]

Peak GPU memory is sampled from nvidia-smi while the worker runs; peak process
RAM is sampled from psutil (worker process tree). CPU runs limit threads only;
they do not limit RAM or emulate a real 4 vCPU host.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

CASES = [
    # name, overrides, reuse_cache_of
    ("GPU cold (res 1 m, 1M rays)", {"device": "gpu"}, None),
    ("GPU warm (same job, rows cached)", {"device": "gpu"}, "GPU cold (res 1 m, 1M rays)"),
    ("GPU cold (res 0.5 m, 4M rays)", {"device": "gpu", "resolution_m": 0.5, "samples_per_tx": 4_000_000}, None),
    ("CPU 4 threads cold (res 1 m, 1M rays)", {"device": "cpu", "cpu_threads": 4}, None),
]


def gpu_mb() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        return int(out[0])
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scene")
    parser.add_argument("--out", default="out/benchmark-optimize.json")
    args = parser.parse_args()
    base = json.loads((Path(args.scene) / "optimize-job.json").read_text())
    caches: dict[str, str] = {}
    rows = []
    for name, overrides, reuse in CASES:
        tmp = Path(tempfile.mkdtemp())
        cache = caches.get(reuse) if reuse else str(tmp / "cache")
        caches[name] = cache
        job = {**base, "output_dir": str(tmp / "out"), "cache_dir": cache, **overrides}
        job_file = tmp / "job.json"
        job_file.write_text(json.dumps(job))
        baseline_gpu = gpu_mb()
        peaks = {"gpu": baseline_gpu or 0, "ram": 0.0}
        stop = threading.Event()
        proc = subprocess.Popen([sys.executable, "-m", "sionna_worker", str(job_file)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def sample():
            ps = psutil.Process(proc.pid)
            while not stop.is_set():
                try:
                    ram = sum(p.memory_info().rss for p in [ps, *ps.children(recursive=True)]) / 1e6
                    peaks["ram"] = max(peaks["ram"], ram)
                except psutil.Error:
                    pass
                g = gpu_mb()
                if g is not None:
                    peaks["gpu"] = max(peaks["gpu"], g)
                time.sleep(0.15)

        t = threading.Thread(target=sample, daemon=True)
        t.start()
        started = time.time()
        _, err = proc.communicate()
        wall = time.time() - started
        stop.set()
        t.join()
        result_file = tmp / "out" / "result.json"
        row = {"case": name, "ok": proc.returncode == 0, "wallSeconds": round(wall, 1)}
        if proc.returncode == 0:
            r = json.loads(result_file.read_text())
            row.update({
                "device": r["backend"]["device"],
                "candidates": r["candidates"]["supplied"],
                "shortlisted": r["candidates"]["shortlisted"],
                "cells": r["resources"]["matrixShape"][1],
                "timings": r["timingsSeconds"],
                "newAps": r["outcome"]["newApCount"],
                "coveragePct": round(r["outcome"]["achievedCoveragePct"], 1),
                "rowCache": r["cache"],
                "peakRamMb": round(peaks["ram"]),
                "peakGpuMbAboveIdle": (peaks["gpu"] - baseline_gpu) if baseline_gpu is not None and r["backend"]["device"] == "gpu" else None,
            })
        else:
            row["error"] = err[-400:]
        rows.append(row)
        print(json.dumps(row), flush=True)
        if not reuse:
            pass  # keep the cache for a possible warm run, removed at the end
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rows, indent=2))
    for c in set(caches.values()):
        shutil.rmtree(Path(c).parent, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
