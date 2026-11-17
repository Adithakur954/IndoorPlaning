import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  publicKeyFromRaw,
  machineMatches,
  validateGrant,
  verifyEnvelope,
} from "../../licensing/protocol.js";

// This clock is deliberately the computer's clock, as selected by the owner.
export function licenseState(grant, activatedAt, currentTime) {
  const expiresAt = activatedAt + grant.durationDays * 86400000;
  return {
    status:
      currentTime < activatedAt
        ? "clock_invalid"
        : currentTime >= expiresAt
          ? "expired"
          : "active",
    licenseId: grant.licenseId,
    machineId: grant.machineIdHash,
    activatedAt,
    expiresAt,
    durationDays: grant.durationDays,
    remainingSeconds: Math.max(0, Math.ceil((expiresAt - currentTime) / 1000)),
  };
}

export function createLicenseClient({
  publicKey,
  databaseFile,
  getMachineId,
  now = Date.now,
}) {
  const verificationKey = publicKeyFromRaw(publicKey);
  mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS license_activations (
      license_id TEXT PRIMARY KEY, license_key TEXT NOT NULL,
      activated_at INTEGER NOT NULL CHECK(activated_at >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS license_selection (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      license_id TEXT NOT NULL REFERENCES license_activations(license_id)
    ) STRICT;`);
  const find = db.prepare(
    "SELECT * FROM license_activations WHERE license_id = ?",
  );
  const selected = db.prepare(`SELECT a.* FROM license_selection s
    JOIN license_activations a ON a.license_id = s.license_id WHERE s.id = 1`);
  async function verifyKey(key) {
    const machineId = await getMachineId();
    const grant = validateGrant(verifyEnvelope(key, "IP2", verificationKey));
    if (!machineMatches(grant.machineIdHash, machineId))
      throw new Error("This license key belongs to another machine ID");
    return grant;
  }
  return {
    async status() {
      const row = selected.get();
      if (!row)
        return {
          status: "activation_required",
          machineId: await getMachineId(),
        };
      const grant = await verifyKey(row.license_key);
      if (row.license_id !== grant.licenseId)
        throw new Error("Invalid activation record");
      return licenseState(grant, row.activated_at, now());
    },
    async activate(key) {
      const grant = await verifyKey(key);
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentTime = now();
        const previous = find.get(grant.licenseId);
        if (previous && previous.license_key !== key)
          throw new Error("This license ID already has another activation key");
        const activatedAt = previous?.activated_at ?? currentTime;
        const state = licenseState(grant, activatedAt, currentTime);
        if (state.status === "active") {
          if (!previous)
            db.prepare("INSERT INTO license_activations VALUES (?, ?, ?)").run(
              grant.licenseId,
              key,
              activatedAt,
            );
          db.prepare(
            `INSERT INTO license_selection(id, license_id) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET license_id = excluded.license_id`,
          ).run(grant.licenseId);
        }
        db.exec("COMMIT");
        return state;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    // Clears the active key only. Activation history is kept so re-entering the
    // same key cannot restart its period.
    deactivate() {
      db.prepare("DELETE FROM license_selection WHERE id = 1").run();
    },
    close: () => db.close(),
  };
}
