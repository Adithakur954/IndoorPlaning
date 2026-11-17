import http from "node:http";

export const simulationRoutes = [
  "/api/scenes",
  "/api/simulations",
  "/api/optimizations",
  "/api/jobs",
  "/api/model-version",
  "/api/cache",
  "/api/maintenance",
];
// Installed UI and APIs share one loopback origin. Preserve streaming uploads.
export function desktopSimulationProxy(req, res, next) {
  const port = Number(process.env.SIM_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return next();
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.originalUrl,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed)
      res.status(503).json({ error: "The simulation service is unavailable" });
  });
  req.once("aborted", () => upstream.destroy());
  res.once("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}
