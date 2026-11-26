//! Wi-Fi capacity engine.
//!
//! One crate for every place the capacity is calculated:
//! - the planner loads it as WebAssembly (`cargo build --target
//!   wasm32-unknown-unknown`, see scripts/build-capacity-wasm.mjs) and calls
//!   it through `cap_call` with JSON requests;
//! - Rust code (the simulation service) links it and calls [`handle`] or the
//!   functions below directly.
//!
//! Requests are `{ "op": ..., "plan", "settings", "cells" }`:
//! - `plan`        deterministic capacity (expected loads)
//! - `sensitivity` the deterministic result under changed assumptions
//! - `monteCarlo`  individual users and devices over many seeded iterations
//! - `loadTest`    the same APs under a rising number of users: breaking
//!   point, KPI degradation and capacity heat maps
//! - `loadTestHeatmap` the load test's heat maps and checks at any `users`
//! - `links`       every AP seen from one position (distance, RSSI, SNR, rate)
//! - `meta`        defaults, standards and limits for the planner's forms
//! - `phyRate`, `channelsFor`, `maxWidth` radio helpers
//! - `setCells`    keep a ray-traced prediction; later requests pass
//!   `"cells": "cached"` instead of sending it again

pub mod apsearch;
pub mod geometry;
pub mod js;
pub mod loadmodel;
pub mod loadtest;
pub mod model;
pub mod montecarlo;
pub mod radio;
pub mod rng;
pub mod settings;
#[cfg(target_arch = "wasm32")]
mod wasm;

use serde_json::{json, Value};
use std::cell::RefCell;

pub use model::{plan_capacity, sensitivity};
pub use montecarlo::run as monte_carlo;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

thread_local! {
    static CELLS: RefCell<Value> = const { RefCell::new(Value::Null) };
}

fn with_cells<R>(req: &Value, f: impl FnOnce(Option<&Value>) -> R) -> R {
    match req.get("cells") {
        Some(Value::String(s)) if s == "cached" => CELLS.with(|c| {
            let c = c.borrow();
            f(if c.is_null() { None } else { Some(&c) })
        }),
        Some(Value::Null) | None => f(None),
        Some(v) => f(Some(v)),
    }
}

pub fn meta() -> Value {
    let standards: serde_json::Map<String, Value> = radio::STANDARDS.iter().map(|(k, v)| ((*k).to_string(), Value::from(*v))).collect();
    let max_width: serde_json::Map<String, Value> = radio::STANDARDS
        .iter()
        .map(|(k, _)| {
            (
                (*k).to_string(),
                json!({
                    "2.4": radio::max_width_mhz(k, radio::Band::B24),
                    "5": radio::max_width_mhz(k, radio::Band::B5),
                    "6": radio::max_width_mhz(k, radio::Band::B6),
                }),
            )
        })
        .collect();
    json!({
        "version": VERSION,
        "defaults": settings::defaults(),
        "monteCarloDefaults": montecarlo::defaults(),
        "loadTestDefaults": loadtest::defaults(),
        "standards": standards,
        "maxWidthMHz": max_width,
        "minSnrDb": radio::MIN_SNR_DB,
    })
}

/// Answer one request.
pub fn handle(req: &Value) -> Value {
    let plan = req.get("plan").unwrap_or(&Value::Null);
    let settings = req.get("settings");
    match req.get("op").and_then(Value::as_str) {
        Some("plan") => with_cells(req, |c| plan_capacity(plan, settings, c)),
        Some("sensitivity") => with_cells(req, |c| sensitivity(plan, settings, c)),
        Some("monteCarlo") => with_cells(req, |c| monte_carlo(plan, settings, c)),
        Some("loadTest") => with_cells(req, |c| loadtest::run(plan, settings, c)),
        Some("loadTestHeatmap") => with_cells(req, |c| loadtest::heatmap_at(plan, settings, c, js::num(req.get("users")))),
        Some("links") => with_cells(req, |c| montecarlo::links(plan, settings, c, req.get("floorId"), js::num(req.get("x")), js::num(req.get("z")))),
        Some("meta") => meta(),
        Some("phyRate") => json!(radio::phy_rate_mbps(
            &js::to_str(req.get("standard").filter(|v| !v.is_null()).or(Some(&json!("wifi6")))),
            req.get("widthMHz").map_or(80.0, |v| js::num(Some(v))),
            req.get("streams").map_or(2.0, |v| js::num(Some(v))),
            js::num(req.get("snrDb")),
        )),
        Some("channelsFor") => json!(radio::channels_for(radio::Band::from_value(req.get("band")), js::num(req.get("widthMHz")))),
        Some("maxWidth") => json!(radio::max_width_mhz(&js::to_str(req.get("standard")), radio::Band::from_value(req.get("band")))),
        Some("setCells") => {
            let cells = req.get("cells").cloned().unwrap_or(Value::Null);
            CELLS.with(|c| *c.borrow_mut() = cells);
            json!({ "ok": true })
        }
        Some(op) => json!({ "error": format!("unknown op: {op}") }),
        None => json!({ "error": "missing op" }),
    }
}

/// Answer one request given as JSON text.
pub fn handle_json(input: &[u8]) -> Vec<u8> {
    let out = match serde_json::from_slice::<Value>(input) {
        Ok(req) => handle(&req),
        Err(e) => json!({ "error": format!("bad request: {e}") }),
    };
    serde_json::to_vec(&out).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}").into_bytes())
}
