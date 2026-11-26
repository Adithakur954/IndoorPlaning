//! Monte Carlo capacity: individual users at sampled positions, with their
//! own devices and traffic, repeated over many seeded iterations.
//!
//! Each iteration
//!   1. places every person as one user at an x, z position, drawn from the
//!      same occupancy weights as the deterministic model (floor, rooms,
//!      zones, desks and seats) and jittered inside its grid square;
//!   2. gives each user whole devices (devices per person, rounded at random
//!      so the average is kept) and each device a traffic profile;
//!   3. reads each AP's signal at the device's position (the ray-traced cell
//!      it stands in, scaled by distance for the other APs) — the prediction
//!      is reused, never recomputed;
//!   4. associates devices with APs and evaluates airtime, shared channels
//!      and the internet plan with the deterministic engine's own functions.
//!
//! The results are distributions over the iterations (mean, P5, P50, P95),
//! the probability that each AP is overloaded (with a 95% interval), and the
//! full per-user detail of a typical (median) and a bad (worst) iteration.

use crate::js::{finite, num, r1, to_str};
use crate::model::{associate, evaluate, plan_capacity_ctx, Ctx, Eval, Occupancy, Traffic, Unit};
use crate::rng::{iteration_seed, Rng};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};

pub fn defaults() -> Value {
    json!({
        "iterations": 200,
        "maxIterations": 2000,
        "targetCiPct": 3,
        "seed": 1,
        "traffic": "simple",
        "peopleVariationPct": 0,
        "binM": 2,
        "profiles": [
            { "id": "idle", "name": "Idle / background", "share": 0.5, "active": false, "minMbps": 0, "lowMbps": 0, "highMbps": 0, "uploadShare": 0.5 },
            { "id": "browsing", "name": "Web, email, chat", "share": 0.22, "active": true, "minMbps": 1, "lowMbps": 0.5, "highMbps": 2, "uploadShare": 0.1 },
            { "id": "video-call", "name": "Video call", "share": 0.12, "active": true, "minMbps": 1.5, "lowMbps": 1.5, "highMbps": 4, "uploadShare": 1 },
            { "id": "streaming", "name": "Video streaming", "share": 0.08, "active": true, "minMbps": 3, "lowMbps": 3, "highMbps": 8, "uploadShare": 0.05 },
            { "id": "download", "name": "Large download or upload", "share": 0.03, "active": true, "minMbps": 5, "lowMbps": 10, "highMbps": 50, "uploadShare": 0.2 },
            { "id": "voice", "name": "Voice call", "share": 0.05, "active": true, "minMbps": 0.1, "lowMbps": 0.1, "highMbps": 0.2, "uploadShare": 1 }
        ]
    })
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub share: f64,
    pub active: bool,
    pub min: f64,
    pub low: f64,
    pub high: f64,
    pub up: f64,
}

pub struct McCfg {
    pub iterations: usize,
    pub max_iterations: usize,
    pub target_ci: f64,
    pub seed: u64,
    /// None = simple traffic: active with the activity share, at the
    /// deterministic typical / minimum / peak speeds.
    pub profiles: Option<Vec<Profile>>,
    pub people_variation: f64,
    pub bin_m: f64,
    pub raw: Map<String, Value>,
}

impl McCfg {
    pub fn new(settings: Option<&Value>) -> McCfg {
        let mut raw = match defaults() {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        if let Some(Value::Object(m)) = settings.and_then(|s| s.get("monteCarlo")) {
            for (k, v) in m {
                raw.insert(k.clone(), v.clone());
            }
        }
        let n = |k: &str, d: f64| finite(raw.get(k)).unwrap_or(d);
        let iterations = n("iterations", 200.0).clamp(1.0, 100_000.0) as usize;
        let max_iterations = (n("maxIterations", 2000.0).clamp(1.0, 100_000.0) as usize).max(iterations);
        let profiles = if crate::js::is_str(raw.get("traffic"), "profiles") {
            let list: Vec<Profile> = match raw.get("profiles") {
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|p| {
                        let low = num(p.get("lowMbps")).max(0.0);
                        Profile {
                            id: to_str(p.get("id")),
                            name: to_str(crate::js::or(p.get("name"), p.get("id"))),
                            share: num(p.get("share")).max(0.0),
                            active: p.get("active").and_then(Value::as_bool).unwrap_or(true),
                            min: num(p.get("minMbps")).max(0.0),
                            low,
                            high: num(p.get("highMbps")).max(low),
                            up: num(p.get("uploadShare")).max(0.0),
                        }
                    })
                    .filter(|p| p.share > 0.0 && p.low.is_finite() && p.high.is_finite() && p.min.is_finite())
                    .collect(),
                _ => Vec::new(),
            };
            (!list.is_empty()).then_some(list)
        } else {
            None
        };
        McCfg {
            iterations,
            max_iterations,
            target_ci: n("targetCiPct", 3.0).clamp(0.1, 50.0) / 100.0,
            seed: n("seed", 1.0).abs() as u64,
            profiles,
            people_variation: n("peopleVariationPct", 0.0).clamp(0.0, 100.0) / 100.0,
            bin_m: n("binM", 2.0).clamp(0.5, 50.0),
            raw,
        }
    }
}

// ---------------------------------------------------------------- sampling

/// Cumulative occupancy weights per group, to draw positions from.
pub(crate) struct Sampler {
    cum: Vec<Vec<f64>>,
}

impl Sampler {
    pub(crate) fn new(occ: &Occupancy) -> Sampler {
        let cum = occ
            .groups
            .iter()
            .map(|g| {
                let mut s = 0.0;
                g.pts
                    .iter()
                    .map(|&p| {
                        s += occ.pts[p].w.max(0.0);
                        s
                    })
                    .collect()
            })
            .collect();
        Sampler { cum }
    }

    /// A point of the group, with probability proportional to its weight.
    fn draw(&self, occ: &Occupancy, group: usize, rng: &mut Rng) -> usize {
        let cum = &self.cum[group];
        let pts = &occ.groups[group].pts;
        let total = cum.last().copied().unwrap_or(0.0);
        if !(total > 0.0) {
            return pts[rng.below(pts.len())];
        }
        let r = rng.f64() * total;
        let i = cum.partition_point(|&c| c <= r).min(pts.len() - 1);
        pts[i]
    }
}

/// The prediction cell that contains a position, per floor.
pub(crate) struct SignalIndex {
    floors: Vec<Option<(f64, f64, f64, HashMap<(i64, i64), usize>)>>,
}

impl SignalIndex {
    pub(crate) fn new(ctx: &Ctx) -> SignalIndex {
        let floors = ctx
            .floors
            .iter()
            .map(|f| {
                let first = f.cells.first()?;
                let step = num(first.step.as_ref());
                let step = if step > 0.0 { step } else { 1.0 };
                let mut map = HashMap::new();
                for (i, c) in f.cells.iter().enumerate() {
                    if c.x.is_finite() && c.z.is_finite() {
                        map.entry((((c.x - first.x) / step).round() as i64, ((c.z - first.z) / step).round() as i64)).or_insert(i);
                    }
                }
                Some((first.x, first.z, step, map))
            })
            .collect();
        SignalIndex { floors }
    }

    pub(crate) fn cell(&self, floor: usize, x: f64, z: f64) -> Option<usize> {
        let (x0, z0, step, map) = self.floors[floor].as_ref()?;
        map.get(&(((x - x0) / step).round() as i64, ((z - z0) / step).round() as i64)).copied()
    }
}

/// A position inside the point's grid square that belongs to the same group
/// (zone, room headcount or free floor) and the same kind of area, so users
/// never land in an excluded room, an empty zone or outside the building.
fn jitter(ctx: &Ctx, occ: &Occupancy, p: usize, rng: &mut Rng) -> (f64, f64) {
    let pt = &occ.pts[p];
    let floor = &ctx.floors[pt.floor];
    let in_areas = |x: f64, z: f64| floor.areas.is_empty() || floor.areas.iter().any(|a| crate::geometry::inside(x, z, a));
    let kind = occ.groups[pt.group].kind;
    let centre_in = in_areas(pt.x, pt.z);
    let half = occ.side[pt.floor] / 2.0;
    for _ in 0..8 {
        let x = pt.x + (2.0 * rng.f64() - 1.0) * half;
        let z = pt.z + (2.0 * rng.f64() - 1.0) * half;
        if let Some((k, _)) = ctx.place(pt.floor, x, z) {
            if k == kind && in_areas(x, z) == centre_in {
                return (x, z);
            }
        }
    }
    (pt.x, pt.z)
}

// ---------------------------------------------------------------- one iteration

pub(crate) struct User {
    pub floor: usize,
    pub x: f64,
    pub z: f64,
    pub room: Option<usize>,
    pub zone: Option<usize>,
    pub devices: Vec<Device>,
}

pub(crate) struct Device {
    pub profile: Option<usize>,
    pub active: bool,
    pub demand: f64,
    pub min: f64,
    /// Index into the iteration's units, or None on a floor without APs.
    pub unit: Option<usize>,
}

pub(crate) struct Iteration {
    pub users: Vec<User>,
    pub units: Vec<Unit>,
    pub ev: Eval,
    pub unserved_devices: usize,
}

#[derive(Clone, Default)]
struct IterStats {
    users: f64,
    devices: f64,
    active: f64,
    demand_typical: f64,
    meets: Option<f64>,
    overloaded_aps: f64,
    no_signal: f64,
    all_ok: bool,
    internet_ok: bool,
    radio_ok: bool,
    ap_devices: Vec<f64>,
    ap_active: Vec<f64>,
    ap_typical: Vec<f64>,
    ap_shared_min: Vec<f64>,
    ap_meets: Vec<Option<f64>>,
    ap_over: Vec<bool>,
    ap_status: Vec<&'static str>,
}

/// One iteration with people[g] people in occupancy group g.
pub(crate) fn run_iteration(ctx: &Ctx, occ: &Occupancy, sampler: &Sampler, sig: &SignalIndex, mc: &McCfg, seed: u64, people: &[f64]) -> Iteration {
    let cfg = &ctx.cfg;
    let mut rng = Rng::new(seed);
    let scale = if mc.people_variation > 0.0 { 1.0 + mc.people_variation * (2.0 * rng.f64() - 1.0) } else { 1.0 };
    let share_total: f64 = mc.profiles.as_ref().map_or(0.0, |ps| ps.iter().map(|p| p.share).sum());

    let mut users = Vec::new();
    let mut units = Vec::new();
    let mut unserved_devices = 0;
    for (gi, g) in occ.groups.iter().enumerate() {
        if g.pts.is_empty() {
            continue;
        }
        let n = rng.round_stochastic(people[gi] * scale);
        for _ in 0..n {
            let p = sampler.draw(occ, gi, &mut rng);
            let (x, z) = jitter(ctx, occ, p, &mut rng);
            let pt = &occ.pts[p];
            let (room, zone) = match ctx.place(pt.floor, x, z) {
                Some((kind, room)) => (room, if let crate::model::GroupKind::Zone(i) = kind { Some(i) } else { None }),
                None => (pt.room, None),
            };
            let n_dev = rng.round_stochastic(cfg.devices_per_user);
            let mut devices = Vec::with_capacity(n_dev);
            for _ in 0..n_dev {
                let (profile, active, demand, min, peak, up) = match &mc.profiles {
                    Some(ps) => {
                        let mut r = rng.f64() * share_total;
                        let mut k = ps.len() - 1;
                        for (i, pr) in ps.iter().enumerate() {
                            if r < pr.share {
                                k = i;
                                break;
                            }
                            r -= pr.share;
                        }
                        let pr = &ps[k];
                        let demand = pr.low + (pr.high - pr.low) * rng.f64();
                        (Some(k), pr.active, demand, pr.min, pr.high, pr.up)
                    }
                    None => (None, rng.f64() < cfg.active_fraction, cfg.demand_mbps, cfg.min_mbps, cfg.peak_mbps, cfg.upload_share),
                };
                let unit = if pt.has_ap {
                    let cell = sig.cell(pt.floor, x, z).or(pt.cell).map(|c| &ctx.floors[pt.floor].cells[c]);
                    let (cand, _) = ctx.candidates(pt.floor, x, z, cell);
                    units.push(Unit {
                        floor: pt.floor,
                        x,
                        z,
                        side: 0.0,
                        users: 1.0 / n_dev as f64,
                        devices: 1.0,
                        active: if active { 1.0 } else { 0.0 },
                        cand,
                        demand,
                        min,
                        peak,
                        up,
                        ap: None,
                        snr: f64::NAN,
                    });
                    Some(units.len() - 1)
                } else {
                    unserved_devices += 1;
                    None
                };
                devices.push(Device { profile, active, demand, min, unit });
            }
            users.push(User { floor: pt.floor, x, z, room, zone, devices });
        }
    }
    // devices are considered in a random order; load-aware association takes
    // the active ones first, as the deterministic engine does
    let mut order: Vec<usize> = (0..units.len()).collect();
    rng.shuffle(&mut order);
    if cfg.load_aware {
        order.sort_by(|&a, &b| units[b].active.partial_cmp(&units[a].active).unwrap_or(std::cmp::Ordering::Equal));
    }
    let (served, ns) = associate(ctx, &mut units, &order);
    let ev = evaluate(ctx, &units, &served, ns, Traffic::PerUnit);
    Iteration { users, units, ev, unserved_devices }
}

fn stats_of(ctx: &Ctx, it: &Iteration) -> IterStats {
    let ev = &it.ev;
    let w = &ev.wan;
    let internet_ok = w.demand_min <= w.usable_down;
    let coverage_ok = ev.ns.active == 0.0 && it.unserved_devices == 0;
    let meets = (w.total_active > 0.0).then(|| ev.rows.iter().fold(0.0, |s, r| s + r.meets * r.acc.active) / w.total_active);
    IterStats {
        users: it.users.len() as f64,
        devices: w.total_devices + it.unserved_devices as f64,
        active: w.total_active,
        demand_typical: w.demand_typical,
        meets,
        overloaded_aps: ev.rows.iter().filter(|r| r.radio_limited).count() as f64,
        no_signal: ev.ns.devices,
        all_ok: internet_ok && !ev.radio_short && coverage_ok,
        internet_ok,
        radio_ok: !ev.radio_short,
        ap_devices: ev.rows.iter().map(|r| r.acc.devices).collect(),
        ap_active: ev.rows.iter().map(|r| r.acc.active).collect(),
        ap_typical: ev.rows.iter().map(|r| r.acc.typical).collect(),
        ap_shared_min: ev.rows.iter().map(|r| r.dom_min).collect(),
        ap_meets: ev.rows.iter().map(|r| (r.acc.active > 0.0).then_some(r.meets)).collect(),
        ap_over: ev.rows.iter().map(|r| r.radio_limited || r.clients_over).collect(),
        ap_status: (0..ctx.aps.len()).map(|i| ev.rows[i].status).collect(),
    }
}

/// How likely each active device is to miss its minimum speed, by location.
fn add_bins(ctx: &Ctx, it: &Iteration, bin: f64, bins: &mut BTreeMap<(usize, i64, i64), (f64, f64)>) {
    for u in &it.units {
        if u.active <= 0.0 {
            continue;
        }
        let fail = device_failure(ctx, it, u);
        let e = bins.entry((u.floor, (u.x / bin).floor() as i64, (u.z / bin).floor() as i64)).or_insert((0.0, 0.0));
        e.0 += 1.0;
        e.1 += fail;
    }
}

/// The share of this device's minimum speed that the radio cannot give:
/// 1 with no usable AP or too weak a signal, 1 − 1/airtime when its channel
/// is over-subscribed, else 0. (The internet plan is a whole-site limit and is
/// reported separately.)
pub(crate) fn device_failure(ctx: &Ctx, it: &Iteration, u: &Unit) -> f64 {
    let Some(ap) = u.ap else { return 1.0 };
    if ctx.rate_of(u.snr) < u.min {
        return 1.0;
    }
    let dom = it.ev.rows[ap].dom_min;
    if dom > 1.0 {
        1.0 - 1.0 / dom
    } else {
        0.0
    }
}

// ---------------------------------------------------------------- statistics

pub(crate) fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let pos = p * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

pub(crate) fn round_to(x: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (x * f).round() / f
}

/// mean, P5, P50, P95, min and max of a metric over the iterations.
fn dist(values: impl IntoIterator<Item = f64>, scale: f64) -> Value {
    let mut v: Vec<f64> = values.into_iter().filter(|x| x.is_finite()).map(|x| x * scale).collect();
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    json!({
        "mean": round_to(mean, 2),
        "p5": round_to(percentile(&v, 0.05), 2),
        "p50": round_to(percentile(&v, 0.5), 2),
        "p95": round_to(percentile(&v, 0.95), 2),
        "min": round_to(v[0], 2),
        "max": round_to(v[v.len() - 1], 2),
    })
}

/// Wilson 95% interval of a proportion: (p, low, high).
pub(crate) fn wilson(k: usize, n: usize) -> (f64, f64, f64) {
    if n == 0 {
        return (0.0, 0.0, 1.0);
    }
    let (k, n) = (k as f64, n as f64);
    let z = 1.959_963_984_540_054;
    let p = k / n;
    let d = 1.0 + z * z / n;
    let c = (p + z * z / (2.0 * n)) / d;
    let h = z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt() / d;
    (p, (c - h).max(0.0), (c + h).min(1.0))
}

fn prob(k: usize, n: usize) -> Value {
    let (p, lo, hi) = wilson(k, n);
    json!({ "pct": r1(p * 100.0), "low": r1(lo * 100.0), "high": r1(hi * 100.0) })
}

fn max_half_width(stats: &[IterStats], n_aps: usize) -> f64 {
    let n = stats.len();
    let half = |k: usize| {
        let (_, lo, hi) = wilson(k, n);
        (hi - lo) / 2.0
    };
    let mut worst = half(stats.iter().filter(|s| s.all_ok).count());
    for a in 0..n_aps {
        worst = worst.max(half(stats.iter().filter(|s| s.ap_over[a]).count()));
    }
    worst
}

// ---------------------------------------------------------------- the run

fn user_id(i: usize, width: usize) -> String {
    format!("U{:0width$}", i + 1, width = width)
}

fn sample_json(ctx: &Ctx, mc: &McCfg, it: &Iteration, index: usize, seed: u64, meets: Option<f64>) -> Value {
    let width = it.users.len().to_string().len().max(3);
    let users: Vec<Value> = it
        .users
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let id = user_id(i, width);
            let devices: Vec<Value> = u
                .devices
                .iter()
                .enumerate()
                .map(|(k, d)| {
                    let profile = match (&mc.profiles, d.profile) {
                        (Some(ps), Some(p)) => Value::from(ps[p].name.clone()),
                        _ => Value::from(if d.active { "Active" } else { "Idle" }),
                    };
                    let mut o = json!({
                        "id": format!("{id}-{}", k + 1),
                        "profile": profile,
                        "active": d.active,
                        "demandMbps": if d.active { Value::from(round_to(d.demand, 2)) } else { Value::from(0) },
                        "minMbps": if d.active { Value::from(d.min) } else { Value::from(0) },
                    });
                    let Some(ui) = d.unit else {
                        o["status"] = "no AP on this floor".into();
                        return o;
                    };
                    let unit = &it.units[ui];
                    o["apsInRange"] = Value::from(unit.cand.iter().filter(|c| c.snr >= crate::radio::MIN_SNR_DB[0]).count());
                    let Some(ap) = unit.ap else {
                        o["status"] = "no usable signal".into();
                        return o;
                    };
                    let row = &it.ev.rows[ap];
                    let link = unit.cand.iter().find(|c| c.ap == ap);
                    let rate = ctx.rate_of(unit.snr);
                    o["apId"] = ctx.aps[ap].id.clone();
                    o["apName"] = ctx.aps[ap].label.clone();
                    o["distanceM"] = link.map_or(Value::Null, |c| Value::from(round_to(c.d, 2)));
                    o["rssiDbm"] = link.map_or(Value::Null, |c| Value::from(r1(c.rssi)));
                    o["snrDb"] = Value::from(r1(unit.snr));
                    o["rateMbps"] = Value::from(r1(rate));
                    let status = if !d.active {
                        "idle"
                    } else if rate < d.min {
                        "weak signal"
                    } else if row.dom_min > 1.0 {
                        "AP congested"
                    } else if it.ev.wan.scale_min < 1.0 {
                        "internet limited"
                    } else {
                        "ok"
                    };
                    o["status"] = status.into();
                    if d.active {
                        let scale = if row.dom_typical > 1.0 { 1.0 / row.dom_typical } else { 1.0 };
                        o["deliveredMbps"] = Value::from(round_to((d.demand * scale * it.ev.wan.scale_typical).min(rate), 2));
                    }
                    o
                })
                .collect();
            json!({
                "id": id,
                "floorId": ctx.floors[u.floor].id,
                "x": round_to(u.x, 2),
                "z": round_to(u.z, 2),
                "roomId": u.room.map_or(Value::Null, |r| ctx.rooms[r].id.clone()),
                "room": u.room.map_or(Value::Null, |r| ctx.rooms[r].name.clone()),
                "zone": u.zone.map_or(Value::Null, |z| Value::from(ctx.cfg.zones[z].name.clone())),
                "devices": devices,
            })
        })
        .collect();
    json!({
        "iteration": index + 1,
        "seed": seed.to_string(),
        "meetsMinimumPct": meets.map(|m| r1(m * 100.0)),
        "activeDevices": it.ev.wan.total_active,
        "users": users,
    })
}

/// Every AP on a floor as seen from one position: distance, RSSI, SNR and the
/// rate there, strongest first. Uses the same signal the simulation uses.
pub fn links(plan: &Value, settings: Option<&Value>, cells: Option<&Value>, floor_id: Option<&Value>, x: f64, z: f64) -> Value {
    let ctx = Ctx::new(plan, settings, cells);
    let Some(floor) = ctx.floors.iter().position(|f| crate::js::strict_eq(Some(&f.id), floor_id)) else {
        return json!([]);
    };
    let sig = SignalIndex::new(&ctx);
    let cell = sig.cell(floor, x, z).or_else(|| {
        // off the prediction grid: the nearest cell
        let cells = &ctx.floors[floor].cells;
        (0..cells.len()).min_by(|&a, &b| {
            let da = crate::js::hypot(cells[a].x - x, cells[a].z - z);
            let db = crate::js::hypot(cells[b].x - x, cells[b].z - z);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let (cand, _) = ctx.candidates(floor, x, z, cell.map(|c| &ctx.floors[floor].cells[c]));
    Value::Array(
        cand.iter()
            .map(|c| {
                json!({
                    "apId": ctx.aps[c.ap].id, "name": ctx.aps[c.ap].label,
                    "distanceM": round_to(c.d, 2), "rssiDbm": r1(c.rssi), "snrDb": r1(c.snr),
                    "rateMbps": r1(ctx.rate_of(c.snr)),
                })
            })
            .collect(),
    )
}

pub fn run(plan: &Value, settings: Option<&Value>, cells: Option<&Value>) -> Value {
    let ctx = Ctx::new(plan, settings, cells);
    let mc = McCfg::new(settings);
    let occ = ctx.occupancy();
    let sampler = Sampler::new(&occ);
    let sig = SignalIndex::new(&ctx);
    let n_aps = ctx.aps.len();
    let people: Vec<f64> = occ.groups.iter().map(|g| g.people).collect();

    let mut stats: Vec<IterStats> = Vec::new();
    let mut bins: BTreeMap<(usize, i64, i64), (f64, f64)> = BTreeMap::new();
    let run_to = |stats: &mut Vec<IterStats>, bins: &mut BTreeMap<_, _>, n: usize| {
        while stats.len() < n {
            let it = run_iteration(&ctx, &occ, &sampler, &sig, &mc, iteration_seed(mc.seed, stats.len()), &people);
            add_bins(&ctx, &it, mc.bin_m, bins);
            stats.push(stats_of(&ctx, &it));
        }
    };
    run_to(&mut stats, &mut bins, mc.iterations);
    let batch = (mc.iterations / 2).max(50);
    while stats.len() < mc.max_iterations && max_half_width(&stats, n_aps) > mc.target_ci {
        let next = (stats.len() + batch).min(mc.max_iterations);
        run_to(&mut stats, &mut bins, next);
    }
    let n = stats.len();
    let half = max_half_width(&stats, n_aps);

    // the deterministic result for the same inputs, to compare with
    let det = plan_capacity_ctx(&ctx);

    let aps: Vec<Value> = (0..n_aps)
        .map(|a| {
            let mut status: BTreeMap<&str, usize> = BTreeMap::new();
            for s in &stats {
                *status.entry(s.ap_status[a]).or_insert(0) += 1;
            }
            let d = &det["aps"][a];
            json!({
                "id": ctx.aps[a].id, "name": ctx.aps[a].label, "floorId": ctx.aps[a].floor,
                "channel": ctx.chan.assign.get(a).copied().filter(|c| !c.is_nan()),
                "devices": dist(stats.iter().map(|s| s.ap_devices[a]), 1.0),
                "activeDevices": dist(stats.iter().map(|s| s.ap_active[a]), 1.0),
                "airtimeTypicalPct": dist(stats.iter().map(|s| s.ap_typical[a]), 100.0),
                "sharedAirtimeMinPct": dist(stats.iter().map(|s| s.ap_shared_min[a]), 100.0),
                "meetsMinimumPct": dist(stats.iter().filter_map(|s| s.ap_meets[a]), 100.0),
                "overload": prob(stats.iter().filter(|s| s.ap_over[a]).count(), n),
                "statusCounts": status,
                "deterministic": { "devices": d["devices"], "activeDevices": d["activeDevices"], "airtimeTypicalPct": d["airtimeTypicalPct"], "status": d["status"] },
            })
        })
        .collect();
    let worst_ap = (0..n_aps)
        .max_by(|&a, &b| {
            let ka = stats.iter().filter(|s| s.ap_over[a]).count();
            let kb = stats.iter().filter(|s| s.ap_over[b]).count();
            let pa = stats.iter().map(|s| s.ap_shared_min[a]).fold(0.0, f64::max);
            let pb = stats.iter().map(|s| s.ap_shared_min[b]).fold(0.0, f64::max);
            ka.cmp(&kb).then(pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)).then(b.cmp(&a))
        })
        .map(|a| json!({ "id": ctx.aps[a].id, "name": ctx.aps[a].label, "overload": aps[a]["overload"] }));

    // a typical and a bad iteration, replayed from their seeds for the full detail
    let meets_of = |s: &IterStats| s.meets.unwrap_or(1.0);
    let mut by_meets: Vec<usize> = (0..n).collect();
    by_meets.sort_by(|&a, &b| meets_of(&stats[a]).partial_cmp(&meets_of(&stats[b])).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    let median = by_meets[(n - 1) / 2];
    let worst = by_meets[0];
    let sample = |i: usize| {
        let seed = iteration_seed(mc.seed, i);
        let it = run_iteration(&ctx, &occ, &sampler, &sig, &mc, seed, &people);
        sample_json(&ctx, &mc, &it, i, seed, stats[i].meets)
    };

    let bin_rows: Vec<Value> = bins
        .iter()
        .filter(|(_, &(active, fail))| active > 0.0 && fail / active >= 0.0005)
        .map(|(&(f, bx, bz), &(active, fail))| {
            json!({
                "floorId": ctx.floors[f].id,
                "x": (bx as f64 + 0.5) * mc.bin_m, "z": (bz as f64 + 0.5) * mc.bin_m, "size": mc.bin_m,
                "activePerRun": round_to(active / n as f64, 3),
                "failPct": r1(fail / active * 100.0),
            })
        })
        .collect();

    let mut used = mc.raw.clone();
    used.insert("iterationsRun".into(), Value::from(n));
    let traffic_note = match &mc.profiles {
        Some(_) => "Traffic: every device draws a profile by its share and a speed in the profile's range; idle devices use no airtime.".to_string(),
        None => format!(
            "Traffic: each device is active with probability {}% at {} Mbps (minimum {} Mbps), as in the deterministic model.",
            crate::js::fmt_num(crate::js::round(ctx.cfg.active_fraction * 100.0)),
            ctx.cfg.text("demandMbpsPerActive"),
            ctx.cfg.text("minMbps")
        ),
    };
    json!({
        "settings": used,
        "iterations": n,
        "seed": mc.seed.to_string(),
        "convergence": {
            "converged": half <= mc.target_ci,
            "maxCiHalfWidthPct": r1(half * 100.0),
            "targetCiPct": r1(mc.target_ci * 100.0),
            "maxIterations": mc.max_iterations,
        },
        "floor": {
            "users": dist(stats.iter().map(|s| s.users), 1.0),
            "devices": dist(stats.iter().map(|s| s.devices), 1.0),
            "activeDevices": dist(stats.iter().map(|s| s.active), 1.0),
            "demandTypicalMbps": dist(stats.iter().map(|s| s.demand_typical), 1.0),
            "meetsMinimumPct": dist(stats.iter().filter_map(|s| s.meets), 100.0),
            "overloadedAps": dist(stats.iter().map(|s| s.overloaded_aps), 1.0),
            "noSignalDevices": dist(stats.iter().map(|s| s.no_signal), 1.0),
            "allTargetsMet": prob(stats.iter().filter(|s| s.all_ok).count(), n),
            "internetSufficient": prob(stats.iter().filter(|s| s.internet_ok).count(), n),
            "radioOk": prob(stats.iter().filter(|s| s.radio_ok).count(), n),
        },
        "aps": aps,
        "worstAp": worst_ap,
        "bins": bin_rows,
        "samples": { "median": sample(median), "worst": sample(worst) },
        "heatmap": crate::loadtest::heatmap_for(&ctx, &occ, settings),
        "deterministic": { "summary": det["summary"], "wan": det["wan"], "source": det["source"] },
        "assumptions": [
            "Every person is placed as one user at a random position, drawn with the same weights as the deterministic model (floor, rooms, zones, desks and seats); the number in each zone and room is kept.",
            format!("Each user carries whole devices: {} per person on average.", ctx.cfg.text("devicesPerUser")),
            traffic_note,
            "Each AP's signal at a device comes from the ray-traced cell it stands in (from distance where there is no prediction); the other APs are scaled from it by distance. The prediction is not recomputed.",
            "Distances are horizontal, in plan metres from the AP's position.",
            "Overload probability is the share of iterations in which the AP is over its airtime target, cannot give the minimum speed, has devices with too weak a signal, or holds too many devices; the range is a 95% Wilson interval.",
            "Positions are simulated, not the real locations of people; traffic is modelled demand, not measured traffic.",
        ],
        "notes": occ.notes,
    })
}
