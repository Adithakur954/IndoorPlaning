import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const dataDir = process.env.INDOOR_DATA_DIR
  ? path.resolve(process.env.INDOOR_DATA_DIR)
  : path.join(rootDir, "data");
export const projectsFile = path.join(dataDir, "projects.json");
export const projectsDatabaseFile = path.join(dataDir, "projects.sqlite");
export const sessionsDir = path.join(dataDir, "sessions");
export const distDir = path.join(rootDir, "dist");
