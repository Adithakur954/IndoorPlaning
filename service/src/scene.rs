//! Safe extraction and validation of an uploaded scene export (.zip).

use std::io::{Cursor, Read};
use std::path::Path;

const MAX_FILES: usize = 64;
const MAX_UNPACKED_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug)]
pub struct SceneSummary {
    pub content_sha256: String,
    pub floors: usize,
    pub access_points: usize,
}

/// Unpacks `bytes` into `dest` after validating its structure. Nothing is
/// written outside `dest`; zip-slip, oversized and malformed archives are rejected.
pub fn extract(bytes: &[u8], dest: &Path) -> Result<SceneSummary, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid zip: {e}"))?;
    if archive.len() > MAX_FILES {
        return Err(format!("zip has more than {MAX_FILES} files"));
    }
    let mut total = 0u64;
    let mut config: Option<Vec<u8>> = None;
    let mut has_scene = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe path in zip: {}", entry.name()))?;
        let name = relative.to_string_lossy().replace('\\', "/");
        let allowed = name == "scene.xml"
            || name == "scene_config.json"
            || (name.starts_with("meshes/")
                && name.ends_with(".ply")
                && name.matches('/').count() == 1);
        if !allowed {
            return Err(format!("unexpected file in scene zip: {name}"));
        }
        total += entry.size();
        if total > MAX_UNPACKED_BYTES {
            return Err("scene is too large once unpacked".into());
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        (&mut entry)
            .take(MAX_UNPACKED_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if name == "scene.xml" {
            has_scene = true;
        }
        if name == "scene_config.json" {
            config = Some(data.clone());
        }
        let target = dest.join(&name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &data).map_err(|e| e.to_string())?;
    }
    if !has_scene {
        return Err("scene.xml is missing".into());
    }
    let config: serde_json::Value =
        serde_json::from_slice(&config.ok_or("scene_config.json is missing")?)
            .map_err(|e| format!("scene_config.json is not valid JSON: {e}"))?;
    if config["exportVersion"] != 1 {
        return Err("unsupported scene export version".into());
    }
    let sha = config["contentSha256"]
        .as_str()
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("scene_config.json has no valid contentSha256")?
        .to_lowercase();
    let access_points = config["accessPoints"].as_array().map_or(0, Vec::len);
    // A scene without access points is valid: the optimiser places its own.
    // Plain predictions check for access points when they are submitted.
    let floors = config["floors"].as_array().map_or(0, Vec::len);
    if floors == 0 {
        return Err("the scene has no floors".into());
    }
    for mesh in config["meshes"]
        .as_array()
        .ok_or("scene_config.json has no meshes")?
    {
        let file = mesh["file"].as_str().ok_or("mesh entry without a file")?;
        if !dest.join(file).exists() {
            return Err(format!("mesh file listed but missing from zip: {file}"));
        }
    }
    Ok(SceneSummary {
        content_sha256: sha,
        floors,
        access_points,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut out);
            for (name, data) in files {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        out.into_inner()
    }

    fn config() -> Vec<u8> {
        serde_json::json!({
            "exportVersion": 1,
            "contentSha256": "a".repeat(64),
            "floors": [{"id": "f"}],
            "accessPoints": [{"id": "ap"}],
            "meshes": [{"file": "meshes/wall__brick.ply"}],
        })
        .to_string()
        .into_bytes()
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sim-scene-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_valid_scene() {
        let dir = temp("ok");
        let zip = zip_of(&[
            ("scene.xml", b"<scene/>"),
            ("scene_config.json", &config()),
            ("meshes/wall__brick.ply", b"ply"),
        ]);
        let summary = extract(&zip, &dir).unwrap();
        assert_eq!(summary.content_sha256, "a".repeat(64));
        assert_eq!((summary.floors, summary.access_points), (1, 1));
    }

    #[test]
    fn rejects_path_traversal_and_unknown_files() {
        let dir = temp("slip");
        assert!(extract(&zip_of(&[("../evil.xml", b"x")]), &dir).is_err());
        assert!(extract(&zip_of(&[("run.sh", b"x")]), &dir).is_err());
    }

    #[test]
    fn rejects_missing_parts() {
        let dir = temp("missing");
        assert!(extract(b"not a zip", &dir).is_err());
        assert!(extract(&zip_of(&[("scene_config.json", &config())]), &dir)
            .unwrap_err()
            .contains("scene.xml"));
        let no_mesh = zip_of(&[("scene.xml", b"<scene/>"), ("scene_config.json", &config())]);
        assert!(extract(&no_mesh, &dir)
            .unwrap_err()
            .contains("missing from zip"));
    }
}
