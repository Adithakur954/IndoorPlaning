"""CLI: python -m sionna_worker <job.json>  or  --scene DIR --out DIR [options]."""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from .job import JobError, JobSettings


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sionna_worker")
    parser.add_argument("job", nargs="?", help="job.json with JobSettings fields")
    parser.add_argument("--scene")
    parser.add_argument("--out")
    parser.add_argument("--device", choices=["auto", "gpu", "cpu"])
    parser.add_argument("--resolution", type=float)
    parser.add_argument("--max-depth", type=int)
    parser.add_argument("--samples", type=int)
    parser.add_argument("--model-version", action="store_true",
                        help="print the simulation model version and exit")
    args = parser.parse_args(argv)
    if args.model_version:
        from .version import model_info

        print(json.dumps(model_info()))
        return 0

    out_dir = args.out
    try:
        raw = json.loads(Path(args.job).read_text(encoding="utf-8")) if args.job else {}
        overrides = {
            "scene_dir": args.scene,
            "output_dir": args.out,
            "device": args.device,
            "resolution_m": args.resolution,
            "max_depth": args.max_depth,
            "samples_per_tx": args.samples,
        }
        raw.update({k: v for k, v in overrides.items() if v is not None})
        out_dir = raw.get("output_dir")
        if raw.get("mode") == "optimize":
            from .job import OptimizeJob
            from .optimize import run_optimize

            result = run_optimize(OptimizeJob.from_dict(raw))
            print(json.dumps({
                "status": "ok", "mode": "optimize", "backend": result["backend"],
                "outcome": result["outcome"], "resources": result["resources"],
            }, indent=2))
            return 0
        settings = JobSettings.from_dict(raw)
        from .simulate import run

        result = run(settings)
        print(json.dumps({
            "status": "ok",
            "backend": result["backend"],
            "resources": result["resources"],
            "floors": result["floors"],
        }, indent=2))
        return 0
    except Exception as error:  # noqa: BLE001 - every failure is reported as a job error
        user_error = isinstance(error, JobError)
        report = {
            "status": "failed",
            "errorType": type(error).__name__,
            "error": str(error),
            "userError": user_error,
            "traceback": None if user_error else traceback.format_exc(),
        }
        if out_dir:
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            Path(out_dir, "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), file=sys.stderr)
        return 2 if user_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
