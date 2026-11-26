//! Cellular (IBS/DAS) prediction requests: a separate route and worker
//! (`python -m cellular_worker`) from the Wi-Fi prediction. This keeps
//! malformed or oversized requests out of the queue; the Python worker checks
//! every value again (worker/cellular_worker/job.py).

use serde_json::{json, Map, Value};

pub const MAX_ANTENNAS: usize = 2000;
pub const MAX_PATTERNS: usize = 500;
pub const MAX_SECTORS: usize = 500;

/// The parts of a request that decide the result, checked.
pub struct CellularRequest {
    pub scene_id: String,
    pub fresh: bool,
    pub carrier: Value,
    pub sectors: Value,
    pub antennas: Value,
    pub patterns: Value,
    pub settings: Value,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub fn parse(body: &Value) -> Result<CellularRequest, String> {
    let obj = body
        .as_object()
        .ok_or("the request must be a JSON object")?;
    let known = [
        "sceneId", "fresh", "carrier", "sectors", "antennas", "patterns", "settings",
    ];
    if let Some(k) = obj.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(format!("unknown field '{k}'"));
    }
    let scene_id = obj.get("sceneId").and_then(Value::as_str).unwrap_or("");
    if !is_hex(scene_id, 64) {
        return Err("sceneId must be a 64-character lowercase hex hash".into());
    }
    let fresh = match obj.get("fresh") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("fresh must be true or false".into()),
    };
    let carrier = obj
        .get("carrier")
        .filter(|v| v.is_object())
        .ok_or("carrier is required")?;
    if !matches!(carrier["technology"].as_str(), Some("LTE" | "NR")) {
        return Err("carrier technology must be LTE or NR".into());
    }
    if !carrier["freqMHz"]
        .as_f64()
        .is_some_and(|f| f.is_finite() && (400.0..=7125.0).contains(&f))
    {
        return Err("carrier freqMHz must be between 400 and 7125".into());
    }
    let list = |key: &str, max: usize| -> Result<&Value, String> {
        let v = obj.get(key).ok_or(format!("{key} is required"))?;
        let n = v.as_array().ok_or(format!("{key} must be a list"))?.len();
        if n == 0 || n > max {
            return Err(format!("{key} must hold 1 to {max} entries"));
        }
        Ok(v)
    };
    let sectors = list("sectors", MAX_SECTORS)?;
    let antennas = list("antennas", MAX_ANTENNAS)?;
    let patterns = obj
        .get("patterns")
        .filter(|v| v.is_object())
        .ok_or("patterns must be an object")?;
    if patterns.as_object().unwrap().len() > MAX_PATTERNS {
        return Err(format!("at most {MAX_PATTERNS} antenna patterns per run"));
    }
    for a in antennas.as_array().unwrap() {
        let pattern = a["pattern"].as_str().unwrap_or("");
        if patterns.get(pattern).is_none() {
            return Err(format!("antenna {}: unknown pattern", a["name"]));
        }
        for key in ["position", "orientationDeg"] {
            let ok = a[key].as_array().is_some_and(|v| {
                v.len() == 3 && v.iter().all(|x| x.as_f64().is_some_and(f64::is_finite))
            });
            if !ok {
                return Err(format!(
                    "antenna {}: '{key}' needs three numbers",
                    a["name"]
                ));
            }
        }
    }
    let settings = match obj.get("settings") {
        None | Some(Value::Null) => json!({}),
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return Err("settings must be an object".into()),
    };
    Ok(CellularRequest {
        scene_id: scene_id.to_string(),
        fresh,
        carrier: carrier.clone(),
        sectors: sectors.clone(),
        antennas: antennas.clone(),
        patterns: patterns.clone(),
        settings,
    })
}

impl CellularRequest {
    /// Stable text of everything that decides the result, for the job id.
    /// serde_json maps are ordered by key, so this is canonical. The model
    /// version makes results of an older cellular model never match.
    pub fn fingerprint(&self, model_version: &str) -> String {
        json!([
            "cellular",
            self.scene_id,
            self.carrier,
            self.sectors,
            self.antennas,
            self.patterns,
            self.settings,
            model_version
        ])
        .to_string()
    }

    /// The worker's job file (worker/cellular_worker/job.py).
    pub fn worker_job(&self, scene_dir: &str, output_dir: &str) -> Value {
        let mut job = Map::new();
        job.insert("mode".into(), json!("cellular"));
        job.insert("scene_dir".into(), json!(scene_dir));
        job.insert("output_dir".into(), json!(output_dir));
        job.insert("device".into(), json!("auto"));
        job.insert("carrier".into(), self.carrier.clone());
        job.insert("sectors".into(), self.sectors.clone());
        job.insert("antennas".into(), self.antennas.clone());
        job.insert("patterns".into(), self.patterns.clone());
        job.insert("settings".into(), self.settings.clone());
        Value::Object(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Value {
        json!({
            "sceneId": "a".repeat(64),
            "carrier": { "id": "c1", "technology": "NR", "freqMHz": 3500, "bandwidthMHz": 100, "scsKHz": 30, "resourceBlocks": 273, "rsrpOffsetDb": 35.155 },
            "sectors": [{ "id": "s1", "name": "Sector 1" }],
            "antennas": [{ "id": "a1", "name": "A1", "floorId": "f1", "sectorId": "s1", "position": [1, -2, 2.9], "orientationDeg": [0, 0, 0], "powerDbm": 10, "pattern": "m@3500" }],
            "patterns": { "m@3500": { "gainDbi": 4 } },
            "settings": { "resolutionM": 1 },
        })
    }

    #[test]
    fn accepts_a_request_and_builds_the_worker_job() {
        let r = parse(&request()).unwrap();
        assert!(!r.fresh);
        let job = r.worker_job("/scene", "/out");
        assert_eq!(job["mode"], "cellular");
        assert_eq!(job["antennas"][0]["id"], "a1");
        assert_eq!(crate::jobs::worker_module(&job), "cellular_worker");
        assert_eq!(
            crate::jobs::worker_module(&json!({ "mode": "optimize" })),
            "sionna_worker"
        );
    }

    #[test]
    fn rejects_bad_requests() {
        let cases: Vec<Box<dyn Fn(&mut Value)>> = vec![
            Box::new(|r| r["sceneId"] = json!("nope")),
            Box::new(|r| r["carrier"]["technology"] = json!("GSM")),
            Box::new(|r| r["carrier"]["freqMHz"] = json!(90000)),
            Box::new(|r| r["antennas"] = json!([])),
            Box::new(|r| r["antennas"][0]["pattern"] = json!("missing")),
            Box::new(|r| r["antennas"][0]["position"] = json!([1, 2])),
            Box::new(|r| r["sectors"] = json!("s1")),
            Box::new(|r| r["extra"] = json!(1)),
            Box::new(|r| r["fresh"] = json!("yes")),
        ];
        for change in cases {
            let mut r = request();
            change(&mut r);
            assert!(parse(&r).is_err(), "{r}");
        }
    }

    #[test]
    fn fingerprint_changes_with_inputs_and_model() {
        let a = parse(&request()).unwrap();
        let mut moved = request();
        moved["antennas"][0]["position"] = json!([2, -2, 2.9]);
        let b = parse(&moved).unwrap();
        assert_eq!(
            a.fingerprint("v1"),
            parse(&request()).unwrap().fingerprint("v1")
        );
        assert_ne!(a.fingerprint("v1"), b.fingerprint("v1"));
        assert_ne!(a.fingerprint("v1"), a.fingerprint("v2"));
    }
}
