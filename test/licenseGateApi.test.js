import test from "node:test";
import assert from "node:assert/strict";

test("unconfigured production API blocks project and import access while activation and health remain available", async () => {
  delete process.env.INDOOR_LICENSE_MODE;
  delete process.env.LICENSE_PUBLIC_KEY_FILE;
  delete process.env.LICENSE_SERVER_URL;
  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + "/api/health")).status, 200);
    const status = await (await fetch(base + "/api/license/status")).json();
    assert.equal(status.status, "configuration_error");
    for (const route of [
      "/api/projects",
      "/api/sessions",
      "/api/floorplan/jobs/example",
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 402);
      assert.equal((await response.json()).code, "LICENSE_REQUIRED");
    }
    const activation = await fetch(base + "/api/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "invalid" }),
    });
    assert.equal(activation.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
