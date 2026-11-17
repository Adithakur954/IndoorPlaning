import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Build the license generator on Windows x64");
}
const output = path.join(root, "build/license-generator");
await mkdir(output, { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      "license-generator/Cargo.toml",
      "--target-dir",
      path.join(output, "target"),
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        RUSTFLAGS:
          `${process.env.RUSTFLAGS || ""} -C target-feature=+crt-static`.trim(),
      },
    },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Generator build failed (${code})`)),
  );
});
const exe = path.join(output, "IndoorPlanner-LicenseGenerator.exe");
await copyFile(
  path.join(output, "target/release/indoor-planner-license-generator.exe"),
  exe,
);
const digest = createHash("sha256")
  .update(await readFile(exe))
  .digest("hex");
await writeFile(exe + ".sha256", `${digest}  ${path.basename(exe)}\n`);
console.log(`Built ${exe}. No private key was embedded.`);
