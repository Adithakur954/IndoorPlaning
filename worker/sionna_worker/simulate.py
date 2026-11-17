"""Runs Sionna RT radio maps for a scene exported by Indoor Planner."""
from __future__ import annotations

import itertools
import json
import math
import platform
import subprocess
import time
from collections import defaultdict
from importlib.metadata import version
from pathlib import Path

import numpy as np
import psutil

from .job import MAX_CELLS_PER_MAP, JobError, JobSettings, band_of
from .runtime import select_backend
from .snr import ap_bandwidth_mhz, noise_floor_dbm, snr_grid
from .version import model_info

FLOOR_DBM = -200.0  # cells with no received power


def _to_dbm(watts: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore"):
        dbm = 10.0 * np.log10(watts) + 30.0
    return np.where(np.isfinite(dbm), np.maximum(dbm, FLOOR_DBM), FLOOR_DBM)


def _rounded(grid: np.ndarray, digits: int = 1) -> list:
    """JSON grid; cells without received power become null."""
    out = np.round(grid, digits).astype(object)
    out[grid <= FLOOR_DBM] = None
    return out.tolist()


def _gpu_memory_mb() -> int | None:
    try:
        lines = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip().splitlines()
        return int(lines[0]) if lines else None
    except Exception:  # noqa: BLE001
        return None


def _eirp_dbm(ap: dict) -> float:
    """Transmit power plus antenna gain. The simulated antenna is isotropic
    (0 dBi), so the AP's gain is applied as extra radiated power."""
    return float(ap["txPowerDbm"]) + float(ap.get("antennaGainDbi") or 0.0)


def load_export(scene_dir: Path, *, require_access_points: bool = True) -> dict:
    """Load a scene; placement optimisation can start without existing APs."""
    config_path = scene_dir / "scene_config.json"
    if not (scene_dir / "scene.xml").exists() or not config_path.exists():
        raise JobError(f"{scene_dir} is not a scene export (scene.xml / scene_config.json missing)")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("exportVersion") != 1:
        raise JobError(f"Unsupported export version {config.get('exportVersion')!r}")
    if require_access_points and not config.get("accessPoints"):
        raise JobError("The scene export has no access points")
    return config


_MATERIAL_IDS = itertools.count(1)  # scene material names must stay unique
WALL_ROLES = ("wall", "exterior-wall", "interior-wall")


def apply_materials(scene, config: dict, freq_mhz: float | None = None) -> list[dict]:
    """Gives every exported mesh its radio material.

    Default: the ITU-R P.2040 material with the exported thickness. A manual
    override per plan material (config["materialOverrides"]) replaces it with
    either explicit permittivity and conductivity, or a loss in dB through the
    wall, converted to the conductivity that gives that loss at the simulated
    frequency. Call it again after changing scene.frequency when overrides use
    a loss (the conductivity depends on the frequency). Returns a report.
    """
    from sionna.rt import ITURadioMaterial, RadioMaterial

    from .materials import itu_properties, sigma_for_loss

    overrides = config.get("materialOverrides") or {}
    report: dict[str, dict] = {}
    for mesh in config["meshes"]:
        obj = scene.get(mesh["shapeId"].removeprefix("mesh-"))
        if obj is None or mesh.get("thicknessM") is None:
            continue
        itu_type = mesh["radioMaterial"]
        ov = overrides.get(mesh["planMaterial"]) or {}
        thickness = float(mesh["thicknessM"])
        counter = next(_MATERIAL_IDS)
        if ov.get("permittivity") is not None and ov.get("conductivity") is not None:
            eps, sigma = float(ov["permittivity"]), float(ov["conductivity"])
            note = {"mode": "permittivity/conductivity"}
        elif ov.get("lossDb") is not None and freq_mhz:
            eps, _ = itu_properties(itu_type, freq_mhz)
            solved = sigma_for_loss(eps, float(ov["referenceThicknessM"]), freq_mhz, float(ov["lossDb"]))
            sigma = solved["sigma"]
            note = {"mode": "loss", "requestedLossDb": float(ov["lossDb"]),
                    "achievedLossDb": solved["achievedDb"], "reachable": solved["reachable"],
                    "referenceThicknessM": float(ov["referenceThicknessM"])}
        else:
            obj.radio_material = ITURadioMaterial(
                name=f"{itu_type}-{mesh['role']}-{counter}",
                itu_type=itu_type.removeprefix("itu_"),
                thickness=thickness,
            )
            continue
        obj.radio_material = RadioMaterial(
            name=f"custom-{mesh['planMaterial']}-{mesh['role']}-{counter}",
            thickness=thickness, relative_permittivity=eps, conductivity=sigma,
        )
        report[mesh["planMaterial"]] = {**note, "relativePermittivity": eps, "conductivity": sigma,
                                       "frequencyMHz": freq_mhz}
    return [{"material": k, **v} for k, v in report.items()]


def _apply_material_thickness(scene, config: dict) -> None:  # kept for callers
    apply_materials(scene, config)


def run(settings: JobSettings) -> dict:
    started = time.time()
    scene_dir = Path(settings.scene_dir)
    out_dir = Path(settings.output_dir)
    config = load_export(scene_dir)

    backend = select_backend(settings.device, settings.cpu_threads)
    import drjit as dr  # imported after the variant is set
    import mitsuba as mi
    import sionna.rt as rt

    scene = rt.load_scene(str(scene_dir / "scene.xml"), merge_shapes=False)
    _apply_material_thickness(scene, config)
    scene.tx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")
    scene.rx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")

    floors = [
        f for f in config["floors"]
        if f.get("radioMapPlane") and (not settings.floor_ids or f["id"] in settings.floor_ids)
    ]
    if not floors:
        raise JobError("No floors selected for simulation")

    by_frequency: dict[float, list[dict]] = defaultdict(list)
    for ap in config["accessPoints"]:
        by_frequency[float(ap["frequencyMHz"])].append(ap)

    process = psutil.Process()
    peak_rss_mb = process.memory_info().rss / 1e6
    summaries = []
    material_report: list[dict] = []
    (out_dir / "maps").mkdir(parents=True, exist_ok=True)

    for freq_mhz, aps in sorted(by_frequency.items()):
        scene.frequency = freq_mhz * 1e6
        material_report = apply_materials(scene, config, freq_mhz)
        for name in list(scene.transmitters):
            scene.remove(name)
        for index, ap in enumerate(aps):
            scene.add(rt.Transmitter(
                name=f"ap{index}", position=ap["position"], power_dbm=_eirp_dbm(ap)
            ))
        for floor in floors:
            plane = floor["radioMapPlane"]
            cell = settings.resolution_m
            nx, ny = math.ceil(plane["size"][0] / cell), math.ceil(plane["size"][1] / cell)
            if nx * ny > MAX_CELLS_PER_MAP:
                raise JobError(
                    f"{floor['name']}: {nx}x{ny} cells exceeds {MAX_CELLS_PER_MAP}; raise resolution_m"
                )
            height = (
                floor["elevationM"] + settings.receiver_height_m
                if settings.receiver_height_m is not None else plane["heightM"]
            )
            t0 = time.time()
            radio_map = rt.RadioMapSolver()(
                scene,
                center=[plane["center"][0], plane["center"][1], height],
                orientation=[0, 0, 0],
                size=plane["size"],
                cell_size=[cell, cell],
                samples_per_tx=settings.samples_per_tx,
                max_depth=settings.max_depth,
                los=True,
                specular_reflection=True,
                diffuse_reflection=settings.diffuse_reflection,
                refraction=settings.refraction,
                diffraction=settings.diffraction,
                seed=settings.seed,
            )
            rss_w = np.array(radio_map.rss)  # (tx, ny, nx) in watts; forces evaluation
            rss_w = rss_w * 10 ** (settings.receiver_gain_dbi / 10)
            dr.sync_thread()
            seconds = time.time() - t0
            peak_rss_mb = max(peak_rss_mb, process.memory_info().rss / 1e6)

            per_ap = _to_dbm(rss_w)
            total_dbm = _to_dbm(rss_w.sum(axis=0))
            best_index = rss_w.argmax(axis=0)
            best_dbm = np.take_along_axis(per_ap, best_index[None], 0)[0]
            centers = np.array(radio_map.cell_centers)  # (ny, nx, 3) in scene coordinates
            weak = best_dbm < settings.weak_threshold_dbm
            # SNR: the best AP's power minus the noise floor of its band and channel width
            band = band_of(freq_mhz)
            floor_20 = {"2.4": settings.noise_floor_24_dbm, "5": settings.noise_floor_5_dbm,
                        "6": settings.noise_floor_6_dbm}.get(band, settings.noise_floor_5_dbm)
            widths = [ap_bandwidth_mhz(ap) for ap in aps]
            noise = np.array([noise_floor_dbm(floor_20, w) for w, _ in widths])
            snr_db = snr_grid(best_dbm, best_index, noise)
            file_name = f"{floor['id']}__{int(freq_mhz)}MHz.json"
            payload = {
                "floorId": floor["id"],
                "floorName": floor["name"],
                "frequencyMHz": freq_mhz,
                "quantity": "Predicted received power at the receiver position (dBm). "
                            "Physics-based estimate; not a measured Wi-Fi RSSI.",
                "planeHeightM": float(height),
                "cellSizeM": cell,
                "shape": [int(per_ap.shape[1]), int(per_ap.shape[2])],
                # scene (x, y) -> plan (x, z = -y). Rows follow zCentersM, columns xCentersM.
                "xCentersM": np.round(centers[0, :, 0], 4).tolist(),
                "zCentersM": np.round(-centers[:, 0, 1], 4).tolist(),
                "accessPoints": [{"id": ap["id"], "name": ap["name"]} for ap in aps],
                "bestDbm": _rounded(best_dbm),
                "bestSnrDb": _rounded(np.where(best_dbm <= FLOOR_DBM, FLOOR_DBM, snr_db)),
                "snr": {
                    "definition": "Strongest AP's received power minus the noise floor of its band "
                                  "and channel width. The floor is a planning assumption for a 20 MHz "
                                  "channel (+3 dB per doubling of the width), not a measurement. "
                                  "Interference from other APs is not included.",
                    "band": band,
                    "noiseFloor20MHzDbm": floor_20,
                    "noiseFloorDbm": [round(float(n), 2) for n in noise],
                    "bandwidthMHz": [w for w, _ in widths],
                    "bandwidthAssumed": [a for _, a in widths],
                },
                "bestApIndex": best_index.tolist(),
                "totalDbm": _rounded(total_dbm),
                "perApDbm": [_rounded(g) for g in per_ap],
                "nullMeans": "no received power reached the cell",
            }
            (out_dir / "maps" / file_name).write_text(json.dumps(payload), encoding="utf-8")
            covered = best_dbm[best_dbm > FLOOR_DBM]
            summaries.append({
                "floorId": floor["id"],
                "frequencyMHz": freq_mhz,
                "file": f"maps/{file_name}",
                "cells": int(best_dbm.size),
                "weakCells": int(weak.sum()),
                "weakFraction": float(weak.mean()),
                "bestDbmMin": float(covered.min()) if covered.size else None,
                "bestDbmMedian": float(np.median(covered)) if covered.size else None,
                "bestDbmMax": float(covered.max()) if covered.size else None,
                "solveSeconds": round(seconds, 3),
            })

    result = {
        "status": "ok",
        "sceneSha256": config.get("contentSha256"),
        "settings": settings.to_dict(),
        "backend": backend,
        "versions": {
            "sionna-rt": version("sionna-rt"),
            "mitsuba": mi.__version__,
            "drjit": dr.__version__,
            "python": platform.python_version(),
        },
        "model": model_info(),
        "weakThresholdDbm": settings.weak_threshold_dbm,
        "floors": summaries,
        "resources": {
            "wallSeconds": round(time.time() - started, 3),
            "peakProcessRssMb": round(peak_rss_mb, 1),
            "gpuMemoryUsedMbAfter": _gpu_memory_mb() if backend["device"] == "gpu" else None,
        },
        "exportWarnings": config.get("warnings", []),
        "materialOverrides": material_report,
        "assumptions": [
            "Reported power = AP transmit power + antenna gain (EIRP, isotropic radiation) + receiver gain, less path loss; "
            "SNR = strongest AP's power minus the noise floor. The floor is a planning assumption per band "
            "for a 20 MHz channel (default -86 dBm at 2.4 GHz, -88 dBm at 5 GHz) plus 3 dB per doubling "
            "of the channel width; an AP with no width recorded is taken as 20 MHz. It is not measured. "
            "Interference (SINR) is not reported.",
            "Isotropic vertically polarised antennas; no small-scale fading, people or unmodelled furniture.",
            "ITU-R P.2040 material properties with assumed thicknesses; not calibrated to measurements.",
            "Doors are modelled closed.",
        ],
    }
    (out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
