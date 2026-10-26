import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { sessionsDir } from "../config/paths.js";

const sessionFilePattern = /^(?!\.)[\w-]+\.(json|csv)$/i;

export async function listSessions() {
  const names = await readdir(sessionsDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .filter((name) => sessionFilePattern.test(name))
    .map((name) => ({ id: name.replace(/\.(json|csv)$/i, "") }));
}

export async function getSession(id) {
  if (!/^[\w-]+$/.test(id)) return { error: "Invalid session ID", status: 400 };
  const base = path.join(sessionsDir, id);
  if (existsSync(`${base}.json`))
    return {
      type: "json",
      data: JSON.parse(await readFile(`${base}.json`, "utf8")),
    };
  if (existsSync(`${base}.csv`))
    return { type: "csv", data: await readFile(`${base}.csv`, "utf8") };
  return { error: "Session data source not found", status: 404 };
}
