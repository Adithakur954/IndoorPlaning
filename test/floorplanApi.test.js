import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "../server/app.js";
import { rootDir } from "../server/config/paths.js";

const sample = path.join(rootDir, "worker", "samples", "floorplan", "office_clean.png");
process.env.INDOOR_LICENSE_MODE = "development";
const python = path.join(rootDir, "worker", ".venv");

test(
  "floor-plan API: upload, calibrate, reconstruct in the background, fetch the overlay",
  { skip: !existsSync(sample) || !existsSync(python) },
  async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/floorplan`;
    const post = (url, body) =>
      fetch(base + url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const bad = await post("/uploads", { name: "plan.exe", dataBase64: "AAAA" });
      assert.equal(bad.status, 400);

      const up = await (
        await post("/uploads", {
          name: "office_clean.png",
          dataBase64: (await readFile(sample)).toString("base64"),
        })
      ).json();
      assert.match(up.id, /^[0-9a-f]{24}$/);
      assert.equal(up.originalWidth, 1840);

      const started = await post(`/jobs/${up.id}/run`, {
        scale: { pxPerM: 40 },
        options: { ocr: false },
      });
      assert.equal(started.status, 200);
      let status;
      for (let i = 0; i < 90; i += 1) {
        status = await (await fetch(`${base}/jobs/${up.id}`)).json();
        if (status.status === "done" || status.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(status.status, "done", status.error);
      assert.equal(status.result.walls.length, 12);
      assert.equal(status.result.rooms.length, 9);
      const overlay = await fetch(`${base}/jobs/${up.id}/files/overlay.png`);
      assert.equal(overlay.status, 200);
      assert.equal(overlay.headers.get("content-type"), "image/png");
      assert.equal((await fetch(`${base}/jobs/${up.id}/files/secret.txt`)).status, 404);
      assert.equal((await fetch(`${base}/jobs/not-an-id`)).status, 404);
      const removed = await fetch(`${base}/jobs/${up.id}`, { method: "DELETE" });
      assert.equal((await removed.json()).removed, true);
    } finally {
      server.close();
    }
  },
);
