# Windows installer

This project builds a Tauri Windows x64 application and an NSIS `setup.exe` for
direct distribution. Microsoft Store publishing, store accounts, MSIX packaging,
automatic updates, and code-signing certificates are not configured.

## Current build: offline activation

Version 1.0.4 displays the hashed machine ID and accepts publisher-signed offline
keys. It includes the publisher public key and requires no licensing server.
Licensed calendar days start at first activation and expiration uses the computer's
local date/time. See [Licensing](LICENSING.md) to generate a key for a machine ID.

No existing projects, imported customer files, activation keys, private signing
keys, license authority, or publisher admin scripts are included.

## Build

On Windows x64, install Node.js 24+, Rust/MSVC Windows build tools, and the worker
dependencies in `worker/.venv`. Create publisher keys once as described in the
licensing guide. The build also expects the trained
`worker/models/floorplan_unet_run5.onnx` model and the LLVM CPU runtime under
`worker/.llvm/Library/bin`.

```powershell
npm.cmd install
npm.cmd run desktop:build
npm.cmd run desktop:smoke
```

The build prepares the frontend and portable runtimes automatically. It downloads
the official CPython 3.13.13 x64 embedded runtime, bundles installed worker
dependencies, verifies CPU ray tracing and model loading, and builds the Rust
service in an isolated target directory. This avoids overwriting a simulation
service already running from the development tree.

The installer is written to:

```text
src-tauri/target/release/bundle/nsis/Indoor Planner_1.0.4_x64-setup.exe
```

Distribute the setup EXE. The bare `indoor-planner-desktop.exe` launcher requires
its packaged payload and is not a standalone portable distribution.

## What is bundled

- Tauri native window and an application icon.
- Production React frontend.
- Node.js runtime, Express API, and SQLite project storage code.
- Release Rust simulation service.
- Isolated Python runtime with image reconstruction, OCR, ONNX model, and
  Sionna/Mitsuba/Dr.Jit dependencies.
- LLVM CPU backend and required native libraries.
- Runtime and dependency notices supplied with those components.

Customers do not need to install Node, Python, Rust, or your virtual environment.
The setup installs for the current user. Microsoft Edge WebView2 is required;
the installer downloads its bootstrapper when necessary, so an internet connection
may be required on a machine without WebView2. License activation and validation
work offline. Online map features still need their own internet access. The
installer is currently unsigned.

## Runtime behavior

The launcher starts hidden Node and Rust processes on dynamically assigned
loopback ports, then opens the UI on the Node origin. The API streams simulation
requests to Rust. A second launch focuses the existing window. Normal exit stops
both backends and their child workers.

Data is stored under:

```text
%LOCALAPPDATA%/com.indoorplanner.desktop/
```

Projects, activation credentials, imports, simulation results, and logs stay
outside the installation directory. Updates do not replace that data. Startup
failures show an error; backend details are in `logs/api.log` and
`logs/simulation.log` within the data directory.

Existing development projects remain in the repository's `data` directory and
are not automatically imported into the installed application. To move them,
stop both versions, back up both data directories, then transfer the project
database and required result/import files to the installed app's data directory.
See [Project storage](PROJECT_STORAGE.md) for SQLite/WAL backup requirements.

## Build with your public key

The default public key is `licensing-private/public.key`. To select another:

```powershell
$env:DESKTOP_LICENSE_PUBLIC_KEY_FILE = 'C:/secure/publisher/public.key'
npm.cmd run desktop:build
```

Only the public key is copied. The build embeds it into the release Rust service
and puts the matching public-key file into the Node payload. The
private key remains on your system/server. Rebuild to change these trust anchors.

Desktop launch always requires an offline license key; the source-development
bypass is not used. No licensing URL needs to be configured.

## Verification

`desktop:smoke` first checks canonical Windows paths and the packaged backends,
then creates a real, hidden WebView through the normal Tauri startup path. It
waits for the React activation screen to render a valid machine ID before
passing. The checks use temporary data and verify blocking of project/simulation
APIs before activation. They stop child processes and remove temporary data.
This does not replace a manual installer test on a clean Windows machine.

Version 1.0.1 fixes startup from Windows verbatim (`\\?\`) resource paths and the
missing React import in the activation screen. It uses `src/assets/tool-logo.svg`
for the application and installer icons, regenerated during each desktop build.
Windows job objects stop backend process trees if the launcher exits unexpectedly.
Version 1.0.4 replaces online license verification with offline keys and local-date expiry.

To verify an installed copy using temporary test data and a hidden WebView:

```powershell
npm.cmd run desktop:smoke -- --exe "$env:LOCALAPPDATA/Indoor Planner/indoor-planner-desktop.exe"
```

Build intermediates and portable runtimes are under `build/desktop/`, ignored by
Git. `build-manifest.json` records runtime version and Python archive hash. Do not
distribute intermediate folders containing publisher build tools or source data.
