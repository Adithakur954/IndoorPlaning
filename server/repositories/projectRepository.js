import { projectsDatabaseFile, projectsFile } from "../config/paths.js";
import { openProjectStore } from "./projectStore.js";

let store;
export function projectStore() {
  return (store ??= openProjectStore({
    databaseFile: projectsDatabaseFile,
    legacyFile: projectsFile,
  }));
}
