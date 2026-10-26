import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { distDir } from "./config/paths.js";
import { projectRouter } from "./routes/projects.js";
import { sessionRouter } from "./routes/sessions.js";
import { floorTraceRouter } from "./routes/floorTrace.js";

export const app = express();
app.use(express.json({ limit: "120mb" }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/projects", projectRouter);
app.use("/api/sessions", sessionRouter);
app.use("/api/floor-image", floorTraceRouter);
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
  console.error(error);
  res.status(500).json({ error: "Server error" });
});
