import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, rootDir } from "../config/paths.js";

// Floor-plan image -> building geometry. The work is done by the local Python
// package in worker/floorplan (OpenCV, Shapely, RapidOCR): free, offline, and
// run in a background process so the API stays responsive.

export const floorplanDir = path.join(dataDir, "floorplan");
const workerDir = process.env.WORKER_DIR || path.join(rootDir, "worker");
const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".pdf"]);
const MAX_BYTES = 60 * 1024 * 1024;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_DAYS = 7;
export const FILES = new Set([
  "preview.png",
  "overlay.png",
  "walls_mask.png",
  "deskewed.png",
  "model_overlay.png",
  "result.json",
]);

export function pythonPath() {
  if (process.env.WORKER_PYTHON) return process.env.WORKER_PYTHON;
  const win = path.join(workerDir, ".venv", "Scripts", "python.exe");
  const nix = path.join(workerDir, ".venv", "bin", "python");
  return existsSync(win) ? win : existsSync(nix) ? nix : "python";
}

const isId = (id) => /^[0-9a-f]{24}$/.test(String(id));
export const jobDir = (id) => path.join(floorplanDir, id);

function run(args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(pythonPath(), ["-m", "floorplan", ...args], {
      cwd: workerDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastJson = (text) => {
  for (const line of String(text).trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      /* not JSON */
    }
  }
  return null;
};

export async function createUpload({ name, dataBase64 }) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!ALLOWED.has(ext))
    throw Object.assign(new Error("Use a PNG, JPG or PDF floor plan."), {
      status: 400,
    });
  const buffer = Buffer.from(String(dataBase64 || ""), "base64");
  if (!buffer.length || buffer.length > MAX_BYTES)
    throw Object.assign(new Error("The file is empty or larger than 60 MB."), {
      status: 400,
    });
  const id = crypto.randomBytes(12).toString("hex");
  const dir = jobDir(id);
  await mkdir(path.join(dir, "out"), { recursive: true });
  const input = path.join(dir, `input${ext}`);
  await writeFile(input, buffer);
  const result = await run(["preview", input, path.join(dir, "preview.png")], {
    timeoutMs: 60_000,
  });
  const info = lastJson(result.stdout);
  if (result.code !== 0 || info?.status !== "done") {
    await rm(dir, { recursive: true, force: true });
    throw Object.assign(
      new Error(
        info?.error || "The file could not be read as a floor plan image.",
      ),
      { status: 422 },
    );
  }
  await writeFile(
    path.join(dir, "upload.json"),
    JSON.stringify({ name, ext, ...info }),
  );
  return { id, name, ...info };
}

const state = new Map(); // id -> { status, error, startedAt, finishedAt }
const queue = [];
let running = false;

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  running = true;
  const dir = jobDir(id);
  const entry = state.get(id);
  entry.status = "running";
  entry.startedAt = Date.now();
  try {
    const upload = JSON.parse(
      await readFile(path.join(dir, "upload.json"), "utf8"),
    );
    const job = JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
    await rm(path.join(dir, "out"), { recursive: true, force: true });
    const spec = {
      image: path.join(dir, `input${upload.ext}`),
      out_dir: path.join(dir, "out"),
      scale: job.scale || null,
      options: job.options || {},
    };
    await writeFile(path.join(dir, "spec.json"), JSON.stringify(spec));
    const result = await run([path.join(dir, "spec.json")], {
      timeoutMs: JOB_TIMEOUT_MS,
    });
    const info = lastJson(result.stdout);
    if (result.code === 0 && info?.status === "done") entry.status = "done";
    else {
      entry.status = "failed";
      entry.error =
        info?.error ||
        result.stderr.split("\n").filter(Boolean).pop() ||
        "reconstruction failed";
    }
  } catch (error) {
    entry.status = "failed";
    entry.error = error.message;
  } finally {
    entry.finishedAt = Date.now();
    running = false;
    pump();
  }
}

export async function startJob(id, { scale, options }) {
  if (!isId(id) || !existsSync(path.join(jobDir(id), "upload.json")))
    throw Object.assign(new Error("Unknown upload."), { status: 404 });
  if (state.get(id)?.status === "running" || queue.includes(id))
    throw Object.assign(new Error("This plan is already being processed."), {
      status: 409,
    });
  if (queue.length >= 4)
    throw Object.assign(
      new Error("Too many reconstructions queued; try again shortly."),
      { status: 429 },
    );
  await writeFile(
    path.join(jobDir(id), "job.json"),
    JSON.stringify({ scale, options }),
  );
  state.set(id, { status: "queued" });
  queue.push(id);
  pump();
  return { id, status: "queued" };
}

export async function jobStatus(id) {
  if (!isId(id) || !existsSync(jobDir(id)))
    throw Object.assign(new Error("Unknown job."), { status: 404 });
  const entry = state.get(id);
  const resultFile = path.join(jobDir(id), "out", "result.json");
  if (!entry || entry.status === "done") {
    if (existsSync(resultFile))
      return {
        id,
        status: "done",
        result: JSON.parse(await readFile(resultFile, "utf8")),
      };
    if (!entry) return { id, status: "uploaded" };
  }
  if (entry.status === "failed")
    return { id, status: "failed", error: entry.error };
  return {
    id,
    status: entry.status,
    queued: queue.indexOf(id) + 1 || undefined,
  };
}

export function jobFile(id, name) {
  if (!isId(id) || !FILES.has(name)) return null;
  const file =
    name === "preview.png"
      ? path.join(jobDir(id), name)
      : path.join(jobDir(id), "out", name);
  return existsSync(file) ? file : null;
}

export async function removeJob(id) {
  if (!isId(id)) return false;
  state.delete(id);
  await rm(jobDir(id), { recursive: true, force: true });
  return true;
}

// Old uploads and results are removed so the data folder stays small.
export async function cleanOldJobs() {
  if (!existsSync(floorplanDir)) return 0;
  let removed = 0;
  for (const name of await readdir(floorplanDir)) {
    const dir = path.join(floorplanDir, name);
    try {
      const age = Date.now() - (await stat(dir)).mtimeMs;
      if (age > KEEP_DAYS * 24 * 3600 * 1000) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
