import crypto from "node:crypto";
import { projectStore } from "../repositories/projectRepository.js";
import { validPlan } from "../repositories/projectStore.js";

export const isValidPlan = validPlan;
export const isValidProjectInput = (input) =>
  Boolean(String(input?.name || "").trim() && isValidPlan(input?.plan));

export async function listProjects() {
  return projectStore().list();
}

export async function getProject(id) {
  return projectStore().get(id);
}

export async function createProject({ name, plan }) {
  const now = new Date().toISOString();
  return projectStore().create({
    id: crypto.randomUUID(),
    name: name.trim(),
    plan,
    createdAt: now,
    updatedAt: now,
  });
}

export async function saveProject(id, { name, plan }) {
  return projectStore().save(id, {
    name: name.trim(),
    plan,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteProject(id) {
  return projectStore().delete(id);
}
