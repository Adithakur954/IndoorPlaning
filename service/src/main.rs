use std::path::PathBuf;
use std::time::Duration;

use indoor_sim_service::{api, jobs};

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    // Defaults are anchored to the project root (parent of this crate), so the
    // service works from any current directory, e.g. `npm run sim:service`.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let app_data = std::env::var("INDOOR_DATA_DIR")
        .map(PathBuf::from).unwrap_or_else(|_| root.join("data"));
    let worker_dir = std::env::var("WORKER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("worker"));
    let venv_python = if cfg!(windows) {
        worker_dir.join(".venv/Scripts/python.exe")
    } else {
        worker_dir.join(".venv/bin/python")
    };
    let cfg = jobs::Config {
        data_dir: std::env::var("SIM_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| app_data.join("simulations")),
        python: std::env::var("WORKER_PYTHON")
            .map(PathBuf::from)
            .unwrap_or(if venv_python.exists() { venv_python } else { PathBuf::from("python") }),
        worker_dir,
        job_timeout: Duration::from_secs(env_or("JOB_TIMEOUT_SECS", 1800)),
        concurrency: env_or("SIM_CONCURRENCY", 1),
        max_upload_bytes: env_or::<usize>("MAX_UPLOAD_MB", 50) * 1024 * 1024,
        max_queued: env_or("MAX_QUEUED_JOBS", 8),
        cache_max_mb: env_or("CACHE_MAX_MB", 500),
        projects_file: std::env::var("PROJECTS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| app_data.join("projects.json")),
    };
    std::fs::create_dir_all(&cfg.data_dir).expect("cannot create SIM_DATA_DIR");
    let port: u16 = env_or("SIM_PORT", 3002);
    // Results no project refers to any more (a run that was replaced, a deleted
    // project) are removed at start-up; very recent ones may not be saved yet.
    let removed = match indoor_sim_service::maintenance::referenced_job_ids(&cfg.projects_file) {
        Ok(keep) => indoor_sim_service::maintenance::cleanup_orphans(
            &cfg, &keep, Duration::from_secs(env_or("ORPHAN_MIN_AGE_SECS", 600)),
        ),
        Err(error) => { eprintln!("skipping result cleanup: {error}"); 0 }
    };
    if removed > 0 {
        println!("removed {removed} saved result(s) no project refers to");
    }
    let (state, rx) = jobs::new_state(cfg);
    jobs::spawn_runners(state.clone(), rx);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("cannot bind port");
    if let Ok(file) = std::env::var("DESKTOP_READY_FILE") {
        std::fs::write(file, serde_json::json!({ "port": listener.local_addr().unwrap().port() }).to_string())
            .expect("cannot report desktop readiness");
    }
    println!("simulation service on http://127.0.0.1:{port} (python: {})", state.cfg.python.display());
    axum::serve(listener, api::router(state)).await.unwrap();
}
