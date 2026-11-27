#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(windows)]
mod windows_job;

struct Backends {
    #[cfg(windows)]
    job: windows_job::ProcessJob,
    children: Mutex<Vec<Child>>,
    ready: Vec<PathBuf>,
}
impl Backends {
    fn stop(&self) {
        if let Ok(mut children) = self.children.lock() {
            for child in children.iter_mut().rev() {
                if child.try_wait().ok().flatten().is_none() {
                    #[cfg(windows)]
                    {
                        let mut kill = Command::new("taskkill.exe");
                        hidden(&mut kill);
                        let _ = kill
                            .args(["/PID", &child.id().to_string(), "/T", "/F"])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
            children.clear();
        }
        for file in &self.ready {
            let _ = fs::remove_file(file);
        }
        if let Some(parent) = self.ready.first().and_then(|p| p.parent()) {
            let _ = fs::remove_dir(parent);
        }
    }
}
impl Drop for Backends {
    fn drop(&mut self) {
        self.stop();
    }
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

// Tauri's Windows path resolver returns verbatim paths. Node's entry-point
// resolver cannot handle those reliably, so pass ordinary paths to runtimes.
fn subprocess_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.as_os_str().to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive) = value.strip_prefix(r"\\?\") {
            if drive.as_bytes().get(1) == Some(&b':') {
                return PathBuf::from(drive);
            }
        }
    }
    path.to_path_buf()
}

fn wait_ready(file: &Path, child: &mut Child) -> Result<u16, Box<dyn std::error::Error>> {
    let started = Instant::now();
    loop {
        if let Some(code) = child.try_wait()? {
            return Err(format!(
                "A background service stopped ({code}). See the application logs."
            )
            .into());
        }
        if let Ok(text) = fs::read_to_string(file) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(port) = value["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                    return Ok(port as u16);
                }
            }
        }
        if started.elapsed() > Duration::from_secs(40) {
            return Err(
                "A background service did not become ready. See the application logs.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn start(payload: &Path, data: &Path) -> Result<(Backends, String), Box<dyn std::error::Error>> {
    let payload = subprocess_path(payload);
    let data = subprocess_path(data);
    fs::create_dir_all(data.join("logs"))?;
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
    );
    let runtime = data.join("runtime").join(run_id);
    fs::create_dir_all(&runtime)?;
    let sim_ready = runtime.join("simulation.json");
    let api_ready = runtime.join("api.json");
    let backends = Backends {
        #[cfg(windows)]
        job: windows_job::ProcessJob::new()?,
        children: Mutex::new(Vec::new()),
        ready: vec![sim_ready.clone(), api_ready.clone()],
    };
    let config: Value = serde_json::from_slice(&fs::read(payload.join("desktop-config.json"))?)?;
    if config["licensing"] != "offline-local-date" {
        return Err(
            "Desktop licensing configuration is incompatible; reinstall the latest version.".into(),
        );
    }
    let python = payload.join("runtime/python/python.exe");
    for (program, ready, log_name) in [
        (
            payload.join("runtime/indoor-sim-service.exe"),
            &sim_ready,
            "simulation.log",
        ),
        (payload.join("runtime/node.exe"), &api_ready, "api.log"),
    ] {
        let mut command = Command::new(program);
        hidden(&mut command);
        command
            .current_dir(&payload)
            .stdin(Stdio::null())
            .env("INDOOR_DATA_DIR", &data)
            .env("INDOOR_LICENSE_MODE", "required")
            .env("NODE_ENV", "production")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env("WORKER_DIR", payload.join("worker"))
            .env("WORKER_PYTHON", &python)
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("MPLCONFIGDIR", data.join("cache/matplotlib"))
            .env(
                "DRJIT_LIBLLVM_PATH",
                payload.join("worker/.llvm/Library/bin/LLVM-C.dll"),
            )
            .env(
                "FLOORPLAN_MODEL",
                payload.join("worker/models/floorplan_unet_run5.onnx"),
            )
            .env("PROJECTS_FILE", data.join("projects.json"))
            .env("SIM_DATA_DIR", data.join("simulations"))
            .env("DESKTOP_READY_FILE", ready)
            .env(
                "LICENSE_PUBLIC_KEY_FILE",
                payload.join("license-public.key"),
            );
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(data.join("logs").join(log_name))?;
        command
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        if log_name == "simulation.log" {
            command.env("SIM_PORT", "0");
        } else {
            let simulation: Value = serde_json::from_slice(&fs::read(&sim_ready)?)?;
            command.arg(payload.join("server/desktop.js")).env(
                "SIM_PORT",
                simulation["port"]
                    .as_u64()
                    .ok_or("missing simulation port")?
                    .to_string(),
            );
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        if let Err(error) = backends.job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
        let result = wait_ready(ready, &mut child);
        backends.children.lock().unwrap().push(child);
        result?;
    }
    let api: Value = serde_json::from_slice(&fs::read(&api_ready)?)?;
    Ok((
        backends,
        format!(
            "http://127.0.0.1:{}",
            api["port"].as_u64().ok_or("missing API port")?
        ),
    ))
}

fn report_error(message: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Indoor Planner".encode_utf16().chain(Some(0)).collect();
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}

fn main() {
    // Headless launch checks exercise the exact packaged runtimes without a window.
    let smoke = std::env::args().any(|arg| arg == "--smoke-test");
    let ui_smoke = std::env::args().any(|arg| arg == "--ui-smoke-test");
    if smoke {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let executable = std::env::current_exe()?;
            let payload = std::env::var_os("INDOOR_SMOKE_PAYLOAD_DIR")
                .map(PathBuf::from)
                .unwrap_or(
                    executable
                        .parent()
                        .ok_or("missing executable directory")?
                        .join("payload"),
                );
            let data = PathBuf::from(std::env::var("INDOOR_SMOKE_DATA_DIR")?);
            // Canonicalization reproduces the verbatim paths returned by Tauri.
            let (backends, url) = start(&fs::canonicalize(&payload)?, &fs::canonicalize(&data)?)?;
            let http = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?;
            let status: Value = http
                .get(format!("{url}/api/license/status"))
                .send()?
                .error_for_status()?
                .json()?;
            if status["machineId"].as_str().is_none() {
                return Err("machine ID is missing".into());
            }
            if status["status"] != "activation_required" {
                return Err("Offline licensing is not ready for activation".into());
            }
            if !http.get(&url).send()?.status().is_success() {
                return Err("packaged frontend is unavailable".into());
            }
            if status["status"] == "activation_required" {
                for route in ["/api/projects", "/api/cache"] {
                    if http.get(format!("{url}{route}")).send()?.status().as_u16() != 402 {
                        return Err(format!("expected activation to block {route}").into());
                    }
                }
            }
            fs::write(
                data.join("desktop-smoke.json"),
                serde_json::to_vec_pretty(
                    &json!({"ok": true, "licenseStatus": status["status"], "machineIdAvailable": true}),
                )?,
            )?;
            backends.stop();
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let mut builder = tauri::Builder::default();
    if !ui_smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let result = builder.setup(move |app| {
            let data = if ui_smoke {
                PathBuf::from(std::env::var("INDOOR_SMOKE_DATA_DIR")?)
            } else { app.path().app_local_data_dir()? };
            // `tauri dev`: the window shows the Vite dev server that
            // `beforeDevCommand` (npm run dev) started with the API, so edits
            // appear instantly. Built apps start the packaged payload.
            let live = tauri::is_dev() && !ui_smoke;
            let url = if live {
                app.config()
                    .build
                    .dev_url
                    .as_ref()
                    .ok_or("devUrl is missing in tauri.conf.json")?
                    .to_string()
            } else {
                let payload = app.path().resource_dir()?.join("payload");
                let (backends, url) = start(&payload, &data)?;
                app.manage(backends);
                url
            };
            let target: reqwest::Url = url.parse()?;
            let origin = target.origin();
            let handle = app.handle().clone();
            let probe = if ui_smoke {
                r#"(() => {
                    let sent = false;
                    const finish = (path, message = '') => {
                        if (!sent) { sent = true; location.assign(path + '?message=' + encodeURIComponent(message)); }
                    };
                    window.addEventListener('error', event => {
                        if (event.message) finish('/_desktop-ui-failed', event.message);
                    });
                    window.addEventListener('unhandledrejection', event => finish('/_desktop-ui-failed', String(event.reason)));
                    const timer = setInterval(() => {
                        const input = document.querySelector('#machine-id');
                        if (/^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/.test(input?.value || '')) {
                            clearInterval(timer); finish('/_desktop-ui-ready');
                        }
                    }, 100);
                    setTimeout(() => finish('/_desktop-ui-failed', 'Activation screen did not render a machine ID within 30 seconds'), 30000);
                })();"#
            } else { "" };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(target))
                .title("Indoor Planner")
                .inner_size(1440.0, 940.0)
                .min_inner_size(1000.0, 700.0)
                .devtools(live)
                .visible(!ui_smoke)
                .data_directory(subprocess_path(&data).join("webview"))
                .initialization_script(probe)
                .on_download(|_webview, event| match event {
                    // Ask where to save instead of silently writing to Downloads.
                    tauri::webview::DownloadEvent::Requested { destination, .. } => {
                        let name = destination
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "download".into());
                        let mut dialog = rfd::FileDialog::new()
                            .set_title("Save file")
                            .set_file_name(&name);
                        if let Some(dir) = destination.parent() {
                            dialog = dialog.set_directory(dir);
                        }
                        let ext = destination
                            .extension()
                            .map(|e| e.to_string_lossy().into_owned());
                        if let Some(ext) = &ext {
                            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
                        }
                        match dialog.save_file() {
                            Some(path) => {
                                *destination = path;
                                true
                            }
                            None => false,
                        }
                    }
                    _ => true,
                })
                .on_navigation(move |url| {
                    if ui_smoke && url.origin() == origin && url.path() == "/_desktop-ui-failed" {
                        let message = url.query_pairs().find(|(name, _)| name == "message").map(|(_, value)| value.into_owned()).unwrap_or_default();
                        let _ = fs::write(data.join("desktop-ui-smoke.json"),
                            serde_json::to_vec(&json!({"ok": false, "message": message})).unwrap());
                        handle.exit(1);
                        return false;
                    }
                    if ui_smoke && url.origin() == origin && url.path() == "/_desktop-ui-ready" {
                        let result = fs::write(data.join("desktop-ui-smoke.json"),
                            br#"{"ok":true,"webviewCreated":true,"activationScreenRendered":true,"machineIdAvailable":true}"#);
                        handle.exit(if result.is_ok() { 0 } else { 1 });
                        return false;
                    }
                    url.origin() == origin
                })
                .build();
            if let Err(error) = window {
                if let Some(backends) = app.try_state::<Backends>() {
                    backends.stop();
                }
                return Err(error.into());
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(backends) = app.try_state::<Backends>() {
                    backends.stop();
                }
            }
        }),
        Err(error) if ui_smoke => {
            eprintln!("{error}");
            std::process::exit(1);
        }
        Err(error) => report_error(&format!("Indoor Planner could not start.\n\n{error}")),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn normalizes_windows_runtime_paths() {
        assert_eq!(
            subprocess_path(Path::new(r"\\?\C:\Program Files\Indoor Planner\payload")),
            PathBuf::from(r"C:\Program Files\Indoor Planner\payload")
        );
        assert_eq!(
            subprocess_path(Path::new(r"\\?\UNC\server\share\payload")),
            PathBuf::from(r"\\server\share\payload")
        );
        assert_eq!(
            subprocess_path(Path::new(r"C:\Users\Test\AppData")),
            PathBuf::from(r"C:\Users\Test\AppData")
        );
    }
}
