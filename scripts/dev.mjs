import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";

if (existsSync(".env")) loadEnvFile(".env");

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function isPlannerApi(port) {
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const status = await health.json();
    return (
      health.ok &&
      status.ok === true &&
      status.service === "indoor-planner-api" &&
      status.licenseRequired === true
    );
  } catch {
    return false;
  }
}

let apiPort = Number(process.env.PORT) || 3001;
let reuseApi = false;
if (!(await canListen(apiPort))) {
  reuseApi = await isPlannerApi(apiPort);
  if (reuseApi) {
    console.log(
      `Using the Indoor Planner API already running on port ${apiPort}.`,
    );
  } else if (process.env.PORT) {
    console.error(`API port ${apiPort} is in use. Choose another PORT.`);
    process.exit(1);
  } else {
    const simulationPort = Number(process.env.SIM_PORT) || 3002;
    while (apiPort === simulationPort || !(await canListen(apiPort))) apiPort++;
    console.log(`API port 3001 is in use; using ${apiPort}.`);
  }
}

const env = {
  ...process.env,
  INDOOR_LICENSE_MODE: "required",
  LICENSE_PUBLIC_KEY_FILE:
    process.env.LICENSE_PUBLIC_KEY_FILE ||
    path.resolve("licensing-private/public.key"),
  PORT: String(apiPort),
  API_PORT: String(apiPort),
};
const api = reuseApi
  ? null
  : spawn(process.execPath, ["server/index.js"], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { cwd: process.cwd(), env, stdio: "inherit" },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api?.kill();
  vite.kill();
  process.exitCode = code;
}
api?.on("exit", (code) => stop(code || 1));
vite.on("exit", (code) => stop(code || 1));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
