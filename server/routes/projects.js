import { Router } from "express";
import {
  createProject,
  deleteProject,
  getProject,
  isValidProjectInput,
  listProjects,
  saveProject,
} from "../services/projectService.js";

export const projectRouter = Router();

projectRouter.get("/", async (_req, res) => res.json(await listProjects()));
projectRouter.get("/:id", async (req, res) => {
  const project = await getProject(req.params.id);
  return project
    ? res.json(project)
    : res.status(404).json({ error: "Project not found" });
});
projectRouter.post("/", async (req, res) => {
  if (!isValidProjectInput(req.body))
    return res
      .status(400)
      .json({ error: "Name and a valid plan are required" });
  return res.status(201).json(await createProject(req.body));
});
projectRouter.put("/:id", async (req, res) => {
  if (!isValidProjectInput(req.body))
    return res
      .status(400)
      .json({ error: "Name and a valid plan are required" });
  const project = await saveProject(req.params.id, req.body);
  return project
    ? res.json(project)
    : res.status(404).json({ error: "Project not found" });
});
projectRouter.delete("/:id", async (req, res) => {
  const deleted = await deleteProject(req.params.id);
  return res.status(deleted ? 204 : 404).end();
});
