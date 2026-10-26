import { Router } from "express";
import { traceFloorImage } from "../services/floorTrace.js";

export const floorTraceRouter = Router();
floorTraceRouter.post("/trace", async (req, res) => {
  try {
    res.json(await traceFloorImage(req.body || {}));
  } catch (error) {
    res
      .status(error.status || 502)
      .json({ error: error.message || "AI tracing failed" });
  }
});
