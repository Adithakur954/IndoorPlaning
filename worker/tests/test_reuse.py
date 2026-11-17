"""Selection and AP-matching logic of the "use my existing APs" mode (no ray tracing)."""
import unittest

import numpy as np

from sionna_worker.optimize import _plan_existing
from sionna_worker.optimizer import Problem, select


def problem(hit, prefer=None, k=1):
    hit = np.array(hit, dtype=bool)
    n = hit.shape[1]
    return Problem(hit=hit, weight=np.ones(n), base_count=np.zeros(n, dtype=np.int32),
                   allowed=np.ones(len(hit), dtype=bool),
                   positions=np.array([[i * 10.0, 0, 0] for i in range(len(hit))]),
                   k=k, prefer=None if prefer is None else np.array(prefer, dtype=bool))


class SelectionTest(unittest.TestCase):
    def test_min_count_keeps_aps_even_when_target_is_met(self):
        # candidate 0 covers everything, 1 and 2 are redundant
        p = problem([[1, 1, 1, 1], [1, 1, 0, 0], [0, 0, 1, 1]])
        self.assertEqual(len(select(p, 100).indices), 1)
        self.assertEqual(len(select(p, 100, min_count=2).indices), 2)

    def test_budget_caps_the_count(self):
        p = problem([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
        sel = select(p, 100, budget=2)
        self.assertEqual(len(sel.indices), 2)
        self.assertEqual(sel.status, "budget-exhausted")

    def test_existing_position_wins_a_tie(self):
        # candidates 0 and 1 are identical; 1 is an existing AP's own position
        p = problem([[1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 1, 1]], prefer=[0, 1, 0])
        self.assertIn(1, select(p, 100).indices)
        self.assertNotIn(0, select(p, 100).indices)


class MatchingTest(unittest.TestCase):
    def ap(self, i, x, z, floor="f"):
        return {"id": i, "name": i, "floorId": floor,
                "planPosition": {"x": x, "z": z, "heightAboveFloorM": 2.5}}

    def spot(self, x, z, floor="f"):
        return {"x": x, "z": z, "heightM": 2.5, "floorId": floor, "kind": "wall"}

    def test_keep_move_remove_and_new(self):
        aps = [self.ap("a", 0, 0), self.ap("b", 10, 0), self.ap("c", 20, 0)]
        chosen = [self.spot(0, 0), self.spot(12, 3), self.spot(50, 50)]
        acts, matched = _plan_existing(aps, chosen, [])
        by = {a["id"]: a["action"] for a in acts}
        self.assertEqual(by["a"], "keep")
        self.assertEqual(by["b"], "move")
        # three spots for three APs: c moves to the far spot, nothing removed
        self.assertEqual(by["c"], "move")
        acts, matched = _plan_existing(aps, chosen[:1], [])
        self.assertEqual(sorted(a["action"] for a in acts), ["keep", "remove", "remove"])
        acts, matched = _plan_existing(aps[:1], chosen, [])
        self.assertEqual(len(matched), 1)  # two spots have no AP: those are new

    def test_aps_to_keep_are_matched_first(self):
        aps = [self.ap("a", 0, 0), self.ap("b", 10, 0)]
        chosen = [self.spot(0, 0)]
        acts, _ = _plan_existing(aps, chosen, ["b"])
        by = {a["id"]: a["action"] for a in acts}
        self.assertEqual(by["b"], "move")
        self.assertEqual(by["a"], "remove")

    def test_other_floor_is_not_a_move(self):
        acts, matched = _plan_existing([self.ap("a", 0, 0, "f1")], [self.spot(0, 0, "f2")], [])
        self.assertEqual(acts[0]["action"], "remove")
        self.assertEqual(matched, {})


if __name__ == "__main__":
    unittest.main()
