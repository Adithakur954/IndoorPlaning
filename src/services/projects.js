import { api } from "./api.js";

export const listProjects = () => api("/projects");
export const getProject = (id) => api(`/projects/${id}`);
export const createProject = (name, plan) =>
  api("/projects", { method: "POST", body: JSON.stringify({ name, plan }) });
export const saveProject = (id, name, plan) =>
  api(`/projects/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name, plan }),
  });
export const deleteProject = (id) =>
  api(`/projects/${id}`, { method: "DELETE" });
