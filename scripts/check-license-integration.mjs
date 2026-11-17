// Uses disposable keys/data and the compiled debug service. No customer data is touched.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), "planner-license-integration-"));
let apiServer, rust, store, closeLicensing;
try {
  const keyDir = process.env.OFFLINE_LICENSE_KEY_DIR || path.join(dir, "keys");
  if (!process.env.OFFLINE_LICENSE_KEY_DIR) {
    await run(
      process.execPath,
      ["scripts/license-admin.mjs", "init", "--dir", keyDir],
      { cwd: root },
    );
  }
  const publicFile = path.join(keyDir, "public.key");
  const privateFile = path.join(keyDir, "private.pem");
  process.env.INDOOR_DATA_DIR = path.join(dir, "customer");
  process.env.INDOOR_LICENSE_MODE = "required";
  process.env.LICENSE_PUBLIC_KEY_FILE = publicFile;
  const { app } = await import("../server/app.js");
  ({ closeLicensing } = await import("../server/licensing/index.js"));
  const { projectStore } =
    await import("../server/repositories/projectRepository.js");
  store = projectStore();
  apiServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  const base = `http://127.0.0.1:${apiServer.address().port}`;
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  rust = spawn(
    process.env.OFFLINE_LICENSE_SERVICE_EXE ||
      path.join(
        root,
        "service",
        "target",
        "debug",
        process.platform === "win32"
          ? "indoor-sim-service.exe"
          : "indoor-sim-service",
      ),
    [],
    {
      cwd: root,
      env: {
        ...process.env,
        SIM_PORT: String(port),
        PROJECTS_FILE: path.join(process.env.INDOOR_DATA_DIR, "projects.json"),
        SIM_DATA_DIR: path.join(process.env.INDOOR_DATA_DIR, "simulations"),
      },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  let spawnError;
  rust.on("error", (error) => {
    spawnError = error;
  });
  const simBase = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    try {
      ready = (await fetch(simBase + "/api/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    ready,
    "Rust service must start; run cargo build --manifest-path service/Cargo.toml first",
  );
  assert.equal((await fetch(base + "/api/projects")).status, 402);
  assert.equal((await fetch(simBase + "/api/cache")).status, 402);
  const status = await (await fetch(base + "/api/license/status")).json();
  assert.equal(status.status, "activation_required");
  const licenseFile = path.join(dir, "customer.license");
  await run(
    process.execPath,
    [
      "scripts/license-admin.mjs",
      "issue",
      "--private",
      privateFile,
      "--machine-id",
      status.machineId,
      "--days",
      "30",
      "--out",
      licenseFile,
    ],
    { cwd: root },
  );
  const activation = await fetch(base + "/api/license/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: readFileSync(licenseFile, "utf8") }),
  });
  assert.equal(activation.status, 200);
  assert.equal((await activation.json()).status, "active");
  assert.equal((await fetch(base + "/api/projects")).status, 200);
  assert.equal(
    (await fetch(simBase + "/api/cache")).status,
    200,
    "Rust must verify the same machine ID and offline signature",
  );
  const removed = await fetch(base + "/api/license", { method: "DELETE" });
  assert.equal((await removed.json()).status, "activation_required");
  assert.equal((await fetch(base + "/api/projects")).status, 402);
  assert.equal((await fetch(simBase + "/api/cache")).status, 402);
  const reactivated = await fetch(base + "/api/license/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: readFileSync(licenseFile, "utf8") }),
  });
  assert.equal((await reactivated.json()).status, "active");
  const stateDb = new DatabaseSync(
    path.join(process.env.INDOOR_DATA_DIR, "licenses.sqlite"),
  );
  stateDb
    .prepare("UPDATE license_activations SET activated_at = ?")
    .run(Date.now() - 30 * 86400000 - 1000);
  stateDb.close();
  assert.equal((await fetch(base + "/api/projects")).status, 402);
  assert.equal((await fetch(simBase + "/api/cache")).status, 402);
  const expired = await (await fetch(base + "/api/license/status")).json();
  assert.equal(expired.status, "expired");
  console.log(
    "PASS: offline CLI keys, real machine ID, activation, Node and Rust verification, and local-computer-date expiry.",
  );
} finally {
  if (rust && rust.exitCode === null && !rust.killed) {
    const exited = new Promise((resolve) => rust.once("exit", resolve));
    rust.kill();
    await exited;
  }
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  store?.close();
  closeLicensing?.();
  rmSync(dir, { recursive: true, force: true });
}
