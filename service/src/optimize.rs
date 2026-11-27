//! Validation of AP-optimisation requests. The Python worker validates again;
//! this keeps obviously bad or oversized requests out of the queue.

use serde_json::{json, Map, Value};

pub const MAX_CANDIDATES: usize = 5000;

// (camelCase key, worker key, lower, upper) for numeric settings.
const NUMBERS: &[(&str, &str, f64, f64)] = &[
    ("thresholdDbm", "threshold_dbm", -120.0, 0.0),
    ("noiseFloor24Dbm", "noise_floor_24_dbm", -110.0, -60.0),
    ("noiseFloor5Dbm", "noise_floor_5_dbm", -110.0, -60.0),
    ("noiseFloor6Dbm", "noise_floor_6_dbm", -110.0, -60.0),
    ("targetCoveragePct", "target_coverage_pct", 1.0, 100.0),
    ("budget", "budget", 0.0, 500.0),
    ("redundancy", "redundancy", 1.0, 4.0),
    ("receiverHeightM", "receiver_height_m", 0.0, 20.0),
    ("resolutionM", "resolution_m", 0.25, 5.0),
    ("screeningResolutionM", "screening_resolution_m", 0.5, 10.0),
    ("samplesPerTx", "samples_per_tx", 10_000.0, 100_000_000.0),
    (
        "screeningSamples",
        "screening_samples",
        10_000.0,
        100_000_000.0,
    ),
    ("maxDepth", "max_depth", 0.0, 20.0),
    ("screeningDepth", "screening_depth", 0.0, 20.0),
    ("seed", "seed", 0.0, 2147483647.0),
    ("shortlistMax", "shortlist_max", 1.0, 2000.0),
    ("shortlistPerRoom", "shortlist_per_room", 0.0, 50.0),
    ("batchSize", "batch_size", 1.0, 256.0),
    ("minApSeparationM", "min_ap_separation_m", 0.0, 50.0),
    ("receiverGainDbi", "receiver_gain_dbi", -20.0, 30.0),
    ("cpuThreads", "cpu_threads", 1.0, 256.0),
];
const STRINGS: &[(&str, &str, &[&str])] = &[
    ("device", "device", &["auto", "gpu", "cpu"]),
    ("band", "band", &["2.4", "5", "6"]),
    (
        "existingHandling",
        "existing_handling",
        &["fixed", "reuse", "ignore"],
    ),
];
const BOOLS: &[(&str, &str)] = &[
    ("includeCommonArea", "include_common_area"),
    ("allowNewAps", "allow_new_aps"),
    ("refraction", "refraction"),
    ("diffraction", "diffraction"),
    ("diffuseReflection", "diffuse_reflection"),
];

/// Checks the request and returns the worker's snake_case settings (without
/// paths and candidates, which the caller adds).
pub fn worker_settings(settings: &Value) -> Result<Map<String, Value>, String> {
    let obj = settings.as_object().ok_or("settings must be an object")?;
    let known = |k: &str| {
        NUMBERS.iter().any(|n| n.0 == k)
            || STRINGS.iter().any(|s| s.0 == k)
            || BOOLS.iter().any(|b| b.0 == k)
            || ["roomOverrides", "floorIds", "lockedApIds", "keepApIds"].contains(&k)
    };
    if let Some(k) = obj.keys().find(|k| !known(k)) {
        return Err(format!("unknown setting '{k}'"));
    }
    let mut out = Map::new();
    for (key, name, lo, hi) in NUMBERS {
        if let Some(v) = obj.get(*key).filter(|v| !v.is_null()) {
            let n = v.as_f64().ok_or(format!("{key} must be a number"))?;
            if !n.is_finite() || n < *lo || n > *hi {
                return Err(format!("{key} must be between {lo} and {hi}"));
            }
            out.insert(name.to_string(), v.clone());
        }
    }
    for (key, name, allowed) in STRINGS {
        if let Some(v) = obj.get(*key) {
            let s = v.as_str().ok_or(format!("{key} must be a string"))?;
            if !allowed.contains(&s) {
                return Err(format!("{key} must be one of {allowed:?}"));
            }
            out.insert(name.to_string(), v.clone());
        }
    }
    for (key, name) in BOOLS {
        if let Some(v) = obj.get(*key) {
            if !v.is_boolean() {
                return Err(format!("{key} must be true or false"));
            }
            out.insert(name.to_string(), v.clone());
        }
    }
    if let Some(v) = obj.get("roomOverrides") {
        if !v.is_object() {
            return Err("roomOverrides must be an object".into());
        }
        out.insert("room_overrides".into(), v.clone());
    }
    if let Some(v) = obj.get("floorIds") {
        if !v.is_array() {
            return Err("floorIds must be a list".into());
        }
        out.insert("floor_ids".into(), v.clone());
    }
    for (key, name) in [
        ("lockedApIds", "locked_ap_ids"),
        ("keepApIds", "keep_ap_ids"),
    ] {
        if let Some(v) = obj.get(key) {
            if !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)) {
                return Err(format!("{key} must be a list of access point ids"));
            }
            out.insert(name.into(), v.clone());
        }
    }
    if obj.get("targetCoveragePct").map_or(true, Value::is_null)
        && obj.get("budget").map_or(true, Value::is_null)
    {
        return Err("give a target coverage, a budget, or both".into());
    }
    // null means "maximise coverage for the budget"
    if obj.get("targetCoveragePct").is_some_and(Value::is_null) {
        out.insert("target_coverage_pct".into(), Value::Null);
    }
    Ok(out)
}

pub fn validate_candidates(candidates: &Value) -> Result<(), String> {
    let list = candidates.as_array().ok_or("candidates must be a list")?;
    if list.is_empty() || list.len() > MAX_CANDIDATES {
        return Err(format!(
            "candidates must hold 1 to {MAX_CANDIDATES} entries"
        ));
    }
    for c in list {
        for key in ["id", "floorId", "x", "z", "heightM"] {
            if c.get(key).is_none() {
                return Err(format!("a candidate is missing '{key}'"));
            }
        }
        for key in ["x", "z", "heightM"] {
            if !c[key].as_f64().is_some_and(f64::is_finite) {
                return Err(format!("candidate {} has an invalid '{key}'", c["id"]));
            }
        }
    }
    Ok(())
}

pub fn validate_profile(profile: &Value) -> Result<(), String> {
    if let Some(width) = profile.get("bandwidthMHz") {
        if !width
            .as_f64()
            .is_some_and(|n| n.is_finite() && (1.0..=320.0).contains(&n))
        {
            return Err("profile.bandwidthMHz must be between 1 and 320".into());
        }
    }
    for key in ["txPowerDbm", "gainDbi", "freqMHz"] {
        if !profile
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        {
            return Err(format!("profile.{key} is required"));
        }
    }
    let tx = profile["txPowerDbm"].as_f64().unwrap();
    if !(-10.0..=40.0).contains(&tx) {
        return Err("profile.txPowerDbm must be between -10 and 40".into());
    }
    Ok(())
}

/// Stable text of everything that decides the result, for the job id.
pub fn fingerprint(
    scene_id: &str,
    settings: &Map<String, Value>,
    profile: &Value,
    candidates: &Value,
    model_version: &str,
) -> String {
    // serde_json maps are ordered by key, so this is canonical. The model
    // version makes results of an older simulation model never match.
    json!([scene_id, settings, profile, candidates, model_version]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> Value {
        json!({"thresholdDbm": -67, "targetCoveragePct": 95, "band": "5", "device": "auto"})
    }

    #[test]
    fn accepts_reuse_settings_and_rejects_bad_ones() {
        let mut v = ok();
        v["existingHandling"] = json!("reuse");
        v["lockedApIds"] = json!(["a"]);
        v["keepApIds"] = json!(["b"]);
        v["allowNewAps"] = json!(true);
        let s = worker_settings(&v).unwrap();
        assert_eq!(s["locked_ap_ids"], json!(["a"]));
        assert_eq!(s["keep_ap_ids"], json!(["b"]));
        assert_eq!(s["allow_new_aps"], json!(true));
        v["lockedApIds"] = json!([1]);
        assert!(worker_settings(&v).is_err());
        assert!(worker_settings(
            &json!({"existingHandling": "reposition", "targetCoveragePct": 95})
        )
        .is_err());
    }

    #[test]
    fn accepts_and_renames_settings() {
        let s = worker_settings(&ok()).unwrap();
        assert_eq!(s["threshold_dbm"], json!(-67));
        assert_eq!(s["target_coverage_pct"], json!(95));
        assert_eq!(s["band"], json!("5"));
    }

    #[test]
    fn accepts_noise_and_channel_width_and_rejects_bad_values() {
        let mut settings = ok();
        settings["noiseFloor5Dbm"] = json!(-92);
        assert_eq!(
            worker_settings(&settings).unwrap()["noise_floor_5_dbm"],
            json!(-92)
        );
        settings["noiseFloor5Dbm"] = json!(-120);
        assert!(worker_settings(&settings).is_err());
        let mut profile = json!({"txPowerDbm":20,"gainDbi":4.5,"freqMHz":5180,"bandwidthMHz":40});
        assert!(validate_profile(&profile).is_ok());
        for width in [json!(0), json!(321), json!("40"), Value::Null] {
            profile["bandwidthMHz"] = width;
            assert!(validate_profile(&profile).is_err());
        }
    }

    #[test]
    fn rejects_bad_settings() {
        for bad in [
            json!({"thresholdDbm": 5, "targetCoveragePct": 95}),
            json!({"thresholdDbm": -67, "targetCoveragePct": 150}),
            json!({"band": "7", "targetCoveragePct": 95}),
            json!({"existingHandling": "delete", "targetCoveragePct": 95}),
            json!({"nope": 1, "targetCoveragePct": 95}),
            json!({"thresholdDbm": -67}),
            json!({"resolutionM": 0.01, "targetCoveragePct": 95}),
        ] {
            assert!(worker_settings(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_budget_alone_is_enough() {
        assert!(worker_settings(&json!({"budget": 4, "targetCoveragePct": null})).is_ok());
    }

    #[test]
    fn validates_candidates_and_profile() {
        let c = json!([{"id": "a", "floorId": "f", "x": 1.0, "z": 2.0, "heightM": 2.5}]);
        assert!(validate_candidates(&c).is_ok());
        assert!(validate_candidates(&json!([])).is_err());
        assert!(validate_candidates(&json!([{"id": "a"}])).is_err());
        assert!(
            validate_profile(&json!({"txPowerDbm": 20, "gainDbi": 4.5, "freqMHz": 5180})).is_ok()
        );
        assert!(
            validate_profile(&json!({"txPowerDbm": 99, "gainDbi": 4.5, "freqMHz": 5180})).is_err()
        );
    }

    #[test]
    fn fingerprint_changes_with_inputs() {
        let s = worker_settings(&ok()).unwrap();
        let p = json!({"txPowerDbm": 20, "gainDbi": 4, "freqMHz": 5180});
        let c = json!([]);
        let a = fingerprint("s", &s, &p, &c, "v1");
        let mut s2 = s.clone();
        s2.insert("threshold_dbm".into(), json!(-70));
        assert_ne!(a, fingerprint("s", &s2, &p, &c, "v1"));
        assert_eq!(a, fingerprint("s", &s, &p, &c, "v1"));
        assert_ne!(
            a,
            fingerprint("s", &s, &p, &c, "v2"),
            "a new model version is a new result"
        );
    }
}
