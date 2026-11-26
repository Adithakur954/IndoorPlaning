import { Router } from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import { dataDir } from "../config/paths.js";
import { machineIdHash } from "./machine.js";
import { createLicenseClient } from "./client.js";
import { FEATURES, featureAllowed } from "../../licensing/protocol.js";

let client;
let identity;
const getMachineId = () =>
  (identity ??= machineIdHash().catch((error) => {
    identity = undefined;
    throw error;
  }));
const development = () =>
  process.env.INDOOR_LICENSE_MODE === "development" &&
  Boolean(process.env.NODE_TEST_CONTEXT);
function licenseClient() {
  return (client ??= createLicenseClient({
    publicKey: readFileSync(process.env.LICENSE_PUBLIC_KEY_FILE, "utf8"),
    databaseFile: path.join(dataDir, "licenses.sqlite"),
    getMachineId: getMachineId,
  }));
}
async function status() {
  if (development())
    return {
      status: "development",
      features: FEATURES,
      message: "License checks are disabled for development",
    };
  let configured;
  try {
    configured = licenseClient();
  } catch {
    return {
      status: "configuration_error",
      machineId: await getMachineId().catch(() => null),
      message:
        "The licensing public key is missing or invalid. Contact the application provider.",
    };
  }
  try {
    return await configured.status();
  } catch {
    return {
      status: "invalid_license",
      machineId: await getMachineId().catch(() => null),
      message:
        "The saved license could not be verified. Enter a valid offline license key.",
    };
  }
}
export const licenseRouter = Router();
licenseRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
licenseRouter.get("/status", async (_req, res) => res.json(await status()));
licenseRouter.post("/activate", async (req, res) => {
  try {
    if (typeof req.body?.key !== "string" || req.body.key.length > 16000)
      return res.status(400).json({ error: "Enter a valid activation key" });
    const result = await licenseClient().activate(req.body.key.trim());
    res.status(result.status === "active" ? 200 : 403).json(result);
  } catch {
    res.status(400).json({
      error:
        "Activation failed. Check that the offline key was issued for this machine ID and publisher.",
    });
  }
});
licenseRouter.delete("/", async (_req, res) => {
  try {
    if (development()) return res.json(await status());
    licenseClient().deactivate();
    res.json(await status());
  } catch {
    res.status(400).json({ error: "Could not remove the license key." });
  }
});
export async function requireLicense(_req, res, next) {
  const license = await status();
  if (["active", "development"].includes(license.status)) return next();
  res.status(402).json({
    error: license.message || "An active license is required",
    code: "LICENSE_REQUIRED",
    license,
  });
}
// Guards a module that is sold separately, for example the cellular IBS/DAS
// add-on. Wi-Fi routes never use it, so they are not affected.
export function requireFeature(name) {
  return async (_req, res, next) => {
    const license = await status();
    if (
      ["active", "development"].includes(license.status) &&
      featureAllowed(license, name)
    )
      return next();
    res.status(403).json({
      error: `The ${name} module is not included in your license.`,
      code: "FEATURE_NOT_LICENSED",
      feature: name,
    });
  };
}
export function closeLicensing() {
  client?.close();
  client = undefined;
}
