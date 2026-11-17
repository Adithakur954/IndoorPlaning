"""Model version: identifies the simulation code and engine a result came from.

A saved or cached result is only reused when this version is unchanged, so
updating the worker code, the material tables or the Sionna RT / Mitsuba / Dr.Jit
packages automatically invalidates old results. Importing this module must stay
cheap (no Mitsuba import): the service calls it from the command line.
"""
from __future__ import annotations

import hashlib
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent


def code_hash(package_dir: Path | None = None) -> str:
    """Hash of every .py file of the worker (names and contents)."""
    digest = hashlib.sha256()
    for path in sorted((package_dir or PACKAGE_DIR).glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "missing"


def model_info(package_dir: Path | None = None) -> dict:
    parts = {
        "code": code_hash(package_dir),
        "sionna-rt": _package_version("sionna-rt"),
        "mitsuba": _package_version("mitsuba"),
        "drjit": _package_version("drjit"),
    }
    combined = hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]
    return {"modelVersion": combined, **{k: (v[:12] if k == "code" else v) for k, v in parts.items()}}


def model_version(package_dir: Path | None = None) -> str:
    return model_info(package_dir)["modelVersion"]
