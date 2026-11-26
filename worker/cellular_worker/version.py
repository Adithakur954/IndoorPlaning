"""Model version of the cellular worker: its own code plus the Wi-Fi worker code it uses
(scene loading, materials, backend) and the engine packages. Changing cellular code never
changes the Wi-Fi model version, so Wi-Fi results stay current."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from sionna_worker.version import code_hash
from sionna_worker.version import model_info as wifi_model_info

PACKAGE_DIR = Path(__file__).resolve().parent


def model_info() -> dict:
    wifi = wifi_model_info()
    parts = {"cellular": code_hash(PACKAGE_DIR), "shared": wifi["modelVersion"]}
    combined = hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]
    return {"modelVersion": combined, "cellularCode": parts["cellular"][:12], "sharedModel": wifi["modelVersion"],
            **{k: wifi[k] for k in ("sionna-rt", "mitsuba", "drjit")}}


def model_version() -> str:
    return model_info()["modelVersion"]
