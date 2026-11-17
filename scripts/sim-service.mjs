// Starts the Rust simulation service with the license public key pinned,
// as release builds require (option_env!("INDOOR_LICENSE_PUBLIC_KEY")).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const keyFile = path.resolve(
  process.env.LICENSE_PUBLIC_KEY_FILE ||
    process.env.DESKTOP_LICENSE_PUBLIC_KEY_FILE ||
    "licensing-private/public.key",
);
let publicKey;
try {
  publicKey = readFileSync(keyFile, "utf8").trim();
} catch {
  console.error(
    `Cannot read the license public key at ${keyFile}. Run: npm run license:admin -- init --dir licensing-private`,
  );
  process.exit(1);
}
const child = spawn(
  "cargo",
  ["run", "--release", "--manifest-path", "service/Cargo.toml"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      INDOOR_LICENSE_PUBLIC_KEY: publicKey,
      LICENSE_PUBLIC_KEY_FILE: keyFile,
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
