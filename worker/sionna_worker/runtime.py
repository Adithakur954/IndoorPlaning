"""Backend selection: CUDA GPU when usable, otherwise the LLVM CPU backend."""
from __future__ import annotations

import os
from pathlib import Path

from .job import JobError

VARIANTS = {"gpu": "cuda_ad_mono_polarized", "cpu": "llvm_ad_mono_polarized"}


def _find_llvm() -> str | None:
    """DRJIT_LIBLLVM_PATH wins; otherwise look for the project-local conda LLVM."""
    if os.environ.get("DRJIT_LIBLLVM_PATH"):
        return None  # already configured
    root = Path(__file__).resolve().parents[1]
    for candidate in (
        root / ".llvm" / "Library" / "bin" / "LLVM-C.dll",
        root / ".llvm" / "lib" / "libLLVM.so",
    ):
        if candidate.exists():
            return str(candidate)
    return None


def _try(device: str):
    # Dr.Jit locates LLVM when it is first imported, so configure the path first.
    path = _find_llvm()
    if path:
        os.environ["DRJIT_LIBLLVM_PATH"] = path
    import mitsuba as mi

    mi.set_variant(VARIANTS[device])
    import drjit as dr

    # set_variant alone does not prove the device works: force a real kernel.
    x = dr.arange(mi.Float, 8) * 2.0
    dr.eval(x)
    dr.sync_thread()
    return mi


def select_backend(device: str = "auto", cpu_threads: int | None = None) -> dict:
    """Returns {'device': 'gpu'|'cpu', 'variant': str, 'fallback_reason': str|None}."""
    order = {"auto": ["gpu", "cpu"], "gpu": ["gpu"], "cpu": ["cpu"]}[device]
    reasons = []
    for choice in order:
        try:
            _try(choice)
            if choice == "cpu" and cpu_threads:
                import drjit as dr

                dr.set_thread_count(cpu_threads)
            return {
                "device": choice,
                "variant": VARIANTS[choice],
                "fallback_reason": "; ".join(reasons) or None,
            }
        except Exception as error:  # noqa: BLE001 - any backend failure means: try the next
            reasons.append(f"{choice} unavailable: {str(error).splitlines()[0][:200]}")
    raise JobError("No usable backend. " + " | ".join(reasons))
