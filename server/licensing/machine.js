import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const run = promisify(execFile);

export async function machineIdHash() {
  let identity;
  if (process.platform === "win32") {
    const { stdout } = await run(
      "reg.exe",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
        "/reg:64",
      ],
      { windowsHide: true, timeout: 5000 },
    );
    identity = stdout.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1];
  } else if (process.platform === "linux") {
    identity = await readFile("/etc/machine-id", "utf8");
  } else if (process.platform === "darwin") {
    const { stdout } = await run(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { timeout: 5000 },
    );
    identity = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  }
  if (!identity?.trim())
    throw new Error("Cannot read a stable machine identity");
  return (
    "IP-" +
    createHash("sha256")
      .update("IndoorPlanner:v1:" + identity.trim().toLowerCase())
      .digest("hex")
      .toUpperCase()
  );
}
