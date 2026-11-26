"""AP placement optimisation pipeline.

Stages: A preprocessing (grid, targets) -> B candidate screening with coarse ray
tracing (approximate, ranking only) -> C batched ray tracing of the shortlist at
the final resolution into a candidate-coverage matrix -> D set-cover optimisation
on that matrix. Rows of the matrix are cached on disk one by one.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import time
from collections import defaultdict
from importlib.metadata import version
from pathlib import Path

import numpy as np
import psutil

from .grid import COMMON_AREA, OUTSIDE, FloorGrid, Targets, build_grids, classify
from .job import JobError, OptimizeJob, band_of
from . import apsearch
from .optimizer import Problem, breakdown, deficit_priority, range_separation, select
from .runtime import select_backend
from .version import model_info, model_version
from .simulate import FLOOR_DBM, _gpu_memory_mb, apply_materials, load_export
from .snr import ap_bandwidth_mhz, noise_floor_dbm, strongest_snr

MAX_MATRIX_ELEMENTS = 150_000_000


def replace_file(tmp: Path, target: Path, attempts: int = 20, delay: float = 0.05) -> bool:
    """os.replace that tolerates Windows locks. On Windows the rename fails with
    "Access is denied" while another process (the service reading progress, an
    antivirus scan, the search indexer) has the target open. Retry for about a
    second; if it is still locked, drop the temporary file and return False."""
    for attempt in range(attempts):
        try:
            os.replace(tmp, target)
            return True
        except PermissionError:
            if attempt + 1 < attempts:
                time.sleep(delay)
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    return False


class Progress:
    def __init__(self, out_dir: Path):
        self.path = out_dir / "progress.json"
        self.started = time.time()

    def update(self, stage: str, fraction: float, message: str, **extra):
        data = {
            "stage": stage,
            "fraction": round(min(max(fraction, 0.0), 1.0), 4),
            "message": message,
            "elapsedSeconds": round(time.time() - self.started, 1),
            **extra,
        }
        # Progress is best effort: a locked file skips this update, never fails the job.
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data), encoding="utf-8")
        except OSError:
            return
        replace_file(tmp, self.path)


class RowCache:
    """One float16 dBm vector per simulated transmitter, keyed by everything that
    changes its value. Oldest files are evicted above the size cap."""

    def __init__(self, directory: str | None, max_mb: int, version: str = "", refresh: bool = False):
        # Rows live in a folder per model version: rows made by other versions
        # of the simulation code or engine are never reused and are deleted.
        self.refresh = refresh
        self.dir = Path(directory) / "rows" / (version or "unversioned") if directory else None
        self.max_bytes = max_mb * 1_000_000
        self.hits = self.misses = 0
        self.removed_old_versions = 0
        if self.dir:
            self.dir.mkdir(parents=True, exist_ok=True)
            for other in self.dir.parent.iterdir():
                if other.is_dir() and other != self.dir:
                    shutil.rmtree(other, ignore_errors=True)
                    self.removed_old_versions += 1
                elif other.is_file():  # rows of the older unversioned layout
                    other.unlink(missing_ok=True)
                    self.removed_old_versions += 1

    @staticmethod
    def key(parts: dict) -> str:
        return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()

    def get(self, key: str, length: int):
        if not self.dir or self.refresh:
            return None
        path = self.dir / f"{key}.npy"
        try:
            row = np.load(path)
            if row.shape == (length,):
                os.utime(path)
                self.hits += 1
                return row
        except (OSError, ValueError):
            pass
        return None

    def put(self, key: str, row: np.ndarray):
        self.misses += 1
        if self.dir:
            # A row that cannot be cached (locked file) is only recomputed next time.
            tmp = self.dir / f"{key}.tmp.npy"
            try:
                np.save(tmp, row)
            except OSError:
                return
            replace_file(tmp, self.dir / f"{key}.npy")

    def evict(self):
        if not self.dir or not self.max_bytes:
            return
        files = sorted(self.dir.glob("*.npy"), key=lambda p: p.stat().st_mtime)
        total = sum(f.stat().st_size for f in files)
        for f in files:
            if total <= self.max_bytes:
                break
            total -= f.stat().st_size
            f.unlink(missing_ok=True)


def _dbm(watts: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore"):
        dbm = 10.0 * np.log10(watts) + 30.0
    return np.where(np.isfinite(dbm), np.maximum(dbm, FLOOR_DBM), FLOOR_DBM)


class Simulator:
    """Runs Sionna RT radio maps for batches of transmitters."""

    def __init__(self, scene, config: dict, job: OptimizeJob, cache: RowCache, rt, dr):
        self.scene, self.config, self.job, self.cache, self.rt, self.dr = scene, config, job, cache, rt, dr
        self.scene_sha = config.get("contentSha256")
        self.rt_seconds = 0.0
        self.material_report: list[dict] = []

    def rows(self, txs: list[dict], grids: list[FloorGrid], samples: int, depth: int,
             freq_mhz: float, on_batch=None) -> np.ndarray:
        """txs: [{position (scene xyz), eirpDbm}] at one frequency -> (len, N) float16 dBm."""
        n_total = sum(g.cells for g in grids)
        out = np.full((len(txs), n_total), FLOOR_DBM, dtype=np.float16)
        base_key = {
            "scene": self.scene_sha, "freq": freq_mhz, "samples": samples, "depth": depth,
            "seed": self.job.seed, "refraction": self.job.refraction,
            "diffraction": self.job.diffraction, "diffuse": self.job.diffuse_reflection,
            "rxGain": self.job.receiver_gain_dbi,
            "grids": [[g.floor_id, g.nx, g.ny, g.cell, round(g.height_m, 3)] for g in grids],
        }
        keys = [
            RowCache.key({**base_key, "pos": [round(v, 3) for v in t["position"]],
                          "eirp": round(t["eirpDbm"], 3)})
            for t in txs
        ]
        missing = []
        for i, key in enumerate(keys):
            row = self.cache.get(key, n_total)
            if row is None:
                missing.append(i)
            else:
                out[i] = row
        rt, dr, scene = self.rt, self.dr, self.scene
        scene.frequency = freq_mhz * 1e6
        if self.config.get("materialOverrides"):
            self.material_report = apply_materials(scene, self.config, freq_mhz)
        done = len(txs) - len(missing)
        if on_batch:
            on_batch(done, len(txs))
        for start in range(0, len(missing), self.job.batch_size):
            batch = missing[start:start + self.job.batch_size]
            for name in list(scene.transmitters):
                scene.remove(name)
            for j, i in enumerate(batch):
                scene.add(rt.Transmitter(
                    name=f"t{j}", position=list(txs[i]["position"]), power_dbm=txs[i]["eirpDbm"],
                ))
            t0 = time.time()
            for g in grids:
                radio_map = rt.RadioMapSolver()(
                    scene,
                    center=[g.center[0], g.center[1], g.height_m],
                    orientation=[0, 0, 0],
                    size=g.size,
                    cell_size=[g.cell, g.cell],
                    samples_per_tx=samples,
                    max_depth=depth,
                    los=True,
                    specular_reflection=True,
                    diffuse_reflection=self.job.diffuse_reflection,
                    refraction=self.job.refraction,
                    diffraction=self.job.diffraction,
                    seed=self.job.seed,
                )
                rss = np.array(radio_map.rss) * 10 ** (self.job.receiver_gain_dbi / 10)
                if rss.shape != (len(batch), g.ny, g.nx):
                    raise JobError(
                        f"Unexpected radio-map shape {rss.shape} for {g.floor_id}; expected "
                        f"{(len(batch), g.ny, g.nx)}"
                    )
                dbm = _dbm(rss).reshape(len(batch), -1).astype(np.float16)
                for j, i in enumerate(batch):
                    out[i, g.offset:g.offset + g.cells] = dbm[j]
            dr.sync_thread()
            self.rt_seconds += time.time() - t0
            for i in batch:
                self.cache.put(keys[i], out[i])
            done += len(batch)
            if on_batch:
                on_batch(done, len(txs))
        return out


def _scene_position(plan_x: float, plan_z: float, elevation: float, height: float):
    return [plan_x, -plan_z, elevation + height]


def run_optimize(job: OptimizeJob) -> dict:
    started = time.time()
    out_dir = Path(job.output_dir)
    (out_dir / "maps").mkdir(parents=True, exist_ok=True)
    progress = Progress(out_dir)
    timings: dict[str, float] = {}
    process = psutil.Process()
    peak_rss = process.memory_info().rss / 1e6

    # ---- Stage A: preprocessing -------------------------------------------
    t = time.time()
    progress.update("preprocess", 0.0, "Loading scene")
    config = load_export(Path(job.scene_dir), require_access_points=False)
    if not config.get("rooms"):
        raise JobError("The scene export has no room data; export the scene again")
    elevation = {f["id"]: f["elevationM"] for f in config["floors"]}
    selected_floors = job.floor_ids or [f["id"] for f in config["floors"] if f.get("radioMapPlane")]
    unknown = [c["id"] for c in job.candidates if c["floorId"] not in elevation]
    if unknown:
        raise JobError(f"Candidates on unknown floors: {unknown[:3]}")
    candidates = [c for c in job.candidates if c["floorId"] in selected_floors]
    if not candidates:
        raise JobError("No candidates on the selected floors")

    backend = select_backend(job.device, job.cpu_threads)
    import drjit as dr
    import mitsuba as mi
    import sionna.rt as rt

    scene = rt.load_scene(str(Path(job.scene_dir) / "scene.xml"), merge_shapes=False)
    apply_materials(scene, config)
    scene.tx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")
    scene.rx_array = rt.PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")
    version_info = model_info()
    cache = RowCache(job.cache_dir, job.cache_max_mb, version_info["modelVersion"], job.refresh_cache)
    sim = Simulator(scene, config, job, cache, rt, dr)

    grids = build_grids(config, job.resolution_m, selected_floors, job.receiver_height_m)
    if not grids:
        raise JobError("No floors with a receiver plane")
    targets = classify(config, grids, job.threshold_dbm, job.room_overrides, job.include_common_area)
    if targets.weight.sum() <= 0:
        raise JobError("The coverage target contains no area (all rooms excluded?)")
    if targets.n > 1_000_000:
        raise JobError(f"{targets.n} receiver cells is too many; raise resolution_m")

    profile = job.profile
    eirp = float(profile["txPowerDbm"]) + float(profile["gainDbi"])
    freq = float(profile["freqMHz"])
    cand_tx = [
        {"position": _scene_position(c["x"], c["z"], elevation[c["floorId"]], c["heightM"]), "eirpDbm": eirp}
        for c in candidates
    ]

    # existing APs in this band (their own settings), grouped by frequency
    originals = [
        ap for ap in config["accessPoints"]
        if ap["floorId"] in elevation and band_of(float(ap["frequencyMHz"])) == job.band
    ]
    ignored_other_band = [
        ap["name"] for ap in config["accessPoints"]
        if band_of(float(ap["frequencyMHz"])) != job.band
    ]
    timings["preprocess"] = time.time() - t
    peak_rss = max(peak_rss, process.memory_info().rss / 1e6)

    # ---- existing APs (before configuration) ------------------------------
    t = time.time()
    n = targets.n
    orig_rows = np.full((len(originals), n), FLOOR_DBM, dtype=np.float16)
    by_freq: dict[float, list[int]] = defaultdict(list)
    for i, ap in enumerate(originals):
        by_freq[float(ap["frequencyMHz"])].append(i)
    for f, idx in by_freq.items():
        txs = [{"position": list(originals[i]["position"]),
                "eirpDbm": float(originals[i]["txPowerDbm"]) + float(originals[i].get("antennaGainDbi") or 0)}
               for i in idx]
        orig_rows[idx] = sim.rows(
            txs, grids, job.samples_per_tx, job.max_depth, f,
            on_batch=lambda d, tot: progress.update("existing", 0.05 + 0.05 * d / max(tot, 1),
                                                    f"Existing APs {d}/{tot}"),
        )
    timings["existingAps"] = time.time() - t

    # ---- Stage B: screening with coarse ray tracing -----------------------
    t = time.time()
    coarse_res = max(job.screening_resolution_m, job.resolution_m)
    coarse_grids = build_grids(config, coarse_res, selected_floors, job.receiver_height_m)
    coarse_targets = classify(config, coarse_grids, job.threshold_dbm, job.room_overrides, job.include_common_area)
    pool = list(range(len(candidates)))
    pool_tx = list(cand_tx)
    # "reuse": the APs that are not locked take part as candidates at their own
    # position (their own power), next to every free mounting position
    reuse = job.existing_handling == "reuse"
    locked_ids = set(job.locked_ap_ids)
    free_aps = [ap for ap in originals if not (reuse and ap["id"] in locked_ids)] if reuse else []
    existing_cands = []
    for ap in free_aps:
        existing_cands.append({
            "id": f"existing:{ap['id']}", "floorId": ap["floorId"], "kind": "existing",
            "x": ap["planPosition"]["x"], "z": ap["planPosition"]["z"],
            "heightM": ap["planPosition"]["heightAboveFloorM"],
            "roomId": None, "roomName": "", "existingId": ap["id"],
        })
    candidates = candidates + existing_cands
    cand_tx += [
        {"position": _scene_position(c["x"], c["z"], elevation[c["floorId"]], c["heightM"]),
         "eirpDbm": float(ap["txPowerDbm"]) + float(ap.get("antennaGainDbi") or 0)}
        for c, ap in zip(existing_cands, free_aps)
    ]
    k_all = len(candidates)
    shortlist = list(range(k_all))
    screening_info = {"performed": False}
    # which existing APs stay as they are (their coverage is the starting point)
    if job.existing_handling == "fixed":
        base_idx = list(range(len(originals)))
    elif reuse:
        base_idx = [i for i, ap in enumerate(originals) if ap["id"] in locked_ids]
    else:
        base_idx = []
    # the limit on new APs applies in every mode ("fewest APs for a target" stops at it too)
    budget, min_count = job.budget, 0
    if reuse:
        # without "allow new", the chosen APs can never outnumber the unlocked ones
        extra = (job.budget or 0) if job.allow_new_aps else 0
        budget = len(free_aps) + extra if (not job.allow_new_aps or job.budget is not None) else None
        min_count = min(len([a for a in free_aps if a["id"] in set(job.keep_ap_ids)]), budget if budget is not None else 10**6)
    all_positions = np.array([[c["x"], c["z"], elevation[c["floorId"]] + c["heightM"]] for c in candidates], dtype=float)
    prefer_all = np.array([c["kind"] == "existing" for c in candidates], dtype=bool)
    warm_fine: list[int] = []
    coarse_sel = None
    engine_notes: list[str] = []
    estimate: dict = {}
    if k_all > job.shortlist_max:
        # ---- coarse ray tracing of EVERY position (cached), and a first search over all of them ----------------
        coarse = sim.rows(
            cand_tx, coarse_grids, job.screening_samples, job.screening_depth, freq,
            on_batch=lambda d, tot: progress.update("screening", 0.10 + 0.35 * d / max(tot, 1),
                                                    f"Coarse ray tracing of every position {d}/{tot}"),
        )
        c_thr = coarse_targets.threshold
        c_hit = coarse >= c_thr[None, :]
        coarse_orig = np.full((len(originals), coarse_targets.n), FLOOR_DBM, np.float32)
        for f, idx in by_freq.items():
            txs = [{"position": list(originals[i]["position"]),
                    "eirpDbm": float(originals[i]["txPowerDbm"]) + float(originals[i].get("antennaGainDbi") or 0)}
                   for i in idx]
            coarse_orig[idx] = sim.rows(txs, coarse_grids, job.screening_samples, job.screening_depth, f)
        # worst first: priority from the CURRENT signal of your APs (as on the map), unless they are ignored
        coarse_current = (coarse_orig.max(axis=0) if len(originals) and job.existing_handling != "ignore"
                          else np.full(coarse_targets.n, FLOOR_DBM, np.float32))
        c_base = ((coarse_orig[base_idx] >= c_thr[None, :]).sum(axis=0).astype(np.int32) if base_idx
                  else np.zeros(coarse_targets.n, dtype=np.int32))
        c_sep = range_separation(c_hit, coarse_res ** 2, job.min_ap_separation_m)
        c_problem = Problem(
            hit=c_hit, weight=coarse_targets.weight, base_count=c_base,
            allowed=np.ones(k_all, dtype=bool), positions=all_positions, k=job.redundancy,
            min_separation_m=c_sep, prefer=prefer_all,
            priority=deficit_priority(coarse_current, c_thr),
        )
        progress.update("screening", 0.46, "Searching all positions (coarse)")
        coarse_sel, coarse_engine = apsearch.run(
            c_problem, target_pct=job.target_coverage_pct, budget=budget, min_gain_pct=job.min_ap_gain_pct,
            min_count=min_count, seed=job.seed)
        engine_notes.append(f"coarse pass over all {k_all} positions: {coarse_engine}")
        # how many APs the requirement needs, from what one AP really covers here (not a circle)
        areas = c_hit[:, coarse_targets.weight > 0].sum(axis=1) * coarse_res ** 2
        typical = float(np.median(areas[areas > 0])) if (areas > 0).any() else 0.0
        target_area = float((coarse_targets.weight > 0).sum() * coarse_res ** 2)
        estimate = {
            "typicalApCoverageM2": round(typical, 1),
            "targetAreaM2": round(target_area, 1),
            "coverageApsNeeded": len(coarse_sel.indices) + int(coarse_sel.more_needed or 0),
            "bestAchievableAllPositionsPct": round(coarse_sel.max_possible_pct, 2),
        }
        # ---- refinement: full-accuracy ray tracing where it matters -------------------------------------------
        # the chosen spots and their close alternatives, the best positions of every weak zone that is left,
        # and your existing APs; then the worst-first ranking fills the rest
        keep: list[int] = list(range(k_all - len(existing_cands), k_all)) + list(coarse_sel.indices)
        for s_i in coarse_sel.indices:
            d = np.linalg.norm(all_positions - all_positions[s_i], axis=1)
            keep += [int(j) for j in np.argsort(d)[1:9] if d[j] <= max(2 * c_sep, 6.0)]
        from scipy import ndimage

        c_counts = c_base + (c_hit[coarse_sel.indices].sum(axis=0) if coarse_sel.indices else 0)
        w_pri = coarse_targets.weight * deficit_priority(coarse_current, c_thr)
        weak_cells = (coarse_targets.weight > 0) & (c_counts < job.redundancy)
        for g in coarse_grids:
            sl = slice(g.offset, g.offset + g.cells)
            labels, count = ndimage.label(weak_cells[sl].reshape(g.ny, g.nx))
            sizes = ndimage.sum(np.ones_like(labels), labels, index=range(1, count + 1)) if count else []
            for lab in [int(i) + 1 for i in np.argsort(-np.asarray(sizes))[:16]]:
                zone = np.zeros(coarse_targets.n, dtype=bool)
                zone[sl] = (labels == lab).ravel()
                if zone.sum() < 3:
                    continue
                zs = (c_hit[:, zone] * w_pri[zone][None, :]).sum(axis=1)
                keep += [int(i) for i in np.argsort(-zs)[:4] if zs[i] > 0]
        score = (c_hit * w_pri[None, :]).sum(axis=1)
        limit = min(max(job.shortlist_max, 12 * len(coarse_sel.indices) + len(existing_cands)),
                    max(1, MAX_MATRIX_ELEMENTS // max(n, 1)))
        seen = set()
        shortlist = []
        for i in keep + [int(i) for i in np.argsort(-score)]:
            if i not in seen:
                seen.add(i)
                shortlist.append(i)
            if len(shortlist) >= limit:
                break
        position_of = {c_i: f_i for f_i, c_i in enumerate(shortlist)}
        warm_fine = [position_of[i] for i in coarse_sel.indices if i in position_of]
        screening_info = {
            "performed": True, "gridResolutionM": coarse_res, "samplesPerTx": job.screening_samples,
            "rayDepth": job.screening_depth, "candidates": k_all, "shortlisted": len(shortlist),
            "method": ("coarse Sionna RT of every position; a first search over all of them; full ray tracing of "
                       "the chosen spots, their close alternatives and the best positions of every remaining "
                       "weak zone"),
        }
    timings["screening"] = time.time() - t
    peak_rss = max(peak_rss, process.memory_info().rss / 1e6)

    # ---- Stage C: full ray tracing of the refined positions -------------------
    t = time.time()
    matrix = sim.rows(
        [cand_tx[i] for i in shortlist], grids, job.samples_per_tx, job.max_depth, freq,
        on_batch=lambda d, tot: progress.update("simulation", 0.50 + 0.40 * d / max(tot, 1),
                                                f"Full ray tracing {d}/{tot}"),
    )
    timings["simulation"] = time.time() - t
    peak_rss = max(peak_rss, process.memory_info().rss / 1e6)

    # ---- Stage D: the final search on full-accuracy coverage ------------------
    t = time.time()
    progress.update("optimize", 0.90, "Selecting access points")
    thr = targets.threshold
    hit = matrix >= thr[None, :]
    orig_hit = orig_rows >= thr[None, :] if len(originals) else np.zeros((0, n), dtype=bool)
    orig_count = orig_hit.sum(axis=0).astype(np.int32)
    base_count = orig_hit[base_idx].sum(axis=0).astype(np.int32) if base_idx else np.zeros(n, dtype=np.int32)
    base_dbm = orig_rows[base_idx].max(axis=0).astype(np.float32) if base_idx else np.full(n, FLOOR_DBM, np.float32)
    positions = all_positions[shortlist]
    # Worst first: a cell's priority grows with how far its CURRENT signal (your existing APs, as on the map) is
    # below the threshold, so APs go to the red areas before the nearly-good ones.
    current_dbm = (orig_rows.max(axis=0) if len(originals) and job.existing_handling != "ignore"
                   else np.full(n, FLOOR_DBM, np.float32))
    priority = deficit_priority(current_dbm, thr)
    # APs keep a distance that follows their range (half the radius one AP covers), never under the setting
    separation = range_separation(hit, job.resolution_m ** 2, job.min_ap_separation_m)
    problem = Problem(
        hit=hit, weight=targets.weight, base_count=base_count,
        allowed=np.ones(len(shortlist), dtype=bool), positions=positions,
        k=job.redundancy, min_separation_m=separation,
        prefer=prefer_all[shortlist],
        priority=priority,
    )
    selection, final_engine = apsearch.run(
        problem, target_pct=job.target_coverage_pct, budget=budget, min_gain_pct=job.min_ap_gain_pct,
        min_count=min_count, warm=warm_fine, seed=job.seed)
    engine_notes.append(f"final pass on full ray tracing: {final_engine}")
    if coarse_sel is not None:
        # "not achievable" is judged over ALL positions (coarse), not only the refined ones
        selection.max_possible_pct = max(selection.max_possible_pct, coarse_sel.max_possible_pct)
        if (selection.status == "infeasible" and job.target_coverage_pct is not None
                and coarse_sel.max_possible_pct >= job.target_coverage_pct - 1e-9):
            selection.status = "low-gain"
        if selection.more_needed is None and coarse_sel.more_needed is not None and selection.status == "low-gain":
            selection.more_needed, selection.more_reach_pct = coarse_sel.more_needed, coarse_sel.more_reach_pct
    final_counts = base_count + problem.hit[selection.indices].sum(axis=0) if selection.indices else base_count
    before_counts = orig_count
    timings["optimization"] = time.time() - t

    # ---- results -------------------------------------------------------------
    progress.update("output", 0.97, "Writing results")
    sel_rows = matrix[selection.indices].astype(np.float32) if selection.indices else np.full((0, n), FLOOR_DBM, np.float32)
    after_dbm = np.maximum(base_dbm, sel_rows.max(axis=0)) if len(sel_rows) else base_dbm
    before_dbm = orig_rows.max(axis=0).astype(np.float32) if len(originals) else np.full(n, FLOOR_DBM, np.float32)

    # SNR follows the strongest signal's own channel width, including retained
    # APs with different widths. It does not choose whichever AP has best SNR.
    floor20 = {"2.4": job.noise_floor_24_dbm, "5": job.noise_floor_5_dbm, "6": job.noise_floor_6_dbm}[job.band]
    original_noise = np.array([noise_floor_dbm(floor20, ap_bandwidth_mhz(ap)[0]) for ap in originals])
    candidate_noise = noise_floor_dbm(floor20, ap_bandwidth_mhz(profile)[0])
    selected_noise = np.array([
        original_noise[next(i for i, ap in enumerate(originals) if ap["id"] == candidates[shortlist[index]]["existingId"])]
        if candidates[shortlist[index]].get("existingId") else candidate_noise
        for index in selection.indices
    ])

    before_snr = strongest_snr(orig_rows, original_noise)
    after_snr = strongest_snr(
        np.concatenate([orig_rows[base_idx], sel_rows], axis=0),
        np.concatenate([original_noise[base_idx], selected_noise]),
    )

    floor_names = [g.name for g in grids]

    def stats(counts):
        by_floor = breakdown(problem, counts, targets.floor_idx, len(grids))
        room_groups = np.where(targets.room_idx >= 0, targets.room_idx, len(targets.room_ids))
        by_room = breakdown(problem, counts, room_groups, len(targets.room_ids) + 1)
        return {
            "coveragePct": problem.coverage_pct(counts),
            "perFloor": [{"floorId": grids[b["group"]].floor_id, "floor": floor_names[b["group"]],
                          "coveragePct": b["coveragePct"], "areaM2": b["areaWeight"]} for b in by_floor],
            "perRoom": [
                {"roomId": (targets.room_ids[b["group"]] if b["group"] < len(targets.room_ids) else None),
                 "room": (targets.room_names[b["group"]] if b["group"] < len(targets.room_ids) else "Common area"),
                 "coveragePct": b["coveragePct"], "areaM2": b["areaWeight"]}
                for b in by_room if b["coveragePct"] is not None
            ],
        }

    chosen = [candidates[shortlist[step["index"]]] for step in selection.steps]
    if reuse:
        actions, matched = _plan_existing(free_aps, chosen, job.keep_ap_ids)
    else:
        actions, matched = [], {}
    recommendations = []
    for rank, step in enumerate(selection.steps, 1):
        c = candidates[shortlist[step["index"]]]
        room_id = c.get("roomId")
        match = matched.get(rank - 1)
        recommendations.append({
            "action": ("keep" if match and match["action"] == "keep" else "move" if match else "new"),
            "rank": rank,
            "candidateId": c["id"],
            "kind": c["kind"],
            "floorId": c["floorId"],
            "floor": next(g.name for g in grids if g.floor_id == c["floorId"]),
            "planX": c["x"], "planZ": c["z"], "heightM": c["heightM"],
            "roomId": room_id, "room": c.get("roomName", ""),
            "wallSide": c.get("wallSide", ""),
            "existingId": match["id"] if match else None,
            "marginalCoveragePct": step["marginalPct"],
            "cumulativeCoveragePct": step["cumulativePct"],
        })

    if reuse:
        for ap in originals:
            if ap["id"] in locked_ids:
                actions.append({"id": ap["id"], "name": ap["name"], "floorId": ap["floorId"],
                                "action": "fixed", "from": _pos(ap), "to": _pos(ap)})
    counts_by_action = {a: sum(1 for x in actions if x["action"] == a) for a in ("keep", "move", "remove", "fixed")}
    new_count = sum(1 for r in recommendations if r["action"] == "new") if reuse else len(selection.indices)
    weak_zones = _weak_zones(grids, targets, final_counts, job.redundancy)
    maps = []
    for gi, g in enumerate(grids):
        sl = slice(g.offset, g.offset + g.cells)

        def grid2d(vec, fill=None):
            a = np.round(vec[sl].astype(np.float32), 1).reshape(g.ny, g.nx).astype(object)
            a[vec[sl].reshape(g.ny, g.nx) <= FLOOR_DBM] = fill
            return a.tolist()

        payload = {
            "floorId": g.floor_id, "floorName": g.name, "frequencyMHz": freq,
            "quantity": "Predicted received power (dBm), strongest AP. Physics-based estimate; not a measured RSSI.",
            "provenance": "Sionna RT (final)", "planeHeightM": g.height_m, "cellSizeM": g.cell,
            "shape": [g.ny, g.nx],
            "xCentersM": np.round(g.xs, 4).tolist(), "zCentersM": np.round(-g.ys, 4).tolist(),
            "afterDbm": grid2d(after_dbm), "beforeDbm": grid2d(before_dbm),
            "afterSnrDb": grid2d(after_snr), "beforeSnrDb": grid2d(before_snr),
            "snr": {"noiseFloor20MHzDbm": floor20,
                    "newApBandwidthMHz": ap_bandwidth_mhz(profile)[0],
                    "newApNoiseFloorDbm": candidate_noise},
            "inTarget": (targets.weight[sl] > 0).reshape(g.ny, g.nx).tolist(),
            "thresholdDbm": np.round(targets.threshold[sl], 1).reshape(g.ny, g.nx).tolist(),
        }
        name = f"opt-{g.floor_id}.json"
        (out_dir / "maps" / name).write_text(json.dumps(payload), encoding="utf-8")
        maps.append({"floorId": g.floor_id, "file": f"maps/{name}"})

    status = selection.status
    result = {
        "status": "ok",
        "mode": "optimize",
        "sceneSha256": config.get("contentSha256"),
        "settings": job.to_dict(),
        "backend": backend,
        "versions": {"sionna-rt": version("sionna-rt"), "mitsuba": mi.__version__,
                     "drjit": dr.__version__, "python": platform.python_version()},
        "outcome": {
            "status": status,
            "targetCoveragePct": job.target_coverage_pct,
            "achievedCoveragePct": selection.coverage_pct,
            "targetAchieved": status == "target-met",
            "bestAchievableWithCandidatesPct": selection.max_possible_pct,
            "newApCount": new_count,
            "existingApCount": len(originals),
            "keptApCount": counts_by_action["keep"],
            "movedApCount": counts_by_action["move"],
            "removedApCount": counts_by_action["remove"],
            "fixedApCount": counts_by_action["fixed"],
            "finalApCount": (counts_by_action["keep"] + counts_by_action["move"] + counts_by_action["fixed"]
                             + new_count) if reuse else (
                (len(originals) if job.existing_handling == "fixed" else 0) + new_count),
            "message": _message(job, selection, len(originals), counts_by_action, new_count, before_counts, problem)
            + ("" if selection.status == "target-met" else _estimate_note(job, estimate, budget))
            + (f" Note: {job.threshold_dbm} dBm is a strict signal requirement and needs many more APs than the "
               "usual -67 dBm for data (-65 dBm for voice)." if job.threshold_dbm > -60 else "")
            + _comparison_note(problem.coverage_pct(before_counts), selection_pct := problem.coverage_pct(final_counts),
                               len(originals), ignored_other_band),
            "beforeCoveragePct": problem.coverage_pct(before_counts),
            "afterCoveragePct": selection_pct,
            "worseThanExisting": bool(len(originals)) and selection_pct < problem.coverage_pct(before_counts) - 0.05,
        },
        "before": stats(before_counts),
        "after": stats(final_counts),
        "recommendations": recommendations,
        "weakZones": weak_zones,
        "maps": maps,
        "candidates": {
            "supplied": len(job.candidates), "existingAddedAsCandidates": len(existing_cands),
            "shortlisted": len(shortlist), "screening": screening_info,
        },
        # how the layout was chosen and what the requirement needs on this floor
        "search": {"engine": engine_notes, "estimate": estimate},
        "existingAps": [{"id": ap["id"], "name": ap["name"], "floorId": ap["floorId"]} for ap in originals],
        "existingActions": actions,
        "ignoredOtherBandAps": ignored_other_band,
        "provenance": {
            "screening": "coarse ray tracing; approximate, used only to rank candidates",
            "final": "Sionna RT at the requested resolution and ray settings",
            "optimizer": "greedy weighted set cover + swap refinement + pruning (heuristic, not a proven minimum)",
        },
        "cache": {"rowHits": cache.hits, "rowMisses": cache.misses,
                  "refreshed": job.refresh_cache, "oldVersionFoldersRemoved": cache.removed_old_versions},
        "model": version_info,
        "timingsSeconds": {k: round(v, 2) for k, v in timings.items()},
        "resources": {
            "wallSeconds": round(time.time() - started, 2),
            "rayTracingSeconds": round(sim.rt_seconds, 2),
            "peakProcessRssMb": round(max(peak_rss, process.memory_info().rss / 1e6), 1),
            "gpuMemoryUsedMbAfter": _gpu_memory_mb() if backend["device"] == "gpu" else None,
            "matrixShape": [len(shortlist), n],
        },
        "assumptions": [
            "Coverage means at least " + str(job.redundancy) + " AP(s) reach the threshold at the receiver height; powers of different APs are never added.",
            "Worst areas first: an area counts more the further its current signal is below the threshold (red before "
            "yellow); areas already at the threshold count for nothing, so no AP is added only to make good areas better.",
            f"New APs keep at least {separation:.1f} m apart (half the range one AP covers, never under "
            f"{job.min_ap_separation_m} m), so they cannot pile up in one spot.",
            "Isotropic radiation with the AP's antenna gain added as EIRP; no antenna pattern, fading, people or unmodelled furniture.",
            "ITU-R P.2040 materials with assumed thicknesses; uncalibrated, so treat results as estimates.",
            "Candidates are simulated independently; co-channel interference and channel reuse are not modelled.",
            "Monte-Carlo ray tracing: cells within about 1-2 dB of the threshold can change with the seed or sample count.",
        ],
        "exportWarnings": config.get("warnings", []),
        "materialOverrides": sim.material_report,
    }
    (out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    cache.evict()
    progress.update("done", 1.0, "Done")
    return result


def _pos(ap: dict) -> dict:
    return {"x": ap["planPosition"]["x"], "z": ap["planPosition"]["z"],
            "heightM": ap["planPosition"]["heightAboveFloorM"]}


def _plan_existing(free_aps: list[dict], chosen: list[dict], keep_ids: list[str]):
    """Which existing AP ends up where. The chosen positions are matched to the
    unlocked APs by distance (APs to keep first), so an AP whose own position
    was chosen stays, another takes the nearest chosen spot (moved), an AP with
    no spot is removed, and a spot nobody takes is a new AP."""
    from scipy.optimize import linear_sum_assignment

    big = 1e6
    keep_ids = set(keep_ids)
    matched: dict[int, dict] = {}
    done: dict[str, int] = {}

    def run(aps: list[dict], spots: list[int]):
        if not aps or not spots:
            return
        cost = np.array([[
            big if ap["floorId"] != chosen[j]["floorId"] else
            float(np.hypot(ap["planPosition"]["x"] - chosen[j]["x"], ap["planPosition"]["z"] - chosen[j]["z"]))
            for j in spots] for ap in aps])
        for r, c in zip(*linear_sum_assignment(cost)):
            if cost[r, c] >= big:
                continue
            done[aps[r]["id"]] = spots[c]
            matched[spots[c]] = {"id": aps[r]["id"],
                                 "action": "keep" if cost[r, c] < 0.05 else "move"}

    everything = list(range(len(chosen)))
    run([a for a in free_aps if a["id"] in keep_ids], everything)
    run([a for a in free_aps if a["id"] not in done],
        [j for j in everything if j not in matched])
    actions = []
    for ap in free_aps:
        j = done.get(ap["id"])
        if j is None:
            actions.append({"id": ap["id"], "name": ap["name"], "floorId": ap["floorId"],
                            "action": "remove", "from": _pos(ap), "to": None})
        else:
            c = chosen[j]
            actions.append({
                "id": ap["id"], "name": ap["name"], "floorId": ap["floorId"],
                "action": matched[j]["action"], "from": _pos(ap),
                "to": {"x": c["x"], "z": c["z"], "heightM": c["heightM"], "floorId": c["floorId"],
                       "room": c.get("roomName", ""), "mounting": c.get("kind", "")},
            })
    return actions, matched


def _message(job: OptimizeJob, sel, n_existing: int, acts=None, new=None, before_counts=None, problem=None) -> str:
    new = len(sel.indices) if new is None else new
    if job.existing_handling == "reuse":
        a = acts or {}
        head = (f"Of your {n_existing} AP(s): keep {a.get('keep', 0)}, move {a.get('move', 0)}, "
                f"remove {a.get('remove', 0)}, {a.get('fixed', 0)} locked; add {new}. "
                f"Coverage {problem.coverage_pct(before_counts):.1f}% → {sel.coverage_pct:.1f}%")
        if sel.status == "target-met":
            return f"{head} (target {job.target_coverage_pct}% reached)."
        if sel.status == "infeasible":
            return (f"{head}. The target {job.target_coverage_pct}% cannot be reached with the available "
                    f"positions; the best achievable is {sel.max_possible_pct:.1f}%.")
        tail = "" if job.allow_new_aps else " Allow new APs to get further."
        return f"{head}; the target {job.target_coverage_pct}% is not reached.{tail}"
    if sel.status == "target-met":
        return f"{new} new AP(s) reach {sel.coverage_pct:.1f}% predicted coverage (target {job.target_coverage_pct}%)."
    if sel.status == "infeasible":
        return (f"The target {job.target_coverage_pct}% cannot be reached with the available candidate positions; "
                f"the best achievable is {sel.max_possible_pct:.1f}%. Add candidates (other mounting types, "
                "relax exclusions) or lower the threshold or target.")
    if sel.status == "budget-exhausted":
        if job.target_coverage_pct is None:
            return f"Your limit of {job.budget} new AP(s), placed worst areas first, gives {sel.coverage_pct:.1f}% coverage."
        return (f"Your limit of {job.budget} new AP(s) gives {sel.coverage_pct:.1f}%: not enough for the target "
                f"{job.target_coverage_pct}%. Allow more APs to reach it.")
    if sel.status == "low-gain":
        head = (f"{new} new AP(s) give {sel.coverage_pct:.1f}%; another AP would add under {job.min_ap_gain_pct:g}% "
                f"coverage, so none was added")
        if job.budget is not None and job.budget > new:
            head += f" ({job.budget - new} of your {job.budget} allowed were not needed)"
        if job.target_coverage_pct is not None and sel.coverage_pct < job.target_coverage_pct - 1e-9 and sel.more_needed:
            head += (f". Reaching the target {job.target_coverage_pct}% would take {sel.more_needed} more AP(s), each "
                     f"adding under {job.min_ap_gain_pct:g}% (about {sel.more_reach_pct:.1f}% in total)")
        return head + "."
    return (f"No further candidate improves coverage; {new} new AP(s) give {sel.coverage_pct:.1f}%. "
            f"The best achievable with these candidates is {sel.max_possible_pct:.1f}%.")


def _estimate_note(job: OptimizeJob, estimate: dict, budget) -> str:
    """What the requirement needs on this floor, from what one AP really covers here."""
    need = estimate.get("coverageApsNeeded")
    if not need:
        return ""
    note = (f" Reaching it needs about {need} AP(s) on this floor (one AP covers about "
            f"{estimate['typicalApCoverageM2']:.0f} m² at {job.threshold_dbm} dBm here")
    if budget is not None and need > budget:
        note += f"; your limit is {budget}"
    return note + ")."


def _comparison_note(before_pct: float, after_pct: float, n_existing: int, ignored_other_band) -> str:
    """Always say how the result compares with the project's existing APs."""
    if ignored_other_band:
        return (f" WARNING: {len(ignored_other_band)} existing AP(s) are on another band and were not counted, "
                "so this cannot be compared with your prediction. Pick the same band.")
    if not n_existing:
        return ""
    if after_pct < before_pct - 0.05:
        return (f" WARNING: this layout covers {after_pct:.1f}%, less than your existing APs "
                f"({before_pct:.1f}%). Do not apply it; keep the existing APs or allow more new APs.")
    return f" Existing APs: {before_pct:.1f}% → optimised: {after_pct:.1f}%."


def _weak_zones(grids: list[FloorGrid], targets: Targets, counts: np.ndarray, k: int, top: int = 8):
    from scipy import ndimage

    zones = []
    for g in grids:
        sl = slice(g.offset, g.offset + g.cells)
        weak = ((targets.weight[sl] > 0) & (counts[sl] < k)).reshape(g.ny, g.nx)
        labels, count = ndimage.label(weak)
        for lab in range(1, count + 1):
            ys, xs = np.nonzero(labels == lab)
            area = len(xs) * g.cell ** 2
            zones.append({
                "floorId": g.floor_id, "floor": g.name, "areaM2": round(area, 2), "cells": int(len(xs)),
                "centroid": {"x": round(float(g.xs[xs].mean()), 2), "z": round(float(-g.ys[ys].mean()), 2)},
                "bbox": {"minX": round(float(g.xs[xs].min() - g.cell / 2), 2),
                         "maxX": round(float(g.xs[xs].max() + g.cell / 2), 2),
                         "minZ": round(float(-g.ys[ys].max() - g.cell / 2), 2),
                         "maxZ": round(float(-g.ys[ys].min() + g.cell / 2), 2)},
            })
    zones.sort(key=lambda z: -z["areaM2"])
    return zones[:top]
