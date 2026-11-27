//! Simulation settings accepted from the API. Ranges mirror the Python worker
//! (`worker/sionna_worker/job.py`), which validates again before running.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Settings {
    pub device: String,
    pub resolution_m: f64,
    pub max_depth: u32,
    pub samples_per_tx: u64,
    pub weak_threshold_dbm: f64,
    pub seed: u32,
    pub refraction: bool,
    pub diffraction: bool,
    pub floor_ids: Option<Vec<String>>,
    pub cpu_threads: Option<u32>,
    pub receiver_gain_dbi: f64,
    /// Noise floor (dBm) of a 20 MHz channel per band, for the SNR map.
    pub noise_floor_24_dbm: f64,
    pub noise_floor_5_dbm: f64,
    pub noise_floor_6_dbm: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device: "auto".into(),
            resolution_m: 1.0,
            max_depth: 5,
            samples_per_tx: 1_000_000,
            weak_threshold_dbm: -75.0,
            seed: 42,
            refraction: true,
            diffraction: false,
            floor_ids: None,
            cpu_threads: None,
            receiver_gain_dbi: 0.0,
            noise_floor_24_dbm: -86.0,
            noise_floor_5_dbm: -88.0,
            noise_floor_6_dbm: -88.0,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !["auto", "gpu", "cpu"].contains(&self.device.as_str()) {
            return Err("device must be auto, gpu or cpu".into());
        }
        let range = |name: &str, v: f64, lo: f64, hi: f64| {
            if v.is_finite() && (lo..=hi).contains(&v) {
                Ok(())
            } else {
                Err(format!("{name} must be between {lo} and {hi}"))
            }
        };
        range("resolutionM", self.resolution_m, 0.1, 10.0)?;
        range("maxDepth", self.max_depth as f64, 0.0, 20.0)?;
        range(
            "samplesPerTx",
            self.samples_per_tx as f64,
            10_000.0,
            100_000_000.0,
        )?;
        range("weakThresholdDbm", self.weak_threshold_dbm, -150.0, 0.0)?;
        range("receiverGainDbi", self.receiver_gain_dbi, -20.0, 30.0)?;
        range("noiseFloor24Dbm", self.noise_floor_24_dbm, -110.0, -60.0)?;
        range("noiseFloor5Dbm", self.noise_floor_5_dbm, -110.0, -60.0)?;
        range("noiseFloor6Dbm", self.noise_floor_6_dbm, -110.0, -60.0)?;
        if let Some(t) = self.cpu_threads {
            range("cpuThreads", t as f64, 1.0, 256.0)?;
        }
        Ok(())
    }

    /// Worker job file contents (snake_case, as `JobSettings` expects).
    pub fn to_worker_job(&self, scene_dir: &str, output_dir: &str) -> serde_json::Value {
        serde_json::json!({
            "scene_dir": scene_dir,
            "output_dir": output_dir,
            "device": self.device,
            "resolution_m": self.resolution_m,
            "max_depth": self.max_depth,
            "samples_per_tx": self.samples_per_tx,
            "weak_threshold_dbm": self.weak_threshold_dbm,
            "seed": self.seed,
            "refraction": self.refraction,
            "diffraction": self.diffraction,
            "floor_ids": self.floor_ids,
            "cpu_threads": self.cpu_threads,
            "receiver_gain_dbi": self.receiver_gain_dbi,
            "noise_floor_24_dbm": self.noise_floor_24_dbm,
            "noise_floor_5_dbm": self.noise_floor_5_dbm,
            "noise_floor_6_dbm": self.noise_floor_6_dbm,
        })
    }

    /// Everything that changes the numerical result, in a stable order. The
    /// device is excluded on purpose: CPU and GPU give the same maps for the
    /// same seed, so a result computed on either one is a valid cache hit.
    pub fn cache_fingerprint(&self) -> String {
        serde_json::json!([
            self.resolution_m,
            self.max_depth,
            self.samples_per_tx,
            self.weak_threshold_dbm,
            self.seed,
            self.refraction,
            self.diffraction,
            self.floor_ids,
            self.receiver_gain_dbi,
            self.noise_floor_24_dbm,
            self.noise_floor_5_dbm,
            self.noise_floor_6_dbm,
        ])
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        assert!(Settings::default().validate().is_ok());
    }

    #[test]
    fn rejects_out_of_range_values() {
        for s in [
            Settings {
                resolution_m: 0.0,
                ..Default::default()
            },
            Settings {
                resolution_m: f64::NAN,
                ..Default::default()
            },
            Settings {
                max_depth: 99,
                ..Default::default()
            },
            Settings {
                samples_per_tx: 1,
                ..Default::default()
            },
            Settings {
                device: "tpu".into(),
                ..Default::default()
            },
            Settings {
                noise_floor_5_dbm: -120.0,
                ..Default::default()
            },
            Settings {
                noise_floor_24_dbm: -50.0,
                ..Default::default()
            },
        ] {
            assert!(s.validate().is_err(), "{s:?}");
        }
    }

    #[test]
    fn device_does_not_change_the_cache_key() {
        let a = Settings::default();
        let b = Settings {
            device: "cpu".into(),
            ..Default::default()
        };
        assert_eq!(a.cache_fingerprint(), b.cache_fingerprint());
        let c = Settings {
            max_depth: 3,
            ..Default::default()
        };
        assert_ne!(a.cache_fingerprint(), c.cache_fingerprint());
    }

    #[test]
    fn noise_floors_are_accepted_passed_on_and_change_the_cache_key() {
        assert_eq!(Settings::default().noise_floor_5_dbm, -88.0);
        assert_eq!(Settings::default().noise_floor_24_dbm, -86.0);
        let s: Settings = serde_json::from_str(r#"{"noiseFloor5Dbm": -92}"#).unwrap();
        assert!(s.validate().is_ok());
        assert_eq!(s.to_worker_job("a", "b")["noise_floor_5_dbm"], -92.0);
        // a result computed with another noise figure has other SNR values
        assert_ne!(
            Settings::default().cache_fingerprint(),
            s.cache_fingerprint()
        );
    }
}
