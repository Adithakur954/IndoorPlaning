//! Background job queue: runs the Python Sionna worker as a subprocess.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, Notify};

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub python: PathBuf,
    pub worker_dir: PathBuf,
    pub job_timeout: Duration,
    pub concurrency: usize,
    pub max_upload_bytes: usize,
    pub max_queued: usize,
    pub cache_max_mb: u64,
    /// where the projects (and so the saved-result references) are stored
    pub projects_file: PathBuf,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub phase: Phase,
    pub error: Option<String>,
}

pub struct AppState {
    pub cfg: Config,
    pub jobs: Mutex<HashMap<String, JobStatus>>,
    pub cancels: Mutex<HashMap<String, Arc<Notify>>>,
    /// (worker files key, model version) from the last time it was asked
    pub model: Mutex<Option<(String, String)>>,
    pub queue: mpsc::UnboundedSender<String>,
}

pub type Shared = Arc<AppState>;

impl Config {
    pub fn scene_dir(&self, scene_id: &str) -> PathBuf {
        self.data_dir.join("scenes").join(scene_id)
    }
    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.data_dir.join("jobs").join(job_id)
    }
}

pub fn new_state(cfg: Config) -> (Shared, mpsc::UnboundedReceiver<String>) {
    let (queue, rx) = mpsc::unbounded_channel();
    (
        Arc::new(AppState {
            cfg,
            jobs: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            model: Mutex::new(None),
            queue,
        }),
        rx,
    )
}

/// Starts `concurrency` runners that share one queue. A CPU-only server should
/// use 1: a single simulation already uses all cores.
pub fn spawn_runners(state: Shared, rx: mpsc::UnboundedReceiver<String>) {
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..state.cfg.concurrency.max(1) {
        let (state, rx) = (state.clone(), rx.clone());
        tokio::spawn(async move {
            loop {
                let next = rx.lock().await.recv().await;
                let Some(id) = next else { break };
                // cancelled while it was still waiting in the queue
                if state.jobs.lock().await.get(&id).is_some_and(|j| j.phase == Phase::Cancelled) {
                    continue;
                }
                let cancel = Arc::new(Notify::new());
                state.cancels.lock().await.insert(id.clone(), cancel.clone());
                set(&state, &id, Phase::Running, None).await;
                let outcome = run_worker(&state.cfg, &id, cancel).await;
                state.cancels.lock().await.remove(&id);
                match outcome {
                    Ok(()) => set(&state, &id, Phase::Done, None).await,
                    Err(WorkerEnd::Cancelled) => set(&state, &id, Phase::Cancelled, None).await,
                    Err(WorkerEnd::Failed(error)) => set(&state, &id, Phase::Failed, Some(error)).await,
                }
            }
        });
    }
}

pub async fn set(state: &Shared, id: &str, phase: Phase, error: Option<String>) {
    state.jobs.lock().await.insert(id.to_string(), JobStatus { phase, error });
}

/// Asks a queued or running job to stop. Returns false when it is not active.
pub async fn cancel(state: &Shared, id: &str) -> bool {
    let phase = state.jobs.lock().await.get(id).map(|j| j.phase);
    match phase {
        Some(Phase::Queued) => {
            set(state, id, Phase::Cancelled, None).await;
            true
        }
        Some(Phase::Running) => {
            if let Some(n) = state.cancels.lock().await.get(id) {
                n.notify_one();
            }
            true
        }
        _ => false,
    }
}

pub async fn queued_count(state: &Shared) -> usize {
    state.jobs.lock().await.values().filter(|j| j.phase == Phase::Queued).count()
}

pub enum WorkerEnd {
    Cancelled,
    Failed(String),
}

impl From<String> for WorkerEnd {
    fn from(e: String) -> Self {
        WorkerEnd::Failed(e)
    }
}

async fn run_worker(cfg: &Config, id: &str, cancel: Arc<Notify>) -> Result<(), WorkerEnd> {
    let job_dir = cfg.job_dir(id);
    let job_file = std::fs::canonicalize(job_dir.join("job.json")).map_err(|e| e.to_string())?;
    let mut command = Command::new(&cfg.python);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let child = command
        .args(["-m", "sionna_worker"])
        .arg(&job_file)
        .current_dir(&cfg.worker_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start the worker ({}): {e}", cfg.python.display()))?;
    // Dropping the child on cancel or timeout kills the worker (kill_on_drop).
    let output = tokio::select! {
        _ = cancel.notified() => return Err(WorkerEnd::Cancelled),
        r = tokio::time::timeout(cfg.job_timeout, child.wait_with_output()) => r
            .map_err(|_| format!("simulation exceeded the {}s limit", cfg.job_timeout.as_secs()))?
            .map_err(|e| e.to_string())?,
    };
    if output.status.success() {
        return Ok(());
    }
    // Prefer the worker's own structured error.
    if let Ok(text) = std::fs::read_to_string(job_dir.join("out").join("result.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(e) = v["error"].as_str() {
                return Err(WorkerEnd::Failed(e.to_string()));
            }
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
    Err(WorkerEnd::Failed(format!("worker exited with {}: {tail}", output.status)))
}
