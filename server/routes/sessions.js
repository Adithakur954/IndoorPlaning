import { Router } from "express";
import { getSession, listSessions } from "../services/sessionService.js";

export const sessionRouter = Router();

sessionRouter.get("/", async (_req, res) => res.json(await listSessions()));
sessionRouter.get("/:id", async (req, res) => {
  const result = await getSession(req.params.id);
  return result.error
    ? res.status(result.status).json({ error: result.error })
    : res.json(result);
});
