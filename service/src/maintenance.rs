//! Keeping results current and the data folder small: the model version, the
//! cleanup of results no project refers to, and the row cache.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::jobs::{Config, Shared};

/// Cheap fingerprint of the worker's source files (names, sizes, mtimes). When
/// it changes the real model version is asked from the worker again.
pub fn worker_files_key(worker_dir: &Path) -> String {
    files_key(worker_dir, &["sionna_worker"])
}

fn files_key(worker_dir: &Path, packages: &[&str]) -> String {
    let mut parts = Vec::new();
    for package in packages {
        if let Ok(entries) = std::fs::read_dir(worker_dir.join(package)) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|x| x == "py") {
                    if let Ok(m) = e.metadata() {
                        let t = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok());
                        parts.push(format!(
                            "{}/{}:{}:{}",
                            package,
                            path.file_name().unwrap().to_string_lossy(),
                            m.len(),
                            t.map_or(0, |d| d.as_nanos())
                        ));
                    }
                }
            }
        }
    }
    parts.sort();
    parts.join("|")
}

/// Version of the simulation code and engine packages, e.g. "c1178c5ee254af7f".
/// A result or cached row is only reused when this is unchanged.
pub async fn model_version(state: &Shared) -> Result<String, String> {
    let key = worker_files_key(&state.cfg.worker_dir);
    worker_version(state, "sionna_worker", key, &state.model).await
}

/// Model version of the cellular worker: its own code plus the Sionna worker
/// code it shares, so a cellular change never invalidates Wi-Fi results.
pub async fn cellular_model_version(state: &Shared) -> Result<String, String> {
    let key = files_key(&state.cfg.worker_dir, &["cellular_worker", "sionna_worker"]);
    worker_version(state, "cellular_worker", key, &state.cellular_model).await
}

async fn worker_version(
    state: &Shared,
    module: &str,
    key: String,
    cache: &tokio::sync::Mutex<Option<(String, String)>>,
) -> Result<String, String> {
    {
        let cached = cache.lock().await;
        if let Some((k, v)) = cached.as_ref() {
            if *k == key {
                return Ok(v.clone());
            }
        }
    }
    let mut command = tokio::process::Command::new(&state.cfg.python);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .args(["-m", module, "--model-version"])
        .current_dir(&state.cfg.worker_dir)
        .output()
        .await
        .map_err(|e| {
            format!(
                "could not start the worker to read its version ({}): {e}",
                state.cfg.python.display()
            )
        })?;
    let text = String::from_utf8_lossy(&output.stdout);
    let info: serde_json::Value = text
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| {
            format!(
                "the worker did not report a model version: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        })?;
    let version = info["modelVersion"]
        .as_str()
        .ok_or("the worker's model version is missing")?
        .to_string();
    *cache.lock().await = Some((key, version.clone()));
    Ok(version)
}

/// Job ids that projects still point to (`plan.savedResults.*.jobId`).
pub fn referenced_job_ids(projects_file: &Path) -> Result<HashSet<String>, String> {
    // Prefer SQLite once migrated. Never fall back to stale JSON on a DB error.
    let database = projects_file.with_file_name("projects.sqlite");
    if database.exists() {
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("cannot read project database: {e}"))?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let imported: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM storage_metadata WHERE key = 'legacy_json_import')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !imported {
            return Err("project migration has not completed".into());
        }
        let mut statement = db
            .prepare("SELECT DISTINCT job_id FROM simulation_runs")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        return rows
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string());
    }
    let mut ids = HashSet::new();
    let text = std::fs::read_to_string(projects_file).map_err(|e| e.to_string())?;
    let value = serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?;
    let projects = value.as_array().or_else(|| value["projects"].as_array());
    if projects.is_none() {
        return Err("invalid legacy projects file".into());
    }
    for project in projects.into_iter().flatten() {
        if let Some(saved) = project["plan"]["savedResults"].as_object() {
            for entry in saved.values() {
                if let Some(id) = entry.as_str() {
                    ids.insert(id.to_string());
                }
                if let Some(id) = entry["jobId"].as_str() {
                    ids.insert(id.to_string());
                }
                if let Some(runs) = entry["runs"].as_object() {
                    for run in runs.values() {
                        if let Some(id) = run["jobId"].as_str() {
                            ids.insert(id.to_string());
                        }
                    }
                }
            }
        }
    }
    Ok(ids)
}

/// Deletes job folders no project refers to. Folders younger than `min_age` are
/// kept: they may belong to a run that has not been saved to its project yet.
pub fn cleanup_orphans(cfg: &Config, referenced: &HashSet<String>, min_age: Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(cfg.data_dir.join("jobs")) else {
        return 0;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if referenced.contains(&name) || !e.path().is_dir() {
            continue;
        }
        let age = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .unwrap_or(Duration::MAX);
        if age >= min_age && std::fs::remove_dir_all(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn delete_job(cfg: &Config, id: &str) -> bool {
    std::fs::remove_dir_all(cfg.job_dir(id)).is_ok()
}

fn dir_size(path: &Path) -> (u64, u64) {
    let (mut bytes, mut files) = (0, 0);
    if let Ok(entries) = std::fs::read_dir(path) {
        for e in entries.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => {
                    let (b, f) = dir_size(&e.path());
                    bytes += b;
                    files += f;
                }
                Ok(m) => {
                    bytes += m.len();
                    files += 1;
                }
                Err(_) => {}
            }
        }
    }
    (bytes, files)
}

/// (bytes, files) of the row cache.
pub fn cache_info(cfg: &Config) -> (u64, u64) {
    dir_size(&cfg.data_dir.join("cache"))
}

/// Deletes the row cache and returns the bytes freed. Saved results stay.
pub fn clear_cache(cfg: &Config) -> u64 {
    let dir = cfg.data_dir.join("cache");
    let (bytes, _) = dir_size(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sim-maint-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config(data: &Path) -> Config {
        Config {
            data_dir: data.to_path_buf(),
            python: "python".into(),
            worker_dir: data.to_path_buf(),
            job_timeout: Duration::from_secs(1),
            concurrency: 1,
            max_upload_bytes: 1,
            max_queued: 8,
            cache_max_mb: 1,
            projects_file: data.join("projects.json"),
        }
    }

    #[test]
    fn worker_key_changes_when_a_source_file_changes() {
        let dir = temp("key");
        let pkg = dir.join("sionna_worker");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("a.py"), "x = 1").unwrap();
        let before = worker_files_key(&dir);
        assert_eq!(before, worker_files_key(&dir));
        std::fs::write(pkg.join("a.py"), "x = 22").unwrap();
        assert_ne!(before, worker_files_key(&dir));
        std::fs::write(pkg.join("b.py"), "").unwrap();
        assert_ne!(worker_files_key(&dir), before);
        std::fs::write(pkg.join("notes.txt"), "ignored").unwrap();
    }

    #[test]
    fn finds_the_results_projects_refer_to() {
        let dir = temp("refs");
        let file = dir.join("projects.json");
        std::fs::write(
            &file,
            r#"[{"id":"p1","plan":{"savedResults":{"prediction":{"jobId":"aaa"},"optimization":{"jobId":"bbb","runs":{"5":{"jobId":"bbb"},"2.4":{"jobId":"ccc"}}}}}},
                {"id":"p2","plan":{}},{"id":"p3"}]"#,
        )
        .unwrap();
        let ids = referenced_job_ids(&file).unwrap();
        assert_eq!(
            ids,
            HashSet::from(["aaa".to_string(), "bbb".to_string(), "ccc".to_string()])
        );
        assert!(referenced_job_ids(&dir.join("missing.json")).is_err());
        std::fs::write(&file, "not json").unwrap();
        assert!(referenced_job_ids(&file).is_err());
    }

    #[test]
    fn sqlite_references_take_precedence_and_errors_prevent_cleanup() {
        let dir = temp("sqlite-refs");
        let legacy = dir.join("projects.json");
        std::fs::write(
            &legacy,
            r#"{"projects":[{"plan":{"savedResults":{"prediction":{"jobId":"stale"}}}}]}"#,
        )
        .unwrap();
        let database = dir.join("projects.sqlite");
        let db = rusqlite::Connection::open(&database).unwrap();
        db.execute_batch(
            "CREATE TABLE storage_metadata(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE simulation_runs(project_id TEXT, slot TEXT, job_id TEXT);
            INSERT INTO storage_metadata VALUES ('legacy_json_import', '{}');
            INSERT INTO simulation_runs VALUES ('p1', 'prediction', 'current');
            INSERT INTO simulation_runs VALUES ('p2', 'prediction', 'current');
            INSERT INTO simulation_runs VALUES ('p1', 'optimization', 'other');",
        )
        .unwrap();
        assert_eq!(
            referenced_job_ids(&legacy).unwrap(),
            HashSet::from(["current".into(), "other".into()])
        );
        db.execute("DELETE FROM storage_metadata", []).unwrap();
        assert!(referenced_job_ids(&legacy).is_err());
        db.execute_batch("DROP TABLE simulation_runs").unwrap();
        assert!(referenced_job_ids(&legacy).is_err());
        drop(db);
        std::fs::write(database, "broken database").unwrap();
        assert!(referenced_job_ids(&legacy).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn orphan_cleanup_keeps_referenced_and_young_folders() {
        let dir = temp("orphans");
        let cfg = config(&dir);
        for id in ["keep", "orphan", "also-orphan"] {
            std::fs::create_dir_all(cfg.job_dir(id).join("out")).unwrap();
            std::fs::write(cfg.job_dir(id).join("out").join("result.json"), "{}").unwrap();
        }
        let referenced = HashSet::from(["keep".to_string()]);
        // too young to delete
        assert_eq!(
            cleanup_orphans(&cfg, &referenced, Duration::from_secs(3600)),
            0
        );
        assert_eq!(cleanup_orphans(&cfg, &referenced, Duration::ZERO), 2);
        assert!(cfg.job_dir("keep").exists());
        assert!(!cfg.job_dir("orphan").exists());
    }

    #[test]
    fn deleting_a_job_and_clearing_the_cache() {
        let dir = temp("cache");
        let cfg = config(&dir);
        std::fs::create_dir_all(cfg.job_dir("j")).unwrap();
        assert!(delete_job(&cfg, "j"));
        assert!(!delete_job(&cfg, "j"));
        let rows = dir.join("cache").join("rows").join("v1");
        std::fs::create_dir_all(&rows).unwrap();
        std::fs::write(rows.join("a.npy"), vec![0u8; 1000]).unwrap();
        std::fs::write(rows.join("b.npy"), vec![0u8; 500]).unwrap();
        assert_eq!(cache_info(&cfg), (1500, 2));
        assert_eq!(clear_cache(&cfg), 1500);
        assert_eq!(cache_info(&cfg), (0, 0));
    }
}
