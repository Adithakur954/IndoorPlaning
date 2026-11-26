//! The deterministic capacity engine, in reusable steps:
//!
//!  1. occupancy: where people can be, as weighted points over the floor
//!  2. signal: each AP's RSSI/SNR at a point (ray-traced where available)
//!  3. association: which AP each load unit joins
//!  4. evaluation: airtime per AP and per channel, the internet plan, verdicts
//!
//! The deterministic result spreads the expected number of people over the
//! points (fractions of a person). The Monte Carlo engine (montecarlo.rs)
//! places whole users and devices instead, and reuses steps 1–4.
//!
//! Two separate checks: the internet plan (more APs never raise it) and the
//! Wi-Fi radio of each AP. Everything is a planning estimate from stated
//! assumptions; the rate table, SNR thresholds and efficiency are nominal.

use crate::geometry::{area, bbox, boundary_points, inside, points_of, P};
use crate::js::{fmt_num, hypot, log10, max2, min2, num, or, r1, round, strict_eq, to_str, truthy};
use crate::radio::{channels_for, max_width_mhz, phy_rate_mbps, plan_channels, standard_label, ChanAp, ChannelPlan, MIN_SNR_DB};
use crate::settings::Cfg;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

// ---------------------------------------------------------------- inputs

pub struct Ap {
    pub id: Value,
    pub sid: String,
    /// `name || id`
    pub label: Value,
    pub floor: Value,
    pub fid: String,
    pub x: f64,
    pub z: f64,
    /// A proposed AP that is not in the ray-traced prediction (`proposed:
    /// true`): its signal is always estimated from distance.
    pub proposed: bool,
}

pub struct Room {
    pub id: Value,
    pub sid: String,
    pub name: Value,
    pub floor: Value,
    pub pts: Vec<P>,
    pub area: f64,
}

pub struct Seat {
    pub x: f64,
    pub z: f64,
    pub w: f64,
    pub d: f64,
}

pub struct Cell {
    pub x: f64,
    pub z: f64,
    pub step: Option<Value>,
    pub dbm: Option<f64>,
    pub snr: Option<f64>,
    pub source: Option<Value>,
}

pub struct Floor {
    pub id: Value,
    pub fid: String,
    pub name: Value,
    /// Rooms on this floor (indices into Ctx::rooms), excluded ones too.
    pub rooms: Vec<usize>,
    /// Rooms that contain no other room.
    pub leaf: Vec<usize>,
    pub excluded: Vec<usize>,
    /// Rooms and building outlines: where people can be.
    pub areas: Vec<Vec<P>>,
    pub seats: Vec<Seat>,
    /// Wi-Fi APs on this floor (indices into Ctx::aps).
    pub aps: Vec<usize>,
    pub cells: Vec<Cell>,
}

/// Everything about a plan that does not change between calculations.
pub struct Ctx {
    pub cfg: Cfg,
    pub width: f64,
    pub streams: f64,
    pub noise_dbm: f64,
    pub aps: Vec<Ap>,
    pub rooms: Vec<Room>,
    pub floors: Vec<Floor>,
    pub channel_list: Vec<f64>,
    pub chan: ChannelPlan,
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    match v.get(key) {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

const SEAT_WORDS: [&str; 7] = ["desk", "chair", "sofa", "seat", "table", "workstation", "bench"];

impl Ctx {
    pub fn new(plan: &Value, settings: Option<&Value>, cells: Option<&Value>) -> Ctx {
        let cfg = Cfg::new(settings);
        let width = min2(cfg.width_mhz, max_width_mhz(&cfg.standard, cfg.band));
        let streams = max2(1.0, min2(cfg.ap_streams, cfg.client_streams));
        let noise_dbm = -174.0 + 10.0 * log10(width * 1e6) + cfg.noise_figure_db;

        let aps: Vec<Ap> = arr(plan, "sources")
            .iter()
            .filter(|s| crate::js::is_str(s.get("kind"), "wifi"))
            .map(|s| Ap {
                id: s.get("id").cloned().unwrap_or(Value::Null),
                sid: to_str(s.get("id")),
                label: or(s.get("name"), s.get("id")).cloned().unwrap_or(Value::Null),
                floor: s.get("floorId").cloned().unwrap_or(Value::Null),
                fid: to_str(s.get("floorId")),
                x: num(s.get("x")),
                z: num(s.get("z")),
                proposed: s.get("proposed").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect();
        let rooms: Vec<Room> = arr(plan, "rooms")
            .iter()
            .map(|r| {
                let pts = points_of(r);
                Room {
                    id: r.get("id").cloned().unwrap_or(Value::Null),
                    sid: to_str(r.get("id")),
                    name: or(r.get("name"), r.get("id")).cloned().unwrap_or(Value::Null),
                    floor: r.get("floorId").cloned().unwrap_or(Value::Null),
                    area: area(&pts),
                    pts,
                }
            })
            .collect();
        let raw_rooms = arr(plan, "rooms");
        let cell_map = match cells {
            Some(Value::Object(m)) => Some(m),
            _ => None,
        };

        let floors = arr(plan, "floors")
            .iter()
            .map(|f| {
                let id = f.get("id").cloned().unwrap_or(Value::Null);
                let fid = to_str(f.get("id"));
                let here: Vec<usize> = (0..rooms.len()).filter(|&i| strict_eq(raw_rooms[i].get("floorId"), Some(&id))).collect();
                let contains_other = |r: usize| {
                    here.iter().any(|&o| {
                        !strict_eq(Some(&rooms[o].id), Some(&rooms[r].id))
                            && rooms[o].pts.iter().all(|p| inside(p.0, p.1, &rooms[r].pts))
                            && rooms[o].area < rooms[r].area
                    })
                };
                let leaf = here.iter().copied().filter(|&r| !contains_other(r)).collect();
                let excluded = here.iter().copied().filter(|&r| crate::js::is_str(raw_rooms[r].get("receiverGrid"), "excluded")).collect();
                let mut areas: Vec<Vec<P>> = here.iter().map(|&r| rooms[r].pts.clone()).collect();
                areas.extend(arr(plan, "boundaries").iter().filter(|b| strict_eq(b.get("floorId"), Some(&id))).map(boundary_points));
                let seats = if cfg.furniture {
                    arr(plan, "furniture")
                        .iter()
                        .filter(|x| strict_eq(x.get("floorId"), Some(&id)))
                        .filter(|x| {
                            let k = if truthy(x.get("kind")) { to_str(x.get("kind")) } else { String::new() };
                            let n = if truthy(x.get("name")) { to_str(x.get("name")) } else { String::new() };
                            let text = format!("{k} {n}").to_lowercase();
                            SEAT_WORDS.iter().any(|w| text.contains(w))
                        })
                        .map(|x| {
                            // (+f.width || 0)
                            let or0 = |v: f64| if v == 0.0 || v.is_nan() { 0.0 } else { v };
                            Seat { x: num(x.get("x")), z: num(x.get("z")), w: or0(num(x.get("width"))), d: or0(num(x.get("depth"))) }
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let cells = match cell_map.and_then(|m| m.get(&fid)) {
                    Some(Value::Array(list)) => list
                        .iter()
                        .map(|c| Cell {
                            x: num(c.get("x")),
                            z: num(c.get("z")),
                            step: c.get("step").cloned(),
                            dbm: crate::js::finite(c.get("dbm")),
                            snr: crate::js::finite(c.get("snr")),
                            source: c.get("sourceName").cloned(),
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                Floor {
                    name: or(f.get("name"), f.get("id")).cloned().unwrap_or(Value::Null),
                    aps: (0..aps.len()).filter(|&a| strict_eq(Some(&aps[a].floor), Some(&id))).collect(),
                    id,
                    fid,
                    rooms: here,
                    leaf,
                    excluded,
                    areas,
                    seats,
                    cells,
                }
            })
            .collect();

        let channel_list = cfg.channels.clone().unwrap_or_else(|| channels_for(cfg.band, width));
        let chan_aps: Vec<ChanAp> = aps.iter().map(|a| ChanAp { id: &a.sid, floor: &a.fid, x: a.x, z: a.z }).collect();
        let chan = plan_channels(&chan_aps, cfg.interference_m, &channel_list);
        Ctx { cfg, width, streams, noise_dbm, aps, rooms, floors, channel_list, chan }
    }

    /// Application-level speed at an SNR: data rate × MAC efficiency.
    pub fn rate_of(&self, snr_db: f64) -> f64 {
        phy_rate_mbps(&self.cfg.standard, self.width, self.streams, snr_db) * self.cfg.mac_efficiency
    }

    fn ap_by_name(&self, floor: usize, name: Option<&Value>) -> Option<usize> {
        self.floors[floor].aps.iter().copied().find(|&a| strict_eq(Some(&self.aps[a].label), name))
    }

    /// Step 2: every AP on the floor at (x, z), strongest first. With a
    /// ray-traced cell, its strongest AP keeps the predicted level and the
    /// others are scaled from it by distance (never stronger). Returns whether
    /// the prediction was used.
    pub fn candidates(&self, floor: usize, x: f64, z: f64, cell: Option<&Cell>) -> (Vec<Cand>, bool) {
        let cfg = &self.cfg;
        let mut cand: Vec<Cand> = self.floors[floor]
            .aps
            .iter()
            .map(|&a| {
                let d = max2(1.0, hypot(self.aps[a].x - x, self.aps[a].z - z));
                let by_distance = cfg.tx_eirp_dbm - cfg.band.path_loss_1m() - 10.0 * cfg.path_loss_exponent * log10(d);
                Cand { ap: a, rssi: by_distance, snr: by_distance - self.noise_dbm, d }
            })
            .collect();
        let mut predicted = false;
        if let Some(cell) = cell {
            if let Some(dbm) = cell.dbm.filter(|v| *v > -149.0) {
                // proposed APs are not in the prediction: they keep the distance estimate
                let measured = |c: &Cand| !self.aps[c.ap].proposed;
                if cand.iter().any(measured) {
                    let best_ap = self.ap_by_name(floor, cell.source.as_ref()).filter(|&b| !self.aps[b].proposed);
                    let best = best_ap.and_then(|b| cand.iter().position(|c| c.ap == b)).unwrap_or_else(|| {
                        let mut b = cand.iter().position(measured).unwrap_or(0);
                        for (i, c) in cand.iter().enumerate() {
                            if measured(c) && c.d < cand[b].d {
                                b = i;
                            }
                        }
                        b
                    });
                    let snr_best = cell.snr.unwrap_or(dbm - self.noise_dbm);
                    let best_d = cand[best].d;
                    for (i, c) in cand.iter_mut().enumerate() {
                        if self.aps[c.ap].proposed {
                            continue;
                        }
                        let delta = 10.0 * cfg.path_loss_exponent * log10(best_d / c.d);
                        c.rssi = dbm + if i == best { 0.0 } else { min2(0.0, delta) - 1e-6 };
                        c.snr = snr_best + (c.rssi - dbm);
                    }
                }
                predicted = true;
            }
        }
        cand.sort_by(|a, b| b.rssi.partial_cmp(&a.rssi).unwrap_or(std::cmp::Ordering::Equal));
        (cand, predicted)
    }
}

// ---------------------------------------------------------------- step 1: occupancy

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GroupKind {
    Free,
    Zone(usize),
    Room(usize),
}

pub struct Group {
    pub key: String,
    pub kind: GroupKind,
    pub pts: Vec<usize>,
    /// People in this group.
    pub people: f64,
}

pub struct Pt {
    pub floor: usize,
    pub x: f64,
    pub z: f64,
    pub cell: Option<usize>,
    /// Floor area this point stands for (m²).
    pub area: f64,
    pub w: f64,
    pub group: usize,
    pub room: Option<usize>,
    pub has_ap: bool,
    /// Expected people at this point (deterministic spread).
    pub people: f64,
}

pub struct Occupancy {
    pub pts: Vec<Pt>,
    pub groups: Vec<Group>,
    pub notes: Vec<String>,
    /// Side of the square each point stands for, per floor.
    pub side: Vec<f64>,
}

impl Ctx {
    /// Which group a position belongs to: a zone, a room with its own
    /// headcount, or the free floor. `None` where nobody can be (an excluded
    /// room or a zone with 0 people).
    pub fn place(&self, floor: usize, x: f64, z: f64) -> Option<(GroupKind, Option<usize>)> {
        let f = &self.floors[floor];
        if f.excluded.iter().any(|&r| inside(x, z, &self.rooms[r].pts)) {
            return None;
        }
        let zi = self
            .cfg
            .zones
            .iter()
            .position(|zn| strict_eq(Some(&zn.floor), Some(&f.id)) && x >= zn.x && x <= zn.x + zn.width && z >= zn.z && z <= zn.z + zn.depth);
        if let Some(i) = zi {
            if self.cfg.zones[i].people == 0.0 {
                return None;
            }
        }
        let room = f.leaf.iter().copied().find(|&r| inside(x, z, &self.rooms[r].pts));
        let fixed_room = room.filter(|&r| self.cfg.room_people(&self.rooms[r].sid).is_some());
        let kind = match (zi, fixed_room) {
            (Some(i), _) => GroupKind::Zone(i),
            (None, Some(r)) => GroupKind::Room(r),
            _ => GroupKind::Free,
        };
        Some((kind, room))
    }

    fn group_key(&self, kind: GroupKind) -> String {
        match kind {
            GroupKind::Free => "free".into(),
            GroupKind::Zone(i) => self.cfg.zones[i].key.clone(),
            GroupKind::Room(r) => format!("r:{}", self.rooms[r].sid),
        }
    }

    fn group_people(&self, key: &str) -> Option<f64> {
        if key.starts_with("z:") {
            self.cfg.zones.iter().find(|z| z.key == key).map(|z| z.people)
        } else if let Some(id) = key.strip_prefix("r:") {
            self.cfg.room_people(id)
        } else {
            None
        }
    }

    /// Step 1: people spread over the whole floor (every point of the
    /// prediction map, or a 1 m grid), weighted towards desks and seats when
    /// asked. Zones and rooms with their own headcount keep it; the rest of
    /// the total is shared over the remaining floor by weight.
    pub fn occupancy(&self) -> Occupancy {
        let cfg = &self.cfg;
        let mut pts: Vec<Pt> = Vec::new();
        let mut groups: Vec<Group> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut notes = Vec::new();
        let mut side = Vec::new();
        for (fi, f) in self.floors.iter().enumerate() {
            let mut step = 1.0;
            let mut raw: Vec<(f64, f64, Option<usize>)> = Vec::new();
            if !f.cells.is_empty() {
                step = if truthy(f.cells[0].step.as_ref()) { num(f.cells[0].step.as_ref()) } else { 1.0 };
                raw = f.cells.iter().enumerate().map(|(i, c)| (c.x, c.z, Some(i))).collect();
            } else if !f.areas.is_empty() {
                let boxes: Vec<_> = f.areas.iter().map(|a| bbox(a)).collect();
                let min_x = crate::js::min_all(boxes.iter().map(|b| b.min_x));
                let max_x = crate::js::max_all(boxes.iter().map(|b| b.max_x));
                let min_z = crate::js::min_all(boxes.iter().map(|b| b.min_z));
                let max_z = crate::js::max_all(boxes.iter().map(|b| b.max_z));
                let mut x = min_x + 0.5;
                while x < max_x {
                    let mut z = min_z + 0.5;
                    while z < max_z {
                        if f.areas.iter().any(|a| inside(x, z, a)) {
                            raw.push((x, z, None));
                        }
                        z += 1.0;
                    }
                    x += 1.0;
                }
            }
            // a very large floor is sampled more coarsely so the calculation stays quick
            let stride = max2(1.0, (raw.len() as f64 / 4000.0).sqrt().ceil());
            let a = (step * stride) * (step * stride);
            side.push(a.sqrt());
            let has_ap = !f.aps.is_empty();
            for (x, z, cell) in raw {
                if stride > 1.0 && (round(x / step) % stride != 0.0 || round(z / step) % stride != 0.0) {
                    continue;
                }
                let Some((kind, room)) = self.place(fi, x, z) else { continue };
                let key = self.group_key(kind);
                let gi = *index.entry(key.clone()).or_insert_with(|| {
                    groups.push(Group { key, kind, pts: Vec::new(), people: 0.0 });
                    groups.len() - 1
                });
                let seat = !f.seats.is_empty() && f.seats.iter().any(|s| x >= s.x - 1.0 && x <= s.x + s.w + 1.0 && z >= s.z - 1.0 && z <= s.z + s.d + 1.0);
                groups[gi].pts.push(pts.len());
                pts.push(Pt { floor: fi, x, z, cell, area: a, w: a * if seat { cfg.seat_weight } else { 1.0 }, group: gi, room, has_ap, people: 0.0 });
            }
        }
        // people for each group
        let mut fixed_total = 0.0;
        for g in &groups {
            if g.key != "free" {
                let p = self.group_people(&g.key).unwrap_or(0.0);
                fixed_total += if p.is_nan() { 0.0 } else { p };
            }
        }
        for z in &cfg.zones {
            if z.people > 0.0 && !index.contains_key(&z.key) {
                notes.push(format!("Zone \"{}\" is outside the floor and holds nobody.", z.name));
            }
        }
        let free_area = index.get("free").map_or(0.0, |&g| groups[g].pts.iter().fold(0.0, |s, &p| s + pts[p].area));
        let free_people = match cfg.total_people {
            Some(t) => max2(0.0, t - fixed_total),
            None => cfg.users_per_m2 * free_area,
        };
        if let Some(t) = cfg.total_people {
            if fixed_total > t {
                notes.push(format!(
                    "The people given to zones and rooms ({}) exceed the total ({}).",
                    fmt_num(round(fixed_total)),
                    cfg.text("totalPeople")
                ));
            }
        }
        for g in groups.iter_mut() {
            let total = if g.key == "free" {
                free_people
            } else {
                let p = self.group_people(&g.key).unwrap_or(0.0);
                if p == 0.0 || p.is_nan() {
                    0.0
                } else {
                    p
                }
            };
            let wsum = g.pts.iter().fold(0.0, |s, &p| s + pts[p].w);
            let wsum = if wsum == 0.0 || wsum.is_nan() { 1.0 } else { wsum };
            for &p in &g.pts {
                pts[p].people = (total * pts[p].w) / wsum;
            }
            g.people = total;
        }
        Occupancy { pts, groups, notes, side }
    }
}

// ---------------------------------------------------------------- steps 3–4

#[derive(Clone, Debug)]
pub struct Cand {
    pub ap: usize,
    pub rssi: f64,
    pub snr: f64,
    pub d: f64,
}

/// A load unit: a share of people at a point (deterministic) or one device
/// (Monte Carlo).
#[derive(Clone, Debug)]
pub struct Unit {
    pub floor: usize,
    pub x: f64,
    pub z: f64,
    pub side: f64,
    pub users: f64,
    pub devices: f64,
    pub active: f64,
    pub cand: Vec<Cand>,
    /// Typical / minimum / peak Mbps of an active device, and the share of
    /// it that is upload. Used when the traffic is per unit (Monte Carlo).
    pub demand: f64,
    pub min: f64,
    pub peak: f64,
    pub up: f64,
    /// Chosen AP (index into Ctx::aps) and the SNR there.
    pub ap: Option<usize>,
    pub snr: f64,
}

#[derive(Default, Clone, Debug)]
pub struct NoSignal {
    pub users: f64,
    pub active: f64,
    pub devices: f64,
    pub demand: f64,
    pub min: f64,
    pub peak: f64,
    pub up_min: f64,
    pub up_peak: f64,
}

/// Step 3: give each unit an AP. `order` is the order units are considered
/// in (load-aware association depends on it).
pub fn associate(ctx: &Ctx, units: &mut [Unit], order: &[usize]) -> (Vec<Vec<usize>>, NoSignal) {
    let min_snr = MIN_SNR_DB[0];
    let mut load = vec![0.0; ctx.aps.len()];
    let mut served: Vec<Vec<usize>> = vec![Vec::new(); ctx.aps.len()];
    let mut ns = NoSignal::default();
    for &u in order {
        let g = &mut units[u];
        let Some(first) = g.cand.first().filter(|c| !(c.snr < min_snr)).cloned() else {
            ns.users += g.users;
            ns.active += g.active;
            ns.devices += g.devices;
            ns.demand += g.active * g.demand;
            ns.min += g.active * g.min;
            ns.peak += g.active * g.peak;
            ns.up_min += g.active * g.min * g.up;
            ns.up_peak += g.active * g.peak * g.up;
            g.ap = None;
            continue;
        };
        let mut pick = first.clone();
        if ctx.cfg.load_aware {
            let pool: Vec<&Cand> = g.cand.iter().filter(|c| c.rssi >= first.rssi - ctx.cfg.roam_margin_db && c.snr >= min_snr).collect();
            if let Some(&p0) = pool.first() {
                let mut b = p0;
                for &c in &pool {
                    if load[c.ap] < load[b.ap] {
                        b = c;
                    }
                }
                pick = b.clone();
            }
        }
        g.ap = Some(pick.ap);
        g.snr = pick.snr;
        load[pick.ap] += g.active;
        served[pick.ap].push(u);
    }
    (served, ns)
}

/// The order the deterministic engine considers units in.
pub fn default_order(ctx: &Ctx, units: &[Unit]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..units.len()).collect();
    if ctx.cfg.load_aware {
        order.sort_by(|&a, &b| units[b].active.partial_cmp(&units[a].active).unwrap_or(std::cmp::Ordering::Equal));
    }
    order
}

#[derive(Default, Clone, Debug)]
pub struct ApAcc {
    pub users: f64,
    pub devices: f64,
    pub active: f64,
    pub typical: f64,
    pub at_min: f64,
    pub at_peak: f64,
    pub capable: f64,
    pub rate_sum: f64,
    pub weakest: Option<f64>,
    pub demand: f64,
    pub min: f64,
    pub peak: f64,
    pub up_min: f64,
    pub up_peak: f64,
}

#[derive(Clone, Debug)]
pub struct ApRow {
    pub acc: ApAcc,
    pub avg_rate: f64,
    pub dom_typical: f64,
    pub dom_min: f64,
    pub dom_peak: f64,
    pub shared_with: usize,
    pub capable_pct: f64,
    pub meets: f64,
    pub radio_limited: bool,
    pub clients_over: bool,
    pub wan_limited: bool,
    pub internet_share: f64,
    pub per_device: Option<f64>,
    pub status: &'static str,
    pub extra: f64,
    pub demand_mbps: f64,
    pub peak_demand_mbps: f64,
}

#[derive(Clone, Debug)]
pub struct Wan {
    pub usable_down: f64,
    pub usable_up: f64,
    pub total_active: f64,
    pub total_devices: f64,
    pub demand_min: f64,
    pub demand_typical: f64,
    pub demand_peak: f64,
    pub up_demand_min: f64,
    pub up_demand_peak: f64,
    pub scale_min: f64,
    pub scale_typical: f64,
}

pub struct Eval {
    pub rows: Vec<ApRow>,
    pub wan: Wan,
    pub ns: NoSignal,
    pub radio_short: bool,
}

/// How the traffic is described: the same for every active device
/// (deterministic) or per unit (Monte Carlo profiles).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Traffic {
    Uniform,
    PerUnit,
}

/// Step 4: airtime per AP and per shared channel, the internet plan, and
/// each AP's verdict.
pub fn evaluate(ctx: &Ctx, units: &[Unit], served: &[Vec<usize>], ns: NoSignal, traffic: Traffic) -> Eval {
    let cfg = &ctx.cfg;
    let uniform = traffic == Traffic::Uniform;
    let accs: Vec<ApAcc> = served
        .iter()
        .map(|list| {
            let mut a = ApAcc::default();
            for &u in list {
                let g = &units[u];
                let rate = ctx.rate_of(g.snr);
                a.users += g.users;
                a.devices += g.devices;
                a.active += g.active;
                let (demand, min, peak) = if uniform { (cfg.demand_mbps, cfg.min_mbps, cfg.peak_mbps) } else { (g.demand, g.min, g.peak) };
                if rate > 0.0 {
                    a.typical += (g.active * demand) / rate;
                    a.at_min += (g.active * min) / rate;
                    a.at_peak += (g.active * peak) / rate;
                    a.rate_sum += g.active * rate;
                    if rate >= min {
                        a.capable += g.active;
                    }
                }
                if !uniform {
                    a.demand += g.active * g.demand;
                    a.min += g.active * g.min;
                    a.peak += g.active * g.peak;
                    a.up_min += g.active * g.min * g.up;
                    a.up_peak += g.active * g.peak * g.up;
                }
                a.weakest = Some(match a.weakest {
                    None => g.snr,
                    Some(w) => min2(w, g.snr),
                });
            }
            a
        })
        .collect();

    // internet
    let total_active = accs.iter().fold(0.0, |s, a| s + a.active) + ns.active;
    let usable_down = cfg.wan_down * (1.0 - cfg.headroom_pct / 100.0);
    let usable_up = cfg.wan_up * (1.0 - cfg.headroom_pct / 100.0);
    let (demand_min, demand_typical, demand_peak, up_demand_min, up_demand_peak) = if uniform {
        let m = total_active * cfg.min_mbps;
        let p = total_active * cfg.peak_mbps;
        (m, total_active * cfg.demand_mbps, p, m * cfg.upload_share, p * cfg.upload_share)
    } else {
        let s = |f: fn(&ApAcc) -> f64| accs.iter().fold(0.0, |s, a| s + f(a));
        (s(|a| a.min) + ns.min, s(|a| a.demand) + ns.demand, s(|a| a.peak) + ns.peak, s(|a| a.up_min) + ns.up_min, s(|a| a.up_peak) + ns.up_peak)
    };
    let scale_min = if demand_min > usable_down { usable_down / demand_min } else { 1.0 };
    let scale_typical = if demand_typical > usable_down { usable_down / demand_typical } else { 1.0 };
    let wan = Wan {
        usable_down,
        usable_up,
        total_active,
        total_devices: accs.iter().fold(0.0, |s, a| s + a.devices) + ns.devices,
        demand_min,
        demand_typical,
        demand_peak,
        up_demand_min,
        up_demand_peak,
        scale_min,
        scale_typical,
    };

    // per AP, with the APs sharing its channel
    let domain = |i: usize| -> Vec<usize> {
        let mut d = vec![i];
        d.extend(ctx.chan.neighbours[i].iter().copied().filter(|&n| ctx.chan.assign[n] == ctx.chan.assign[i]));
        d
    };
    let rows: Vec<ApRow> = accs
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let dom = domain(i);
            let sum = |f: fn(&ApAcc) -> f64| dom.iter().fold(0.0, |s, &j| s + f(&accs[j]));
            let (dom_typical, dom_min, dom_peak) = (sum(|a| a.typical), sum(|a| a.at_min), sum(|a| a.at_peak));
            let active = r.active != 0.0 && !r.active.is_nan();
            let radio_scale_min = if dom_min > 1.0 { 1.0 / dom_min } else { 1.0 };
            let capable_pct = if active { r.capable / r.active } else { 1.0 };
            let meets = capable_pct * radio_scale_min * scale_min;
            let internet_share = if total_active != 0.0 { min2(demand_typical, usable_down) * (r.active / total_active) } else { 0.0 };
            let radio_limited = r.active > 0.0 && (dom_min > 1.0 || capable_pct < 0.999 || dom_typical > cfg.target_utilisation);
            let clients_over = r.devices > cfg.max_clients_per_ap;
            let per_active_demand = if uniform { cfg.demand_mbps } else if active { r.demand / r.active } else { 0.0 };
            let per_device = active.then(|| per_active_demand * min2(1.0, if dom_typical > 1.0 { 1.0 / dom_typical } else { 1.0 }) * scale_typical);
            let status = if !active {
                "no devices"
            } else if clients_over {
                "too many devices"
            } else if dom_min > 1.0 {
                "cannot give the minimum speed (airtime)"
            } else if capable_pct < 0.999 {
                "weak signal for some devices"
            } else if dom_typical > cfg.target_utilisation {
                "airtime busy"
            } else if scale_min < 1.0 {
                "limited by the internet plan"
            } else {
                "ok"
            };
            let extra = max2(
                0.0,
                (crate::js::max_all([r.devices / cfg.max_clients_per_ap, dom_typical / cfg.target_utilisation, dom_min]) - 1e-9).ceil() - 1.0,
            );
            ApRow {
                avg_rate: if active { r.rate_sum / r.active } else { 0.0 },
                dom_typical,
                dom_min,
                dom_peak,
                shared_with: dom.len() - 1,
                capable_pct,
                meets,
                radio_limited,
                clients_over,
                wan_limited: r.active > 0.0 && scale_min < 1.0,
                internet_share,
                per_device,
                status,
                extra: if radio_limited || clients_over { extra } else { 0.0 },
                demand_mbps: if uniform { r.active * cfg.demand_mbps } else { r.demand },
                peak_demand_mbps: if uniform { r.active * cfg.peak_mbps } else { r.peak },
                acc: r.clone(),
            }
        })
        .collect();
    let radio_short = rows.iter().any(|r| r.radio_limited || r.status == "too many devices");
    Eval { rows, wan, ns, radio_short }
}

// ---------------------------------------------------------------- the deterministic result

fn opt(v: Option<f64>) -> Value {
    v.map_or(Value::Null, Value::from)
}

/// The deterministic capacity result (what the planner's capacity tab shows).
pub fn plan_capacity(plan: &Value, settings: Option<&Value>, cells: Option<&Value>) -> Value {
    let ctx = Ctx::new(plan, settings, cells);
    plan_capacity_ctx(&ctx)
}

pub fn plan_capacity_ctx(ctx: &Ctx) -> Value {
    let cfg = &ctx.cfg;
    let occ = ctx.occupancy();

    let mut units: Vec<Unit> = Vec::new();
    let mut predicted = 0usize;
    let mut estimated = 0usize;
    let mut room_people: HashMap<String, f64> = HashMap::new();
    let mut open_people = 0.0;
    let mut area_total = 0.0;
    let mut unserved_people: HashMap<usize, f64> = HashMap::new();
    for q in &occ.pts {
        area_total += q.area;
        match q.room {
            Some(r) => *room_people.entry(ctx.rooms[r].sid.clone()).or_insert(0.0) += q.people,
            None => open_people += q.people,
        }
        if !q.has_ap {
            *unserved_people.entry(q.floor).or_insert(0.0) += q.people;
            continue;
        }
        let devices = q.people * cfg.devices_per_user;
        let cell = q.cell.map(|c| &ctx.floors[q.floor].cells[c]);
        let (cand, used) = ctx.candidates(q.floor, q.x, q.z, cell);
        if used {
            predicted += 1;
        } else {
            estimated += 1;
        }
        units.push(Unit {
            floor: q.floor,
            x: q.x,
            z: q.z,
            side: q.area.sqrt(),
            users: q.people,
            devices,
            active: devices * cfg.active_fraction,
            cand,
            demand: cfg.demand_mbps,
            min: cfg.min_mbps,
            peak: cfg.peak_mbps,
            up: cfg.upload_share,
            ap: None,
            snr: f64::NAN,
        });
    }
    let unserved: Vec<Value> = ctx
        .floors
        .iter()
        .enumerate()
        .filter_map(|(i, f)| {
            let u = unserved_people.get(&i).copied().unwrap_or(0.0);
            (u > 0.0).then(|| json!({ "floorId": f.id, "name": f.name, "users": r1(u) }))
        })
        .collect();
    let mut room_rows: Vec<Value> = ctx
        .rooms
        .iter()
        .filter(|r| room_people.contains_key(&r.sid))
        .map(|r| json!({ "roomId": r.id, "name": r.name, "floorId": r.floor, "areaM2": r1(r.area), "users": r1(room_people[&r.sid]) }))
        .collect();
    if open_people > 0.0 {
        room_rows.push(json!({ "roomId": null, "name": "Open area, corridors", "users": r1(open_people) }));
    }

    let order = default_order(ctx, &units);
    let (served, ns) = associate(ctx, &mut units, &order);
    let ev = evaluate(ctx, &units, &served, ns, Traffic::Uniform);
    let w = &ev.wan;

    let head = 1.0 - cfg.headroom_pct / 100.0;
    let wan = json!({
        "planDownMbps": cfg.raw.get("wanDownMbps"),
        "planUpMbps": cfg.raw.get("wanUpMbps"),
        "headroomPct": cfg.raw.get("wanHeadroomPct"),
        "usableDownMbps": r1(w.usable_down),
        "usableUpMbps": r1(w.usable_up),
        "activeDevices": r1(w.total_active),
        "totalDevices": r1(w.total_devices),
        "demandMinMbps": r1(w.demand_min),
        "demandTypicalMbps": r1(w.demand_typical),
        "demandPeakMbps": r1(w.demand_peak),
        "upDemandMinMbps": r1(w.up_demand_min),
        "upDemandPeakMbps": r1(w.up_demand_peak),
        "downVsMinPct": if w.usable_down > 0.0 { Value::from(r1((w.demand_min / w.usable_down) * 100.0)) } else { Value::Null },
        "sufficientForMin": w.demand_min <= w.usable_down,
        "sufficientForPeak": w.demand_peak <= w.usable_down,
        "upSufficientForMin": w.up_demand_min <= w.usable_up,
        "neededPlanMbps": r1(w.demand_min / head),
        "neededPlanPeakMbps": r1(w.demand_peak / head),
    });
    let sufficient_min = w.demand_min <= w.usable_down;
    let sufficient_peak = w.demand_peak <= w.usable_down;

    let rows: Vec<Value> = ev
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let ap = &ctx.aps[i];
            let active = r.acc.active != 0.0 && !r.acc.active.is_nan();
            json!({
                "id": ap.id, "name": ap.label, "floorId": ap.floor,
                "users": r1(r.acc.users), "devices": round(r.acc.devices), "activeDevices": r1(r.acc.active),
                "avgRateMbps": r1(r.avg_rate), "weakestSnrDb": opt(r.acc.weakest.map(r1)),
                "demandMbps": r1(r.demand_mbps), "peakDemandMbps": r1(r.peak_demand_mbps),
                "airtimeTypicalPct": r1(r.acc.typical * 100.0), "airtimeMinPct": r1(r.acc.at_min * 100.0), "airtimePeakPct": r1(r.acc.at_peak * 100.0),
                "sharedAirtimeMinPct": r1(r.dom_min * 100.0), "sharedWith": r.shared_with,
                "internetShareMbps": r1(r.internet_share),
                "perDeviceMbps": opt(r.per_device.map(r1)),
                "meetsMinimumPct": if active { Value::from(round(r.meets * 100.0)) } else { Value::Null },
                "radioLimited": r.radio_limited, "wanLimited": r.wan_limited, "status": r.status, "extraApsNeeded": r.extra,
                "channel": ctx.chan.assign.get(i).copied().filter(|c| !c.is_nan()),
            })
        })
        .collect();

    let coverage_short = ev.ns.active > 0.0 || !unserved.is_empty();
    let overall = if w.total_active != 0.0 {
        let s = rows.iter().fold(0.0, |s, r| {
            let m = r["meetsMinimumPct"].as_f64().unwrap_or(100.0);
            s + m * r["activeDevices"].as_f64().unwrap_or(0.0)
        });
        Value::from(round(s / w.total_active))
    } else {
        Value::Null
    };
    let mut verdict = Vec::new();
    if !sufficient_min {
        verdict.push("internet");
    }
    if ev.radio_short {
        verdict.push("radio");
    }
    if coverage_short {
        verdict.push("coverage");
    }

    let wn = |k: &str| fmt_num(wan[k].as_f64().unwrap_or(f64::NAN));
    let mut rec: Vec<String> = Vec::new();
    if !sufficient_min {
        rec.push(format!(
            "Internet plan: {} Mbps is usable but the active devices need {} Mbps at {} Mbps each. Choose a plan of at least {} Mbps. More access points will not fix this.",
            wn("usableDownMbps"),
            wn("demandMinMbps"),
            cfg.text("minMbps"),
            fmt_num(wan["neededPlanMbps"].as_f64().unwrap_or(f64::NAN).ceil())
        ));
    } else if !sufficient_peak {
        rec.push(format!(
            "Internet plan: enough for the minimum speed, but not if every active device runs at its {} Mbps peak ({} Mbps needed; plan of about {} Mbps).",
            cfg.text("peakMbps"),
            wn("demandPeakMbps"),
            fmt_num(wan["neededPlanPeakMbps"].as_f64().unwrap_or(f64::NAN).ceil())
        ));
    }
    if w.up_demand_min > w.usable_up || w.up_demand_min.is_nan() {
        rec.push(format!("Upload: the minimum speeds need about {} Mbps upload but {} Mbps is usable.", wn("upDemandMinMbps"), wn("usableUpMbps")));
    }
    for (i, r) in ev.rows.iter().enumerate() {
        if r.radio_limited || r.status == "too many devices" {
            rec.push(format!(
                "{}: {}{}. Add or move an access point, use a different channel, or move devices to a less busy AP{}.",
                to_str(Some(&ctx.aps[i].label)),
                r.status,
                if r.shared_with > 0 { format!(" (shares its channel with {} nearby AP(s))", r.shared_with) } else { String::new() },
                if r.extra != 0.0 { format!("; about {} more AP(s) needed here", fmt_num(r.extra)) } else { String::new() }
            ));
        }
    }
    if !ctx.chan.conflicts.is_empty() {
        rec.push(format!("{} pair(s) of nearby APs have to share a channel. A narrower channel width gives more channels.", ctx.chan.conflicts.len()));
    }
    if ev.ns.active > 0.0 {
        rec.push(format!(
            "About {} people are where the signal is too weak to connect at all. Move or add an AP there (see the coverage prediction).",
            fmt_num(r1(ev.ns.users))
        ));
    }
    if !unserved.is_empty() {
        let names: Vec<String> = unserved.iter().map(|u| to_str(u.get("name"))).collect();
        rec.push(format!("{}: no AP on this floor.", names.join(", ")));
    }
    if rec.is_empty() {
        rec.push("No bottleneck found for these assumptions.".into());
    }

    let summary = json!({
        "totalUsers": r1(occ.pts.iter().fold(0.0, |s, q| s + q.people)),
        "floorAreaM2": r1(area_total),
        "activeDevices": wan["activeDevices"],
        "overloaded": ev.rows.iter().filter(|r| r.radio_limited).count(),
        "extraApsNeeded": ev.rows.iter().fold(0.0, |s, r| s + r.extra) + unserved.len() as f64,
        "meetingMinimumPct": overall,
        "coChannelPairs": ctx.chan.conflicts.len(),
        "noSignalUsers": r1(ev.ns.users),
    });
    let source = if predicted > 0 && estimated > 0 {
        "mixed"
    } else if predicted > 0 {
        "ray-traced"
    } else {
        "distance estimate"
    };

    let mut settings_out = cfg.raw.clone();
    settings_out.insert("widthMHz".into(), Value::from(ctx.width));
    let clients: Vec<Value> = units
        .iter()
        .map(|g| {
            json!({
                "floorId": ctx.floors[g.floor].id, "x": g.x, "z": g.z, "side": g.side, "people": g.users,
                "apId": g.ap.map_or(Value::Null, |a| ctx.aps[a].id.clone()),
                "snrDb": if g.ap.is_some() { Value::from(r1(g.snr)) } else { Value::Null },
            })
        })
        .collect();
    let mut assumptions = assumptions(ctx, source, area_total);
    assumptions.extend(occ.notes.iter().cloned());
    json!({
        "settings": settings_out,
        "wan": wan,
        "aps": rows,
        "rooms": room_rows,
        "unserved": unserved,
        "summary": summary,
        "bottleneck": { "internet": !sufficient_min, "radio": ev.radio_short, "coverage": coverage_short, "verdict": verdict },
        "recommendations": rec,
        "source": source,
        "clients": clients,
        "notes": occ.notes,
        "channels": channels_json(ctx),
        "assumptions": assumptions,
    })
}

pub fn channels_json(ctx: &Ctx) -> Value {
    let mut plan = Map::new();
    for &i in &ctx.chan.order {
        plan.insert(ctx.aps[i].sid.clone(), Value::from(ctx.chan.assign[i]));
    }
    let conflicts: Vec<Value> = ctx.chan.conflicts.iter().map(|&(a, b, c)| json!({ "a": ctx.aps[a].id, "b": ctx.aps[b].id, "channel": c })).collect();
    json!({ "plan": plan, "conflicts": conflicts, "list": ctx.channel_list })
}

fn assumptions(ctx: &Ctx, source: &str, area_total: f64) -> Vec<String> {
    let cfg = &ctx.cfg;
    vec![
        format!(
            "Signal: {}.",
            match source {
                "ray-traced" => "from the ray-traced prediction",
                "mixed" => "from the ray-traced prediction where it reaches, estimated from distance elsewhere",
                _ => "estimated from distance only (no walls); run the ray-traced prediction for a better result",
            }
        ),
        format!(
            "Data rate from the signal-to-noise ratio with nominal {} rates, {} MHz, {} stream(s). The SNR needed for each rate and the {}% efficiency are illustrative.",
            standard_label(&cfg.standard).unwrap_or("undefined"),
            fmt_num(ctx.width),
            fmt_num(ctx.streams),
            fmt_num(round(cfg.mac_efficiency * 100.0))
        ),
        format!(
            "Devices are given to the {}.",
            if cfg.load_aware {
                format!(
                    "AP with the least load among those within {} dB of the strongest (a planning assumption; real devices choose for themselves)",
                    cfg.text("roamMarginDb")
                )
            } else {
                "strongest AP (real devices choose for themselves)".into()
            }
        ),
        "APs on the same channel within the interference distance share the air; walls between them are not considered.".into(),
        format!(
            "People are spread over the whole floor ({} m²) {}, not only inside rooms; rooms marked as excluded and zones with 0 people hold nobody.",
            fmt_num(round(area_total)),
            if cfg.furniture { "with more near desks and seats" } else { "evenly" }
        ),
    ]
}

/// How the answer changes when the assumptions are wrong. Each row is a full
/// calculation.
pub fn sensitivity(plan: &Value, settings: Option<&Value>, cells: Option<&Value>) -> Value {
    let base = plan_capacity(plan, settings, cells);
    let people = base["summary"]["totalUsers"].as_f64().unwrap_or(0.0);
    let min = num(base["settings"].get("minMbps"));
    let variants: Vec<(String, Value)> = vec![
        ("As set".into(), json!({})),
        ("50% more people".into(), json!({ "totalPeople": round(people * 1.5) })),
        ("Twice the people".into(), json!({ "totalPeople": round(people * 2.0) })),
        ("80% of devices active".into(), json!({ "activeFraction": 0.8 })),
        ("All devices active".into(), json!({ "activeFraction": 1 })),
        (format!("Minimum speed {} Mbps", fmt_num(min * 2.0)), json!({ "minMbps": min * 2.0 })),
    ];
    let rows: Vec<Value> = variants
        .into_iter()
        .map(|(label, change)| {
            let out = if change.as_object().is_some_and(|m| !m.is_empty()) {
                let mut s = match settings {
                    Some(Value::Object(m)) => m.clone(),
                    _ => Map::new(),
                };
                for (k, v) in change.as_object().unwrap() {
                    s.insert(k.clone(), v.clone());
                }
                plan_capacity(plan, Some(&Value::Object(s)), cells)
            } else {
                base.clone()
            };
            json!({
                "label": label,
                "people": out["summary"]["totalUsers"],
                "activeDevices": out["wan"]["activeDevices"],
                "demandMinMbps": out["wan"]["demandMinMbps"],
                "neededPlanMbps": out["wan"]["neededPlanMbps"],
                "meetingMinimumPct": out["summary"]["meetingMinimumPct"],
                "overloadedAps": out["summary"]["overloaded"],
                "verdict": out["bottleneck"]["verdict"],
            })
        })
        .collect();
    Value::Array(rows)
}
