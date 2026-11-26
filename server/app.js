import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { distDir } from "./config/paths.js";
import { projectRouter } from "./routes/projects.js";
import { sessionRouter } from "./routes/sessions.js";
import { floorplanRouter } from "./routes/floorplan.js";
import {
  licenseRouter,
  requireFeature,
  requireLicense,
} from "./licensing/index.js";
import { desktopSimulationProxy, simulationRoutes } from "./desktopProxy.js";

export const app = express();
app.use(simulationRoutes, desktopSimulationProxy);
// The cellular module is sold separately: checked here and again by the service.
app.use("/api/cellular", requireFeature("cellular"), desktopSimulationProxy);
app.use(express.json({ limit: "120mb" }));
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "indoor-planner-api", licenseRequired: true }),
);
app.use("/api/license", licenseRouter);
app.use("/api", requireLicense);
app.use("/api/projects", projectRouter);
app.use("/api/sessions", sessionRouter);
app.use("/api/floorplan", floorplanRouter);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found" }),
);

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("/{*splat}", (_req, res) =>
    res.sendFile(path.join(distDir, "index.html")),
  );
}

app.use((error, _req, res, _next) => {
  // The browser closed the connection mid-upload (reload, navigation, a newer
  // autosave): nobody is left to answer, and it is not a server fault.
  if (error.type === "request.aborted" || error.code === "ECONNABORTED") return;
  console.error(error);
  res.status(500).json({ error: "Server error" });
});
