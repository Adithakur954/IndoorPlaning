"""The AP placement search, run by the Rust `apsearch` binary (capacity/src/apsearch.rs).

Ray tracing stays here in Python (Sionna); choosing the APs is done in Rust on the cached coverage: greedy maximum
coverage worst areas first, then simulated annealing (relocate / add / remove), then pruning of APs that do not
earn their place. Without the binary the older Python greedy (optimizer.select) is used and the result says so.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from .optimizer import Problem, Selection, select

_HERE = Path(__file__).resolve().parent
_EXE = "apsearch.exe" if sys.platform == "win32" else "apsearch"


def binary() -> Path | None:
    """The apsearch binary: $APSEARCH_BIN, the packaged worker/bin, or the development build."""
    candidates = [
        Path(os.environ["APSEARCH_BIN"]) if os.environ.get("APSEARCH_BIN") else None,
        _HERE.parent / "bin" / _EXE,
        _HERE.parents[1] / "capacity" / "target" / "release" / _EXE,
    ]
    for c in candidates:
        if c and c.exists():
            return c
    return None


def run(problem: Problem, *, target_pct: float | None, budget: int | None, min_gain_pct: float,
        min_count: int = 0, warm: list[int] | None = None, iterations: int = 30_000,
        time_limit_ms: int = 30_000, seed: int = 42) -> tuple[Selection, str]:
    """(selection, engine description). Falls back to the Python greedy when the binary is missing or fails."""
    exe = binary()
    if exe is not None:
        tmp = Path(tempfile.mkdtemp(prefix="apsearch-"))
        try:
            k, n = problem.hit.shape
            np.ascontiguousarray(problem.hit, dtype=np.uint8).tofile(tmp / "hit.u8")
            params = {
                "k": int(k), "n": int(n),
                "weight": [float(v) for v in problem.weight],
                "priority": [float(v) for v in (problem.priority if problem.priority is not None else np.ones(n))],
                "base": [int(v) for v in problem.base_count],
                "need": int(problem.k),
                "positions": [[float(v) for v in p] for p in problem.positions],
                "allowed": [bool(v) for v in problem.allowed],
                "prefer": [bool(v) for v in (problem.prefer if problem.prefer is not None else np.zeros(k, bool))],
                "warm": [int(i) for i in (warm or [])],
                "budget": None if budget is None else int(budget),
                "targetPct": None if target_pct is None else float(target_pct),
                "minGainPct": float(min_gain_pct),
                "minSeparationM": float(problem.min_separation_m),
                "minCount": int(min_count),
                "iterations": int(iterations), "timeLimitMs": int(time_limit_ms), "seed": int(seed),
            }
            (tmp / "params.json").write_text(json.dumps(params), encoding="utf-8")
            flags = 0x08000000 if sys.platform == "win32" else 0   # no console window
            done = subprocess.run([str(exe), str(tmp)], capture_output=True, text=True,
                                  timeout=max(60, time_limit_ms // 1000 * 3), creationflags=flags)
            if done.returncode != 0:
                raise RuntimeError(done.stderr.strip() or f"exit code {done.returncode}")
            out = json.loads((tmp / "result.json").read_text(encoding="utf-8"))
            sel = Selection(
                indices=[int(i) for i in out["selected"]], status=out["status"],
                coverage_pct=float(out["coveragePct"]), baseline_pct=float(out["baselinePct"]),
                max_possible_pct=float(out["maxPossiblePct"]),
                steps=[{"index": int(s["index"]), "marginalPct": float(s["marginalPct"]),
                        "cumulativePct": float(s["cumulativePct"])} for s in out["steps"]],
                more_needed=out.get("moreNeeded"), more_reach_pct=out.get("moreReachPct"),
            )
            return sel, (f"Rust search: greedy worst-areas-first, then simulated annealing "
                         f"({out.get('iterations', 0)} moves tried, {out.get('accepted', 0)} accepted), then pruning")
        except Exception as error:   # the fallback must never fail the job
            fallback_note = f" (the Rust search failed: {error})"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        fallback_note = " (the apsearch binary was not found)"
    sel = select(problem, target_pct, budget, min_count=min_count, min_gain_pct=min_gain_pct)
    return sel, "Python greedy + swaps" + fallback_note
