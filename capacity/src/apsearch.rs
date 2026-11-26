//! AP placement search on cached coverage (no ray tracing in here).
//!
//! The simulation worker ray-traces every candidate mounting position once and gives, per candidate, the target
//! cells where it reaches the required signal. This module picks the APs:
//!
//! 1. **Greedy maximum coverage**, worst areas first: each step adds the position that turns the most (weighted)
//!    uncovered area into covered area. A cell's weight is its area x its priority (how far its current signal is
//!    below the requirement), so red is fixed before yellow and good areas are worth nothing. A position is only
//!    added when it newly covers at least `min_gain_pct` of the REAL target area (no crumbs).
//! 2. **Simulated annealing**: relocate an AP to a nearby or random position, remove one, add one; a worse layout
//!    is accepted with a probability that falls over time, so the search escapes the greedy's local choices.
//!    Objective: covered value - (cost of each AP) - (large penalty per % short of the target). The best layout
//!    seen is kept.
//! 3. **Pruning**: an AP whose own contribution is under the minimum gain (or that the target does not need) is
//!    removed.
//!
//! Hard rules throughout: only allowed positions; chosen APs keep `min_sep` metres apart; never more than the
//! budget; at least `min_count` APs (APs the user wants to keep). Everything is seeded and deterministic.

use crate::rng::Rng;
use serde_json::{json, Value};
use std::time::Instant;

pub struct Input {
    /// per candidate: the target cells (weight > 0) it reaches
    pub cover: Vec<Vec<u32>>,
    pub weight: Vec<f64>,
    pub priority: Vec<f64>,
    /// APs that stay as they are and already reach each cell
    pub base: Vec<u32>,
    /// distinct APs a cell needs to count as covered
    pub need: u32,
    pub pos: Vec<[f64; 3]>,
    pub allowed: Vec<bool>,
    /// wins ties (an existing AP's own position)
    pub prefer: Vec<bool>,
    /// a starting layout (from an earlier, coarser search)
    pub warm: Vec<usize>,
    pub budget: Option<usize>,
    pub target_pct: Option<f64>,
    pub min_gain_pct: f64,
    pub min_sep: f64,
    pub min_count: usize,
    pub iterations: usize,
    pub time_limit_ms: u64,
    pub seed: u64,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub selected: Vec<usize>,
    pub status: &'static str,
    pub coverage_pct: f64,
    pub baseline_pct: f64,
    pub max_possible_pct: f64,
    /// (candidate, marginal %, cumulative %), best first
    pub steps: Vec<(usize, f64, f64)>,
    pub more_needed: Option<usize>,
    pub more_reach_pct: Option<f64>,
    pub iterations_run: usize,
    pub accepted: usize,
}

struct State<'a> {
    inp: &'a Input,
    value: &'a [f64],
    counts: Vec<u32>,
    sel: Vec<usize>,
    in_sel: Vec<bool>,
    val: f64,
    area: f64,
}

impl<'a> State<'a> {
    fn new(inp: &'a Input, value: &'a [f64]) -> State<'a> {
        let counts = inp.base.clone();
        let mut val = 0.0;
        let mut area = 0.0;
        for c in 0..counts.len() {
            if counts[c] >= inp.need {
                val += value[c];
                area += inp.weight[c];
            }
        }
        State { inp, value, counts, sel: Vec::new(), in_sel: vec![false; inp.cover.len()], val, area }
    }

    fn add(&mut self, i: usize) {
        let need = self.inp.need;
        for &c in &self.inp.cover[i] {
            let c = c as usize;
            self.counts[c] += 1;
            if self.counts[c] == need {
                self.val += self.value[c];
                self.area += self.inp.weight[c];
            }
        }
        self.sel.push(i);
        self.in_sel[i] = true;
    }

    fn remove(&mut self, i: usize) {
        let need = self.inp.need;
        for &c in &self.inp.cover[i] {
            let c = c as usize;
            if self.counts[c] == need {
                self.val -= self.value[c];
                self.area -= self.inp.weight[c];
            }
            self.counts[c] -= 1;
        }
        if let Some(p) = self.sel.iter().position(|&s| s == i) {
            self.sel.swap_remove(p);
        }
        self.in_sel[i] = false;
    }

    /// (progress value, real area this position would newly count as covered or bring closer to it)
    fn gain(&self, i: usize) -> (f64, f64) {
        let need = self.inp.need;
        let (mut prog, mut area) = (0.0, 0.0);
        for &c in &self.inp.cover[i] {
            let c = c as usize;
            let n = self.counts[c];
            if n < need {
                prog += self.value[c] * (1.0 + n as f64);
                // the area this AP newly covers (one AP per cell) or brings one AP closer (more per cell)
                area += self.inp.weight[c];
            }
        }
        (prog, area)
    }

    fn blocked(&self, i: usize, ignore: Option<usize>) -> bool {
        if self.inp.min_sep <= 0.0 {
            return false;
        }
        let p = self.inp.pos[i];
        self.sel.iter().any(|&s| {
            Some(s) != ignore && {
                let q = self.inp.pos[s];
                let d = ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt();
                d < self.inp.min_sep
            }
        })
    }

    fn pct(&self, total: f64) -> f64 {
        100.0 * self.area / total
    }
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

pub fn search(inp: &Input) -> Output {
    let k = inp.cover.len();
    let total_w: f64 = inp.weight.iter().sum::<f64>().max(1e-12);
    let value: Vec<f64> = inp.weight.iter().zip(&inp.priority).map(|(w, p)| w * p.max(1.0)).collect();
    let total_v: f64 = value.iter().sum::<f64>().max(1e-12);
    let min_gain_area = inp.min_gain_pct / 100.0 * total_w;
    let target_area = inp.target_pct.map(|t| t / 100.0 * total_w);
    let cap = inp.budget.unwrap_or(usize::MAX);

    // the most any layout can reach: every allowed position at once
    let max_possible = {
        let mut counts = inp.base.clone();
        for i in 0..k {
            if inp.allowed[i] {
                for &c in &inp.cover[i] {
                    counts[c as usize] += 1;
                }
            }
        }
        100.0 * counts.iter().zip(&inp.weight).filter(|(n, _)| **n >= inp.need).map(|(_, w)| w).sum::<f64>() / total_w
    };

    let mut st = State::new(inp, &value);
    let baseline = st.pct(total_w);

    // ---- 1. warm start, then greedy -----------------------------------------
    for &w in &inp.warm {
        if w < k && inp.allowed[w] && !st.in_sel[w] && st.sel.len() < cap && !st.blocked(w, None) {
            st.add(w);
        }
    }
    let stop;
    loop {
        let forced = st.sel.len() < inp.min_count;
        if !forced {
            if let Some(ta) = target_area {
                if st.area >= ta - 1e-9 {
                    stop = "target-met";
                    break;
                }
            }
        }
        if st.sel.len() >= cap {
            stop = "budget-exhausted";
            break;
        }
        let mut best: Option<(usize, f64)> = None;
        let mut any_progress = false;
        for i in 0..k {
            if !inp.allowed[i] || st.in_sel[i] || st.blocked(i, None) {
                continue;
            }
            let (prog, area) = st.gain(i);
            if prog <= 0.0 {
                continue;
            }
            any_progress = true;
            if !forced && area < min_gain_area {
                continue;
            }
            let score = if inp.prefer[i] { prog * 1.001 + 1e-9 } else { prog };
            if best.map_or(true, |(_, s)| score > s) {
                best = Some((i, score));
            }
        }
        match best {
            Some((i, _)) => st.add(i),
            None => {
                stop = if any_progress { "low-gain" } else { "no-gain" };
                break;
            }
        }
    }

    // ---- 2. simulated annealing ---------------------------------------------
    let lambda = inp.min_gain_pct / 100.0 * total_v;
    let penalty = 50.0 * total_v / total_w; // per unit of area short of the target
    let objective = |s: &State| -> f64 {
        let short = target_area.map_or(0.0, |ta| (ta - s.area).max(0.0));
        s.val - lambda * s.sel.len() as f64 - penalty * short
    };
    let allowed_idx: Vec<usize> = (0..k).filter(|&i| inp.allowed[i]).collect();
    // nearby alternatives of every position (for "move this AP a little")
    let radius = (3.0 * inp.min_sep).max(15.0);
    let neighbours: Vec<Vec<usize>> = (0..k)
        .map(|i| {
            let mut near: Vec<(f64, usize)> = allowed_idx
                .iter()
                .filter(|&&j| j != i)
                .map(|&j| (dist(inp.pos[i], inp.pos[j]), j))
                .filter(|(d, _)| *d <= radius)
                .collect();
            near.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            near.truncate(40);
            near.into_iter().map(|(_, j)| j).collect()
        })
        .collect();

    let mut rng = Rng::new(inp.seed);
    let started = Instant::now();
    let mut best_sel = st.sel.clone();
    let mut best_key = rank_key(&st, target_area, objective(&st));
    let mut iterations_run = 0;
    let mut accepted = 0;
    if !allowed_idx.is_empty() && inp.iterations > 0 {
        // starting temperature: the typical size of a change
        let mut t0 = 0.0;
        let mut samples = 0;
        for _ in 0..60 {
            if st.sel.is_empty() {
                break;
            }
            let a = st.sel[rng.below(st.sel.len())];
            let b = allowed_idx[rng.below(allowed_idx.len())];
            if st.in_sel[b] || st.blocked(b, Some(a)) {
                continue;
            }
            let before = objective(&st);
            st.remove(a);
            st.add(b);
            t0 += (objective(&st) - before).abs();
            samples += 1;
            st.remove(b);
            st.add(a);
        }
        let t0 = if samples > 0 && t0 > 0.0 { t0 / samples as f64 } else { lambda.max(1e-6) };
        let mut current = objective(&st);
        for it in 0..inp.iterations {
            if it % 256 == 0 && started.elapsed().as_millis() as u64 > inp.time_limit_ms {
                break;
            }
            iterations_run = it + 1;
            let temp = t0 * (1e-3f64).powf(it as f64 / inp.iterations as f64);
            let r = rng.f64();
            // pick a move
            let applied: Option<(Option<usize>, Option<usize>)> = if r < 0.6 && !st.sel.is_empty() {
                // relocate: mostly a nearby position, sometimes anywhere
                let a = st.sel[rng.below(st.sel.len())];
                let b = if rng.f64() < 0.8 && !neighbours[a].is_empty() {
                    neighbours[a][rng.below(neighbours[a].len())]
                } else {
                    allowed_idx[rng.below(allowed_idx.len())]
                };
                if st.in_sel[b] || st.blocked(b, Some(a)) {
                    None
                } else {
                    st.remove(a);
                    st.add(b);
                    Some((Some(a), Some(b)))
                }
            } else if r < 0.8 && st.sel.len() > inp.min_count {
                let a = st.sel[rng.below(st.sel.len())];
                st.remove(a);
                Some((Some(a), None))
            } else if st.sel.len() < cap {
                // add: the best of a few random positions
                let mut pick: Option<(usize, f64)> = None;
                for _ in 0..24 {
                    let b = allowed_idx[rng.below(allowed_idx.len())];
                    if st.in_sel[b] || st.blocked(b, None) {
                        continue;
                    }
                    let (g, _) = st.gain(b);
                    if pick.map_or(true, |(_, s)| g > s) {
                        pick = Some((b, g));
                    }
                }
                match pick {
                    Some((b, g)) if g > 0.0 => {
                        st.add(b);
                        Some((None, Some(b)))
                    }
                    _ => None,
                }
            } else {
                None
            };
            let Some((removed, added)) = applied else { continue };
            let next = objective(&st);
            let delta = next - current;
            if delta >= 0.0 || rng.f64() < (delta / temp.max(1e-12)).exp() {
                current = next;
                accepted += 1;
                let key = rank_key(&st, target_area, current);
                if key > best_key {
                    best_key = key;
                    best_sel = st.sel.clone();
                }
            } else {
                if let Some(b) = added {
                    st.remove(b);
                }
                if let Some(a) = removed {
                    st.add(a);
                }
            }
        }
    }
    // restore the best layout seen
    let mut st = State::new(inp, &value);
    for &i in &best_sel {
        st.add(i);
    }

    // ---- 3. pruning: every AP must earn its place ----------------------------
    loop {
        if st.sel.len() <= inp.min_count {
            break;
        }
        let mut weakest: Option<(usize, f64)> = None;
        for &s in st.sel.clone().iter() {
            let before = st.area;
            st.remove(s);
            let loss = before - st.area;
            let still_met = target_area.map_or(false, |ta| st.area >= ta - 1e-9);
            st.add(s);
            let removable = still_met || loss < min_gain_area;
            if removable && weakest.map_or(true, |(_, l)| loss < l) {
                weakest = Some((s, loss));
            }
        }
        match weakest {
            Some((s, _)) => st.remove(s),
            None => break,
        }
    }

    let coverage = st.pct(total_w);
    let met = inp.target_pct.map_or(false, |t| coverage >= t - 1e-9);
    let status: &'static str = if met {
        "target-met"
    } else if st.sel.len() >= cap && cap != usize::MAX {
        "budget-exhausted"
    } else if inp.target_pct.map_or(false, |t| max_possible < t - 1e-9) {
        "infeasible"
    } else if stop == "no-gain" {
        "no-gain"
    } else {
        "low-gain"
    };

    // how far the target still is: keep adding without the minimum gain and count
    let (more_needed, more_reach) = if !met && inp.target_pct.is_some() && status != "infeasible" {
        let mut extra = State::new(inp, &value);
        for &i in &st.sel {
            extra.add(i);
        }
        let ta = target_area.unwrap();
        let mut n = 0;
        while extra.area < ta - 1e-9 && n < 300 {
            let mut best: Option<(usize, f64)> = None;
            for i in 0..k {
                if !inp.allowed[i] || extra.in_sel[i] || extra.blocked(i, None) {
                    continue;
                }
                let (g, _) = extra.gain(i);
                if g > 0.0 && best.map_or(true, |(_, s)| g > s) {
                    best = Some((i, g));
                }
            }
            match best {
                Some((i, _)) => {
                    extra.add(i);
                    n += 1;
                }
                None => break,
            }
        }
        (Some(n), Some(extra.pct(total_w)))
    } else {
        (None, None)
    };

    // order the chosen APs by what each adds (best first)
    let mut steps = Vec::new();
    {
        let mut s = State::new(inp, &value);
        let mut left = st.sel.clone();
        let mut prev = s.pct(total_w);
        while !left.is_empty() {
            let mut best = (0, f64::NEG_INFINITY);
            for (p, &i) in left.iter().enumerate() {
                s.add(i);
                let c = s.pct(total_w);
                s.remove(i);
                if c > best.1 {
                    best = (p, c);
                }
            }
            let i = left.swap_remove(best.0);
            s.add(i);
            steps.push((i, best.1 - prev, best.1));
            prev = best.1;
        }
    }
    Output {
        selected: steps.iter().map(|s| s.0).collect(),
        status,
        coverage_pct: coverage,
        baseline_pct: baseline,
        max_possible_pct: max_possible,
        steps,
        more_needed,
        more_reach_pct: more_reach,
        iterations_run,
        accepted,
    }
}

/// Which layout is better: with a target, reaching it first, then fewer APs, then more covered value; without
/// one, the objective (covered value minus the cost of the APs).
fn rank_key(s: &State, target_area: Option<f64>, objective: f64) -> (u8, i64, i64) {
    match target_area {
        Some(ta) if s.area >= ta - 1e-9 => (1, -(s.sel.len() as i64), (s.val * 1e6) as i64),
        Some(_) => (0, (objective * 1e6) as i64, 0),
        None => (0, (objective * 1e6) as i64, 0),
    }
}

// ---- JSON / file interface (the worker calls the `apsearch` binary) --------------

/// Builds the input from the worker's params and the K x N hit matrix (1 = reaches the requirement).
pub fn input_from(params: &Value, hit: &[u8]) -> Result<Input, String> {
    let k = params["k"].as_u64().ok_or("k missing")? as usize;
    let n = params["n"].as_u64().ok_or("n missing")? as usize;
    if hit.len() != k * n {
        return Err(format!("hit matrix has {} bytes, expected {}", hit.len(), k * n));
    }
    let f64s = |key: &str, len: usize, default: f64| -> Result<Vec<f64>, String> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(vec![default; len]),
            Some(Value::Array(a)) if a.len() == len => Ok(a.iter().map(|v| v.as_f64().unwrap_or(default)).collect()),
            _ => Err(format!("{key} must be an array of {len} numbers")),
        }
    };
    let weight = f64s("weight", n, 0.0)?;
    let priority = f64s("priority", n, 1.0)?;
    let base: Vec<u32> = f64s("base", n, 0.0)?.into_iter().map(|v| v.max(0.0) as u32).collect();
    let bools = |key: &str, default: bool| -> Vec<bool> {
        params[key].as_array().map_or(vec![default; k], |a| a.iter().map(|v| v.as_bool().unwrap_or(default)).collect())
    };
    let pos: Vec<[f64; 3]> = params["positions"]
        .as_array()
        .ok_or("positions missing")?
        .iter()
        .map(|p| [p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0), p[2].as_f64().unwrap_or(0.0)])
        .collect();
    if pos.len() != k {
        return Err("positions must have one entry per candidate".into());
    }
    let cover = (0..k)
        .map(|i| {
            let row = &hit[i * n..(i + 1) * n];
            (0..n).filter(|&c| row[c] != 0 && weight[c] > 0.0).map(|c| c as u32).collect()
        })
        .collect();
    let idx = |key: &str| -> Vec<usize> {
        params[key].as_array().map_or(vec![], |a| a.iter().filter_map(|v| v.as_u64().map(|x| x as usize)).collect())
    };
    Ok(Input {
        cover,
        weight,
        priority,
        base,
        need: params["need"].as_u64().unwrap_or(1).max(1) as u32,
        pos,
        allowed: bools("allowed", true),
        prefer: bools("prefer", false),
        warm: idx("warm"),
        budget: params["budget"].as_u64().map(|b| b as usize),
        target_pct: params["targetPct"].as_f64(),
        min_gain_pct: params["minGainPct"].as_f64().unwrap_or(1.0),
        min_sep: params["minSeparationM"].as_f64().unwrap_or(0.0),
        min_count: params["minCount"].as_u64().unwrap_or(0) as usize,
        iterations: params["iterations"].as_u64().unwrap_or(30_000) as usize,
        time_limit_ms: params["timeLimitMs"].as_u64().unwrap_or(30_000),
        seed: params["seed"].as_u64().unwrap_or(42),
    })
}

pub fn output_json(o: &Output) -> Value {
    json!({
        "selected": o.selected,
        "status": o.status,
        "coveragePct": o.coverage_pct,
        "baselinePct": o.baseline_pct,
        "maxPossiblePct": o.max_possible_pct,
        "steps": o.steps.iter().map(|(i, m, c)| json!({"index": i, "marginalPct": m, "cumulativePct": c})).collect::<Vec<_>>(),
        "moreNeeded": o.more_needed,
        "moreReachPct": o.more_reach_pct,
        "iterations": o.iterations_run,
        "accepted": o.accepted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(sets: Vec<Vec<u32>>, n: usize, positions: Vec<[f64; 3]>) -> Input {
        let k = sets.len();
        Input {
            cover: sets,
            weight: vec![1.0; n],
            priority: vec![1.0; n],
            base: vec![0; n],
            need: 1,
            pos: positions,
            allowed: vec![true; k],
            prefer: vec![false; k],
            warm: vec![],
            budget: None,
            target_pct: None,
            min_gain_pct: 1.0,
            min_sep: 0.0,
            min_count: 0,
            iterations: 5000,
            time_limit_ms: 5000,
            seed: 1,
        }
    }

    fn line(k: usize, step: f64) -> Vec<[f64; 3]> {
        (0..k).map(|i| [i as f64 * step, 0.0, 3.0]).collect()
    }

    #[test]
    fn a_big_budget_is_a_maximum_not_a_quota() {
        // two positions cover 190 of 200 cells; ten more add one cell (0.5 %) each
        let mut sets = vec![(0..100).collect::<Vec<u32>>(), (100..190).collect()];
        sets.extend((0..10).map(|i| vec![190 + i]));
        let mut inp = input(sets, 200, line(12, 20.0));
        inp.budget = Some(50);
        let o = search(&inp);
        let mut s = o.selected.clone();
        s.sort();
        assert_eq!(s, vec![0, 1]);
        assert_eq!(o.status, "low-gain");
    }

    #[test]
    fn annealing_escapes_a_greedy_trap() {
        // greedy takes the big middle set first, then needs two more; two side sets alone cover everything
        let sets = vec![(25..75).collect::<Vec<u32>>(), (0..50).collect(), (50..100).collect()];
        let mut inp = input(sets, 100, line(3, 30.0));
        inp.target_pct = Some(100.0);
        let o = search(&inp);
        let mut s = o.selected.clone();
        s.sort();
        assert_eq!(s, vec![1, 2]);
        assert_eq!(o.status, "target-met");
    }

    #[test]
    fn aps_keep_their_distance_and_the_budget() {
        // ten positions 1 m apart along a corridor, each covering its own block
        let sets = (0..10).map(|i| ((i * 10)..(i * 10 + 10)).collect::<Vec<u32>>()).collect();
        let mut inp = input(sets, 100, line(10, 1.0));
        inp.min_sep = 3.5;
        inp.budget = Some(10);
        let o = search(&inp);
        for a in &o.selected {
            for b in &o.selected {
                if a != b {
                    assert!(dist(inp.pos[*a], inp.pos[*b]) >= 3.5);
                }
            }
        }
        assert!(o.selected.len() <= 3);
    }

    #[test]
    fn red_areas_come_first() {
        // one position covers 5 nearly-good cells, the other 4 red ones; one AP allowed
        let sets = vec![(0..5).collect::<Vec<u32>>(), (5..9).collect()];
        let mut inp = input(sets, 9, line(2, 50.0));
        inp.priority = vec![1.1, 1.1, 1.1, 1.1, 1.1, 3.0, 3.0, 3.0, 3.0];
        inp.budget = Some(1);
        let o = search(&inp);
        assert_eq!(o.selected, vec![1]);
    }

    #[test]
    fn an_unreachable_target_is_counted() {
        // one position covers 190 of 200 cells; ten more add 0.5 % each (under the 1 % minimum)
        let mut sets = vec![(0..190).collect::<Vec<u32>>()];
        sets.extend((0..10).map(|i| vec![190 + i]));
        let mut inp = input(sets, 200, line(11, 20.0));
        inp.target_pct = Some(100.0);
        let o = search(&inp);
        assert_eq!(o.selected, vec![0]);
        assert_eq!(o.status, "low-gain");
        assert_eq!(o.more_needed, Some(10));
    }
}
