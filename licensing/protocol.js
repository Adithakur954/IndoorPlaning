import { createPublicKey, sign, verify } from "node:crypto";

export const PRODUCT = "indoor-planner";
export const MACHINE_PATTERN = /^IP-[A-F0-9]{64}$/;
export const SHORT_MACHINE_PATTERN = /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/;

// Short form shown to users: first 16 hex characters of the full hash.
export function shortMachineId(fullId) {
  return fullId.slice(3, 19).match(/.{4}/g).join("-");
}

// Licenses may be bound to the full hash (older keys) or the short form.
export function machineMatches(grantId, fullId) {
  return grantId === fullId || grantId === shortMachineId(fullId);
}

export function publicKeyFromRaw(raw) {
  const bytes = Buffer.from(raw.trim(), "base64url");
  if (bytes.length !== 32) throw new Error("Invalid license public key");
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
    format: "der",
    type: "spki",
  });
}

export function signEnvelope(prefix, payload, privateKey) {
  const message = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), privateKey).toString("base64url")}`;
}

export function verifyEnvelope(token, prefix, publicKey) {
  if (typeof token !== "string" || token.length > 16000)
    throw new Error("Invalid license token");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== prefix ||
    !verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    )
  ) {
    throw new Error("License signature is invalid");
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// Optional product modules a license can unlock. A license without a
// `features` list is a Wi-Fi license, so keys issued before this field existed
// keep working unchanged. Names the app does not know are ignored, so a newer
// key never breaks an older app.
export const FEATURES = ["wifi", "cellular"];

export function grantFeatures(grant) {
  if (!Array.isArray(grant?.features)) return ["wifi"];
  return FEATURES.filter((name) => grant.features.includes(name));
}

// One rule for every check: Node API, UI and (later) the Rust service.
// Development mode and states that carry no feature list are decided by the caller.
export const featureAllowed = (license, name) =>
  Array.isArray(license?.features) && license.features.includes(name);

export function validateGrant(grant) {
  if (
    grant?.product !== PRODUCT ||
    grant.version !== 2 ||
    typeof grant.licenseId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(grant.licenseId) ||
    !(
      MACHINE_PATTERN.test(grant.machineIdHash) ||
      SHORT_MACHINE_PATTERN.test(grant.machineIdHash)
    ) ||
    !Number.isInteger(grant.durationDays) ||
    grant.durationDays < 1 ||
    grant.durationDays > 36500 ||
    (grant.features !== undefined &&
      (!Array.isArray(grant.features) ||
        grant.features.length > 16 ||
        grant.features.some((name) => typeof name !== "string")))
  ) {
    throw new Error("Invalid license contents");
  }
  return grant;
}
