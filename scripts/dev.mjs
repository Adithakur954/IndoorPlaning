import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildSimulationService, simulationEnvironment, startChild, stopChild } from "./simulation-process.mjs";

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

let readyFile;
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) stopChild(child);
  if (readyFile) {
    rmSync(readyFile, { force: true });
    rmdirSync(path.dirname(readyFile));
  }
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

function monitor(name, child) {
  children.push(child);
  child.completed.then(
    ({ code, signal }) => {
      if (!stopping) console.error(`${name} stopped (${signal || code}).`);
      stop(code || 1);
    },
    (error) => {
      if (!stopping) console.error(`Could not start ${name}: ${error.message}`);
      stop(1);
    },
  );
}

async function simulationPortWhenReady(file) {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const { port } = JSON.parse(readFileSync(file, "utf8"));
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(75);
  }
  if (!stopping) throw new Error("The simulation service did not report its port.");
}

try {
  const vitePort = Number(process.env.VITE_PORT ?? 5173);
  if (!Number.isInteger(vitePort) || vitePort < 1 || vitePort > 65535) {
    throw new Error("VITE_PORT must be a number from 1 to 65535.");
  }
  if (vitePort === apiPort || !(await canListen(vitePort))) {
    throw new Error(`The Vite port ${vitePort} is in use. Close the previous dev session or choose another VITE_PORT for browser development.`);
  }
  const simEnv = simulationEnvironment(process.env);
  const build = buildSimulationService(simEnv);
  children.push(build);
  const executable = await build.executable;
  if (!stopping) {
    readyFile = path.join(mkdtempSync(path.join(os.tmpdir(), "indoor-planner-dev-")), "simulation.json");
    const preferredPort = Number(simEnv.SIM_PORT ?? 0);
    if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
      throw new Error("SIM_PORT must be a number from 0 to 65535.");
    }
    const simPort = preferredPort !== apiPort && preferredPort && await canListen(preferredPort) ? preferredPort : 0;
    let boundPort;
    if (!stopping) {
      monitor("Simulation service", startChild(executable, [], {
        ...simEnv,
        SIM_PORT: String(simPort),
        DESKTOP_READY_FILE: readyFile,
        SIM_SKIP_STARTUP_CLEANUP: "1",
      }));
      boundPort = await simulationPortWhenReady(readyFile);
    }
    if (!stopping) {
      const env = {
        ...simEnv,
        SIM_PORT: String(boundPort),
        PORT: String(apiPort),
        API_PORT: String(apiPort),
      };
      console.log(`Vite simulation proxy: http://127.0.0.1:${boundPort}`);
      if (!reuseApi) {
        monitor("Indoor Planner API", startChild(process.execPath, ["server/index.js"], env));
        const deadline = Date.now() + 15_000;
        while (!stopping && !(await isPlannerApi(apiPort))) {
          if (Date.now() >= deadline) throw new Error("The Indoor Planner API did not become ready.");
          await delay(100);
        }
      }
      if (!stopping) {
        monitor("Vite", startChild(
          process.execPath,
          ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort", "--configLoader", "runner"],
          env,
        ));
      }
    }
  }
} catch (error) {
  if (!stopping) {
    console.error(error.message);
    stop(1);
  }
}
