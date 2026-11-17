import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "indoor-desktop-check-"));
try {
  const exeArgument = process.argv.indexOf("--exe");
  const exe =
    exeArgument >= 0
      ? path.resolve(process.argv[exeArgument + 1])
      : path.join(root, "src-tauri/target/release/indoor-planner-desktop.exe");
  for (const mode of ["--smoke-test", "--ui-smoke-test"]) {
    await new Promise((resolve, reject) => {
      const child = spawn(exe, [mode], {
        cwd: root,
        windowsHide: true,
        stdio: "inherit",
        env: {
          ...process.env,
          INDOOR_SMOKE_DATA_DIR: dir,
          INDOOR_SMOKE_PAYLOAD_DIR: path.join(path.dirname(exe), "payload"),
        },
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Desktop startup check timed out"));
      }, 100000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error(`Desktop check failed (${code}). Logs: ${dir}`));
      });
    });
  }
  const result = JSON.parse(
    await readFile(path.join(dir, "desktop-smoke.json"), "utf8"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.licenseStatus, "activation_required");
  assert.equal(result.machineIdAvailable, true);
  const ui = JSON.parse(
    await readFile(path.join(dir, "desktop-ui-smoke.json"), "utf8"),
  );
  assert.equal(ui.webviewCreated, true);
  assert.equal(ui.activationScreenRendered, true);
  console.log(
    `PASS: canonical Windows paths, packaged backends, real WebView, rendered activation screen, machine ID, and ${result.licenseStatus} licensing state.`,
  );
} catch (error) {
  const uiFailure = await readFile(
    path.join(dir, "desktop-ui-smoke.json"),
    "utf8",
  ).catch(() => "");
  if (uiFailure) console.error(uiFailure);
  for (const name of ["api.log", "simulation.log"]) {
    const log = await readFile(path.join(dir, "logs", name), "utf8").catch(
      () => "",
    );
    if (log) console.error(`${name}:\n${log.slice(-5000)}`);
  }
  throw error;
} finally {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
