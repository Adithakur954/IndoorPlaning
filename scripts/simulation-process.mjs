import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

export function startChild(command, args, env, stdio = "inherit") {
  const child = spawn(command, args, { env, stdio, windowsHide: true });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Callers can attach a handler after a readiness probe.
  completed.catch(() => {});
  return { child, completed };
}

export function stopChild(processHandle) {
  const child = processHandle?.child;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Stop workers spawned by the service and rustc spawned by Cargo as well.
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  child.kill();
}

export function simulationEnvironment(env) {
  const keyFile = path.resolve(
    env.LICENSE_PUBLIC_KEY_FILE ||
      env.DESKTOP_LICENSE_PUBLIC_KEY_FILE ||
      "licensing-private/public.key",
  );
  let publicKey;
  try {
    publicKey = readFileSync(keyFile, "utf8").trim();
  } catch {
    throw new Error(`Cannot read the license public key at ${keyFile}`);
  }
  const llvm = path.join(env.WORKER_DIR || "worker", ".llvm", "Library", "bin", "LLVM-C.dll");
  return {
    ...env,
    INDOOR_LICENSE_MODE: "required",
    INDOOR_LICENSE_PUBLIC_KEY: publicKey,
    LICENSE_PUBLIC_KEY_FILE: keyFile,
    ...(process.platform === "win32" && !env.DRJIT_LIBLLVM_PATH && existsSync(llvm)
      ? { DRJIT_LIBLLVM_PATH: path.resolve(llvm) }
      : {}),
  };
}

export function buildSimulationService(env) {
  const build = startChild(
    "cargo",
    ["build", "--release", "--manifest-path", "service/Cargo.toml", "--message-format=json-render-diagnostics"],
    env,
    ["ignore", "pipe", "inherit"],
  );
  const executable = (async () => {
    let file;
    const lines = createInterface({ input: build.child.stdout });
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.reason === "compiler-message") {
        process.stderr.write(message.message.rendered || "");
      }
      if (message.executable && message.target?.name === "indoor-sim-service") {
        file = message.executable;
      }
    }
    const { code, signal } = await build.completed;
    if (code !== 0 || !file) throw new Error(`Simulation service build failed (${signal || code})`);
    return file;
  })();
  executable.catch(() => {});
  return { ...build, executable };
}
