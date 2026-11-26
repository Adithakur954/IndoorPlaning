"""Cellular (DAS) coverage of one carrier with Sionna RT.

Every antenna is traced with its own radiation pattern, direction and the power
at its port; antennas of a sector are added up as one cell; the maps give RSRP
of the best cell, which cell that is, and SINR against the other cells of the
carrier. The building, materials and ray settings are the same as the Wi-Fi
prediction's (shared code in sionna_worker), but the run, its results and its
cache are separate.
"""
from __future__ import annotations

import json
import math
import platform
import time
from collections import defaultdict
from importlib.metadata import version
from pathlib import Path

import numpy as np

from sionna_worker.runtime import select_backend
from sionna_worker.simulate import apply_materials, load_export

from . import patterns as pattern_mod
from .job import MAX_CELLS_PER_MAP, CellularJob, CellularJobError
from .kpi import FLOOR_DBM, cell_grids, noise_per_re_dbm
from .version import model_info


def _rounded(grid: np.ndarray, digits: int = 1) -> list:
    out = np.round(grid, digits).astype(object)
    out[~np.isfinite(grid) | (grid <= FLOOR_DBM)] = None
    return out.tolist()


def _write_progress(out_dir: Path, done: int, total: int, label: str) -> None:
    try:
        (out_dir / "progress.json").write_text(json.dumps({"done": done, "total": total, "stage": label}))
    except OSError:
        pass


def run(job: CellularJob) -> dict:
    started = time.time()
    scene_dir, out_dir = Path(job.scene_dir), Path(job.output_dir)
    config = load_export(scene_dir, require_access_points=False)
    backend = select_backend(job.device, job.cpu_threads)
    import drjit as dr
    import mitsuba as mi
    import sionna.rt as rt

    floors = [f for f in config["floors"]
              if f.get("radioMapPlane") and (not job.floor_ids or f["id"] in job.floor_ids)]
    if not floors:
        raise CellularJobError("No floors selected for the prediction")
    known = {f["id"] for f in config["floors"]}
    stray = [a.name for a in job.antennas if a.floor_id not in known]
    if stray:
        raise CellularJobError(f"Antennas on floors the scene does not have: {', '.join(stray[:5])}")

    scene = rt.load_scene(str(scene_dir / "scene.xml"), merge_shapes=False)
    scene.frequency = job.carrier.freq_mhz * 1e6
    material_report = apply_materials(scene, config, job.carrier.freq_mhz)
    scene.rx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")

    names = {key: pattern_mod.register(p) for key, p in job.patterns.items()}
    groups: dict[str, list[int]] = defaultdict(list)
    for i, a in enumerate(job.antennas):
        groups[a.pattern].append(i)
    sector_index = {s["id"]: k for k, s in enumerate(job.sectors)}
    sector_of = np.array([sector_index[a.sector_id] for a in job.antennas])
    noise_re = noise_per_re_dbm(job.carrier.scs_khz, job.ue_noise_figure_db)

    (out_dir / "maps").mkdir(parents=True, exist_ok=True)
    summaries = []
    steps, step = len(floors) * len(groups), 0
    deg = math.pi / 180.0
    for floor in floors:
        plane = floor["radioMapPlane"]
        cell = job.resolution_m
        nx, ny = math.ceil(plane["size"][0] / cell), math.ceil(plane["size"][1] / cell)
        if nx * ny > MAX_CELLS_PER_MAP:
            raise CellularJobError(f"{floor['name']}: {nx}x{ny} cells is too many; use a coarser grid")
        height = floor["elevationM"] + job.receiver_height_m
        rss = None
        centers = None
        t0 = time.time()
        for key, members in groups.items():
            _write_progress(out_dir, step, steps, f"{floor['name']}: {job.patterns[key].model or key}")
            step += 1
            scene.tx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern=names[key], polarization="V")
            for name in list(scene.transmitters):
                scene.remove(name)
            for j, i in enumerate(members):
                a = job.antennas[i]
                scene.add(rt.Transmitter(
                    name=f"ant{j}", position=mi.Point3f(*a.position),
                    orientation=mi.Point3f(*(v * deg for v in a.orientation_deg)), power_dbm=a.power_dbm,
                ))
            radio_map = rt.RadioMapSolver()(
                scene,
                center=[plane["center"][0], plane["center"][1], height],
                orientation=[0, 0, 0], size=plane["size"], cell_size=[cell, cell],
                samples_per_tx=job.samples_per_tx, max_depth=job.max_depth,
                los=True, specular_reflection=True, diffuse_reflection=False,
                refraction=True, diffraction=job.diffraction, seed=job.seed,
            )
            part = np.array(radio_map.rss)  # (members, ny, nx) watts
            if rss is None:
                rss = np.zeros((len(job.antennas), *part.shape[1:]))
                centers = np.array(radio_map.cell_centers)
            rss[members] = part
        dr.sync_thread()
        seconds = time.time() - t0
        g = cell_grids(rss, sector_of, len(job.sectors), job.carrier.rsrp_offset_db, noise_re)
        best = g["bestRsrpDbm"]
        file_name = f"{floor['id']}__cell_{int(round(job.carrier.freq_mhz))}MHz.json"
        payload = {
            "network": "cellular",
            "floorId": floor["id"],
            "floorName": floor["name"],
            "carrier": {"id": job.carrier.id, "label": job.carrier.label, "technology": job.carrier.technology,
                        "band": job.carrier.band, "frequencyMHz": job.carrier.freq_mhz,
                        "bandwidthMHz": job.carrier.bandwidth_mhz, "resourceBlocks": job.carrier.resource_blocks},
            "frequencyMHz": job.carrier.freq_mhz,
            "quantity": "RSRP of the best cell (dBm per resource element). Physics-based estimate, not a measurement.",
            "planeHeightM": float(height),
            "cellSizeM": cell,
            "shape": [int(best.shape[0]), int(best.shape[1])],
            "xCentersM": np.round(centers[0, :, 0], 4).tolist(),
            "zCentersM": np.round(-centers[:, 0, 1], 4).tolist(),
            "sectors": job.sectors,
            # the same names as a Wi-Fi map so shared map code can read it: the "access points" are the cells
            "accessPoints": [{"id": s["id"], "name": s["name"]} for s in job.sectors],
            "bestDbm": _rounded(best),
            "bestApIndex": g["bestSector"].tolist(),
            "bestSinrDb": _rounded(g["sinrDb"]),
            "perSectorRsrpDbm": [_rounded(x) for x in g["perSectorRsrpDbm"]],
            "antennas": [{"id": a.id, "name": a.name, "sectorId": a.sector_id} for a in job.antennas],
            "bestAntennaIndex": g["bestAntenna"].tolist(),
            "noisePerReDbm": round(float(noise_re), 2),
            "nullMeans": "no received power reached the cell",
        }
        (out_dir / "maps" / file_name).write_text(json.dumps(payload), encoding="utf-8")
        reached = best[best > FLOOR_DBM]
        summaries.append({
            "floorId": floor["id"], "file": f"maps/{file_name}", "cells": int(best.size),
            "rsrpMinDbm": float(reached.min()) if reached.size else None,
            "rsrpMedianDbm": float(np.median(reached)) if reached.size else None,
            "rsrpMaxDbm": float(reached.max()) if reached.size else None,
            "solveSeconds": round(seconds, 3),
        })

    patterns_used = {k: {"model": p.model, "source": p.source, "gainDbi": p.gain_dbi} for k, p in job.patterns.items()}
    result = {
        "status": "ok",
        "network": "cellular",
        "sceneSha256": config.get("contentSha256"),
        "carrier": summaries and {"id": job.carrier.id, "label": job.carrier.label,
                                   "frequencyMHz": job.carrier.freq_mhz, "bandwidthMHz": job.carrier.bandwidth_mhz,
                                   "technology": job.carrier.technology, "resourceBlocks": job.carrier.resource_blocks,
                                   "rsrpOffsetDb": job.carrier.rsrp_offset_db},
        "sectors": job.sectors,
        "antennaCount": len(job.antennas),
        "patterns": patterns_used,
        "backend": backend,
        "versions": {"sionna-rt": version("sionna-rt"), "mitsuba": mi.__version__, "drjit": dr.__version__,
                     "python": platform.python_version()},
        "model": model_info(),
        "floors": summaries,
        "materialOverrides": material_report,
        "resources": {"wallSeconds": round(time.time() - started, 3)},
        "assumptions": [
            "Each antenna radiates the power at its port through its pattern (from the antenna's pattern file, "
            "or shaped from its datasheet gain, beamwidths and front-to-back ratio as in 3GPP TR 38.901).",
            "The antennas of a sector send one cell: their powers add up.",
            "RSRP = cell power less 10*log10(12 x resource blocks): the power is spread equally over the "
            "subcarriers. When the operator sets the reference signal higher or lower, RSRP moves by the same amount.",
            "SINR: the best cell's RSRP over the other cells of this carrier (taken as fully loaded) plus thermal "
            f"noise of one subcarrier and a {job.ue_noise_figure_db:g} dB handset noise figure. Interference from "
            "outdoor sites is not included.",
            "Handset antenna isotropic (0 dBi), vertically polarised; no fading, people or unmodelled furniture.",
            "ITU-R P.2040 material properties with assumed thicknesses; not calibrated to measurements. "
            "Doors are modelled closed.",
        ],
    }
    (out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
