// Builds the Rust capacity engine (capacity/) as WebAssembly and copies it next
// to its JavaScript loader, where the planner and the tests load it from.
//
//   npm run capacity:build
//
// Needs the wasm32 target once: rustup target add wasm32-unknown-unknown
import { spawnSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "capacity", "Cargo.toml");
const built = path.join(root, "capacity", "target", "wasm32-unknown-unknown", "release", "capacity_core.wasm");
const target = path.join(root, "src", "infra", "wifi", "capacity_core.wasm");

const run = spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest], { stdio: "inherit" });
if (run.status !== 0) {
  console.error("\nThe capacity engine did not build. If the target is missing: rustup target add wasm32-unknown-unknown");
  process.exit(run.status ?? 1);
}
copyFileSync(built, target);
console.log(`capacity engine: ${path.relative(root, target)} (${Math.round(statSync(target).size / 1024)} KB)`);
