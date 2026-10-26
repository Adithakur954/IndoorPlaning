import crypto from "node:crypto";
import {
  changeProjects,
  readProjects,
} from "../repositories/projectRepository.js";

export const isValidPlan = (plan) =>
  Boolean(
    plan &&
    typeof plan === "object" &&
    !Array.isArray(plan) &&
    Array.isArray(plan.floors) &&
    Array.isArray(plan.rooms),
  );
export const isValidProjectInput = (input) =>
  Boolean(String(input?.name || "").trim() && isValidPlan(input?.plan));
const summary = ({ plan, ...details }) => ({
  ...details,
  floorCount: plan.floors.length,
  roomCount: plan.rooms.length,
});

export async function listProjects() {
  return (await readProjects())
    .map(summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id) {
  return (await readProjects()).find((item) => item.id === id) || null;
}

export async function createProject({ name, plan }) {
  const now = new Date().toISOString();
  return changeProjects((projects) => {
    const item = {
      id: crypto.randomUUID(),
      name: name.trim(),
      plan,
      createdAt: now,
      updatedAt: now,
    };
    projects.push(item);
    return item;
  });
}

export async function saveProject(id, { name, plan }) {
  return changeProjects((projects) => {
    const item = projects.find((project) => project.id === id);
    if (!item) return null;
    Object.assign(item, {
      name: name.trim(),
      plan,
      updatedAt: new Date().toISOString(),
    });
    return item;
  });
}

export async function deleteProject(id) {
  return changeProjects((projects) => {
    const index = projects.findIndex((project) => project.id === id);
    if (index < 0) return false;
    projects.splice(index, 1);
    return true;
  });
}
