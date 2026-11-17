import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const iconDir = path.join(root, "src-tauri/icons");
const original = await readFile(
  path.join(root, "src/assets/tool-logo.svg"),
  "utf8",
);
const square = original.replace(/<svg\b[\s\S]*?>/, (tag) =>
  tag
    .replace(/\bwidth="[^"]*"/, 'width="512"')
    .replace(/\bheight="[^"]*"/, 'height="512"'),
);
await writeFile(path.join(iconDir, "source.svg"), square);
await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      "node_modules/@tauri-apps/cli/tauri.js",
      "icon",
      "src-tauri/icons/source.svg",
      "--output",
      "src-tauri/icons",
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Icon generation failed (${code})`)),
  );
});
const keep = new Set(["source.svg", "32x32.png", "128x128.png", "icon.ico"]);
for (const entry of await readdir(iconDir)) {
  if (keep.has(entry)) continue;
  const target = path.resolve(iconDir, entry);
  if (!target.startsWith(iconDir + path.sep))
    throw new Error("Unsafe generated icon path");
  await rm(target, { recursive: true, force: true });
}
