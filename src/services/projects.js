import { api } from "./api.js";
import { cleanupResults } from "./maintenance.js";

export const listProjects = () => api("/projects");
export const getProject = (id) => api(`/projects/${id}`);
export const createProject = (name, plan) =>
  api("/projects", { method: "POST", body: JSON.stringify({ name, plan }) });
// baseUpdatedAt: the version this window loaded or last saved; a newer stored
// version (another window, an import) makes the save fail with status 409.
export const saveProject = (id, name, plan, baseUpdatedAt) =>
  api(`/projects/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name, plan, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) }),
  });
export const deleteProject = async (id) => {
  const result = await api(`/projects/${id}`, { method: "DELETE" });
  // its saved simulation results are no longer referenced; ignore if the
  // simulation service is not running (it also cleans up when it starts)
  cleanupResults().catch(() => {});
  return result;
};
