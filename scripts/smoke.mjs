import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { mkdir, writeFile, rm } from "node:fs/promises";

const base = process.env.API_URL || "http://127.0.0.1:3001";
const call = async (path, method = "GET", body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
await call("/api/health");
const item = await call("/api/projects", "POST", {
  name: "Smoke test project",
  plan: initialPlan(),
});
try {
  const room = {
    id: "test-room",
    floorId: "level-1",
    name: "Office",
    shape: "rectangle",
    x: 1,
    z: 2,
    width: 8,
    depth: 6,
    height: 3,
    material: "brick",
  };
  const plan = {
    ...item.plan,
    floors: [
      ...item.plan.floors,
      { id: "level-2", name: "Level 2", elevation: 3.2 },
    ],
    rooms: [room],
    doors: [
      {
        id: "d",
        floorId: "level-1",
        roomId: "test-room",
        wallSide: "north",
        offset: 2,
        width: 1,
        height: 2,
      },
    ],
    windows: [
      {
        id: "w",
        floorId: "level-1",
        roomId: "test-room",
        wallSide: "east",
        offset: 2,
        width: 1,
        height: 1,
        sillHeight: 1,
      },
    ],
    interiorWalls: [
      {
        id: "iw",
        floorId: "level-1",
        x1: 2,
        z1: 2,
        x2: 4,
        z2: 2,
        material: "concrete",
      },
    ],
    furniture: [
      {
        id: "desk",
        floorId: "level-1",
        x: 2,
        z: 2,
        width: 1,
        depth: 0.6,
        height: 0.8,
      },
    ],
    sources: [
      {
        id: "test-ap",
        floorId: "level-1",
        kind: "wifi",
        name: "AP",
        x: 3,
        z: 4,
        txPowerDbm: 20,
        freqMHz: 2400,
      },
    ],
    logs: [{ id: "test-log", floorId: "level-1", x: 2, z: 3, rsrp: -82 }],
    rf: { ...item.plan.rf, doorLossDb: 5 },
    images: {
      "level-1": { url: "data:image/png;base64,AA==", widthM: 20, heightM: 10 },
    },
    sessionIds: ["smoke"],
    alignment: { lat: 28.6, lng: 77.2, x: 0, z: 0, rotationDeg: 0, unit: "m" },
  };
  await call(`/api/projects/${item.id}`, "PUT", {
    name: "Updated smoke project",
    plan,
  });
  const fetched = await call(`/api/projects/${item.id}`);
  assert.deepEqual(fetched.plan, plan);
  assert.equal(fetched.name, "Updated smoke project");
  assert.ok(
    (await call("/api/projects")).some(
      (p) => p.id === item.id && p.roomCount === 1,
    ),
  );
  const sessionFile = new URL("../data/sessions/smoke.csv", import.meta.url);
  await mkdir(new URL("../data/sessions/", import.meta.url), {
    recursive: true,
  });
  await writeFile(sessionFile, "x,z,RSRP\n2,3,-82");
  try {
    assert.ok((await call("/api/sessions")).some((s) => s.id === "smoke"));
    assert.match((await call("/api/sessions/smoke")).data, /RSRP/);
  } finally {
    await rm(sessionFile);
  }
  console.log(
    "API project create, update, list, reload, and full-plan persistence: passed",
  );
} finally {
  await call(`/api/projects/${item.id}`, "DELETE");
}
