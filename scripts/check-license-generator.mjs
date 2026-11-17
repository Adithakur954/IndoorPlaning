import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { validateGrant, verifyEnvelope } from "../licensing/protocol.js";
import { createLicenseClient } from "../server/licensing/client.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const exe = path.join(
  root,
  "build/license-generator/IndoorPlanner-LicenseGenerator.exe",
);
const run = promisify(execFile);
const dir = await mkdtemp(path.join(os.tmpdir(), "license-generator-check-"));
let client;
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const raw = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
  const privateFile = path.join(dir, "private.pem");
  const publicFile = path.join(dir, "public.key");
  const outputFile = path.join(dir, "customer.license");
  const machineId = "IP-" + "A".repeat(64);
  await writeFile(privateFile, pem, { mode: 0o600 });
  await writeFile(publicFile, raw);
  await run(exe, ["--ui-self-test", privateFile, machineId, "5", outputFile], {
    windowsHide: true,
    timeout: 15000,
  });
  const token = await readFile(outputFile, "utf8");
  const grant = validateGrant(verifyEnvelope(token, "IP2", publicKey));
  assert.equal(grant.durationDays, 5);
  assert.equal(grant.machineIdHash, machineId);
  assert.equal(await readFile(privateFile, "utf8"), pem);
  let time = Date.UTC(2026, 0, 1);
  client = createLicenseClient({
    publicKey: raw,
    databaseFile: path.join(dir, "licenses.sqlite"),
    getMachineId: async () => machineId,
    now: () => time,
  });
  const activation = await client.activate(token);
  assert.equal(activation.status, "active");
  time += 5 * 86400000;
  assert.equal((await client.status()).status, "expired");
  await writeFile(publicFile, "not-the-matching-public-key");
  await assert.rejects(
    run(
      exe,
      [
        "--ui-self-test",
        privateFile,
        machineId,
        "5",
        path.join(dir, "invalid.license"),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  );
  const binary = await readFile(exe);
  assert.equal(binary.includes(Buffer.from(pem)), false);
  const publisherPem = await readFile(
    path.join(root, "licensing-private/private.pem"),
  ).catch(() => null);
  if (publisherPem) assert.equal(binary.includes(publisherPem), false);
  console.log(
    "PASS: native generator window, signing, copy/save control states, invalid-input reset, matching publisher key, and 5-day app activation/expiry. Private keys were not embedded or changed.",
  );
} finally {
  client?.close();
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
