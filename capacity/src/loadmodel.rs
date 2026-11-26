//! Load-test radio model: what each user gets from where they stand, under that load.
//!
//! Used by the load test only (loadtest.rs); the deterministic engine and the Monte Carlo simulation keep their
//! own per-AP model. Per iteration (one placement of users):
//!
//! 1. **Who shares airtime, who interferes** (per AP pair, from the prediction at the APs' positions):
//!    - same channel and heard above the carrier-sense level (`ccaDbm`, default -82 dBm): they defer to each
//!      other, so they *share airtime* (contention) and add no interference;
//!    - same channel but below that level (hidden): they do not defer, so they *add interference* to SINR,
//!      weighted by how busy they are;
//!    - partly overlapping channels: interference scaled by the overlap; the next channel over: interference
//!      reduced by the adjacent-channel rejection (`adjacentRejectionDb`); further apart: nothing.
//!    Contention and interference are never counted for the same pair.
//! 2. **Data rate per user from its SNR** (the planner's SNR at that spot). Optionally (`interference`, off by
//!    default) hidden and adjacent-channel APs lower it, in linear power: `S / (N + Σ busy_j · f_j · I_j)`.
//!    Upload is sent by the client at a lower SNR (`uplinkLossDb`) and also uses airtime.
//! 3. **Airtime per contention domain**: usable airtime = 1 − collision loss (Bianchi, from the number of
//!    stations contending); shared by `fairness`:
//!    - `airtime` (default, modern APs): each active device gets an equal share of airtime, unused airtime
//!      goes to the others (max-min fair in airtime): near users get more Mbps than far ones;
//!    - `throughput` (plain 802.11 DCF): equal Mbps for everyone, so one slow user slows the whole cell.
//! 4. Load changes busy, busy changes SINR, SINR changes the airtime needed: repeated with damping until the
//!    busy shares change by less than `tolerance`, at most `maxIterations`; a run that does not settle is
//!    flagged, not hidden.
//! 5. **Internet plan** after Wi-Fi: max-min fair over every active device (a device already slowed by Wi-Fi
//!    takes less, the others get more): `throughput = min(Wi-Fi, internet share, demand)`.
//!
//! A heat-map square is a test device that wants more than it gets (greedy): what it would get there under
//! the same load, so the map shows real speed by position, not a capped demand.

use crate::model::{Cand, Ctx, Unit};
use crate::montecarlo::SignalIndex;
use crate::radio::{Band, MIN_SNR_DB};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Fairness {
    Airtime,
    Throughput,
}

#[derive(Clone, Debug)]
pub struct LmCfg {
    pub cca_dbm: f64,
    pub fairness: Fairness,
    pub uplink_loss_db: f64,
    pub acr_db: f64,
    pub damping: f64,
    pub tolerance: f64,
    pub max_iterations: usize,
    pub collisions: bool,
    /// Hidden / adjacent-channel APs lower the signal quality (SINR). Off: rates follow the SNR alone.
    pub interference: bool,
}

impl LmCfg {
    pub fn new(raw: &serde_json::Map<String, Value>) -> LmCfg {
        let n = |k: &str, d: f64| crate::js::finite(raw.get(k)).unwrap_or(d);
        LmCfg {
            cca_dbm: n("ccaDbm", -82.0).clamp(-100.0, -40.0),
            fairness: if crate::js::is_str(raw.get("fairness"), "throughput") { Fairness::Throughput } else { Fairness::Airtime },
            uplink_loss_db: n("uplinkLossDb", 5.0).clamp(0.0, 30.0),
            acr_db: n("adjacentRejectionDb", 25.0).clamp(0.0, 60.0),
            damping: n("convergenceDamping", 0.5).clamp(0.05, 1.0),
            tolerance: n("convergenceTolerance", 0.005).clamp(1e-5, 0.1),
            max_iterations: n("convergenceIterations", 40.0).round().clamp(1.0, 500.0) as usize,
            collisions: raw.get("collisions").and_then(Value::as_bool).unwrap_or(true),
            interference: raw.get("interference").and_then(Value::as_bool).unwrap_or(false),
        }
    }
}

pub fn mw(dbm: f64) -> f64 {
    if dbm.is_finite() {
        libm::pow(10.0, dbm / 10.0)
    } else {
        0.0
    }
}

pub fn db(x: f64) -> f64 {
    if x > 0.0 {
        10.0 * libm::log10(x)
    } else {
        f64::NEG_INFINITY
    }
}

/// Centre frequency (MHz) of a channel number in a band.
fn freq(band: Band, ch: f64) -> f64 {
    match band {
        Band::B24 => {
            if (ch - 14.0).abs() < 1e-9 {
                2484.0
            } else {
                2407.0 + 5.0 * ch
            }
        }
        Band::B5 => 5000.0 + 5.0 * ch,
        Band::B6 => 5950.0 + 5.0 * ch,
    }
}

/// How AP pairs relate, from the predicted signal of every AP at each AP's position.
pub struct Relations {
    /// AP a and the same-channel APs it hears above the carrier-sense level (a included): one airtime domain.
    pub contend: Vec<Vec<usize>>,
    /// APs whose transmissions reach a's clients as interference: (j, weight) — 1 for a hidden same-channel
    /// AP, the overlap for partly overlapping channels, the rejection for the next channel.
    pub interf: Vec<Vec<(usize, f64)>>,
    /// The strongest level each AP hears from another same-channel AP (for the report).
    pub heard: Vec<Vec<(usize, f64)>>,
}

impl Relations {
    pub(crate) fn new(ctx: &Ctx, sig: &SignalIndex, cfg: &LmCfg) -> Relations {
        let n = ctx.aps.len();
        let floor_of: Vec<Option<usize>> =
            (0..n).map(|a| (0..ctx.floors.len()).find(|&f| ctx.floors[f].aps.contains(&a))).collect();
        // rssi[a][j]: AP j's level at AP a's position (same floor only, as everywhere in the engine)
        let mut rssi = vec![vec![f64::NEG_INFINITY; n]; n];
        for a in 0..n {
            let Some(f) = floor_of[a] else { continue };
            let (x, z) = (ctx.aps[a].x, ctx.aps[a].z);
            let cell = sig.cell(f, x, z).map(|c| &ctx.floors[f].cells[c]);
            for c in ctx.candidates(f, x, z, cell).0 {
                rssi[a][c.ap] = c.rssi;
            }
        }
        let width = ctx.width;
        let mut contend = vec![Vec::new(); n];
        let mut interf = vec![Vec::new(); n];
        let mut heard = vec![Vec::new(); n];
        for a in 0..n {
            contend[a].push(a);
            for j in 0..n {
                if j == a || floor_of[j].is_none() || floor_of[j] != floor_of[a] {
                    continue;
                }
                let (ca, cj) = (ctx.chan.assign[a], ctx.chan.assign[j]);
                if !ca.is_finite() || !cj.is_finite() {
                    continue;
                }
                let df = (freq(ctx.cfg.band, ca) - freq(ctx.cfg.band, cj)).abs();
                let overlap = (1.0 - df / width).max(0.0);
                if overlap >= 0.999 {
                    // the same channel: deferring (heard either way round) or hidden
                    let level = rssi[a][j].max(rssi[j][a]);
                    heard[a].push((j, level));
                    if level >= cfg.cca_dbm {
                        contend[a].push(j);
                    } else {
                        interf[a].push((j, 1.0));
                    }
                } else if overlap > 0.0 {
                    interf[a].push((j, overlap));
                } else if df < 2.0 * width - 1e-9 {
                    interf[a].push((j, mw(-cfg.acr_db)));
                }
            }
        }
        Relations { contend, interf, heard }
    }
}

/// What one active device gets in one iteration.
#[derive(Clone, Debug, Default)]
pub struct UserLoad {
    pub ap: Option<usize>,
    pub snr: f64,
    pub sinr: f64,
    pub rate: f64,
    pub rate_up: f64,
    /// Airtime per Mbps of its traffic (download plus its upload share).
    pub cost: f64,
    pub need: f64,
    pub got: f64,
    /// Mbps of its demand delivered over Wi-Fi, and after the internet plan.
    pub wifi: f64,
    pub net: f64,
}

pub struct LoadEval {
    /// Per unit (same index as the iteration's units); inactive or unserved devices have ap = None or wifi 0.
    pub units: Vec<UserLoad>,
    /// Share of time each AP's cell transmits (its own devices' airtime).
    pub busy: Vec<f64>,
    /// Airtime demanded in each AP's contention domain over the usable airtime (1 = full; can exceed 1).
    pub load: Vec<f64>,
    /// Usable airtime per domain after collisions.
    pub capacity: Vec<f64>,
    /// Collision probability per attempt in each domain.
    pub collision: Vec<f64>,
    /// Active devices per contention domain.
    pub contenders: Vec<f64>,
    /// Max-min internet level (Mbps) every device can get at most.
    pub wan_level: f64,
    pub converged: bool,
    pub iterations: usize,
}

/// Level L with Σ w_i · min(c_i, L) = total (c_i may be infinite). Returns +∞ when everyone fits.
pub fn waterfill(items: &[(f64, f64)], total: f64) -> f64 {
    let mut v: Vec<(f64, f64)> = items.iter().copied().filter(|(c, w)| *w > 0.0 && *c > 0.0).collect();
    if v.is_empty() {
        return f64::INFINITY;
    }
    let finite_sum: f64 = v.iter().map(|(c, w)| if c.is_finite() { c * w } else { f64::INFINITY }).sum();
    if finite_sum <= total {
        return f64::INFINITY;
    }
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = 0.0;
    let mut w_left: f64 = v.iter().map(|(_, w)| w).sum();
    for &(c, w) in &v {
        // everyone left gets level L >= c?
        let level = (total - used) / w_left;
        if level <= c {
            return level.max(0.0);
        }
        used += c * w;
        w_left -= w;
    }
    f64::INFINITY
}

/// Collision probability per transmission attempt with `n` contending stations (802.11 DCF, Bianchi).
pub fn collision_prob(n: f64) -> f64 {
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

fn cand_of(cand: &[Cand], ap: usize) -> Option<&Cand> {
    cand.iter().find(|c| c.ap == ap)
}

/// SINR (dB) at a position with this candidate list, served by `ap`, with the other cells as busy as `busy`.
pub fn sinr_at(rel: &Relations, cand: &[Cand], ap: usize, busy: &[f64], interference: bool) -> (f64, f64) {
    let Some(c) = cand_of(cand, ap) else { return (f64::NAN, f64::NAN) };
    if !interference {
        return (c.snr, c.snr);
    }
    let s = mw(c.rssi);
    let noise = mw(c.rssi - c.snr);
    let mut i = 0.0;
    for &(j, wgt) in &rel.interf[ap] {
        if let Some(cj) = cand_of(cand, j) {
            i += busy[j].clamp(0.0, 1.0) * wgt * mw(cj.rssi);
        }
    }
    (c.snr, db(s / (noise + i)))
}

/// Uplink rate at an SINR: the client sends `loss` dB weaker; never below the lowest rate while the
/// downlink works (management frames get through), so a working link always has some upload.
fn up_rate(ctx: &Ctx, sinr: f64, loss: f64) -> f64 {
    let r = ctx.rate_of(sinr - loss);
    if r > 0.0 {
        r
    } else {
        ctx.rate_of(MIN_SNR_DB[0])
    }
}

pub fn evaluate(ctx: &Ctx, rel: &Relations, cfg: &LmCfg, units: &[Unit], usable_down: f64, unserved_active: usize) -> LoadEval {
    let n_ap = ctx.aps.len();
    let mut out: Vec<UserLoad> = units
        .iter()
        .map(|u| UserLoad { ap: if u.active > 0.0 { u.ap } else { None }, ..Default::default() })
        .collect();
    let on_ap: Vec<Vec<usize>> = (0..n_ap).map(|a| (0..units.len()).filter(|&i| out[i].ap == Some(a)).collect()).collect();
    let domain_users: Vec<Vec<usize>> = (0..n_ap).map(|a| rel.contend[a].iter().flat_map(|&j| on_ap[j].iter().copied()).collect()).collect();

    let mut busy = vec![0.0; n_ap];
    let mut capacity = vec![1.0; n_ap];
    let mut collision = vec![0.0; n_ap];
    let mut load = vec![0.0; n_ap];
    let mut converged = false;
    let mut iterations = 0;
    for it in 0..cfg.max_iterations {
        iterations = it + 1;
        // 1. SINR, rates and the airtime each device needs for its demand
        for i in 0..units.len() {
            let Some(a) = out[i].ap else { continue };
            let (snr, sinr) = sinr_at(rel, &units[i].cand, a, &busy, cfg.interference);
            let rate = ctx.rate_of(sinr);
            let o = &mut out[i];
            o.snr = snr;
            o.sinr = sinr;
            o.rate = rate;
            if rate > 0.0 {
                o.rate_up = up_rate(ctx, sinr, cfg.uplink_loss_db);
                o.cost = 1.0 / rate + units[i].up / o.rate_up;
                o.need = units[i].demand * o.cost;
            } else {
                o.rate_up = 0.0;
                o.cost = f64::INFINITY;
                o.need = 0.0;
            }
        }
        // 2. airtime per contention domain: collisions, then the fair share
        let mut new_busy = vec![0.0; n_ap];
        for a in 0..n_ap {
            let users = &domain_users[a];
            let demand_air: f64 = users.iter().map(|&i| out[i].need).sum();
            let rho = demand_air.clamp(0.0, 0.98);
            let n_cont = (users.iter().filter(|&&i| out[i].rate > 0.0).count() as f64).min(1.0 + rho / (1.0 - rho));
            collision[a] = if cfg.collisions { collision_prob(n_cont) } else { 0.0 };
            capacity[a] = (1.0 - collision[a]).max(0.05);
            load[a] = demand_air / capacity[a];
            let level = match cfg.fairness {
                Fairness::Airtime => waterfill(&users.iter().filter(|&&i| out[i].rate > 0.0).map(|&i| (out[i].need, 1.0)).collect::<Vec<_>>(), capacity[a]),
                Fairness::Throughput => waterfill(
                    &users.iter().filter(|&&i| out[i].rate > 0.0).map(|&i| (units[i].demand, out[i].cost)).collect::<Vec<_>>(),
                    capacity[a],
                ),
            };
            for &i in &on_ap[a] {
                let o = &mut out[i];
                if !(o.rate > 0.0) {
                    o.got = 0.0;
                    o.wifi = 0.0;
                    continue;
                }
                match cfg.fairness {
                    Fairness::Airtime => {
                        o.got = o.need.min(level);
                        o.wifi = if o.cost > 0.0 { o.got / o.cost } else { 0.0 };
                    }
                    Fairness::Throughput => {
                        o.wifi = units[i].demand.min(level);
                        o.got = o.wifi * o.cost;
                    }
                }
                new_busy[a] += o.got;
            }
        }
        // 3. damped update of how busy each cell is; settled when nothing moves
        let mut delta: f64 = 0.0;
        for a in 0..n_ap {
            let nb = new_busy[a].clamp(0.0, 1.0);
            let b = busy[a] + cfg.damping * (nb - busy[a]);
            delta = delta.max((b - busy[a]).abs());
            busy[a] = b;
        }
        if delta < cfg.tolerance && it > 0 {
            converged = true;
            break;
        }
    }
    // 4. the internet plan, max-min fair over every active device (no signal: nothing over Wi-Fi)
    let caps: Vec<(f64, f64)> = out.iter().filter(|o| o.ap.is_some()).map(|o| (o.wifi, 1.0)).collect();
    let _ = unserved_active;
    let wan_level = if usable_down > 0.0 { waterfill(&caps, usable_down) } else { 0.0 };
    for o in out.iter_mut() {
        o.net = o.wifi.min(wan_level);
    }
    let contenders = (0..n_ap).map(|a| domain_users[a].iter().filter(|&&i| out[i].rate > 0.0).count() as f64).collect();
    LoadEval { units: out, busy, load, capacity, collision, contenders, wan_level, converged, iterations }
}

/// One contention domain's sharing, sorted once, to answer "what would one more greedy device get here"
/// quickly for every heat-map square and every device.
pub struct Greedy {
    /// (cap, weight), ascending cap: airtime mode (need, 1), throughput mode (demand, cost per Mbps).
    items: Vec<(f64, f64)>,
    pre_cw: Vec<f64>,
    pre_w: Vec<f64>,
    cap: f64,
}

impl Greedy {
    /// Level L of a newcomer with weight `extra_w` that wants more than it gets:
    /// Σ_saturated w·c + L·(Σ_rest w + extra_w) = cap.
    pub fn level(&self, extra_w: f64) -> f64 {
        let n = self.items.len();
        let total_w = self.pre_w[n];
        for k in 0..=n {
            let l = (self.cap - self.pre_cw[k]) / (total_w - self.pre_w[k] + extra_w);
            if k == n || l <= self.items[k].0 {
                return l.max(0.0);
            }
        }
        0.0
    }
}

pub fn greedy(cfg: &LmCfg, rel: &Relations, ev: &LoadEval, units: &[Unit]) -> Vec<Greedy> {
    (0..ev.busy.len())
        .map(|a| {
            let mut items: Vec<(f64, f64)> = rel.contend[a]
                .iter()
                .flat_map(|&j| (0..units.len()).filter(move |&i| ev.units[i].ap == Some(j)))
                .filter(|&i| ev.units[i].rate > 0.0)
                .map(|i| match cfg.fairness {
                    Fairness::Airtime => (ev.units[i].need, 1.0),
                    Fairness::Throughput => (units[i].demand, ev.units[i].cost),
                })
                .collect();
            items.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut pre_cw = vec![0.0];
            let mut pre_w = vec![0.0];
            for &(c, w) in &items {
                pre_cw.push(pre_cw.last().unwrap() + c * w);
                pre_w.push(pre_w.last().unwrap() + w);
            }
            Greedy { items, pre_cw, pre_w, cap: ev.capacity[a] }
        })
        .collect()
}

/// What a greedy test device at a square gets, served by `ap`: (snr, sinr, rate, Mbps over Wi-Fi).
pub fn probe(ctx: &Ctx, rel: &Relations, cfg: &LmCfg, ev: &LoadEval, g: &[Greedy], cand: &[Cand], ap: usize) -> (f64, f64, f64, f64) {
    let (snr, sinr) = sinr_at(rel, cand, ap, &ev.busy, cfg.interference);
    let rate = ctx.rate_of(sinr);
    if !(rate > 0.0) {
        return (snr, sinr, 0.0, 0.0);
    }
    (snr, sinr, rate, greedy_mbps(cfg, &g[ap], rate))
}

/// Mbps a device with this rate gets if it wants more: its fair share of the domain's airtime.
pub fn greedy_mbps(cfg: &LmCfg, g: &Greedy, rate: f64) -> f64 {
    if !(rate > 0.0) {
        return 0.0;
    }
    match cfg.fairness {
        Fairness::Airtime => g.level(1.0) * rate,
        Fairness::Throughput => g.level(1.0 / rate),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "expected {b}, got {a}");
    }

    #[test]
    fn waterfill_levels() {
        // everyone fits
        assert!(waterfill(&[(0.1, 1.0), (0.2, 1.0)], 1.0).is_infinite());
        // 3 equal greedy users share 0.9 equally
        near(waterfill(&[(f64::INFINITY, 1.0), (f64::INFINITY, 1.0), (f64::INFINITY, 1.0)], 0.9), 0.3, 1e-12);
        // a small user keeps its need, the rest split what is left (max-min fair)
        near(waterfill(&[(0.1, 1.0), (f64::INFINITY, 1.0), (f64::INFINITY, 1.0)], 1.0), 0.45, 1e-12);
        // weighted (equal throughput): costs 1 and 3, total 1 -> L·(1+3) = 1
        near(waterfill(&[(f64::INFINITY, 1.0), (f64::INFINITY, 3.0)], 1.0), 0.25, 1e-12);
    }

    #[test]
    fn greedy_newcomer() {
        // two devices needing 0.1 and 0.5 of the airtime, capacity 1: a greedy newcomer gets the rest
        let g = Greedy { items: vec![(0.1, 1.0), (0.5, 1.0)], pre_cw: vec![0.0, 0.1, 0.6], pre_w: vec![0.0, 1.0, 2.0], cap: 1.0 };
        near(g.level(1.0), 0.45, 1e-12); // 0.1 kept, then 0.9 split between the 0.5-device and it: 0.45 each
        let busy = Greedy { items: vec![(0.9, 1.0), (0.9, 1.0)], pre_cw: vec![0.0, 0.9, 1.8], pre_w: vec![0.0, 1.0, 2.0], cap: 1.0 };
        near(busy.level(1.0), 1.0 / 3.0, 1e-12); // over-subscribed: equal thirds
    }

    #[test]
    fn linear_power() {
        near(db(mw(-60.0) / (mw(-90.0) + mw(-90.0))), 27.0, 0.02); // noise + an equal interferer: 3 dB less
        near(mw(-30.0), 1e-3, 1e-15);
    }

    #[test]
    fn collisions_grow_with_stations() {
        assert_eq!(collision_prob(1.0), 0.0);
        assert!(collision_prob(10.0) > collision_prob(2.0));
    }

    #[test]
    fn channel_frequencies() {
        near(freq(Band::B24, 1.0), 2412.0, 1e-9);
        near(freq(Band::B24, 6.0), 2437.0, 1e-9);
        near(freq(Band::B5, 36.0), 5180.0, 1e-9);
    }
}
