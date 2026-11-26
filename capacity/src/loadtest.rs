//! Progressive load test: how many users can the existing APs carry?
//!
//! The APs stay fixed. The headcount is raised step by step (for example 50,
//! 100, 150 … 500) and every step is a Monte Carlo run of whole users and
//! devices (montecarlo.rs). Every step uses the same iteration seeds, so two
//! steps differ only by the number of people (common random numbers), which
//! keeps the comparison between steps steady.
//!
//! Each step is judged against the planner's own targets (minimum speed,
//! highest airtime use, most devices per AP, the internet plan) and gets
//! Pass, Warning or Fail. Between the last passing and the first failing step
//! the headcount is narrowed down by bisection, for the whole network and
//! for each KPI on its own.
//!
//! Per location (a heat-map grid over the floor) it also works out what a
//! device standing there would get under that load: the AP it would join,
//! the airtime used on that AP's channel, the data rate at its SNR, the
//! throughput still available, and estimated latency and retries.
//!
//! RSSI and SNR do not depend on the load and are reported once, as the
//! baseline.
//!
//! What each device gets comes from loadmodel.rs (the load test's own per-user model: data rate from the SNR
//! where it stands, airtime shared fairly per contention domain, collisions, the internet plan shared max-min
//! after Wi-Fi). The Monte Carlo result's heat maps (`heatmap_for`) keep the simpler per-AP model.

use crate::js::{finite, r1};
use crate::loadmodel::{self, LmCfg, LoadEval, Relations};
use crate::model::{Cand, Ctx, Eval, Occupancy};
use crate::montecarlo::{device_failure, percentile, round_to, run_iteration, wilson, Iteration, McCfg, Sampler, SignalIndex};
use crate::radio::MIN_SNR_DB;
use crate::rng::iteration_seed;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub fn defaults() -> Value {
    json!({
        "startUsers": 50,
        "maxUsers": 500,
        "stepUsers": 50,
        "refineUsers": 5,
        "runsPerStep": 60,
        "confidencePct": 95,
        "passMeetsPct": 95,
        "warnMeetsPct": 99,
        "warnPct": 85,
        "stopAfterFailSteps": 2,
        "heatmapM": 1,
        "heatmapRuns": 12,
        "maxHeatmapSteps": 12,
        "txopMs": 2,
        "latencyWarnMs": 30,
        "latencyFailMs": 100,
        "retryWarnPct": 15,
        "retryFailPct": 30,
        "estimatesDecide": false,
        "fairness": "airtime",
        "ccaDbm": -82,
        "uplinkLossDb": 5,
        "collisions": true,
        "interference": false,
        "adjacentRejectionDb": 25,
        "convergenceDamping": 0.5,
        "convergenceTolerance": 0.005,
        "convergenceIterations": 40,
        "maxUserDots": 3000
    })
}

// ---------------------------------------------------------------- progress

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn cap_progress(done: u32, total: u32);
}

fn progress(done: usize, total: usize) {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        cap_progress(done as u32, total.max(done) as u32);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = (done, total);
}

// ---------------------------------------------------------------- settings

struct LtCfg {
    start: usize,
    max: usize,
    step: usize,
    refine: usize,
    runs: usize,
    conf: f64,
    pass_meets: f64,
    warn_meets: f64,
    warn: f64,
    stop_after_fail: usize,
    heat_m: f64,
    heat_runs: usize,
    max_heat_steps: usize,
    txop_ms: f64,
    latency_warn: f64,
    latency_fail: f64,
    retry_warn: f64,
    retry_fail: f64,
    estimates_decide: bool,
    max_dots: usize,
    raw: Map<String, Value>,
    notes: Vec<String>,
}

const MAX_STEPS: usize = 200;

impl LtCfg {
    fn new(settings: Option<&Value>) -> LtCfg {
        let mut raw = match defaults() {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        if let Some(Value::Object(m)) = settings.and_then(|s| s.get("loadTest")) {
            for (k, v) in m {
                raw.insert(k.clone(), v.clone());
            }
        }
        let n = |k: &str, d: f64| finite(raw.get(k)).unwrap_or(d);
        let mut notes = Vec::new();
        let start = n("startUsers", 50.0).round().clamp(1.0, 1e6) as usize;
        let max = (n("maxUsers", 500.0).round().clamp(1.0, 1e6) as usize).max(start);
        let mut step = n("stepUsers", 50.0).round().clamp(1.0, 1e6) as usize;
        if (max - start) / step + 1 > MAX_STEPS {
            step = (max - start).div_ceil(MAX_STEPS - 1);
            notes.push(format!("The step was raised to {step} users to keep the test under {MAX_STEPS} steps."));
        }
        let runs = n("runsPerStep", 60.0).round().clamp(10.0, 5000.0) as usize;
        let pass_meets = n("passMeetsPct", 95.0).clamp(0.0, 100.0);
        LtCfg {
            start,
            max,
            step,
            refine: (n("refineUsers", 5.0).round().max(1.0) as usize).min(step),
            runs,
            conf: n("confidencePct", 95.0).clamp(50.0, 99.9) / 100.0,
            pass_meets,
            warn_meets: n("warnMeetsPct", 99.0).clamp(pass_meets, 100.0),
            warn: n("warnPct", 85.0).clamp(1.0, 100.0) / 100.0,
            stop_after_fail: n("stopAfterFailSteps", 2.0).round().clamp(0.0, 1e6) as usize,
            heat_m: n("heatmapM", 1.0).clamp(0.5, 50.0),
            heat_runs: (n("heatmapRuns", 12.0).round().clamp(1.0, 1000.0) as usize).min(runs),
            max_heat_steps: n("maxHeatmapSteps", 12.0).round().clamp(1.0, 50.0) as usize,
            txop_ms: n("txopMs", 2.0).clamp(0.1, 20.0),
            latency_warn: n("latencyWarnMs", 30.0).max(0.0),
            latency_fail: n("latencyFailMs", 100.0).max(0.0),
            retry_warn: n("retryWarnPct", 15.0).clamp(0.0, 100.0),
            retry_fail: n("retryFailPct", 30.0).clamp(0.0, 100.0),
            estimates_decide: raw.get("estimatesDecide").and_then(Value::as_bool).unwrap_or(false),
            max_dots: n("maxUserDots", 3000.0).round().clamp(0.0, 100_000.0) as usize,
            raw,
            notes,
        }
    }
}

// ---------------------------------------------------------------- KPIs

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Status {
    Pass,
    Warning,
    Fail,
}

impl Status {
    fn text(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Warning => "warning",
            Status::Fail => "fail",
        }
    }
}

/// The KPIs every step is judged on, in report order. `minSpeed` and
/// `throughput` are Wi-Fi alone; the internet plan is `internet`. `estimate` KPIs come
/// from simple models (not measurable from the plan) and only decide the
/// step when `estimatesDecide` is set.
const KPIS: [(&str, bool); 8] = [
    ("airtime", false),
    ("minSpeed", false),
    ("throughput", false),
    ("devices", false),
    ("internet", false),
    ("coverage", false),
    ("latency", true),
    ("retries", true),
];

struct Kpi {
    value: f64,
    limit: f64,
    warn_at: f64,
    status: Status,
}

/// `higher` = a higher value is worse.
fn judge(value: f64, limit: f64, warn_at: f64, higher: bool) -> Kpi {
    let status = if !value.is_finite() {
        Status::Pass
    } else if higher {
        if value > limit {
            Status::Fail
        } else if value > warn_at {
            Status::Warning
        } else {
            Status::Pass
        }
    } else if value < limit {
        Status::Fail
    } else if value < warn_at {
        Status::Warning
    } else {
        Status::Pass
    };
    Kpi { value, limit, warn_at, status }
}

// ---------------------------------------------------------------- the environment

/// One heat-map square: a representative point and the signal of every AP there.
struct Probe {
    floor: usize,
    x: f64,
    z: f64,
    cand: Vec<Cand>,
}

struct Env<'a> {
    ctx: &'a Ctx,
    occ: &'a Occupancy,
    sampler: Sampler,
    sig: SignalIndex,
    mc: McCfg,
    lt: LtCfg,
    base_people: Vec<f64>,
    base_total: f64,
    group_area: Vec<f64>,
    /// Each AP and the APs it shares airtime with (same channel, in range).
    dom: Vec<Vec<usize>>,
    probes: Vec<Probe>,
    probe_at: HashMap<(usize, i64, i64), usize>,
    bin: Vec<f64>,
    /// The load test's per-user model (loadmodel.rs); false keeps the per-AP model (Monte Carlo heat maps).
    dynamic: bool,
    lm: LmCfg,
    rel: Relations,
}

impl<'a> Env<'a> {
    fn new(ctx: &'a Ctx, occ: &'a Occupancy, settings: Option<&Value>, dynamic: bool) -> Env<'a> {
        let lt = LtCfg::new(settings);
        let lm = LmCfg::new(&lt.raw);
        let base_people: Vec<f64> = occ.groups.iter().map(|g| if g.people.is_finite() { g.people } else { 0.0 }).collect();
        let base_total = base_people.iter().sum();
        let group_area = occ.groups.iter().map(|g| g.pts.iter().map(|&p| occ.pts[p].area).sum()).collect();
        let dom = (0..ctx.aps.len())
            .map(|i| {
                let mut d = vec![i];
                d.extend(ctx.chan.neighbours[i].iter().copied().filter(|&n| ctx.chan.assign[n] == ctx.chan.assign[i]));
                d
            })
            .collect();
        let sig = SignalIndex::new(ctx);
        let rel = Relations::new(ctx, &sig, &lm);

        // heat-map squares: at most ~6000 per floor, never finer than the occupancy grid
        let mut bin = Vec::with_capacity(ctx.floors.len());
        for (fi, _) in ctx.floors.iter().enumerate() {
            let area: f64 = occ.pts.iter().filter(|p| p.floor == fi).map(|p| p.area).sum();
            let side = occ.side.get(fi).copied().unwrap_or(1.0);
            bin.push(lt.heat_m.max(side).max((area / 6000.0).sqrt()));
        }
        let mut probes: Vec<Probe> = Vec::new();
        let mut probe_at = HashMap::new();
        let mut best: HashMap<(usize, i64, i64), f64> = HashMap::new();
        for p in &occ.pts {
            if !p.has_ap {
                continue;
            }
            let b = bin[p.floor];
            let key = (p.floor, (p.x / b).floor() as i64, (p.z / b).floor() as i64);
            let cx = (key.1 as f64 + 0.5) * b;
            let cz = (key.2 as f64 + 0.5) * b;
            let d = (p.x - cx).hypot(p.z - cz);
            let cell = sig.cell(p.floor, p.x, p.z).or(p.cell).map(|c| &ctx.floors[p.floor].cells[c]);
            match probe_at.get(&key) {
                Some(&i) => {
                    if d < best[&key] {
                        best.insert(key, d);
                        probes[i] = Probe { floor: p.floor, x: p.x, z: p.z, cand: ctx.candidates(p.floor, p.x, p.z, cell).0 };
                    }
                }
                None => {
                    best.insert(key, d);
                    probe_at.insert(key, probes.len());
                    probes.push(Probe { floor: p.floor, x: p.x, z: p.z, cand: ctx.candidates(p.floor, p.x, p.z, cell).0 });
                }
            }
        }
        Env {
            ctx,
            occ,
            sampler: Sampler::new(occ),
            sig,
            mc: McCfg::new(settings),
            lt,
            base_people,
            base_total,
            group_area,
            dom,
            probes,
            probe_at,
            bin,
            dynamic,
            lm,
            rel,
        }
    }

    /// People per occupancy group for a total of `n`: the planner's spread
    /// (zones, rooms, desks) scaled to n; by floor area when it holds nobody.
    fn people_for(&self, n: f64) -> Vec<f64> {
        if self.base_total > 0.0 {
            return self.base_people.iter().map(|p| p * n / self.base_total).collect();
        }
        let total: f64 = self.group_area.iter().sum();
        if total > 0.0 {
            self.group_area.iter().map(|a| a / total * n).collect()
        } else {
            vec![0.0; self.group_area.len()]
        }
    }

    fn bin_of(&self, floor: usize, x: f64, z: f64) -> Option<usize> {
        let b = self.bin[floor];
        self.probe_at.get(&(floor, (x / b).floor() as i64, (z / b).floor() as i64)).copied()
    }
}

// ---------------------------------------------------------------- radio estimates

/// Collision probability per transmission attempt with `n` contending
/// stations (Bianchi's model of 802.11 DCF, CWmin 16, 6 backoff stages).
/// Retries from collisions only; errors from a weak signal are not included.
fn collision_prob(n: f64) -> f64 {
    if !(n > 1.0) {
        return 0.0;
    }
    let (w, m) = (16.0f64, 6i32);
    let tau = |p: f64| {
        let p = if (p - 0.5).abs() < 1e-7 { 0.5 + 1e-7 } else { p };
        2.0 * (1.0 - 2.0 * p) / ((1.0 - 2.0 * p) * (w + 1.0) + p * w * (1.0 - (2.0 * p).powi(m)))
    };
    let f = |p: f64| 1.0 - (1.0 - tau(p)).powf(n - 1.0) - p;
    let (mut lo, mut hi) = (0.0, 0.999);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if f(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// Per-AP view of one iteration.
struct ApLoad {
    /// Airtime used on the AP's channel (its own and the APs sharing it), typical speeds.
    air: f64,
    /// Active devices on that channel.
    n_dom: f64,
    latency_ms: f64,
    retry: f64,
}

fn ap_loads(env: &Env, ev: &Eval) -> Vec<ApLoad> {
    (0..env.ctx.aps.len())
        .map(|a| {
            let row = &ev.rows[a];
            let air = row.dom_typical;
            let n_dom: f64 = env.dom[a].iter().map(|&j| ev.rows[j].acc.active).sum();
            let rho = air.clamp(0.0, 0.98);
            ApLoad {
                air,
                n_dom,
                // mean access delay of a queue at this utilisation
                latency_ms: env.lt.txop_ms / (1.0 - rho),
                // stations with a frame waiting at the same time: one transmitting plus
                // the queue of a channel at this utilisation, never more than are active
                retry: collision_prob(n_dom.min(1.0 + rho / (1.0 - rho))),
            }
        })
        .collect()
}

/// The AP a device at this spot joins, the same way association does.
fn serving(env: &Env, cand: &[Cand], ev: &Eval) -> Option<usize> {
    let min_snr = MIN_SNR_DB[0];
    let first = cand.first().filter(|c| !(c.snr < min_snr))?;
    if !env.ctx.cfg.load_aware {
        return Some(first.ap);
    }
    let mut b = first;
    for c in cand.iter().filter(|c| c.rssi >= first.rssi - env.ctx.cfg.roam_margin_db && c.snr >= min_snr) {
        if ev.rows[c.ap].acc.active < ev.rows[b.ap].acc.active {
            b = c;
        }
    }
    Some(b.ap)
}

// ---------------------------------------------------------------- one iteration's figures

struct IterM {
    users: f64,
    devices: f64,
    active: f64,
    /// Share of active devices getting their minimum: over Wi-Fi alone, and
    /// with the internet plan too.
    meets_wifi: Option<f64>,
    meets: Option<f64>,
    max_air: f64,
    max_dev: f64,
    wan_min: f64,
    wan_typ: f64,
    no_signal_pct: f64,
    max_lat: f64,
    max_retry: f64,
    ap_air: Vec<f64>,
    ap_dev: Vec<f64>,
    ap_active: Vec<f64>,
    ap_meets: Vec<Option<f64>>,
    ap_over: Vec<bool>,
    ap_lat: Vec<f64>,
    ap_retry: Vec<f64>,
    ap_status: Vec<&'static str>,
    /// The load model settled (loadmodel.rs); always true for the per-AP model.
    converged: bool,
    /// Every simulated user with its devices' results (heat-map runs of the load test only).
    users_json: Option<Value>,
}

#[derive(Default, Clone)]
struct HeatAcc {
    n: f64,
    served: f64,
    avail: f64,
    delivered: f64,
    delivered_net: f64,
    air: f64,
    rate: f64,
    lat: f64,
    retry: f64,
    dev_active: f64,
    dev_fail: f64,
    /// Load test: what a typical active user standing in this square gets under that load (Mbps, never more than
    /// its demand), over Wi-Fi and after the internet plan, summed over the heat-map runs.
    act_wifi: f64,
    act_net: f64,
    ap_count: BTreeMap<usize, usize>,
    wan_cap: f64,
    wan_n: f64,
}

/// Per active device, over the runs of a step (Mbps):
/// - `spare`: what it could get if it wanted more, over Wi-Fi (its rate × the
///   airtime left on its channel, at least an equal share);
/// - `wifi`: what it gets of its own demand over Wi-Fi: all of it while the
///   channel has airtime, less once the channel is over-subscribed;
/// - `net`: that, after the internet plan's share too;
/// - `ratio`: `wifi` over the device's minimum.
#[derive(Default)]
struct DevSamples {
    spare: Vec<f64>,
    wifi: Vec<f64>,
    net: Vec<f64>,
    ratio: Vec<f64>,
    /// `wifi` over the device's own demand (1 = gets all of it)
    full: Vec<f64>,
}

impl DevSamples {
    fn clear(&mut self) {
        self.spare.clear();
        self.wifi.clear();
        self.net.clear();
        self.ratio.clear();
        self.full.clear();
    }
}

/// What a device with `demand` gets over Wi-Fi at `rate` on a channel using
/// `air` of its airtime: its demand, scaled down once the channel is
/// over-subscribed, never more than its rate.
fn delivered(demand: f64, rate: f64, air: f64) -> f64 {
    (demand / air.max(1.0)).min(rate).max(0.0)
}

/// The share of an AP's active devices that get their minimum over Wi-Fi
/// alone: signal good enough, times the airtime scale (the internet plan is
/// judged on its own).
fn wifi_meets(r: &crate::model::ApRow) -> f64 {
    r.capable_pct * if r.dom_min > 1.0 { 1.0 / r.dom_min } else { 1.0 }
}

fn measure(env: &Env, it: &Iteration, dev: &mut DevSamples, heat: Option<&mut Vec<HeatAcc>>) -> IterM {
    if env.dynamic {
        return measure_dynamic(env, it, dev, heat);
    }
    let ctx = env.ctx;
    let ev = &it.ev;
    let w = &ev.wan;
    let loads = ap_loads(env, ev);

    for u in &it.users {
        for d in &u.devices {
            if !d.active {
                continue;
            }
            let (spare, wifi) = match d.unit.map(|i| &it.units[i]) {
                Some(unit) => match unit.ap {
                    Some(ap) => {
                        let l = &loads[ap];
                        let rate = ctx.rate_of(unit.snr);
                        let own = if rate > 0.0 { d.demand / rate } else { 0.0 };
                        let share = (1.0 - l.air + own).max(1.0 / l.n_dom.max(1.0)).clamp(0.0, 1.0);
                        ((rate * share).max(0.0), delivered(d.demand, rate, l.air))
                    }
                    None => (0.0, 0.0),
                },
                None => (0.0, 0.0),
            };
            dev.spare.push(spare);
            dev.wifi.push(wifi);
            dev.net.push(wifi * w.scale_typical);
            if d.min > 0.0 {
                dev.ratio.push(wifi / d.min);
            }
            if d.demand > 0.0 {
                dev.full.push(wifi / d.demand);
            }
        }
    }

    let usable = w.usable_down;
    if let Some(heat) = heat {
        if let Some(h0) = heat.first_mut() {
            // what is left of the internet plan for one more device (kept on the first square)
            h0.wan_cap += (usable - w.demand_typical).max(usable / (w.total_active + 1.0));
            h0.wan_n += 1.0;
        }
        // a typical active device of this run, standing at each square
        let demand = if w.total_active > 0.0 { w.demand_typical / w.total_active } else { ctx.cfg.demand_mbps };
        for (pi, p) in env.probes.iter().enumerate() {
            let h = &mut heat[pi];
            h.n += 1.0;
            let Some(ap) = serving(env, &p.cand, ev) else { continue };
            let c = p.cand.iter().find(|c| c.ap == ap).expect("serving AP is a candidate");
            let l = &loads[ap];
            let rate = ctx.rate_of(c.snr);
            // Wi-Fi only: the internet plan is one cap for the whole site, reported per step
            let share = (1.0 - l.air).max(1.0 / (l.n_dom + 1.0)).clamp(0.0, 1.0);
            h.served += 1.0;
            h.avail += (rate * share).max(0.0);
            let got = delivered(demand, rate, l.air);
            h.delivered += got;
            h.delivered_net += got * w.scale_typical;
            h.air += l.air;
            h.rate += rate;
            h.lat += l.latency_ms;
            h.retry += l.retry;
            *h.ap_count.entry(ap).or_insert(0) += 1;
        }
        for u in &it.units {
            if u.active <= 0.0 {
                continue;
            }
            if let Some(b) = env.bin_of(u.floor, u.x, u.z) {
                heat[b].dev_active += 1.0;
                heat[b].dev_fail += device_failure(ctx, it, u);
            }
        }
    }

    let busy = |a: usize| ev.rows[a].acc.active > 0.0;
    let n_aps = ctx.aps.len();
    let devices = w.total_devices + it.unserved_devices as f64;
    IterM {
        users: it.users.len() as f64,
        devices,
        active: w.total_active,
        // devices without a usable signal count in total_active and meet nothing
        meets_wifi: (w.total_active > 0.0).then(|| ev.rows.iter().fold(0.0, |s, r| s + wifi_meets(r) * r.acc.active) / w.total_active),
        meets: (w.total_active > 0.0).then(|| ev.rows.iter().fold(0.0, |s, r| s + r.meets * r.acc.active) / w.total_active),
        max_air: ev.rows.iter().map(|r| r.dom_typical).fold(0.0, f64::max),
        max_dev: ev.rows.iter().map(|r| r.acc.devices).fold(0.0, f64::max),
        wan_min: if usable > 0.0 { w.demand_min / usable } else { f64::INFINITY },
        wan_typ: if usable > 0.0 { w.demand_typical / usable } else { f64::INFINITY },
        no_signal_pct: if devices > 0.0 { (ev.ns.devices + it.unserved_devices as f64) / devices * 100.0 } else { 0.0 },
        max_lat: (0..n_aps).filter(|&a| busy(a)).map(|a| loads[a].latency_ms).fold(f64::NAN, f64::max),
        max_retry: (0..n_aps).filter(|&a| busy(a)).map(|a| loads[a].retry * 100.0).fold(f64::NAN, f64::max),
        ap_air: ev.rows.iter().map(|r| r.dom_typical).collect(),
        ap_dev: ev.rows.iter().map(|r| r.acc.devices).collect(),
        ap_active: ev.rows.iter().map(|r| r.acc.active).collect(),
        ap_meets: ev.rows.iter().map(|r| (r.acc.active > 0.0).then_some(wifi_meets(r))).collect(),
        ap_over: ev.rows.iter().map(|r| r.radio_limited || r.clients_over).collect(),
        ap_lat: loads.iter().map(|l| l.latency_ms).collect(),
        ap_retry: loads.iter().map(|l| l.retry * 100.0).collect(),
        ap_status: ev.rows.iter().map(|r| r.status).collect(),
        converged: true,
        users_json: None,
    }
}

/// The load test's figures: every device's own result from loadmodel.rs.
fn measure_dynamic(env: &Env, it: &Iteration, dev: &mut DevSamples, heat: Option<&mut Vec<HeatAcc>>) -> IterM {
    let ctx = env.ctx;
    let cfg = &ctx.cfg;
    let ev = &it.ev;
    let w = &ev.wan;
    let le: LoadEval = loadmodel::evaluate(ctx, &env.rel, &env.lm, &it.units, w.usable_down, it.unserved_devices);
    let g = loadmodel::greedy(&env.lm, &env.rel, &le, &it.units);
    let n_aps = ctx.aps.len();
    let latency = |a: usize| env.lt.txop_ms / (1.0 - le.load[a].clamp(0.0, 0.98));

    let mut ap_active = vec![0.0; n_aps];
    let mut ap_ok = vec![0.0; n_aps];
    let mut ap_weak = vec![false; n_aps];
    let (mut active, mut ok_wifi, mut ok_net) = (0.0, 0.0, 0.0);
    for u in &it.users {
        for d in &u.devices {
            if !d.active {
                continue;
            }
            active += 1.0;
            let (spare, wifi, net) = match d.unit.map(|i| (i, &le.units[i])) {
                Some((_, l)) => match l.ap {
                    Some(a) => {
                        ap_active[a] += 1.0;
                        if l.rate < d.min {
                            ap_weak[a] = true;
                        }
                        if l.wifi >= d.min - 1e-9 {
                            ap_ok[a] += 1.0;
                        }
                        (loadmodel::greedy_mbps(&env.lm, &g[a], l.rate), l.wifi, l.net)
                    }
                    None => (0.0, 0.0, 0.0),
                },
                None => (0.0, 0.0, 0.0),
            };
            if wifi >= d.min - 1e-9 {
                ok_wifi += 1.0;
            }
            if net >= d.min - 1e-9 {
                ok_net += 1.0;
            }
            dev.spare.push(spare);
            dev.wifi.push(wifi);
            dev.net.push(net);
            if d.min > 0.0 {
                dev.ratio.push(wifi / d.min);
            }
            if d.demand > 0.0 {
                dev.full.push(wifi / d.demand);
            }
        }
    }

    let usable = w.usable_down;
    let used: f64 = le.units.iter().map(|l| l.net).sum();
    let wan_left = if le.wan_level.is_finite() { le.wan_level } else { (usable - used).max(0.0) };
    let want_users = heat.is_some();
    // the demand of a typical active device of this run
    let typical = if w.total_active > 0.0 { w.demand_typical / w.total_active } else { cfg.demand_mbps };
    if let Some(heat) = heat {
        if let Some(h0) = heat.first_mut() {
            // what the internet plan leaves one more device (kept on the first square)
            h0.wan_cap += wan_left;
            h0.wan_n += 1.0;
        }
        for (pi, p) in env.probes.iter().enumerate() {
            let h = &mut heat[pi];
            h.n += 1.0;
            let Some(ap) = serving(env, &p.cand, ev) else { continue };
            let (_, _, rate, mbps) = loadmodel::probe(ctx, &env.rel, &env.lm, &le, &g, &p.cand, ap);
            h.served += 1.0;
            // a device there that wants more: its fair share of the airtime at its own rate
            h.avail += mbps;
            h.delivered += mbps;
            h.delivered_net += mbps.min(wan_left);
            // a typical user standing here: its demand, or its fair share of the airtime at its own rate if
            // that is less (the AP has run out of airtime, or its signal is too weak)
            h.act_wifi += mbps.min(typical);
            h.act_net += mbps.min(typical).min(wan_left);
            h.air += le.load[ap];
            h.rate += rate;
            h.lat += latency(ap);
            h.retry += le.collision[ap];
            *h.ap_count.entry(ap).or_insert(0) += 1;
        }
        for (i, u) in it.units.iter().enumerate() {
            if u.active <= 0.0 {
                continue;
            }
            if let Some(b) = env.bin_of(u.floor, u.x, u.z) {
                heat[b].dev_active += 1.0;
                heat[b].dev_fail += if le.units[i].wifi >= u.min - 1e-9 { 0.0 } else { 1.0 };
            }
        }
    }

    let devices = w.total_devices + it.unserved_devices as f64;
    let with_users = |a: usize| ev.rows[a].acc.active > 0.0;
    let status = |a: usize| -> &'static str {
        let r = &ev.rows[a];
        if r.acc.active <= 0.0 {
            "no devices"
        } else if r.clients_over {
            "too many devices"
        } else if ap_weak[a] {
            "weak signal for some devices"
        } else if ap_ok[a] < ap_active[a] {
            "cannot give the minimum speed (airtime)"
        } else if le.load[a] > cfg.target_utilisation {
            "airtime busy"
        } else if le.wan_level.is_finite() {
            "limited by the internet plan"
        } else {
            "ok"
        }
    };
    let users_json = (want_users && env.lt.max_dots > 0).then(|| users_json(env, it, &le));
    IterM {
        users: it.users.len() as f64,
        devices,
        active,
        meets_wifi: (active > 0.0).then(|| ok_wifi / active),
        meets: (active > 0.0).then(|| ok_net / active),
        max_air: (0..n_aps).filter(|&a| with_users(a)).map(|a| le.load[a]).fold(0.0, f64::max),
        max_dev: ev.rows.iter().map(|r| r.acc.devices).fold(0.0, f64::max),
        wan_min: if usable > 0.0 { w.demand_min / usable } else { f64::INFINITY },
        wan_typ: if usable > 0.0 { w.demand_typical / usable } else { f64::INFINITY },
        no_signal_pct: if devices > 0.0 { (ev.ns.devices + it.unserved_devices as f64) / devices * 100.0 } else { 0.0 },
        max_lat: (0..n_aps).filter(|&a| with_users(a)).map(latency).fold(f64::NAN, f64::max),
        max_retry: (0..n_aps).filter(|&a| with_users(a)).map(|a| le.collision[a] * 100.0).fold(f64::NAN, f64::max),
        ap_air: le.load.clone(),
        ap_dev: ev.rows.iter().map(|r| r.acc.devices).collect(),
        ap_active: ap_active.clone(),
        ap_meets: (0..n_aps).map(|a| (ap_active[a] > 0.0).then(|| ap_ok[a] / ap_active[a])).collect(),
        ap_over: (0..n_aps)
            .map(|a| ev.rows[a].clients_over || (ap_active[a] > 0.0 && (ap_ok[a] < ap_active[a] || le.load[a] > cfg.target_utilisation)))
            .collect(),
        ap_lat: (0..n_aps).map(latency).collect(),
        ap_retry: le.collision.iter().map(|c| c * 100.0).collect(),
        ap_status: (0..n_aps).map(status).collect(),
        converged: le.converged,
        users_json,
    }
}

/// Every simulated user of one run, where they stand and what each of their devices gets.
fn users_json(env: &Env, it: &Iteration, le: &LoadEval) -> Value {
    let ctx = env.ctx;
    let list: Vec<Value> = it
        .users
        .iter()
        .take(env.lt.max_dots)
        .map(|u| {
            let mut worst = "idle";
            let rank = |s: &str| match s {
                "no signal" => 4,
                "below minimum" => 3,
                "below demand" => 2,
                "ok" => 1,
                _ => 0,
            };
            let mut ap = None;
            let devices: Vec<Value> = u
                .devices
                .iter()
                .map(|d| {
                    let l = d.unit.map(|i| &le.units[i]);
                    let served = l.and_then(|l| l.ap);
                    let unit_ap = d.unit.and_then(|i| it.units[i].ap);
                    ap = ap.or(served).or(unit_ap);
                    let state = if !d.active {
                        "idle"
                    } else if served.is_none() || l.map_or(true, |l| !(l.rate > 0.0)) {
                        "no signal"
                    } else if l.unwrap().wifi < d.min - 1e-9 {
                        "below minimum"
                    } else if l.unwrap().wifi < d.demand - 1e-6 {
                        "below demand"
                    } else {
                        "ok"
                    };
                    if rank(state) > rank(worst) {
                        worst = state;
                    }
                    let snr = d.unit.map_or(f64::NAN, |i| it.units[i].snr);
                    let rssi = d.unit.and_then(|i| {
                        let u = &it.units[i];
                        u.ap.and_then(|a| u.cand.iter().find(|c| c.ap == a)).map(|c| c.rssi)
                    });
                    json!({
                        "active": d.active,
                        "demandMbps": num_or_null(d.demand, 2),
                        "minMbps": num_or_null(d.min, 2),
                        "snrDb": num_or_null(snr, 1),
                        "rssiDbm": rssi.map_or(Value::Null, |r| num_or_null(r, 1)),
                        "rateMbps": l.map_or(Value::Null, |l| num_or_null(l.rate, 1)),
                        "wifiMbps": l.map_or(Value::Null, |l| num_or_null(l.wifi, 2)),
                        "netMbps": l.map_or(Value::Null, |l| num_or_null(l.net, 2)),
                        "airtimePct": l.map_or(Value::Null, |l| num_or_null(l.got * 100.0, 2)),
                        "status": state,
                    })
                })
                .collect();
            json!({
                "floorId": ctx.floors[u.floor].id,
                "x": round_to(u.x, 2),
                "z": round_to(u.z, 2),
                "apId": ap.map_or(Value::Null, |a| ctx.aps[a].id.clone()),
                "apName": ap.map_or(Value::Null, |a| ctx.aps[a].label.clone()),
                "status": worst,
                "devices": devices,
            })
        })
        .collect();
    Value::Array(list)
}

// ---------------------------------------------------------------- one step

struct Step {
    users: usize,
    status: Status,
    kpis: Vec<Kpi>,
    ap_over_pct: Vec<f64>,
    json: Value,
}

fn sorted(v: impl IntoIterator<Item = f64>) -> Vec<f64> {
    let mut v: Vec<f64> = v.into_iter().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        f64::NAN
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn num_or_null(x: f64, digits: i32) -> Value {
    if x.is_finite() {
        Value::from(round_to(x, digits))
    } else {
        Value::Null
    }
}

fn run_step(env: &Env, users: usize, refined: bool) -> Step {
    let ctx = env.ctx;
    let lt = &env.lt;
    let people = env.people_for(users as f64);
    let mut dev = DevSamples::default();
    let iters: Vec<IterM> = (0..lt.runs)
        .map(|i| {
            let it = run_iteration(ctx, env.occ, &env.sampler, &env.sig, &env.mc, iteration_seed(env.mc.seed, i), &people);
            measure(env, &it, &mut dev, None)
        })
        .collect();
    let n = iters.len();
    let (c, lo_q) = (lt.conf, 1.0 - lt.conf);
    let hi = |v: Vec<f64>| percentile(&sorted(v), c);
    let lo = |v: Vec<f64>| percentile(&sorted(v), lo_q);
    let avail_s = sorted(dev.spare.iter().copied());
    let wifi_s = sorted(dev.wifi.iter().copied());
    let net_s = sorted(dev.net.iter().copied());
    let ratio_s = sorted(dev.ratio.iter().copied());

    let cfg = &ctx.cfg;
    let limit_air = cfg.target_utilisation * 100.0;
    let ratio_low = percentile(&ratio_s, lo_q);
    let tp = percentile(&wifi_s, lo_q);
    let tp_kpi = {
        // shown in Mbps; judged per device: below its own minimum fails, below
        // its own demand (the airtime has run out, but the minimum still holds) warns
        let full_low = percentile(&sorted(dev.full.iter().copied()), lo_q);
        let status = if ratio_low.is_finite() && ratio_low < 1.0 - 1e-9 {
            Status::Fail
        } else if full_low.is_finite() && full_low < 1.0 - 1e-9 {
            Status::Warning
        } else {
            Status::Pass
        };
        let simple = env.mc.profiles.is_none();
        Kpi {
            value: tp,
            limit: if simple { cfg.min_mbps } else { f64::NAN },
            warn_at: if simple { cfg.demand_mbps.max(cfg.min_mbps) } else { f64::NAN },
            status,
        }
    };
    let kpis = vec![
        judge(hi(iters.iter().map(|m| m.max_air * 100.0).collect()), limit_air, limit_air * lt.warn, true),
        // Wi-Fi alone: the internet plan is the "internet" KPI
        judge(lo(iters.iter().map(|m| m.meets_wifi.unwrap_or(1.0) * 100.0).collect()), lt.pass_meets, lt.warn_meets, false),
        tp_kpi,
        judge(hi(iters.iter().map(|m| m.max_dev).collect()), cfg.max_clients_per_ap, cfg.max_clients_per_ap * lt.warn, true),
        judge(hi(iters.iter().map(|m| m.wan_min * 100.0).collect()), 100.0, lt.warn * 100.0, true),
        judge(lo(iters.iter().map(|m| 100.0 - m.no_signal_pct).collect()), lt.pass_meets, lt.warn_meets, false),
        judge(hi(iters.iter().map(|m| m.max_lat).collect()), lt.latency_fail, lt.latency_warn, true),
        judge(hi(iters.iter().map(|m| m.max_retry).collect()), lt.retry_fail, lt.retry_warn, true),
    ];
    let status = kpis
        .iter()
        .zip(KPIS.iter())
        .filter(|(_, (_, est))| !est || lt.estimates_decide)
        .map(|(k, _)| k.status)
        .max()
        .unwrap_or(Status::Pass);

    let n_aps = ctx.aps.len();
    let ap_over_pct: Vec<f64> = (0..n_aps).map(|a| iters.iter().filter(|m| m.ap_over[a]).count() as f64 / n as f64 * 100.0).collect();
    let aps: Vec<Value> = (0..n_aps)
        .map(|a| {
            let mut status: BTreeMap<&str, usize> = BTreeMap::new();
            for m in &iters {
                *status.entry(m.ap_status[a]).or_insert(0) += 1;
            }
            let common = status.iter().max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0))).map(|(s, _)| *s).unwrap_or("no devices");
            // why it is overloaded in the runs where it is
            let mut why: BTreeMap<&str, usize> = BTreeMap::new();
            for m in iters.iter().filter(|m| m.ap_over[a]) {
                *why.entry(m.ap_status[a]).or_insert(0) += 1;
            }
            let over_reason = why.iter().max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0))).map(|(s, _)| *s);
            let (_, olo, ohi) = wilson(iters.iter().filter(|m| m.ap_over[a]).count(), n);
            json!({
                "airtimePct": num_or_null(percentile(&sorted(iters.iter().map(|m| m.ap_air[a] * 100.0)), 0.5), 1),
                "airtimeHighPct": num_or_null(hi(iters.iter().map(|m| m.ap_air[a] * 100.0).collect()), 1),
                "devices": num_or_null(percentile(&sorted(iters.iter().map(|m| m.ap_dev[a])), 0.5), 1),
                "activeDevices": num_or_null(percentile(&sorted(iters.iter().map(|m| m.ap_active[a])), 0.5), 1),
                "meetsMinimumPct": num_or_null(percentile(&sorted(iters.iter().filter_map(|m| m.ap_meets[a]).map(|x| x * 100.0)), 0.5), 1),
                "overloadPct": r1(ap_over_pct[a]),
                "overloadLow": r1(olo * 100.0),
                "overloadHigh": r1(ohi * 100.0),
                "latencyMs": num_or_null(percentile(&sorted(iters.iter().map(|m| m.ap_lat[a])), 0.5), 1),
                "retryPct": num_or_null(percentile(&sorted(iters.iter().map(|m| m.ap_retry[a])), 0.5), 1),
                "status": common,
                "overloadReason": over_reason,
            })
        })
        .collect();

    let kpi_json: Map<String, Value> = kpis
        .iter()
        .zip(KPIS.iter())
        .map(|(k, (id, est))| {
            (
                (*id).to_string(),
                json!({
                    "value": num_or_null(k.value, 1),
                    "limit": num_or_null(k.limit, 1),
                    "warnAt": num_or_null(k.warn_at, 1),
                    "status": k.status.text(),
                    "estimate": est,
                }),
            )
        })
        .collect();
    let failing: Vec<&str> = kpis.iter().zip(KPIS.iter()).filter(|(k, (_, est))| k.status == Status::Fail && (!est || lt.estimates_decide)).map(|(_, (id, _))| *id).collect();
    // the verdict for each part on its own: Wi-Fi radio, internet plan, coverage
    let part = |ids: &[&str]| {
        kpis.iter()
            .zip(KPIS.iter())
            .filter(|(_, (id, est))| ids.contains(id) && (!est || lt.estimates_decide))
            .map(|(k, _)| k.status)
            .max()
            .unwrap_or(Status::Pass)
            .text()
    };
    let json = json!({
        "users": users,
        "refined": refined,
        "status": status.text(),
        "wifiStatus": part(&["airtime", "minSpeed", "throughput", "devices", "latency", "retries"]),
        "internetStatus": part(&["internet"]),
        "coverageStatus": part(&["coverage"]),
        "failing": failing,
        "bottleneck": bottleneck_of(&failing),
        "kpis": kpi_json,
        "floor": {
            "usersSimulated": num_or_null(mean(&iters.iter().map(|m| m.users).collect::<Vec<_>>()), 1),
            "devices": num_or_null(mean(&iters.iter().map(|m| m.devices).collect::<Vec<_>>()), 1),
            "activeDevices": num_or_null(mean(&iters.iter().map(|m| m.active).collect::<Vec<_>>()), 1),
            "airtimeMaxPct": num_or_null(percentile(&sorted(iters.iter().map(|m| m.max_air * 100.0)), 0.5), 1),
            "airtimeMaxHighPct": num_or_null(hi(iters.iter().map(|m| m.max_air * 100.0).collect()), 1),
            // per active device: what it gets of its demand over Wi-Fi, and after the internet plan
            "wifiAvgMbps": num_or_null(mean(&wifi_s), 2),
            "wifiLowMbps": num_or_null(tp, 2),
            "netAvgMbps": num_or_null(mean(&net_s), 2),
            "netLowMbps": num_or_null(percentile(&net_s, lo_q), 2),
            // spare: what it could get if it wanted more (Wi-Fi)
            "spareAvgMbps": num_or_null(mean(&avail_s), 1),
            "spareLowMbps": num_or_null(percentile(&avail_s, lo_q), 1),
            "meetsMinimumWifiPct": num_or_null(mean(&iters.iter().map(|m| m.meets_wifi.unwrap_or(1.0) * 100.0).collect::<Vec<_>>()), 1),
            "meetsMinimumWifiLowPct": num_or_null(lo(iters.iter().map(|m| m.meets_wifi.unwrap_or(1.0) * 100.0).collect()), 1),
            "meetsMinimumPct": num_or_null(mean(&iters.iter().map(|m| m.meets.unwrap_or(1.0) * 100.0).collect::<Vec<_>>()), 1),
            "meetsMinimumLowPct": num_or_null(lo(iters.iter().map(|m| m.meets.unwrap_or(1.0) * 100.0).collect()), 1),
            "wanUsePct": num_or_null(mean(&iters.iter().map(|m| m.wan_typ * 100.0).collect::<Vec<_>>()), 1),
            "wanUseHighPct": num_or_null(hi(iters.iter().map(|m| m.wan_typ * 100.0).collect()), 1),
            "wanMinHighPct": num_or_null(hi(iters.iter().map(|m| m.wan_min * 100.0).collect()), 1),
            "noSignalPct": num_or_null(mean(&iters.iter().map(|m| m.no_signal_pct).collect::<Vec<_>>()), 1),
            "latencyMs": num_or_null(percentile(&sorted(iters.iter().map(|m| m.max_lat)), 0.5), 1),
            "latencyHighMs": num_or_null(hi(iters.iter().map(|m| m.max_lat).collect()), 1),
            "retryPct": num_or_null(percentile(&sorted(iters.iter().map(|m| m.max_retry)), 0.5), 1),
            "retryHighPct": num_or_null(hi(iters.iter().map(|m| m.max_retry).collect()), 1),
            // the load model settled in this share of runs (loadmodel.rs); below 100 the figures are less certain
            "convergedPct": r1(iters.iter().filter(|m| m.converged).count() as f64 / n.max(1) as f64 * 100.0),
        },
        "aps": aps,
    });
    Step { users, status, kpis, ap_over_pct, json }
}

fn bottleneck_of(failing: &[&str]) -> Value {
    let radio = failing.iter().any(|k| matches!(*k, "airtime" | "minSpeed" | "throughput" | "devices" | "latency" | "retries"));
    let internet = failing.contains(&"internet");
    let coverage = failing.contains(&"coverage");
    let mut v = Vec::new();
    if coverage {
        v.push("coverage");
    }
    if radio {
        v.push("radio");
    }
    if internet {
        v.push("internet");
    }
    json!(v)
}

// ---------------------------------------------------------------- heat maps

struct Heat {
    users: usize,
    acc: Vec<HeatAcc>,
    /// The users of the run whose share meeting the minimum is the median of the heat-map runs.
    dots: Value,
}

fn run_heat(env: &Env, users: usize) -> Heat {
    let people = env.people_for(users as f64);
    let mut acc = vec![HeatAcc::default(); env.probes.len()];
    let mut dev = DevSamples::default();
    let mut runs: Vec<(f64, usize, Value)> = Vec::new();
    for i in 0..env.lt.heat_runs {
        let it = run_iteration(env.ctx, env.occ, &env.sampler, &env.sig, &env.mc, iteration_seed(env.mc.seed, i), &people);
        let m = measure(env, &it, &mut dev, Some(&mut acc));
        dev.clear();
        if let Some(u) = m.users_json {
            runs.push((m.meets_wifi.unwrap_or(1.0), i, u));
        }
    }
    // the representative run: the median share of devices meeting their minimum
    runs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    let dots = if runs.is_empty() { Value::Null } else { runs.swap_remove((runs.len() - 1) / 2).2 };
    Heat { users, acc, dots }
}

fn heat_floor_json(env: &Env) -> Value {
    let ctx = env.ctx;
    let floors: Vec<Value> = (0..ctx.floors.len())
        .filter(|&f| env.probes.iter().any(|p| p.floor == f))
        .map(|f| {
            let idx: Vec<usize> = (0..env.probes.len()).filter(|&i| env.probes[i].floor == f).collect();
            let b = env.bin[f];
            let col = |g: &dyn Fn(&Probe) -> f64| Value::Array(idx.iter().map(|&i| num_or_null(g(&env.probes[i]), 1)).collect());
            json!({
                "floorId": ctx.floors[f].id,
                "name": ctx.floors[f].name,
                "size": round_to(b, 3),
                "x": col(&|p| ((p.x / b).floor() + 0.5) * b),
                "z": col(&|p| ((p.z / b).floor() + 0.5) * b),
                "rssi": col(&|p| p.cand.first().map_or(f64::NAN, |c| c.rssi)),
                "snr": col(&|p| p.cand.first().map_or(f64::NAN, |c| c.snr)),
                "bestAp": Value::Array(idx.iter().map(|&i| env.probes[i].cand.first().map_or(Value::Null, |c| ctx.aps[c.ap].id.clone())).collect()),
            })
        })
        .collect();
    Value::Array(floors)
}

fn heat_step_json(env: &Env, h: &Heat) -> Value {
    let ctx = env.ctx;
    let floors: Vec<Value> = (0..ctx.floors.len())
        .filter(|&f| env.probes.iter().any(|p| p.floor == f))
        .map(|f| {
            let idx: Vec<usize> = (0..env.probes.len()).filter(|&i| env.probes[i].floor == f).collect();
            let served = |g: &dyn Fn(&HeatAcc) -> f64| {
                Value::Array(idx.iter().map(|&i| {
                    let a = &h.acc[i];
                    if a.served > 0.0 { num_or_null(g(a) / a.served, 1) } else { Value::Null }
                }).collect())
            };
            // a device that finds no usable AP gets nothing: averaged over all runs
            let over_runs = |g: &dyn Fn(&HeatAcc) -> f64, digits: i32| {
                Value::Array(idx.iter().map(|&i| {
                    let a = &h.acc[i];
                    if a.n > 0.0 { num_or_null(g(a) / a.n, digits) } else { Value::Null }
                }).collect())
            };
            // load test: what a typical user standing there would get under that run's load, over the runs in
            // which it has a usable AP (null where it never has one: shown grey, not as 0 Mbps)
            let actual = |g: &dyn Fn(&HeatAcc) -> f64| served(&|a| g(a));
            let mut fl = json!({
                "floorId": ctx.floors[f].id,
                // per-user throughput of a typical active device there: over Wi-Fi, and after the internet plan
                "delivered": over_runs(&|a| a.delivered, 2),
                "deliveredNet": over_runs(&|a| a.delivered_net, 2),
                // spare: what one device there could get if it wanted more (Wi-Fi)
                "avail": over_runs(&|a| a.avail, 1),
                "air": served(&|a| a.air * 100.0),
                "rate": served(&|a| a.rate),
                "latency": served(&|a| a.lat),
                "retry": served(&|a| a.retry * 100.0),
                "fail": Value::Array(idx.iter().map(|&i| {
                    let a = &h.acc[i];
                    if a.dev_active > 0.0 { num_or_null(a.dev_fail / a.dev_active * 100.0, 1) } else { Value::Null }
                }).collect()),
                "ap": Value::Array(idx.iter().map(|&i| {
                    h.acc[i].ap_count.iter().max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0))).map_or(Value::Null, |(&a, _)| ctx.aps[a].id.clone())
                }).collect()),
            });
            if env.dynamic {
                fl["actual"] = actual(&|a| a.act_wifi);
                fl["actualNet"] = actual(&|a| a.act_net);
                // what one active user standing there could achieve under that load (not capped at its demand):
                // its data rate × its fair share of the airtime; over the runs where it has a usable AP
                fl["achievable"] = served(&|a| a.delivered);
                fl["achievableNet"] = served(&|a| a.delivered_net);
            }
            fl
        })
        .collect();
    let wan = h.acc.first().filter(|a| a.wan_n > 0.0).map_or(f64::NAN, |a| a.wan_cap / a.wan_n);
    let mut out = json!({ "users": h.users, "wanCapMbps": num_or_null(wan, 1), "floors": floors });
    if !h.dots.is_null() {
        // one representative run's users (dots); the squares are the average over all heat-map runs
        out["userDots"] = h.dots.clone();
    }
    out
}

/// The heat maps and the step's figures for any number of users, to compare
/// with the load test's own steps. Same grid, seeds and checks as `run`.
pub fn heatmap_at(plan: &Value, settings: Option<&Value>, cells: Option<&Value>, users: f64) -> Value {
    let ctx = Ctx::new(plan, settings, cells);
    let occ = ctx.occupancy();
    let env = Env::new(&ctx, &occ, settings, true);
    let u = if users.is_finite() { users.round().clamp(0.0, 1e6) as usize } else { 0 };
    if env.probes.is_empty() {
        return json!({ "users": u, "heat": null, "step": null });
    }
    let mut step = run_step(&env, u, true).json;
    step["custom"] = json!(true);
    let h = run_heat(&env, u);
    // the grid too, so one number of users can be shown on its own (Capacity simulation)
    json!({ "users": u, "heat": heat_step_json(&env, &h), "step": step, "floors": heat_floor_json(&env) })
}

/// Heat maps for the planner's own headcount (used by the Monte Carlo result).
pub(crate) fn heatmap_for(ctx: &Ctx, occ: &Occupancy, settings: Option<&Value>) -> Value {
    // the Monte Carlo result keeps the per-AP model: only the load test uses loadmodel.rs
    let env = Env::new(ctx, occ, settings, false);
    if env.probes.is_empty() {
        return Value::Null;
    }
    let people = env.base_people.clone();
    let mut acc = vec![HeatAcc::default(); env.probes.len()];
    let mut dev = DevSamples::default();
    for i in 0..env.lt.heat_runs {
        let it = run_iteration(ctx, occ, &env.sampler, &env.sig, &env.mc, iteration_seed(env.mc.seed, i), &people);
        measure(&env, &it, &mut dev, Some(&mut acc));
        dev.clear();
    }
    let h = Heat { users: env.base_total.round() as usize, acc, dots: Value::Null };
    json!({ "floors": heat_floor_json(&env), "step": heat_step_json(&env, &h) })
}

fn worst_locations(env: &Env, h: &Heat, limit: usize) -> Vec<Value> {
    let ctx = env.ctx;
    let mut rows: Vec<(f64, f64, usize)> = h
        .acc
        .iter()
        .enumerate()
        .filter(|(_, a)| a.dev_active > 0.0)
        .map(|(i, a)| (a.dev_fail / a.dev_active, if a.n > 0.0 { a.avail / a.n } else { 0.0 }, i))
        .filter(|(f, _, _)| *f > 0.0005)
        .collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.partial_cmp(&b.1).unwrap()).then(a.2.cmp(&b.2)));
    rows.iter()
        .take(limit)
        .map(|&(fail, avail, i)| {
            let p = &env.probes[i];
            let b = env.bin[p.floor];
            let ap = h.acc[i].ap_count.iter().max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0))).map(|(&a, _)| a);
            json!({
                "floorId": ctx.floors[p.floor].id,
                "x": round_to(((p.x / b).floor() + 0.5) * b, 2),
                "z": round_to(((p.z / b).floor() + 0.5) * b, 2),
                "failPct": r1(fail * 100.0),
                "availMbps": r1(avail),
                "apId": ap.map_or(Value::Null, |a| ctx.aps[a].id.clone()),
                "apName": ap.map_or(Value::Null, |a| ctx.aps[a].label.clone()),
            })
        })
        .collect()
}

/// How loaded the APs are with `users` people (deterministic expected loads,
/// for comparing AP positions quickly). An AP's load is its channel's airtime
/// or its share of the device limit (scaled to the airtime target),
/// whichever is worse. Returns (score, busiest load): the score is the
/// busiest load, plus a little for an uneven spread (so ties go to the spot
/// that shares the load best), plus the share of active devices without a
/// usable signal.
fn siting_score(env: &Env, ctx: &Ctx, users: f64) -> (f64, f64) {
    let cfg = &ctx.cfg;
    let area: f64 = env.occ.pts.iter().map(|q| q.area).sum();
    let mut units = Vec::new();
    for q in env.occ.pts.iter().filter(|q| q.has_ap) {
        let people = if env.base_total > 0.0 { q.people * users / env.base_total } else if area > 0.0 { q.area * users / area } else { 0.0 };
        let devices = people * cfg.devices_per_user;
        let cell = q.cell.map(|c| &ctx.floors[q.floor].cells[c]);
        units.push(crate::model::Unit {
            floor: q.floor,
            x: q.x,
            z: q.z,
            side: q.area.sqrt(),
            users: people,
            devices,
            active: devices * cfg.active_fraction,
            cand: ctx.candidates(q.floor, q.x, q.z, cell).0,
            demand: cfg.demand_mbps,
            min: cfg.min_mbps,
            peak: cfg.peak_mbps,
            up: cfg.upload_share,
            ap: None,
            snr: f64::NAN,
        });
    }
    let order = crate::model::default_order(ctx, &units);
    let (served, ns) = crate::model::associate(ctx, &mut units, &order);
    let ev = crate::model::evaluate(ctx, &units, &served, ns, crate::model::Traffic::Uniform);
    let loads: Vec<f64> = ev.rows.iter().map(|r| r.dom_typical.max(r.acc.devices / cfg.max_clients_per_ap * cfg.target_utilisation)).collect();
    let busiest = loads.iter().copied().fold(0.0, f64::max);
    let spread = if loads.is_empty() { 0.0 } else { loads.iter().map(|l| l * l).sum::<f64>() / loads.len() as f64 };
    let no_signal = if ev.wan.total_active > 0.0 { ev.ns.active / ev.wan.total_active } else { 0.0 };
    (busiest + 0.25 * spread + no_signal, busiest)
}

fn with_ap(plan: &Value, floor_id: &Value, x: f64, z: f64) -> Value {
    let mut p = plan.clone();
    let ap = json!({ "id": "proposed-ap", "kind": "wifi", "name": "Proposed AP", "floorId": floor_id, "x": x, "z": z, "proposed": true });
    match p.get_mut("sources") {
        Some(Value::Array(list)) => list.push(ap),
        _ => p["sources"] = json!([ap]),
    }
    p
}

/// Where one extra AP relieves the busiest AP most at `users` people: spots
/// spread over the area `ap` serves (at least 3 m from every AP) are each
/// tried with the extra AP in the plan; the best one is kept only if it
/// lowers the load. Returns (floor, x, z, busiest load before, after).
fn propose_near(env: &Env, h: &Heat, ap: usize, plan: &Value, settings: Option<&Value>, cells: Option<&Value>, users: f64) -> Option<(usize, f64, f64, f64, f64)> {
    let ctx = env.ctx;
    let floor = ctx.floors.iter().position(|f| f.aps.contains(&ap))?;
    let pool: Vec<usize> = (0..env.probes.len())
        .filter(|&i| {
            let p = &env.probes[i];
            p.floor == floor
                && h.acc[i].ap_count.get(&ap).copied().unwrap_or(0) > 0
                && ctx.floors[floor].aps.iter().all(|&a| (ctx.aps[a].x - p.x).hypot(ctx.aps[a].z - p.z) >= 3.0)
        })
        .collect();
    if pool.is_empty() {
        return None;
    }
    // farthest-point sampling: up to 16 spots spread over the area
    let a0 = &ctx.aps[ap];
    let far = |i: usize| (env.probes[i].x - a0.x).hypot(env.probes[i].z - a0.z);
    let mut picked = vec![*pool.iter().max_by(|&&a, &&b| far(a).partial_cmp(&far(b)).unwrap().then(b.cmp(&a)))?];
    while picked.len() < 16.min(pool.len()) {
        let next = pool
            .iter()
            .copied()
            .filter(|i| !picked.contains(i))
            .max_by(|&a, &b| {
                let d = |i: usize| picked.iter().map(|&j| (env.probes[i].x - env.probes[j].x).hypot(env.probes[i].z - env.probes[j].z)).fold(f64::INFINITY, f64::min);
                d(a).partial_cmp(&d(b)).unwrap().then(b.cmp(&a))
            });
        match next {
            Some(i) => picked.push(i),
            None => break,
        }
    }
    let (before_score, before) = siting_score(env, ctx, users);
    let floor_id = &ctx.floors[floor].id;
    let mut best: Option<(f64, f64, usize)> = None;
    for &i in &picked {
        let p = &env.probes[i];
        let trial = Ctx::new(&with_ap(plan, floor_id, p.x, p.z), settings, cells);
        let (s, busiest) = siting_score(env, &trial, users);
        if best.is_none_or(|(b, _, _)| s < b - 1e-12) {
            best = Some((s, busiest, i));
        }
    }
    let (score, after, i) = best?;
    (score < before_score * 0.98 && after < before).then(|| (floor, env.probes[i].x, env.probes[i].z, before, after))
}

/// Where an extra AP would cover the places with no usable signal.
fn propose_coverage(env: &Env, h: &Heat) -> Option<(usize, f64, f64)> {
    let mut per_floor: BTreeMap<usize, (f64, f64, f64)> = BTreeMap::new();
    for (i, p) in env.probes.iter().enumerate() {
        if h.acc[i].served == 0.0 && h.acc[i].n > 0.0 {
            let e = per_floor.entry(p.floor).or_insert((0.0, 0.0, 0.0));
            let w = h.acc[i].dev_active + 0.01;
            e.0 += w * p.x;
            e.1 += w * p.z;
            e.2 += w;
        }
    }
    let (&floor, &(sx, sz, sw)) = per_floor.iter().max_by(|a, b| a.1 .2.partial_cmp(&b.1 .2).unwrap())?;
    let (cx, cz) = (sx / sw, sz / sw);
    let snap = env
        .probes
        .iter()
        .filter(|p| p.floor == floor)
        .min_by(|p, q| (p.x - cx).hypot(p.z - cz).partial_cmp(&(q.x - cx).hypot(q.z - cz)).unwrap())?;
    Some((floor, snap.x, snap.z))
}

// ---------------------------------------------------------------- the run

pub fn run(plan: &Value, settings: Option<&Value>, cells: Option<&Value>) -> Value {
    let ctx = Ctx::new(plan, settings, cells);
    let occ = ctx.occupancy();
    let env = Env::new(&ctx, &occ, settings, true);
    let lt = &env.lt;
    let n_aps = ctx.aps.len();

    let mut coarse: Vec<usize> = (0..).map(|i| lt.start + i * lt.step).take_while(|&u| u <= lt.max).collect();
    if coarse.last() != Some(&lt.max) {
        coarse.push(lt.max);
    }
    // a rough count of the work for the progress bar
    let refine_guess = ((lt.step as f64 / lt.refine as f64).log2().ceil().max(0.0) as usize) * 2;
    let heat_guess = coarse.len().min(lt.max_heat_steps) + 2;
    let mut total = coarse.len() + refine_guess + (heat_guess * lt.heat_runs).div_ceil(lt.runs.max(1));
    let mut done = 0;
    progress(done, total);

    let mut steps: BTreeMap<usize, Step> = BTreeMap::new();
    let mut fails_in_a_row = 0;
    let mut tested_up_to = 0;
    for &u in &coarse {
        let s = run_step(&env, u, false);
        done += 1;
        progress(done, total);
        tested_up_to = u;
        fails_in_a_row = if s.status == Status::Fail { fails_in_a_row + 1 } else { 0 };
        steps.insert(u, s);
        if lt.stop_after_fail > 0 && fails_in_a_row > lt.stop_after_fail {
            break;
        }
    }
    let coarse: Vec<usize> = coarse.into_iter().filter(|&u| u <= tested_up_to).collect();

    // narrow down where a condition first holds, between a count where it does not and one where it does
    let mut bisect = |steps: &mut BTreeMap<usize, Step>, failed: &dyn Fn(&Step) -> bool| -> Option<usize> {
        let first = coarse.iter().position(|u| failed(&steps[u]))?;
        if first == 0 {
            return Some(coarse[0]);
        }
        let (mut ok, mut bad) = (coarse[first - 1], coarse[first]);
        // results already known in between (from an earlier bisection)
        for (&u, s) in steps.range(ok + 1..bad) {
            if failed(s) {
                bad = u;
                break;
            }
            ok = u;
        }
        while bad - ok > lt.refine {
            let mid = ok + (bad - ok) / 2;
            if !steps.contains_key(&mid) {
                if done >= total {
                    total = done + 1;
                }
                steps.insert(mid, run_step(&env, mid, true));
                done += 1;
                progress(done, total);
            }
            if failed(&steps[&mid]) {
                bad = mid;
            } else {
                ok = mid;
            }
        }
        Some(bad)
    };
    let first_fail = bisect(&mut steps, &|s: &Step| s.status == Status::Fail);
    let kpi_first_fail: Vec<Option<usize>> = (0..KPIS.len()).map(|k| bisect(&mut steps, &|s: &Step| s.kpis[k].status == Status::Fail)).collect();
    let kpi_first_warn: Vec<Option<usize>> = (0..KPIS.len()).map(|k| steps.values().find(|s| s.kpis[k].status >= Status::Warning).map(|s| s.users)).collect();
    let first_warn = steps.values().find(|s| s.status >= Status::Warning).map(|s| s.users);
    let max_supported = match first_fail {
        Some(f) => steps.range(..f).next_back().filter(|(_, s)| s.status != Status::Fail).map(|(&u, _)| u),
        None => Some(tested_up_to),
    };

    // when each AP is first overloaded in more than (100 − confidence)% of the runs
    let over_limit = (1.0 - lt.conf) * 100.0;
    let ap_first: Vec<Option<usize>> = (0..n_aps).map(|a| steps.values().find(|s| s.ap_over_pct[a] > over_limit).map(|s| s.users)).collect();
    let first_ap = (0..n_aps).filter(|&a| ap_first[a].is_some()).min_by(|&a, &b| {
        let (ua, ub) = (ap_first[a].unwrap(), ap_first[b].unwrap());
        ua.cmp(&ub).then(steps[&ub].ap_over_pct[b].partial_cmp(&steps[&ua].ap_over_pct[a]).unwrap_or(std::cmp::Ordering::Equal)).then(a.cmp(&b))
    });

    // heat maps: the coarse steps (thinned out evenly), plus the key headcounts
    let mut heat_users: BTreeSet<usize> = BTreeSet::new();
    let k = coarse.len();
    if k <= lt.max_heat_steps {
        heat_users.extend(coarse.iter().copied());
    } else {
        for i in 0..lt.max_heat_steps {
            heat_users.insert(coarse[i * (k - 1) / (lt.max_heat_steps - 1).max(1)]);
        }
    }
    heat_users.extend(first_fail);
    heat_users.extend(max_supported.filter(|&u| u > 0));
    total = done + (heat_users.len() * lt.heat_runs).div_ceil(lt.runs.max(1));
    let heats: Vec<Heat> = if env.probes.is_empty() {
        Vec::new()
    } else {
        heat_users
            .iter()
            .enumerate()
            .map(|(i, &u)| {
                let h = run_heat(&env, u);
                progress(done + ((i + 1) * lt.heat_runs).div_ceil(lt.runs.max(1)), total);
                h
            })
            .collect()
    };
    let heat_at = |u: usize| heats.iter().find(|h| h.users == u);
    let focus = first_fail.or(Some(tested_up_to)).and_then(heat_at);

    // what failed at the first failing headcount
    let mut failing_at_first: Vec<Value> = Vec::new();
    let mut proposal = Value::Null;
    let mut recommendations: Vec<String> = Vec::new();
    let mut internet_needed = Value::Null;
    if let Some(f) = first_fail {
        let s = &steps[&f];
        let mut over: Vec<usize> = (0..n_aps).filter(|&a| s.ap_over_pct[a] > 0.0).collect();
        over.sort_by(|&a, &b| s.ap_over_pct[b].partial_cmp(&s.ap_over_pct[a]).unwrap().then(a.cmp(&b)));
        // the APs over the limit; with many APs the network can fail while each one
        // is rarely overloaded on its own: then the ones overloaded most often
        let above = over.iter().filter(|&&a| s.ap_over_pct[a] > over_limit).count();
        over.truncate(if above > 0 { above } else { 3 });
        for &a in &over {
            failing_at_first.push(json!({
                "kind": "ap", "id": ctx.aps[a].id, "name": ctx.aps[a].label,
                "reason": s.json["aps"][a]["overloadReason"], "overloadPct": r1(s.ap_over_pct[a]),
            }));
        }
        let internet = &s.kpis[4];
        failing_at_first.push(json!({
            "kind": "internet",
            "status": internet.status.text(),
            "usePct": s.json["floor"]["wanMinHighPct"],
        }));
        let fails = |id: &str| s.json["failing"].as_array().is_some_and(|a| a.iter().any(|v| v == id));
        if fails("internet") {
            let need = s.json["floor"]["wanMinHighPct"].as_f64().unwrap_or(100.0) / 100.0 * ctx.cfg.wan_down;
            let need = (need / 50.0).ceil() * 50.0;
            internet_needed = json!(need);
            recommendations.push(format!(
                "The internet plan limits the network at {f} users: about {} Mbps download (with the same spare share) would carry the minimum speed. More APs do not help this.",
                need
            ));
        }
        let radio_fails = s.json["bottleneck"].as_array().is_some_and(|a| a.iter().any(|v| v == "radio"));
        let place = if fails("coverage") {
            focus.and_then(|h| propose_coverage(&env, h)).map(|(f, x, z)| ((f, x, z, f64::NAN, f64::NAN), None))
        } else if radio_fails {
            let found = over.first().and_then(|&a| focus.and_then(|h| propose_near(&env, h, a, plan, settings, cells, f as f64)).map(|p| (p, Some(a))));
            if found.is_none() && !over.is_empty() {
                recommendations.push(format!(
                    "No single extra AP near {} lowered the load in a quick check: look at the channel plan, the channel width or load-aware association, or add more than one AP.",
                    crate::js::to_str(Some(&ctx.aps[over[0]].label))
                ));
            }
            found
        } else {
            None
        };
        if let Some(((floor, x, z, before, after), near)) = place {
            proposal = json!({
                "floorId": ctx.floors[floor].id,
                "x": round_to(x, 2),
                "z": round_to(z, 2),
                "nearApId": near.map_or(Value::Null, |a| ctx.aps[a].id.clone()),
                "nearApName": near.map_or(Value::Null, |a| ctx.aps[a].label.clone()),
                "reason": if near.is_some() { "radio" } else { "coverage" },
                "users": f,
                // quick deterministic check used to choose the spot; the rerun is the real test
                "busiestLoadBeforePct": num_or_null(before * 100.0, 1),
                "busiestLoadAfterPct": num_or_null(after * 100.0, 1),
            });
            recommendations.push(match near {
                Some(a) => format!(
                    "Add or move an AP near ({}, {}) m on {} to take load off {}, then rerun the test: it shows whether that actually raises the number of users.",
                    round_to(x, 1), round_to(z, 1), crate::js::to_str(Some(&ctx.floors[floor].name)), crate::js::to_str(Some(&ctx.aps[a].label))
                ),
                None => format!(
                    "Add an AP near ({}, {}) m on {} where devices find no usable signal, then rerun the test.",
                    round_to(x, 1), round_to(z, 1), crate::js::to_str(Some(&ctx.floors[floor].name))
                ),
            });
        }
        if fails("devices") {
            recommendations.push("Some APs hold more devices than the limit set on the Wi-Fi tab: spread the devices with more APs or load-aware association.".into());
        }
        if f == coarse[0] {
            recommendations.push(format!("The network already fails at the first step ({f} users): lower the starting number to find where it starts."));
        }
    } else {
        recommendations.push(format!("No step failed up to {tested_up_to} users: raise the maximum to find the limit."));
    }
    if ctx.aps.iter().any(|a| a.proposed) {
        recommendations.push("Proposed APs have no ray-traced prediction: their signal is estimated from distance. Run the ray-traced prediction with the AP in place to confirm.".into());
    }

    let kpi_ids: Vec<&str> = KPIS.iter().map(|(id, _)| *id).collect();
    let first_map = |v: &[Option<usize>]| -> Map<String, Value> { kpi_ids.iter().zip(v).map(|(id, u)| ((*id).to_string(), json!(u))).collect() };
    let mut used = lt.raw.clone();
    used.insert("stepUsers".into(), json!(lt.step));
    let mut notes = occ.notes.clone();
    notes.extend(lt.notes.iter().cloned());
    if env.base_total <= 0.0 {
        notes.push("The plan holds nobody yet, so people are spread over the floor by area.".into());
    }
    if n_aps == 0 {
        notes.push("The plan has no access points.".into());
    }
    let pct = |x: f64| crate::js::fmt_num(r1(x * 100.0));

    json!({
        "settings": used,
        "runsPerStep": lt.runs,
        "seed": env.mc.seed.to_string(),
        "aps": (0..n_aps).map(|a| json!({
            "id": ctx.aps[a].id, "name": ctx.aps[a].label, "floorId": ctx.aps[a].floor,
            "channel": ctx.chan.assign.get(a).copied().filter(|c| !c.is_nan()),
            "proposed": ctx.aps[a].proposed,
            "firstOverloadUsers": ap_first[a],
        })).collect::<Vec<_>>(),
        "steps": steps.values().map(|s| s.json.clone()).collect::<Vec<_>>(),
        "result": {
            "maxSupportedUsers": max_supported,
            "firstFailUsers": first_fail,
            "degradationStartsUsers": first_warn,
            "testedUpToUsers": tested_up_to,
            "failsAtStart": first_fail == coarse.first().copied(),
            "resolutionUsers": lt.refine,
            "firstOverloadedAp": first_ap.map(|a| json!({ "id": ctx.aps[a].id, "name": ctx.aps[a].label, "users": ap_first[a] })),
            "bottleneck": first_fail.map_or(json!([]), |f| steps[&f].json["bottleneck"].clone()),
            "failingAtFirstFail": failing_at_first,
            "internetNeededMbps": internet_needed,
        },
        "kpiFirstFail": first_map(&kpi_first_fail),
        "kpiFirstWarn": first_map(&kpi_first_warn),
        "heatmaps": if heats.is_empty() { Value::Null } else { json!({
            "floors": heat_floor_json(&env),
            "steps": heats.iter().map(|h| heat_step_json(&env, h)).collect::<Vec<_>>(),
        }) },
        "worstLocations": focus.map_or(Vec::new(), |h| worst_locations(&env, h, 10)),
        "proposal": proposal,
        "recommendations": recommendations,
        "assumptions": [
            "The APs, their channels and the ray-traced prediction stay fixed; only the number of people changes. People are spread the way the planner spreads them (zones, rooms, desks), scaled to each total.".to_string(),
            format!("Each step is {} Monte Carlo runs of whole users and devices, with the same seeds at every step.", lt.runs),
            format!(
                "A step fails when, in {}% of the runs, the busiest channel is over {}% airtime, fewer than {}% of active devices get their minimum speed over Wi-Fi, an AP holds more than {} devices, the internet plan cannot carry the minimum speed, or fewer than {}% of devices have a usable signal. It is a warning within {}% of a limit. Wi-Fi, internet and coverage each get their own verdict.",
                pct(lt.conf), crate::js::fmt_num(r1(ctx.cfg.target_utilisation * 100.0)), crate::js::fmt_num(lt.pass_meets),
                ctx.cfg.text("maxClientsPerAp"), crate::js::fmt_num(lt.pass_meets), crate::js::fmt_num(r1(100.0 - lt.warn * 100.0))
            ),
            format!("Between the last passing and the first failing step the number of users is narrowed to {} users by bisection.", lt.refine),
            "Per-user throughput (Wi-Fi) is what an active device gets of its own demand: all of it while its channel has airtime to spare; once the channel needs more than 100% of its airtime, every device on it gets the same smaller share. It never exceeds the device's data rate. Per-user throughput (with internet) is that, scaled down when the internet plan cannot carry everyone's demand.".to_string(),
            "Spare capacity is what one device could get if it wanted more: its data rate times the airtime its channel has left (at least an equal share with the active devices on it). It is Wi-Fi only.".to_string(),
            format!("Latency and retries are estimates: access delay of {} ms per transmission divided by the airtime left, and collisions between the active devices on a channel (Bianchi's 802.11 model). They do not decide Pass or Fail unless that is switched on.", crate::js::fmt_num(lt.txop_ms)),
            "RSSI and SNR do not change with the number of users and are shown once, as the baseline.".to_string(),
            "Positions are simulated and traffic is modelled demand: check the result against site measurements.".to_string(),
        ],
        "notes": notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bianchi_collisions_grow_with_stations() {
        assert_eq!(collision_prob(1.0), 0.0);
        let p2 = collision_prob(2.0);
        let p10 = collision_prob(10.0);
        let p50 = collision_prob(50.0);
        assert!(p2 > 0.0 && p2 < p10 && p10 < p50 && p50 < 1.0, "{p2} {p10} {p50}");
        // W = 16, m = 6: about 0.11 with 2 stations
        assert!((p2 - 0.11).abs() < 0.03, "{p2}");
    }

    #[test]
    fn judge_directions() {
        assert_eq!(judge(60.0, 50.0, 42.5, true).status, Status::Fail);
        assert_eq!(judge(45.0, 50.0, 42.5, true).status, Status::Warning);
        assert_eq!(judge(30.0, 50.0, 42.5, true).status, Status::Pass);
        assert_eq!(judge(90.0, 95.0, 99.0, false).status, Status::Fail);
        assert_eq!(judge(97.0, 95.0, 99.0, false).status, Status::Warning);
        assert_eq!(judge(f64::NAN, 95.0, 99.0, false).status, Status::Pass);
    }
}
