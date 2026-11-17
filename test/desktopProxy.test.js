import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  desktopSimulationProxy,
  simulationRoutes,
} from "../server/desktopProxy.js";

test("desktop proxy streams binary uploads and JSON to Rust before body parsing", async () => {
  const upstream = http
    .createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(req.url.includes("locked") ? 402 : 200, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          path: req.url,
          method: req.method,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("base64"),
        }),
      );
    })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => upstream.once("listening", resolve));
  process.env.SIM_PORT = String(upstream.address().port);
  const app = express();
  app.use(simulationRoutes, desktopSimulationProxy);
  app.use(express.json());
  const local = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => local.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${local.address().port}`;
    for (const [route, type, body] of [
      ["/api/scenes?name=test", "application/zip", Buffer.from([0, 255, 1, 0])],
      [
        "/api/simulations",
        "application/json",
        Buffer.from('{"sceneId":"test"}'),
      ],
    ]) {
      const result = await (
        await fetch(base + route, {
          method: "POST",
          headers: { "Content-Type": type },
          body,
        })
      ).json();
      assert.equal(result.path, route);
      assert.equal(result.contentType, type);
      assert.equal(result.body, body.toString("base64"));
    }
    assert.equal((await fetch(base + "/api/cache/locked")).status, 402);
  } finally {
    await new Promise((resolve) => local.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    delete process.env.SIM_PORT;
  }
});
