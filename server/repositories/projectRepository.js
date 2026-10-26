import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dataDir, projectsFile } from "../config/paths.js";

let writeQueue = Promise.resolve();

export async function readProjects() {
  try {
    const data = JSON.parse(await readFile(projectsFile, "utf8"));
    return Array.isArray(data.projects) ? data.projects : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function changeProjects(update) {
  const operation = writeQueue.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const projects = await readProjects();
    const result = update(projects);
    const tempFile = `${projectsFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify({ projects }), "utf8");
    await rename(tempFile, projectsFile);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
