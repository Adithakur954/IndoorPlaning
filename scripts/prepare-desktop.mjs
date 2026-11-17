import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = path.join(root, "build", "desktop");
const payload = path.join(build, "payload");
const cache = path.join(build, "downloads");
const sourcePython = path.join(root, "worker/.venv/Scripts/python.exe");
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(command)} failed (${code})`)),
    );
  });
}
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  Number(process.versions.node.split(".")[0]) < 24
) {
  throw new Error(
    "Build this installer on Windows x64 with Node.js 24 or later",
  );
}
await run(process.execPath, ["scripts/generate-desktop-icons.mjs"]);
const publicFile =
  process.env.DESKTOP_LICENSE_PUBLIC_KEY_FILE ||
  path.join(root, "licensing-private/public.key");
if (!existsSync(publicFile))
  throw new Error(
    "Create publisher keys with npm run license:admin -- init --dir licensing-private, or set DESKTOP_LICENSE_PUBLIC_KEY_FILE",
  );
const { publicKeyFromRaw } = await import("../licensing/protocol.js");
const publicKey = (await readFile(publicFile, "utf8")).trim();
publicKeyFromRaw(publicKey);
await mkdir(cache, { recursive: true });
// Delete only the fixed generated staging directory, never repository/user data.
if (path.dirname(path.resolve(payload)) !== path.resolve(build))
  throw new Error("Unsafe desktop staging path");
await rm(payload, { recursive: true, force: true });
await mkdir(path.join(payload, "runtime"), { recursive: true });
console.log("Building desktop frontend…");
await run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
await cp(path.join(root, "dist"), path.join(payload, "dist"), {
  recursive: true,
});
await cp(path.join(root, "server"), path.join(payload, "server"), {
  recursive: true,
});
await mkdir(path.join(payload, "licensing"), { recursive: true });
await copyFile(
  path.join(root, "licensing/protocol.js"),
  path.join(payload, "licensing/protocol.js"),
);
await copyFile(process.execPath, path.join(payload, "runtime/node.exe"));
await writeFile(
  path.join(payload, "package.json"),
  JSON.stringify({
    name: "indoor-planner-runtime",
    version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
      .version,
    type: "module",
    private: true,
  }),
);
await writeFile(
  path.join(payload, "desktop-config.json"),
  JSON.stringify({ licensing: "offline-local-date", activationRequired: true }),
);
if (publicKey)
  await writeFile(path.join(payload, "license-public.key"), publicKey);

// Copy only Express's installed dependency closure. No dev tools or license issuer.
const visited = new Set();
async function stageDependency(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  let folder;
  try {
    folder = path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    folder = path.dirname(require.resolve(name));
    while (
      !existsSync(path.join(folder, "package.json")) ||
      JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"))
        .name !== name
    ) {
      const parent = path.dirname(folder);
      if (parent === folder)
        throw new Error(`Cannot locate dependency ${name}`);
      folder = parent;
    }
  }
  if (visited.has(folder)) return;
  visited.add(folder);
  const relative = path.relative(path.join(root, "node_modules"), folder);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Dependency is outside this workspace's node_modules");
  await cp(folder, path.join(payload, "node_modules", relative), {
    recursive: true,
  });
  const pkg = JSON.parse(
    await readFile(path.join(folder, "package.json"), "utf8"),
  );
  for (const child of Object.keys(pkg.dependencies || {}))
    await stageDependency(child, folder);
}
await stageDependency("express", root);

const pythonZip = path.join(cache, "python-3.13.13-embed-amd64.zip");
if (!existsSync(pythonZip)) {
  console.log("Downloading the official portable CPython runtime…");
  const response = await fetch(
    "https://www.python.org/ftp/python/3.13.13/python-3.13.13-embed-amd64.zip",
  );
  if (!response.ok)
    throw new Error(`Python download failed (${response.status})`);
  await writeFile(pythonZip, Buffer.from(await response.arrayBuffer()));
}
console.log(
  "Packaging Python, floor-plan models, and CPU simulation dependencies…",
);
await run(sourcePython, [
  "scripts/package-python.py",
  root,
  payload,
  pythonZip,
]);
console.log("Checking the isolated Python runtime…");
const pythonEnv = {
  ...process.env,
  PYTHONNOUSERSITE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  DRJIT_LIBLLVM_PATH: path.join(payload, "worker/.llvm/Library/bin/LLVM-C.dll"),
  MPLCONFIGDIR: path.join(build, "python-cache"),
};
await run(
  path.join(payload, "runtime/python/python.exe"),
  [
    "-c",
    "import cv2, scipy, onnxruntime, pypdfium2, rapidocr; from floorplan.model import info; print(info()); from sionna_worker.runtime import select_backend; print(select_backend('cpu')); from sionna_worker.version import model_info; print(model_info())",
  ],
  pythonEnv,
);
console.log("Building the release simulation service…");
await run(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    "service/Cargo.toml",
    "--target-dir",
    path.join(build, "service-target"),
  ],
  {
    ...process.env,
    INDOOR_LICENSE_PUBLIC_KEY: publicKey,
  },
);
await copyFile(
  path.join(build, "service-target/release/indoor-sim-service.exe"),
  path.join(payload, "runtime/indoor-sim-service.exe"),
);
await mkdir(path.join(payload, "THIRD_PARTY_NOTICES"), { recursive: true });
for (const [name, url] of [
  [
    "LLVM-LICENSE.txt",
    "https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/LICENSE.TXT",
  ],
  [
    "zstd-LICENSE.txt",
    "https://raw.githubusercontent.com/facebook/zstd/dev/LICENSE",
  ],
  [
    "zlib-LICENSE.txt",
    "https://raw.githubusercontent.com/madler/zlib/develop/LICENSE",
  ],
]) {
  const cached = path.join(cache, name);
  if (!existsSync(cached)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not include ${name}`);
    await writeFile(cached, await response.text());
  }
  await copyFile(cached, path.join(payload, "THIRD_PARTY_NOTICES", name));
}
const nodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
if (existsSync(nodeLicense))
  await copyFile(
    nodeLicense,
    path.join(payload, "THIRD_PARTY_NOTICES/Node-LICENSE.txt"),
  );
else {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  );
  if (!response.ok)
    throw new Error("Could not include Node's third-party notices");
  await writeFile(
    path.join(payload, "THIRD_PARTY_NOTICES/Node-LICENSE.txt"),
    await response.text(),
  );
}
// Explicitly reject accidental customer data or publisher tooling in the package.
for (const forbidden of [
  "data",
  "licensing-private",
  "licensing/authority.js",
  "licensing/server.js",
  "scripts",
  ".env",
  "private.pem",
]) {
  if (existsSync(path.join(payload, forbidden)))
    throw new Error(`Forbidden installer content: ${forbidden}`);
}
await writeFile(
  path.join(build, "build-manifest.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      licensing: "offline-local-date",
      node: process.versions.node,
      pythonArchiveSha256: createHash("sha256")
        .update(await readFile(pythonZip))
        .digest("hex"),
      dependencies: visited.size,
    },
    null,
    2,
  ),
);
console.log("Desktop payload ready (offline licensing; local computer date).");
