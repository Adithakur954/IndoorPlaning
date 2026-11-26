import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRODUCT,
  signEnvelope,
  publicKeyFromRaw,
} from "../licensing/protocol.js";
import { createLicenseClient } from "../server/licensing/client.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "planner-offline-license-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
  const machineId = "IP-" + "A".repeat(64);
  let time = Date.UTC(2026, 0, 1);
  const handles = [];
  const options = {
    publicKey: raw,
    databaseFile: path.join(dir, "licenses.sqlite"),
    getMachineId: async () => machineId,
    now: () => time,
  };
  const open = () => {
    const client = createLicenseClient(options);
    handles.push(client);
    return client;
  };
  t.after(() => {
    for (const client of handles) client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    machineId,
    options,
    client: open(),
    open,
    setTime: (value) => {
      time = value;
    },
    advance: (value) => {
      time += value;
    },
    issue: (overrides = {}) =>
      signEnvelope(
        "IP2",
        {
          product: PRODUCT,
          version: 2,
          licenseId: randomUUID(),
          machineIdHash: machineId,
          durationDays: 30,
          ...overrides,
        },
        privateKey,
      ),
  };
}

test("offline activation starts calendar days at first use and expires against local computer time", async (t) => {
  const f = fixture(t);
  const key = f.issue();
  f.advance(12 * 86400000);
  assert.equal((await f.client.status()).status, "activation_required");
  const activated = await f.client.activate(key);
  assert.equal(activated.status, "active");
  assert.equal(activated.expiresAt - activated.activatedAt, 30 * 86400000);
  f.advance(30 * 86400000 - 1);
  assert.equal((await f.client.status()).status, "active");
  f.advance(1);
  assert.equal((await f.client.status()).status, "expired");
});

test("re-entering a key or reopening the application does not reset activation", async (t) => {
  const f = fixture(t);
  const key = f.issue();
  const activated = await f.client.activate(key);
  f.advance(10 * 86400000);
  const reopened = f.open();
  assert.equal((await reopened.activate(key)).expiresAt, activated.expiresAt);
  f.advance(20 * 86400000);
  assert.equal((await reopened.activate(key)).status, "expired");
  assert.equal((await reopened.status()).expiresAt, activated.expiresAt);
});

test("wrong device, modified duration, invalid grant and wrong publisher cannot activate", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.client.activate(f.issue({ machineIdHash: "IP-" + "B".repeat(64) })),
    /another machine ID/,
  );
  const [prefix, encoded, signature] = f.issue().split(".");
  const edited = JSON.parse(Buffer.from(encoded, "base64url"));
  edited.durationDays = 36500;
  await assert.rejects(
    f.client.activate(
      `${prefix}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`,
    ),
    /signature/,
  );
  await assert.rejects(
    f.client.activate(f.issue({ durationDays: -1 })),
    /contents/,
  );
  const other = generateKeyPairSync("ed25519");
  await assert.rejects(
    f.client.activate(signEnvelope("IP2", edited, other.privateKey)),
    /signature/,
  );
  assert.equal((await f.client.status()).status, "activation_required");
});

test("renewal uses a new signed key and failed activation preserves the current license", async (t) => {
  const f = fixture(t);
  const first = await f.client.activate(f.issue());
  f.advance(31 * 86400000);
  const renewal = await f.client.activate(f.issue({ durationDays: 7 }));
  assert.notEqual(renewal.licenseId, first.licenseId);
  assert.equal(renewal.expiresAt - renewal.activatedAt, 7 * 86400000);
  await assert.rejects(f.client.activate("invalid"));
  assert.equal((await f.client.status()).licenseId, renewal.licenseId);
});

test("local date changes affect expiry; a date before activation is rejected", async (t) => {
  const f = fixture(t);
  const activation = await f.client.activate(f.issue());
  f.setTime(activation.activatedAt - 1);
  assert.equal((await f.client.status()).status, "clock_invalid");
  f.setTime(activation.expiresAt);
  assert.equal((await f.client.status()).status, "expired");
  f.setTime(activation.expiresAt - 1);
  assert.equal((await f.client.status()).status, "active");
});

test("no internet or external server is needed for activation and validation", async (t) => {
  const f = fixture(t);
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network is disabled");
  };
  try {
    assert.equal((await f.client.activate(f.issue())).status, "active");
    assert.equal((await f.client.status()).status, "active");
  } finally {
    globalThis.fetch = previous;
  }
  assert.throws(() => publicKeyFromRaw("bad"), /Invalid license public key/);
});

test("a license without a feature list is a Wi-Fi license; cellular needs the signed feature", async (t) => {
  const { featureAllowed } = await import("../licensing/protocol.js");
  const f = fixture(t);
  const old = await f.client.activate(f.issue());
  assert.deepEqual(old.features, ["wifi"]);
  assert.equal(featureAllowed(old, "wifi"), true);
  assert.equal(featureAllowed(old, "cellular"), false);

  const both = await f.client.activate(
    f.issue({ features: ["wifi", "cellular"] }),
  );
  assert.deepEqual(both.features, ["wifi", "cellular"]);
  assert.equal(featureAllowed(both, "cellular"), true);
});

test("unknown features are ignored and a malformed feature list is refused", async (t) => {
  const f = fixture(t);
  const grant = await f.client.activate(
    f.issue({ features: ["cellular", "future-module"] }),
  );
  assert.deepEqual(grant.features, ["cellular"]);
  await assert.rejects(
    f.client.activate(f.issue({ features: "cellular" })),
    /contents/,
  );
  await assert.rejects(
    f.client.activate(f.issue({ features: [1] })),
    /contents/,
  );
});

test("a feature list cannot be added by editing a signed key", async (t) => {
  const f = fixture(t);
  const [prefix, encoded, signature] = f.issue().split(".");
  const edited = JSON.parse(Buffer.from(encoded, "base64url"));
  edited.features = ["wifi", "cellular"];
  await assert.rejects(
    f.client.activate(
      `${prefix}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`,
    ),
    /signature/,
  );
});
