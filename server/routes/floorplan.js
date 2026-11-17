import { Router } from "express";
import {
  cleanOldJobs,
  createUpload,
  jobFile,
  jobStatus,
  removeJob,
  startJob,
} from "../services/floorplanService.js";

export const floorplanRouter = Router();
cleanOldJobs().catch(() => {});

const fail = (res, error) =>
  res
    .status(error.status || 500)
    .json({ error: error.message || "Floor-plan service error" });

// 1. upload the image or PDF; the reply carries a preview for scale calibration
floorplanRouter.post("/uploads", async (req, res) => {
  try {
    res.json(await createUpload(req.body || {}));
  } catch (error) {
    fail(res, error);
  }
});

// 2. start reconstruction with the chosen scale and options
floorplanRouter.post("/jobs/:id/run", async (req, res) => {
  try {
    res.json(await startJob(req.params.id, req.body || {}));
  } catch (error) {
    fail(res, error);
  }
});

floorplanRouter.get("/jobs/:id", async (req, res) => {
  try {
    res.json(await jobStatus(req.params.id));
  } catch (error) {
    fail(res, error);
  }
});

floorplanRouter.get("/jobs/:id/files/:name", (req, res) => {
  const file = jobFile(req.params.id, req.params.name);
  return file
    ? res.sendFile(file)
    : res.status(404).json({ error: "File not found" });
});

floorplanRouter.delete("/jobs/:id", async (req, res) => {
  res.json({ removed: await removeJob(req.params.id) });
});
