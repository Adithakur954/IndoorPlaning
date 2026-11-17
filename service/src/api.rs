//! HTTP API.
//!
//!   POST /api/scenes                       body: scene .zip  -> { sceneId }
//!   POST /api/simulations                  { sceneId, settings? } -> { id, status, cached }
//!   GET  /api/simulations/{id}             -> { id, status, error?, result? }
//!   GET  /api/simulations/{id}/maps/{file} -> radio-map JSON
//!   GET  /api/health

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::jobs::{self, Phase, Shared};
use crate::maintenance;
use crate::optimize;
use crate::scene;
use crate::settings::Settings;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}
fn internal(msg: impl ToString) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg.to_string())
}
fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub fn router(state: Shared) -> Router {
    let limit = state.cfg.max_upload_bytes;
    Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/scenes", post(upload_scene))
        .route("/api/simulations", post(submit))
        .route("/api/optimizations", post(submit_optimization))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .route("/api/jobs/{id}", axum::routing::delete(delete_job))
        .route("/api/model-version", get(model_version))
        .route("/api/cache", get(cache_info))
        .route("/api/cache/clear", post(cache_clear))
        .route("/api/maintenance/cleanup", post(cleanup))
        .route("/api/simulations/{id}", get(status))
        .route("/api/optimizations/{id}", get(status))
        .route("/api/optimizations/{id}/maps/{file}", get(map_file))
        .route("/api/simulations/{id}/maps/{file}", get(map_file))
        .layer(DefaultBodyLimit::max(limit))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::licensing::require_license))
        .with_state(state)
}

async fn upload_scene(State(state): State<Shared>, body: Bytes) -> Result<Json<serde_json::Value>, ApiError> {
    let scenes = state.cfg.data_dir.join("scenes");
    std::fs::create_dir_all(&scenes).map_err(internal)?;
    let staging = scenes.join(format!(".upload-{}", hex::encode(Sha256::digest(&body))[..16].to_string()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(internal)?;
    let summary = match scene::extract(&body, &staging) {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(bad(e));
        }
    };
    let target = state.cfg.scene_dir(&summary.content_sha256);
    if target.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        std::fs::rename(&staging, &target).map_err(internal)?;
    }
    Ok(Json(json!({
        "sceneId": summary.content_sha256,
        "floors": summary.floors,
        "accessPoints": summary.access_points,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitRequest {
    scene_id: String,
    #[serde(default)]
    settings: Settings,
    /// ignore any saved result of identical inputs and compute again
    #[serde(default)]
    fresh: bool,
}

async fn submit(
    State(state): State<Shared>,
    Json(req): Json<SubmitRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !is_hex(&req.scene_id, 64) {
        return Err(bad("sceneId must be a 64-character lowercase hex hash"));
    }
    req.settings.validate().map_err(bad)?;
    let scene_dir = state.cfg.scene_dir(&req.scene_id);
    if !scene_dir.join("scene.xml").exists() {
        return Err(ApiError(StatusCode::NOT_FOUND, "unknown sceneId; upload the scene first".into()));
    }
    let has_aps = std::fs::read(scene_dir.join("scene_config.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|c| c["accessPoints"].as_array().map(|a| !a.is_empty()))
        .unwrap_or(false);
    if !has_aps {
        return Err(bad("the scene has no access points"));
    }
    let model = maintenance::model_version(&state).await.map_err(internal)?;
    let id = hex::encode(Sha256::digest(
        format!("{}|{}|{}", req.scene_id, req.settings.cache_fingerprint(), model).as_bytes(),
    ))[..32]
        .to_string();

    // Cache hit: a finished result for the same scene, settings and model.
    if !req.fresh && disk_status(&state, &id).await.is_some_and(|(p, _)| p == Phase::Done) {
        return Ok(Json(json!({ "id": id, "status": Phase::Done, "cached": true })));
    }
    {
        let jobs = state.jobs.lock().await;
        if let Some(job) = jobs.get(&id) {
            if matches!(job.phase, Phase::Queued | Phase::Running) {
                return Ok(Json(json!({ "id": id, "status": job.phase, "cached": false })));
            }
        }
    }
    if jobs::queued_count(&state).await >= state.cfg.max_queued {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "the job queue is full; try again shortly".into()));
    }
    let job_dir = state.cfg.job_dir(&id);
    let _ = std::fs::remove_dir_all(&job_dir); // a previous failed attempt
    std::fs::create_dir_all(job_dir.join("out")).map_err(internal)?;
    let abs = |p: &std::path::Path| std::fs::canonicalize(p).map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    let job = req
        .settings
        .to_worker_job(&abs(&scene_dir).map_err(internal)?, &abs(&job_dir.join("out")).map_err(internal)?);
    std::fs::write(job_dir.join("job.json"), serde_json::to_vec_pretty(&job).map_err(internal)?).map_err(internal)?;
    jobs::set(&state, &id, Phase::Queued, None).await;
    state.queue.send(id.clone()).map_err(internal)?;
    Ok(Json(json!({ "id": id, "status": Phase::Queued, "cached": false })))
}

/// Status from memory, else from the finished result on disk (survives restarts).
async fn disk_status(state: &Shared, id: &str) -> Option<(Phase, Option<String>)> {
    if let Some(job) = state.jobs.lock().await.get(id) {
        return Some((job.phase, job.error.clone()));
    }
    let text = std::fs::read_to_string(state.cfg.job_dir(id).join("out").join("result.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    match v["status"].as_str()? {
        "ok" => Some((Phase::Done, None)),
        _ => Some((Phase::Failed, v["error"].as_str().map(str::to_string))),
    }
}

async fn status(State(state): State<Shared>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    if !is_hex(&id, 32) {
        return Err(bad("invalid id"));
    }
    let (phase, error) = disk_status(&state, &id)
        .await
        .ok_or(ApiError(StatusCode::NOT_FOUND, "unknown simulation".into()))?;
    let mut body = json!({ "id": id, "status": phase, "error": error });
    if matches!(phase, Phase::Running | Phase::Queued) {
        // progress written by the worker while it runs
        if let Ok(text) = std::fs::read_to_string(state.cfg.job_dir(&id).join("out").join("progress.json")) {
            if let Ok(p) = serde_json::from_str::<serde_json::Value>(&text) {
                body["progress"] = p;
            }
        }
    }
    if phase == Phase::Done {
        let text = std::fs::read_to_string(state.cfg.job_dir(&id).join("out").join("result.json")).map_err(internal)?;
        body["result"] = serde_json::from_str(&text).map_err(internal)?;
    }
    Ok(Json(body))
}

async fn map_file(State(state): State<Shared>, Path((id, file)): Path<(String, String)>) -> Result<Response, ApiError> {
    let safe = !file.is_empty()
        && file.ends_with(".json")
        && file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !file.contains("..");
    if !is_hex(&id, 32) || !safe {
        return Err(bad("invalid id or file name"));
    }
    let path = state.cfg.job_dir(&id).join("out").join("maps").join(&file);
    let data = std::fs::read(path).map_err(|_| ApiError(StatusCode::NOT_FOUND, "map not found".into()))?;
    Ok(([(header::CONTENT_TYPE, "application/json")], data).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OptimizeRequest {
    scene_id: String,
    settings: serde_json::Value,
    profile: serde_json::Value,
    candidates: serde_json::Value,
    #[serde(default)]
    fresh: bool,
}

async fn submit_optimization(
    State(state): State<Shared>,
    Json(req): Json<OptimizeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !is_hex(&req.scene_id, 64) {
        return Err(bad("sceneId must be a 64-character lowercase hex hash"));
    }
    let worker = optimize::worker_settings(&req.settings).map_err(bad)?;
    optimize::validate_profile(&req.profile).map_err(bad)?;
    optimize::validate_candidates(&req.candidates).map_err(bad)?;
    let scene_dir = state.cfg.scene_dir(&req.scene_id);
    if !scene_dir.join("scene.xml").exists() {
        return Err(ApiError(StatusCode::NOT_FOUND, "unknown sceneId; upload the scene first".into()));
    }
    let model = maintenance::model_version(&state).await.map_err(internal)?;
    let id = hex::encode(Sha256::digest(
        optimize::fingerprint(&req.scene_id, &worker, &req.profile, &req.candidates, &model).as_bytes(),
    ))[..32]
        .to_string();
    if !req.fresh && disk_status(&state, &id).await.is_some_and(|(p, _)| p == Phase::Done) {
        return Ok(Json(json!({ "id": id, "status": Phase::Done, "cached": true })));
    }
    {
        let jobs = state.jobs.lock().await;
        if let Some(job) = jobs.get(&id) {
            if matches!(job.phase, Phase::Queued | Phase::Running) {
                return Ok(Json(json!({ "id": id, "status": job.phase, "cached": false })));
            }
        }
    }
    if jobs::queued_count(&state).await >= state.cfg.max_queued {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "the job queue is full; try again shortly".into()));
    }
    let job_dir = state.cfg.job_dir(&id);
    let _ = std::fs::remove_dir_all(&job_dir);
    std::fs::create_dir_all(job_dir.join("out")).map_err(internal)?;
    let cache_dir = state.cfg.data_dir.join("cache");
    std::fs::create_dir_all(&cache_dir).map_err(internal)?;
    let abs = |p: &std::path::Path| {
        std::fs::canonicalize(p).map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
    };
    let mut job = worker;
    job.insert("mode".into(), json!("optimize"));
    job.insert("scene_dir".into(), json!(abs(&scene_dir).map_err(internal)?));
    job.insert("output_dir".into(), json!(abs(&job_dir.join("out")).map_err(internal)?));
    job.insert("cache_dir".into(), json!(abs(&cache_dir).map_err(internal)?));
    job.insert("cache_max_mb".into(), json!(state.cfg.cache_max_mb));
    job.insert("refresh_cache".into(), json!(req.fresh));
    job.insert("profile".into(), req.profile.clone());
    job.insert("candidates".into(), req.candidates.clone());
    std::fs::write(job_dir.join("job.json"), serde_json::to_vec(&job).map_err(internal)?).map_err(internal)?;
    jobs::set(&state, &id, Phase::Queued, None).await;
    state.queue.send(id.clone()).map_err(internal)?;
    Ok(Json(json!({ "id": id, "status": Phase::Queued, "cached": false })))
}

async fn cancel_job(State(state): State<Shared>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    if !is_hex(&id, 32) {
        return Err(bad("invalid id"));
    }
    if jobs::cancel(&state, &id).await {
        Ok(Json(json!({ "id": id, "status": "cancelling" })))
    } else {
        Err(ApiError(StatusCode::CONFLICT, "the job is not queued or running".into()))
    }
}

/// Removes a finished (or failed) job's files, e.g. the result a new run replaced.
async fn delete_job(State(state): State<Shared>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    if !is_hex(&id, 32) {
        return Err(bad("invalid id"));
    }
    if state.jobs.lock().await.get(&id).is_some_and(|j| matches!(j.phase, Phase::Queued | Phase::Running)) {
        return Err(ApiError(StatusCode::CONFLICT, "the job is still queued or running".into()));
    }
    state.jobs.lock().await.remove(&id);
    Ok(Json(json!({ "id": id, "deleted": maintenance::delete_job(&state.cfg, &id) })))
}

/// The version of the simulation model a new run would use; a saved result made
/// with another version is out of date.
async fn model_version(State(state): State<Shared>) -> Result<Json<serde_json::Value>, ApiError> {
    let v = maintenance::model_version(&state).await.map_err(internal)?;
    Ok(Json(json!({ "modelVersion": v })))
}

async fn cache_info(State(state): State<Shared>) -> Json<serde_json::Value> {
    let (bytes, files) = maintenance::cache_info(&state.cfg);
    Json(json!({ "bytes": bytes, "files": files, "limitMb": state.cfg.cache_max_mb }))
}

async fn cache_clear(State(state): State<Shared>) -> Result<Json<serde_json::Value>, ApiError> {
    if state.jobs.lock().await.values().any(|j| matches!(j.phase, Phase::Queued | Phase::Running)) {
        return Err(ApiError(StatusCode::CONFLICT, "wait for the running job to finish".into()));
    }
    Ok(Json(json!({ "freedBytes": maintenance::clear_cache(&state.cfg) })))
}

/// Removes results no project refers to (e.g. after a project was deleted). Runs
/// that finished in the last two minutes are kept: they may not be saved to
/// their project yet. Queued and running jobs are never touched.
async fn cleanup(State(state): State<Shared>) -> Result<Json<serde_json::Value>, ApiError> {
    let mut keep = maintenance::referenced_job_ids(&state.cfg.projects_file)
        .map_err(|e| ApiError(StatusCode::SERVICE_UNAVAILABLE, format!("cleanup skipped: {e}")))?;
    keep.extend(state.jobs.lock().await.iter().filter(|(_, j)| matches!(j.phase, Phase::Queued | Phase::Running)).map(|(id, _)| id.clone()));
    let removed = maintenance::cleanup_orphans(&state.cfg, &keep, std::time::Duration::from_secs(120));
    Ok(Json(json!({ "removed": removed })))
}
