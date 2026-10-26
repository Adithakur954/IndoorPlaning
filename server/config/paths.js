import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const dataDir = path.join(rootDir, "data");
export const projectsFile = path.join(dataDir, "projects.json");
export const sessionsDir = path.join(dataDir, "sessions");
export const distDir = path.join(rootDir, "dist");
