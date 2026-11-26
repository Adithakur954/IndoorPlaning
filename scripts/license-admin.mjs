import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FEATURES,
  PRODUCT,
  signEnvelope,
  validateGrant,
} from "../licensing/protocol.js";

const [command, ...args] = process.argv.slice(2);
const options = Object.fromEntries(
  args.reduce((entries, value, i) => {
    if (i % 2 === 0) entries.push([value.replace(/^--/, ""), args[i + 1]]);
    return entries;
  }, []),
);
if (command === "init" && options.dir) {
  mkdirSync(options.dir, { recursive: true });
  if (
    ["private.pem", "public.key"].some((name) =>
      existsSync(path.join(options.dir, name)),
    )
  ) {
    throw new Error(
      "Publisher keys already exist in this directory; choose an empty directory",
    );
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // Never overwrite an existing publisher identity.
  writeFileSync(
    path.join(options.dir, "private.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(options.dir, "public.key"),
    publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url"),
    { flag: "wx" },
  );
  console.log(
    "Created private.pem and public.key. Distribute only public.key.",
  );
} else if (command === "issue" && options.private && options.out) {
  const features = String(options.features || "wifi")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = features.filter((name) => !FEATURES.includes(name));
  if (unknown.length || !features.length)
    throw new Error(
      `--features must be a comma list of: ${FEATURES.join(", ")} (got: ${unknown.join(", ") || "nothing"})`,
    );
  const grant = validateGrant({
    product: PRODUCT,
    version: 2,
    licenseId: randomUUID(),
    machineIdHash: String(options["machine-id"] || options.machine || "")
      .trim()
      .toUpperCase(),
    durationDays: Number(options.days),
    features,
  });
  writeFileSync(
    options.out,
    signEnvelope("IP2", grant, readFileSync(options.private, "utf8")),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Created ${grant.durationDays}-day offline key (${features.join(", ")}) at ${options.out}. Expiry uses the activating computer's date starting at first activation.`,
  );
} else {
  console.error(
    "Usage:\n  node scripts/license-admin.mjs init --dir <private-directory>\n  node scripts/license-admin.mjs issue --private <private.pem> --machine-id <hashed-machine-id> --days <30> [--features wifi,cellular] --out <customer.license>",
  );
  process.exitCode = 1;
}
