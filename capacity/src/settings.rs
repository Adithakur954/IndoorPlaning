//! Capacity settings: the defaults and the merged, typed view the engine uses.

use crate::js::{finite, is_str, num, to_str};
use crate::radio::Band;
use serde_json::{json, Map, Value};

/// The defaults the planner shows (the JavaScript copy in
/// src/infra/wifi/capacityDefaults.js is checked against this by a test).
pub fn defaults() -> Value {
    json!({
        "totalPeople": null,
        "usersPerM2": 0.2,
        "devicesPerUser": 1.5,
        "activeFraction": 0.6,
        "minMbps": 5,
        "demandMbpsPerActive": 5,
        "peakMbps": 10,
        "roomUsers": {},
        "distribution": "uniform",
        "seatWeight": 5,
        "zones": [],
        "wanDownMbps": 300,
        "wanUpMbps": 300,
        "wanHeadroomPct": 15,
        "uploadShare": 0.2,
        "standard": "wifi6",
        "band": "5",
        "widthMHz": 80,
        "apStreams": 2,
        "clientStreams": 2,
        "macEfficiency": 0.65,
        "targetUtilisation": 0.5,
        "maxClientsPerAp": 100,
        "interferenceM": 25,
        "channels": null,
        "association": "strongest",
        "roamMarginDb": 6,
        "txEirpDbm": 20,
        "noiseFigureDb": 7,
        "pathLossExponent": 3.5
    })
}

#[derive(Clone, Debug)]
pub struct Zone {
    pub id: Value,
    pub key: String,
    pub name: String,
    pub floor: Value,
    pub x: f64,
    pub z: f64,
    pub width: f64,
    pub depth: f64,
    pub people: f64,
}

/// `{ ...defaults, ...settings }` with every field the engine reads.
#[derive(Clone, Debug)]
pub struct Cfg {
    /// The merged object, returned as `settings` and used where a value is
    /// printed as given.
    pub raw: Map<String, Value>,
    pub total_people: Option<f64>,
    pub users_per_m2: f64,
    pub devices_per_user: f64,
    pub active_fraction: f64,
    pub min_mbps: f64,
    pub demand_mbps: f64,
    pub peak_mbps: f64,
    pub room_users: Option<Map<String, Value>>,
    pub furniture: bool,
    pub seat_weight: f64,
    pub zones: Vec<Zone>,
    pub wan_down: f64,
    pub wan_up: f64,
    pub headroom_pct: f64,
    pub upload_share: f64,
    pub standard: String,
    pub band: Band,
    pub width_mhz: f64,
    pub ap_streams: f64,
    pub client_streams: f64,
    pub mac_efficiency: f64,
    pub target_utilisation: f64,
    pub max_clients_per_ap: f64,
    pub interference_m: f64,
    pub channels: Option<Vec<f64>>,
    pub load_aware: bool,
    pub roam_margin_db: f64,
    pub tx_eirp_dbm: f64,
    pub noise_figure_db: f64,
    pub path_loss_exponent: f64,
}

impl Cfg {
    pub fn new(settings: Option<&Value>) -> Cfg {
        let mut raw = match defaults() {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        if let Some(Value::Object(s)) = settings {
            for (k, v) in s {
                raw.insert(k.clone(), v.clone());
            }
        }
        let g = |k: &str| num(raw.get(k));
        let zones = match raw.get("zones") {
            Some(Value::Array(list)) => list
                .iter()
                .filter(|z| num(z.get("people")).is_finite() && num(z.get("width")) > 0.0 && num(z.get("depth")) > 0.0)
                .map(|z| Zone {
                    id: z.get("id").cloned().unwrap_or(Value::Null),
                    key: format!("z:{}", to_str(z.get("id"))),
                    name: to_str(crate::js::or(z.get("name"), z.get("id"))),
                    floor: z.get("floorId").cloned().unwrap_or(Value::Null),
                    x: num(z.get("x")),
                    z: num(z.get("z")),
                    width: num(z.get("width")),
                    depth: num(z.get("depth")),
                    people: num(z.get("people")),
                })
                .collect(),
            _ => Vec::new(),
        };
        let channels = match raw.get("channels") {
            Some(Value::Array(c)) if !c.is_empty() => Some(c.iter().map(|v| num(Some(v))).collect()),
            _ => None,
        };
        Cfg {
            total_people: finite(raw.get("totalPeople")),
            users_per_m2: g("usersPerM2"),
            devices_per_user: g("devicesPerUser"),
            active_fraction: g("activeFraction"),
            min_mbps: g("minMbps"),
            demand_mbps: g("demandMbpsPerActive"),
            peak_mbps: g("peakMbps"),
            room_users: match raw.get("roomUsers") {
                Some(Value::Object(m)) => Some(m.clone()),
                _ => None,
            },
            furniture: is_str(raw.get("distribution"), "furniture"),
            seat_weight: g("seatWeight"),
            zones,
            wan_down: g("wanDownMbps"),
            wan_up: g("wanUpMbps"),
            headroom_pct: g("wanHeadroomPct"),
            upload_share: g("uploadShare"),
            standard: to_str(raw.get("standard")),
            band: Band::from_value(raw.get("band")),
            width_mhz: g("widthMHz"),
            ap_streams: g("apStreams"),
            client_streams: g("clientStreams"),
            mac_efficiency: g("macEfficiency"),
            target_utilisation: g("targetUtilisation"),
            max_clients_per_ap: g("maxClientsPerAp"),
            interference_m: g("interferenceM"),
            channels,
            load_aware: is_str(raw.get("association"), "load-aware"),
            roam_margin_db: g("roamMarginDb"),
            tx_eirp_dbm: g("txEirpDbm"),
            noise_figure_db: g("noiseFigureDb"),
            path_loss_exponent: g("pathLossExponent"),
            raw,
        }
    }

    /// People fixed for a room (`Number.isFinite(cfg.roomUsers?.[id])`).
    pub fn room_people(&self, room_id: &str) -> Option<f64> {
        self.room_users.as_ref().and_then(|m| finite(m.get(room_id)))
    }

    /// A setting printed the way JavaScript prints it in a template string.
    pub fn text(&self, key: &str) -> String {
        to_str(self.raw.get(key))
    }
}
