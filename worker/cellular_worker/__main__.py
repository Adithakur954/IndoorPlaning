"""CLI: python -m cellular_worker <job.json>  or  --model-version."""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from .job import CellularJob, CellularJobError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="cellular_worker")
    parser.add_argument("job", nargs="?")
    parser.add_argument("--model-version", action="store_true")
    args = parser.parse_args(argv)
    if args.model_version:
        from .version import model_info

        print(json.dumps(model_info()))
        return 0
    out_dir = None
    try:
        raw = json.loads(Path(args.job).read_text(encoding="utf-8"))
        out_dir = raw.get("output_dir")
        job = CellularJob.from_dict(raw)
        from .predict import run

        result = run(job)
        print(json.dumps({"status": "ok", "network": "cellular", "backend": result["backend"],
                          "resources": result["resources"], "floors": result["floors"]}, indent=2))
        return 0
    except Exception as error:  # noqa: BLE001 - every failure is reported as a job error
        from sionna_worker.job import JobError

        user_error = isinstance(error, (CellularJobError, JobError))
        report = {"status": "failed", "errorType": type(error).__name__, "error": str(error),
                  "userError": user_error, "traceback": None if user_error else traceback.format_exc()}
        if out_dir:
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            Path(out_dir, "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), file=sys.stderr)
        return 2 if user_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
