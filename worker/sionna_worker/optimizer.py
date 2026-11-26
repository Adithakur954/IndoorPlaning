"""AP placement optimizer: weighted maximum-coverage / set-cover on a cached
candidate-coverage matrix. Pure NumPy; no ray tracing happens here.

A receiver cell is covered when at least `k` distinct APs reach the cell's
threshold. Power from different APs is never added: only whether each AP on
its own reaches the threshold matters (strongest-AP coverage planning).

Worst first: each cell also has a `priority` (how far its CURRENT signal is below the threshold). Choices are made
on area x priority, so a new AP goes where it turns red into green before it turns nearly-good into good; a cell
already at the threshold is worth nothing, so no AP is added only to make good areas better. The coverage % that
is reported (and the target) is still plain area.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Problem:
    hit: np.ndarray            # (K, N) bool: candidate k reaches the cell's threshold
    weight: np.ndarray         # (N,) float: represented area x room weight (0 = not a target)
    base_count: np.ndarray     # (N,) int: fixed APs that already reach the threshold
    allowed: np.ndarray        # (K,) bool: candidate may be selected
    positions: np.ndarray      # (K, 3) metres, for the minimum-separation rule
    k: int = 1                 # distinct APs required per cell
    min_separation_m: float = 0.0
    # candidates that win a tie (an existing AP's own position): keeping an AP
    # where it is beats moving it for the same coverage
    prefer: np.ndarray | None = None
    # (N,) >= 1: how much fixing this cell matters (worse current signal = higher); None = all equal
    priority: np.ndarray | None = None

    def __post_init__(self):
        self.hit_f = self.hit.astype(np.float32)
        self.total_weight = float(self.weight.sum())
        pr = np.ones_like(self.weight) if self.priority is None else np.asarray(self.priority, dtype=float)
        self.value = (self.weight * pr).astype(np.float64)   # what the choices maximise
        if self.total_weight <= 0:
            raise ValueError("The coverage target has no area")
        diff = self.positions[:, None, :] - self.positions[None, :, :]
        self.distance = np.sqrt((diff ** 2).sum(-1))

    def coverage_pct(self, counts: np.ndarray) -> float:
        return 100.0 * float(self.weight[counts >= self.k].sum()) / self.total_weight


@dataclass
class Selection:
    indices: list[int]
    status: str                # target-met | budget-exhausted | no-gain | infeasible
    coverage_pct: float
    baseline_pct: float
    max_possible_pct: float
    steps: list[dict] = field(default_factory=list)   # per added AP, in order
    # stopped because the next AP would add less than the minimum useful gain: how many more APs (each under it)
    # the target would still need, and the coverage they would reach (None when not computed)
    more_needed: int | None = None
    more_reach_pct: float | None = None


def _counts(problem: Problem, indices: list[int]) -> np.ndarray:
    counts = problem.base_count.copy()
    for i in indices:
        counts += problem.hit[i]
    return counts


def _blocked(problem: Problem, selected: list[int]) -> np.ndarray:
    """Candidates that may not be chosen next (too close to a chosen AP)."""
    if not selected or problem.min_separation_m <= 0:
        return np.zeros(len(problem.allowed), dtype=bool)
    return (problem.distance[selected] < problem.min_separation_m).any(axis=0)


def _gains(problem: Problem, counts: np.ndarray) -> np.ndarray:
    # Cells closer to being completed count more; with k = 1 this is plain
    # newly-covered area.
    need = (counts < problem.k).astype(np.float32)
    progress = need * (1.0 + counts.astype(np.float32))
    gains = problem.hit_f @ (problem.value * progress).astype(np.float32)
    return _favour(problem, gains)


def _favour(problem: Problem, scores: np.ndarray) -> np.ndarray:
    if problem.prefer is None:
        return scores
    return np.where(problem.prefer, scores * 1.001 + 1e-6, scores)


def select(
    problem: Problem,
    target_pct: float | None,
    budget: int | None = None,
    min_gain_pct: float = 0.05,
    swap_passes: int = 3,
    min_count: int = 0,
) -> Selection:
    """Greedy selection, then swap refinement, then removal of redundant APs.

    target_pct=None maximises coverage for the budget; otherwise it stops at the
    smallest count the heuristic finds that reaches the target. The result is a
    good heuristic answer, not a proven minimum. `min_count` APs are always
    chosen (APs the user wants to keep somewhere, even if the target is met).
    """
    baseline = problem.coverage_pct(problem.base_count)
    all_allowed = np.flatnonzero(problem.allowed)
    max_counts = problem.base_count + problem.hit[all_allowed].sum(axis=0)
    max_possible = problem.coverage_pct(max_counts)

    selected: list[int] = []
    counts = problem.base_count.copy()
    min_gain = min_gain_pct / 100.0 * problem.total_weight   # (value >= weight: still at least this much area)
    status = "no-gain"
    while True:
        coverage = problem.coverage_pct(counts)
        forced = len(selected) < min_count
        if not forced and target_pct is not None and coverage >= target_pct - 1e-9:
            status = "target-met"
            break
        if budget is not None and len(selected) >= budget:
            status = "budget-exhausted"
            break
        gains = _gains(problem, counts)
        gains[~problem.allowed] = -1
        gains[selected] = -1
        gains[_blocked(problem, selected)] = -1
        best = int(np.argmax(gains))
        if gains[best] <= (-0.5 if forced else min_gain):
            status = "no-gain" if gains[best] <= 1e-9 * problem.total_weight else "low-gain"
            break
        selected.append(best)
        counts = counts + problem.hit[best]

    selected = _swap_refine(problem, selected, swap_passes)
    if target_pct is not None:
        selected = _prune(problem, selected, target_pct, min_count)
    counts = _counts(problem, selected)
    coverage = problem.coverage_pct(counts)
    if target_pct is not None and coverage >= target_pct - 1e-9:
        status = "target-met"
    elif target_pct is not None and max_possible < target_pct - 1e-9:
        status = "infeasible"
    elif status == "target-met":
        status = "no-gain"
    more_needed = more_reach = None
    if status == "low-gain" and target_pct is not None:
        # how far the target is: keep adding (without the minimum gain) and count, so the user can decide
        extra, counts_x, chosen = 0, counts.copy(), list(selected)
        while problem.coverage_pct(counts_x) < target_pct - 1e-9 and extra < 200:
            if budget is not None and len(chosen) >= budget:
                break
            g = _gains(problem, counts_x)
            g[~problem.allowed] = -1
            g[chosen] = -1
            g[_blocked(problem, chosen)] = -1
            b = int(np.argmax(g))
            if g[b] <= 1e-9:
                break
            chosen.append(b)
            counts_x = counts_x + problem.hit[b]
            extra += 1
        more_needed, more_reach = extra, problem.coverage_pct(counts_x)
    return Selection(
        indices=selected,
        status=status,
        coverage_pct=coverage,
        baseline_pct=baseline,
        max_possible_pct=max_possible,
        steps=_marginal_steps(problem, selected),
        more_needed=more_needed,
        more_reach_pct=more_reach,
    )


def _swap_refine(problem: Problem, selected: list[int], passes: int) -> list[int]:
    selected = list(selected)
    for _ in range(passes):
        improved = False
        for pos in range(len(selected)):
            without = selected[:pos] + selected[pos + 1:]
            counts_wo = _counts(problem, without)
            base_cov = problem.value[counts_wo >= problem.k].sum()
            # cells that exactly one more AP would complete
            one_short = (counts_wo == problem.k - 1) * problem.value
            new_cov = base_cov + problem.hit_f @ one_short.astype(np.float32)
            new_cov[~problem.allowed] = -1
            new_cov[without] = -1
            new_cov[_blocked(problem, without)] = -1
            real = new_cov
            best = int(np.argmax(np.where(real > 0, _favour(problem, real), real)))
            current = problem.value[_counts(problem, selected) >= problem.k].sum()
            snaps_back = (
                problem.prefer is not None and problem.prefer[best]
                and not problem.prefer[selected[pos]] and real[best] >= current - 1e-9
            )
            if best != selected[pos] and (real[best] > current + 1e-9 or snaps_back):
                selected[pos] = best
                improved = True
        if not improved:
            break
    return selected


def _prune(problem: Problem, selected: list[int], target_pct: float, min_count: int = 0) -> list[int]:
    """Drop any AP whose removal keeps the target met (weakest first)."""
    selected = list(selected)
    changed = True
    while changed and len(selected) > min_count:
        changed = False
        # contribution = coverage lost without it
        losses = []
        for pos in range(len(selected)):
            without = selected[:pos] + selected[pos + 1:]
            losses.append(problem.coverage_pct(_counts(problem, without)))
        order = np.argsort(losses)[::-1]  # highest remaining coverage first
        for pos in order:
            if losses[pos] >= target_pct - 1e-9:
                selected.pop(int(pos))
                changed = True
                break
    return selected


def _marginal_steps(problem: Problem, selected: list[int]) -> list[dict]:
    """Order the chosen APs by marginal gain (best first) and report each."""
    remaining = list(selected)
    counts = problem.base_count.copy()
    previous = problem.coverage_pct(counts)
    steps = []
    while remaining:
        scores = [
            problem.coverage_pct(counts + problem.hit[i]) for i in remaining
        ]
        pick = int(np.argmax(scores))
        index = remaining.pop(pick)
        counts = counts + problem.hit[index]
        coverage = problem.coverage_pct(counts)
        steps.append({
            "index": index,
            "marginalPct": coverage - previous,
            "cumulativePct": coverage,
        })
        previous = coverage
    return steps


def deficit_priority(current_dbm: np.ndarray, threshold_dbm: np.ndarray, span_db: float = 10.0,
                     cap_db: float = 30.0) -> np.ndarray:
    """Priority of each cell from how far its current signal is below the threshold: 1 at the threshold, +1 per
    `span_db` below it (a red -95 dBm cell against -75 dBm counts 3x a cell just short of it), capped."""
    deficit = np.clip(np.asarray(threshold_dbm, float) - np.asarray(current_dbm, float), 0.0, cap_db)
    return 1.0 + deficit / span_db


def range_separation(hit: np.ndarray, cell_area_m2: float, floor_m: float, share: float = 0.5) -> float:
    """Minimum distance between chosen APs from what one AP covers: `share` x the radius of the median candidate's
    coverage area (an AP that reaches 30 m keeps the next one ~15 m away, so they cannot pile up in one spot), never
    below the user's `floor_m`."""
    if hit.size == 0:
        return floor_m
    areas = hit.sum(axis=1) * cell_area_m2
    radius = float(np.sqrt(np.median(areas) / np.pi)) if len(areas) else 0.0
    return max(floor_m, share * radius)


def breakdown(problem: Problem, counts: np.ndarray, groups: np.ndarray, n_groups: int) -> list[dict]:
    """Coverage % per group (floor or room index) from the final counts."""
    out = []
    covered = (counts >= problem.k) & (problem.weight > 0)
    for g in range(n_groups):
        in_group = (groups == g) & (problem.weight > 0)
        total = float(problem.weight[in_group].sum())
        out.append({
            "group": g,
            "areaWeight": total,
            "coveragePct": None if total <= 0 else
            100.0 * float(problem.weight[in_group & covered].sum()) / total,
        })
    return out
