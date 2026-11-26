//! Wi-Fi radio figures: data rate from SNR, channel lists and channel planning.

use crate::js::{hypot, locale_cmp, max_all};

/// Data rate in Mbit/s of ONE spatial stream on a 20 MHz channel, by MCS,
/// standard guard interval. Nominal values from the standards.
const RATE20_WIFI4: &[f64] = &[6.5, 13.0, 19.5, 26.0, 39.0, 52.0, 58.5, 65.0];
const RATE20_WIFI5: &[f64] = &[6.5, 13.0, 19.5, 26.0, 39.0, 52.0, 58.5, 65.0, 78.0, 86.7];
const RATE20_WIFI6: &[f64] = &[8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86.0, 103.2, 114.7, 129.0, 143.4];
const RATE20_WIFI7: &[f64] = &[8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86.0, 103.2, 114.7, 129.0, 143.4, 172.1, 193.4];

/// How a wider channel multiplies the 20 MHz rate, as (width, factor).
const WIDTH_WIFI4: &[(f64, f64)] = &[(20.0, 1.0), (40.0, 2.077)];
const WIDTH_WIFI5: &[(f64, f64)] = &[(20.0, 1.0), (40.0, 2.077), (80.0, 4.5), (160.0, 9.0)];
const WIDTH_WIFI6: &[(f64, f64)] = &[(20.0, 1.0), (40.0, 2.0), (80.0, 4.2), (160.0, 8.4)];
const WIDTH_WIFI7: &[(f64, f64)] = &[(20.0, 1.0), (40.0, 2.0), (80.0, 4.2), (160.0, 8.4), (320.0, 16.8)];

/// SNR (dB) a receiver needs for each MCS (typical figures: illustrative).
pub const MIN_SNR_DB: [f64; 14] = [5.0, 8.0, 11.0, 14.0, 18.0, 21.0, 24.0, 26.0, 30.0, 32.0, 35.0, 37.0, 40.0, 42.0];

pub const STANDARDS: [(&str, &str); 4] = [
    ("wifi4", "Wi-Fi 4 (802.11n)"),
    ("wifi5", "Wi-Fi 5 (802.11ac)"),
    ("wifi6", "Wi-Fi 6 / 6E (802.11ax)"),
    ("wifi7", "Wi-Fi 7 (802.11be)"),
];

pub fn standard_label(standard: &str) -> Option<&'static str> {
    STANDARDS.iter().find(|(k, _)| *k == standard).map(|(_, v)| *v)
}

fn tables(standard: &str) -> (&'static [f64], &'static [(f64, f64)]) {
    match standard {
        "wifi4" => (RATE20_WIFI4, WIDTH_WIFI4),
        "wifi5" => (RATE20_WIFI5, WIDTH_WIFI5),
        "wifi7" => (RATE20_WIFI7, WIDTH_WIFI7),
        _ => (RATE20_WIFI6, WIDTH_WIFI6),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Band {
    B24,
    B5,
    B6,
}

impl Band {
    /// Only the exact strings "2.4" and "6" select those bands; anything else is 5 GHz.
    pub fn from_value(v: Option<&serde_json::Value>) -> Band {
        match v {
            Some(serde_json::Value::String(s)) if s == "2.4" => Band::B24,
            Some(serde_json::Value::String(s)) if s == "6" => Band::B6,
            _ => Band::B5,
        }
    }
    pub fn path_loss_1m(self) -> f64 {
        match self {
            Band::B24 => 40.0,
            Band::B6 => 49.0,
            Band::B5 => 47.0,
        }
    }
}

/// Widest channel each standard and band allows.
pub fn max_width_mhz(standard: &str, band: Band) -> f64 {
    let top = max_all(tables(standard).1.iter().map(|w| w.0));
    if band == Band::B24 {
        top.min(40.0)
    } else {
        top
    }
}

/// Data rate for an SNR, or 0 when it is too weak to connect.
pub fn phy_rate_mbps(standard: &str, width_mhz: f64, streams: f64, snr_db: f64) -> f64 {
    let (table, factors) = tables(standard);
    let factor = factors
        .iter()
        .find(|w| w.0 == width_mhz)
        .or_else(|| {
            let best = max_all(factors.iter().map(|w| w.0).filter(|w| *w <= width_mhz));
            factors.iter().find(|w| w.0 == best)
        })
        .map_or(1.0, |w| w.1);
    if !snr_db.is_finite() {
        return 0.0;
    }
    let mut mcs: isize = -1;
    for i in 0..table.len() {
        if snr_db >= MIN_SNR_DB[i] {
            mcs = i as isize;
        }
    }
    if mcs < 0 {
        return 0.0;
    }
    if standard == "wifi5" && width_mhz == 20.0 && mcs > 8 {
        mcs = 8;
    }
    table[mcs as usize] * factor * streams
}

/// 20 MHz-aligned channel numbers for a band and width (first of each block).
pub fn channels_for(band: Band, width_mhz: f64) -> Vec<f64> {
    let make = |start: f64, step: f64, n: usize| (0..n).map(|i| start + i as f64 * step).collect::<Vec<_>>();
    match band {
        Band::B24 => {
            if width_mhz >= 40.0 {
                vec![3.0]
            } else {
                vec![1.0, 6.0, 11.0]
            }
        }
        Band::B6 => {
            if width_mhz >= 320.0 {
                vec![31.0, 95.0, 159.0]
            } else if width_mhz >= 160.0 {
                make(15.0, 32.0, 7)
            } else if width_mhz >= 80.0 {
                make(7.0, 16.0, 14)
            } else if width_mhz >= 40.0 {
                make(3.0, 8.0, 12)
            } else {
                make(1.0, 4.0, 24)
            }
        }
        Band::B5 => {
            if width_mhz >= 160.0 {
                vec![50.0, 114.0]
            } else if width_mhz >= 80.0 {
                vec![42.0, 58.0, 106.0, 122.0, 138.0, 155.0]
            } else if width_mhz >= 40.0 {
                vec![38.0, 46.0, 54.0, 62.0, 102.0, 110.0, 118.0, 126.0, 134.0, 142.0, 151.0, 159.0]
            } else {
                vec![
                    36.0, 40.0, 44.0, 48.0, 52.0, 56.0, 60.0, 64.0, 100.0, 104.0, 108.0, 112.0, 116.0, 120.0, 124.0, 128.0, 132.0, 136.0,
                    140.0, 144.0, 149.0, 153.0, 157.0, 161.0, 165.0,
                ]
            }
        }
    }
}

/// What channel planning needs to know about an AP.
pub struct ChanAp<'a> {
    pub id: &'a str,
    pub floor: &'a str,
    pub x: f64,
    pub z: f64,
}

pub struct ChannelPlan {
    /// Channel per AP (same index as the input).
    pub assign: Vec<f64>,
    /// Order in which channels were assigned (for the output map).
    pub order: Vec<usize>,
    pub neighbours: Vec<Vec<usize>>,
    /// (a, b, channel) with a's id < b's id.
    pub conflicts: Vec<(usize, usize, f64)>,
}

/// Greedy colouring: the most crowded APs first, each takes the channel its
/// neighbours use least. Same-floor APs within the interference distance are
/// neighbours; on other floors, within 40% of it.
pub fn plan_channels(aps: &[ChanAp], interference_m: f64, channels: &[f64]) -> ChannelPlan {
    let n = aps.len();
    let near = |a: &ChanAp, b: &ChanAp| {
        let d = hypot(a.x - b.x, a.z - b.z);
        if a.floor == b.floor {
            d < interference_m
        } else {
            d < interference_m * 0.4
        }
    };
    let neighbours: Vec<Vec<usize>> = (0..n).map(|i| (0..n).filter(|&j| aps[j].id != aps[i].id && near(&aps[i], &aps[j])).collect()).collect();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| neighbours[b].len().cmp(&neighbours[a].len()).then_with(|| locale_cmp(aps[a].id, aps[b].id)));
    let mut assign: Vec<Option<f64>> = vec![None; n];
    for &i in &order {
        let mut used: Vec<(f64, usize)> = Vec::new();
        for &c in channels {
            if !used.iter().any(|u| u.0 == c) {
                used.push((c, 0));
            }
        }
        for &nb in &neighbours[i] {
            if let Some(ch) = assign[nb] {
                if let Some(u) = used.iter_mut().find(|u| u.0 == ch) {
                    u.1 += 1;
                }
            }
        }
        let count = |c: f64| used.iter().find(|u| u.0 == c).map_or(0, |u| u.1);
        let mut best = channels.first().copied().unwrap_or(f64::NAN);
        for &c in channels {
            if count(c) < count(best) {
                best = c;
            }
        }
        assign[i] = Some(best);
    }
    let assign: Vec<f64> = assign.into_iter().map(|c| c.unwrap_or(f64::NAN)).collect();
    let mut conflicts = Vec::new();
    for i in 0..n {
        for &j in &neighbours[i] {
            if aps[i].id < aps[j].id && assign[i] == assign[j] {
                conflicts.push((i, j, assign[i]));
            }
        }
    }
    ChannelPlan { assign, order, neighbours, conflicts }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "expected {b}, got {a}");
    }

    #[test]
    fn data_rate() {
        assert_eq!(phy_rate_mbps("wifi6", 20.0, 1.0, 2.0), 0.0);
        near(phy_rate_mbps("wifi6", 20.0, 1.0, 6.0), 8.6, 1e-9);
        near(phy_rate_mbps("wifi6", 20.0, 1.0, 60.0), 143.4, 1e-9);
        near(phy_rate_mbps("wifi6", 80.0, 2.0, 60.0), 143.4 * 4.2 * 2.0, 1e-9);
        assert_eq!(max_width_mhz("wifi6", Band::B24), 40.0);
        assert_eq!(channels_for(Band::B24, 20.0).len(), 3);
    }

    #[test]
    fn channels_avoid_neighbours() {
        let aps = [ChanAp { id: "a", floor: "f", x: 0.0, z: 0.0 }, ChanAp { id: "b", floor: "f", x: 5.0, z: 0.0 }];
        let p = plan_channels(&aps, 25.0, &[36.0, 40.0]);
        assert_ne!(p.assign[0], p.assign[1]);
        assert!(p.conflicts.is_empty());
    }
}
