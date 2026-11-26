import unittest

import numpy as np

from sionna_worker.optimizer import Problem, breakdown, deficit_priority, range_separation, select


def problem(sets, n, weight=None, base=None, allowed=None, k=1, positions=None, min_sep=0.0):
    hit = np.zeros((len(sets), n), dtype=bool)
    for i, cells in enumerate(sets):
        hit[i, list(cells)] = True
    return Problem(
        hit=hit,
        weight=np.ones(n) if weight is None else np.asarray(weight, dtype=float),
        base_count=np.zeros(n, dtype=int) if base is None else np.asarray(base, dtype=int),
        allowed=np.ones(len(sets), dtype=bool) if allowed is None else np.asarray(allowed),
        positions=np.array(positions, dtype=float) if positions is not None
        else np.array([[i * 10.0, 0, 3] for i in range(len(sets))]),
        k=k,
        min_separation_m=min_sep,
    )


class CoverageTest(unittest.TestCase):
    def test_area_weighted_coverage(self):
        p = problem([[0]], 4, weight=[3, 1, 1, 1])
        self.assertAlmostEqual(p.coverage_pct(np.array([1, 0, 0, 0])), 50.0)
        self.assertAlmostEqual(p.coverage_pct(np.array([0, 1, 1, 1])), 50.0)

    def test_zero_weight_cells_are_not_targets(self):
        p = problem([[0, 1]], 3, weight=[1, 1, 0])
        self.assertAlmostEqual(p.coverage_pct(np.array([1, 1, 0])), 100.0)


class SelectionTest(unittest.TestCase):
    def test_reaches_target_with_few_aps_and_reports_marginals(self):
        # two APs cover everything; the third set is a decoy
        p = problem([[0, 1, 2, 3], [4, 5, 6, 7], [2, 3, 4, 5]], 8)
        s = select(p, target_pct=100)
        self.assertEqual(s.status, "target-met")
        self.assertEqual(sorted(s.indices), [0, 1])
        self.assertAlmostEqual(s.coverage_pct, 100.0)
        self.assertAlmostEqual(sum(x["marginalPct"] for x in s.steps), 100.0)
        self.assertAlmostEqual(s.steps[-1]["cumulativePct"], 100.0)

    def test_swap_refinement_escapes_the_greedy_trap(self):
        # decoy first: greedy picks it, a swap fixes it within budget 2
        p = problem([[2, 3, 4, 5], [0, 1, 2, 3], [4, 5, 6, 7]], 8)
        s = select(p, target_pct=None, budget=2)
        self.assertAlmostEqual(s.coverage_pct, 100.0)
        self.assertEqual(sorted(s.indices), [1, 2])

    def test_budget_exhausted_reports_best_coverage(self):
        p = problem([[0, 1], [2, 3], [4, 5], [6, 7]], 8)
        s = select(p, target_pct=100, budget=2)
        self.assertEqual(s.status, "budget-exhausted")
        self.assertAlmostEqual(s.coverage_pct, 50.0)

    def test_infeasible_when_candidates_cannot_reach_the_target(self):
        p = problem([[0, 1], [2, 3]], 6)  # cells 4,5 are unreachable
        s = select(p, target_pct=100)
        self.assertEqual(s.status, "infeasible")
        self.assertLess(s.coverage_pct, 100.0)
        self.assertAlmostEqual(s.max_possible_pct, 4 / 6 * 100)

    def test_fixed_aps_count_and_reduce_what_is_needed(self):
        base = [1, 1, 1, 1, 0, 0, 0, 0]  # a fixed AP already covers the left half
        p = problem([[0, 1, 2, 3], [4, 5, 6, 7]], 8, base=base)
        s = select(p, target_pct=100)
        self.assertEqual(s.indices, [1])
        self.assertAlmostEqual(s.baseline_pct, 50.0)

    def test_pruning_removes_a_redundant_ap(self):
        p = problem([[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7]], 8)
        s = select(p, target_pct=100)
        self.assertEqual(s.indices, [2])

    def test_target_below_one_hundred_stops_early(self):
        p = problem([[0, 1, 2, 3, 4, 5, 6, 7, 8], [9]], 10)
        s = select(p, target_pct=90)
        self.assertEqual(s.indices, [0])
        self.assertEqual(s.status, "target-met")

    def test_disallowed_candidates_are_never_chosen(self):
        p = problem([[0, 1, 2, 3], [0, 1]], 4, allowed=[False, True])
        s = select(p, target_pct=100)
        self.assertEqual(s.indices, [1])
        self.assertEqual(s.status, "infeasible")

    def test_minimum_separation_between_chosen_aps(self):
        pos = [[0, 0, 3], [1, 0, 3], [20, 0, 3]]
        p = problem([[0, 1, 2], [2, 3], [3, 4, 5]], 6, positions=pos, min_sep=5.0)
        s = select(p, target_pct=100)
        chosen = sorted(s.indices)
        self.assertFalse({0, 1} <= set(chosen), "APs 0 and 1 are 1 m apart")

    def test_redundancy_needs_distinct_aps(self):
        p = problem([[0, 1], [0, 1], [2, 3], [2, 3]], 4, k=2)
        s = select(p, target_pct=100)
        self.assertEqual(sorted(s.indices), [0, 1, 2, 3])
        p1 = problem([[0, 1], [0, 1]], 2, k=2)
        self.assertEqual(select(p1, target_pct=100).status, "target-met")
        p2 = problem([[0, 1]], 2, k=2)
        self.assertEqual(select(p2, target_pct=100).status, "infeasible")

    def test_empty_target_is_rejected(self):
        with self.assertRaises(ValueError):
            problem([[0]], 2, weight=[0, 0])


class BreakdownTest(unittest.TestCase):
    def test_per_group_coverage(self):
        p = problem([[0, 1]], 4)
        counts = np.array([1, 1, 0, 0])
        groups = np.array([0, 0, 1, 1])
        out = breakdown(p, counts, groups, 2)
        self.assertAlmostEqual(out[0]["coveragePct"], 100.0)
        self.assertAlmostEqual(out[1]["coveragePct"], 0.0)



class WorstFirstTest(unittest.TestCase):
    def test_red_area_is_fixed_before_a_nearly_good_one(self):
        # AP 0 covers 5 cells that are just short of the threshold (-76 dBm); AP 1 covers 4 red cells (-95 dBm).
        # By plain area AP 0 wins; worst first, with one AP allowed, the red area is fixed.
        current = np.array([-76.0] * 5 + [-95.0] * 4)
        p = Problem(hit=np.array([[1] * 5 + [0] * 4, [0] * 5 + [1] * 4], dtype=bool), weight=np.ones(9),
                    base_count=np.zeros(9, dtype=int), allowed=np.ones(2, dtype=bool),
                    positions=np.array([[0, 0, 3], [50, 0, 3]], dtype=float),
                    priority=deficit_priority(current, np.full(9, -75.0)))
        s = select(p, target_pct=None, budget=1)
        self.assertEqual(s.indices, [1])

    def test_good_areas_are_worth_nothing(self):
        # cells 0-3 are already covered by a fixed AP: an AP that only adds signal there is never chosen
        p = problem([[0, 1, 2, 3], [4]], 5, base=[1, 1, 1, 1, 0])
        s = select(p, target_pct=100)
        self.assertEqual(s.indices, [1])

    def test_the_ap_limit_holds_when_aiming_for_a_target(self):
        p = problem([[0], [1], [2], [3]], 4)
        s = select(p, target_pct=100, budget=2)
        self.assertEqual(len(s.indices), 2)
        self.assertEqual(s.status, "budget-exhausted")

    def test_spacing_follows_the_range(self):
        # each candidate covers 314 cells of 1 m2: radius 10 m, so APs keep 5 m apart (more than the 3 m setting)
        hit = np.zeros((3, 400), dtype=bool)
        hit[:, :314] = True
        self.assertAlmostEqual(range_separation(hit, 1.0, 3.0), 5.0, places=1)
        self.assertEqual(range_separation(hit[:, :10], 1.0, 3.0), 3.0)


class UsefulGainTest(unittest.TestCase):
    def sets(self):
        # 200 cells: two APs cover 190 of them; ten more APs would each add one cell (0.5 %)
        return [list(range(0, 100)), list(range(100, 190))] + [[190 + i] for i in range(10)]

    def test_a_big_budget_is_a_maximum_not_a_quota(self):
        p = problem(self.sets(), 200)
        s = select(p, target_pct=None, budget=50, min_gain_pct=1.0)
        self.assertEqual(sorted(s.indices), [0, 1])
        self.assertEqual(s.status, "low-gain")

    def test_target_shortfall_is_counted_not_filled_with_crumbs(self):
        p = problem(self.sets(), 200)
        s = select(p, target_pct=100, min_gain_pct=1.0)
        self.assertEqual(sorted(s.indices), [0, 1])
        self.assertEqual(s.status, "low-gain")
        self.assertEqual(s.more_needed, 10)
        self.assertAlmostEqual(s.more_reach_pct, 100.0)


if __name__ == "__main__":
    unittest.main()
