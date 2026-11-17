import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../src/models/plan.js";
import { buildSceneFiles, writePly } from "../src/utils/sceneExport.js";
import { wallPieces } from "../src/utils/wallPieces.js";

const room = (over) => ({
  id: "r1",
  floorId: "level-1",
  name: "R1",
  shape: "rectangle",
  x: 0,
  z: 0,
  width: 10,
  depth: 6,
  height: 3,
  material: "concrete",
  ...over,
});

const plan = () => ({
  ...initialPlan(),
  floors: [
    { id: "level-1", name: "Level 1", elevation: 0 },
    { id: "level-2", name: "Level 2", elevation: 3.2 },
  ],
  rooms: [room({}), room({ id: "r2", floorId: "level-2", name: "R2" })],
  doors: [
    {
      id: "d1",
      floorId: "level-1",
      roomId: "r1",
      wallSide: "north",
      offset: 2,
      width: 1,
      height: 2,
    },
  ],
  windows: [
    {
      id: "w1",
      floorId: "level-1",
      roomId: "r1",
      wallSide: "east",
      offset: 1,
      width: 2,
      height: 1.2,
      sillHeight: 1,
    },
  ],
  sources: [
    {
      id: "ap1",
      floorId: "level-2",
      kind: "wifi",
      name: "AP",
      x: 5,
      z: 3,
      heightM: 2.7,
      txPowerDbm: 20,
      freqMHz: 5000,
    },
  ],
});

test("wall pieces leave the door and window openings open", () => {
  const p = plan();
  const north = wallPieces({
    length: 10,
    side: "north",
    room: room({}),
    doors: p.doors,
    windows: p.windows,
  });
  assert.equal(north.openings.length, 1);
  assert.ok(
    !north.pieces.some(
      (x) => x.from < 3 && x.to > 2 && x.bottom === 0 && x.top === 3,
    ),
  );
  const east = wallPieces({
    length: 6,
    side: "east",
    room: room({}),
    doors: p.doors,
    windows: p.windows,
  });
  assert.deepEqual(east.pieces.map((x) => x.key).sort(), [
    "above-w1",
    "after",
    "before-w1",
    "below-w1",
  ]);
});

test("scene export builds meshes, xml, config and a stable hash", async () => {
  const a = await buildSceneFiles(plan());
  const b = await buildSceneFiles(plan());
  assert.equal(a.config.contentSha256, b.config.contentSha256);
  assert.ok(a.files["scene.xml"].includes('id="mat-itu_concrete"'));
  assert.ok(a.config.meshes.every((m) => m.triangles > 0));
  assert.ok(a.files[a.config.meshes[0].file] instanceof Uint8Array);
  // Z-up: floor 2 slab sits at z = 3.2; AP at 3.2 + 2.7
  assert.equal(a.config.accessPoints[0].position[2], 3.2 + 2.7);
  assert.equal(a.config.accessPoints[0].position[1], -3);
  // only the top floor gets a ceiling
  assert.equal(a.config.meshes.filter((m) => m.role === "ceiling").length, 1);
  const none = await buildSceneFiles({ ...plan(), sources: [] });
  assert.ok(none.warnings.some((w) => /No access points/.test(w)));
});

test("scene export rejects invalid geometry and reports overlaps", async () => {
  await assert.rejects(
    buildSceneFiles({ ...plan(), rooms: [room({ width: 0 })] }),
    /invalid or zero-area/,
  );
  await assert.rejects(buildSceneFiles({ ...initialPlan() }), /no rooms/);
  const overlapping = {
    ...plan(),
    rooms: [room({}), room({ id: "r3", name: "R3", x: 5 })],
  };
  const out = await buildSceneFiles(overlapping);
  assert.ok(out.warnings.some((w) => /overlaps/.test(w)));
});

test("PLY writer produces a valid binary header and size", () => {
  const ply = writePly({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  });
  const text = new TextDecoder().decode(ply.slice(0, 300));
  assert.ok(text.startsWith("ply\nformat binary_little_endian 1.0"));
  const headerLength = text.indexOf("end_header\n") + 11;
  assert.equal(ply.length, headerLength + 36 + 13);
});

test("a door on a wall shared by two rooms is kept", async () => {
  const p = {
    ...initialPlan(),
    rooms: [room({}), room({ id: "r2", name: "R2", x: 10 })],
    // r2's west wall is the same wall as r1's east wall
    doors: [
      {
        id: "dw",
        floorId: "level-1",
        roomId: "r2",
        wallSide: "west",
        offset: 2,
        width: 1,
        height: 2,
      },
    ],
  };
  const out = await buildSceneFiles(p);
  assert.equal(out.config.stats.sharedEdges, 1);
  assert.equal(out.config.meshes.filter((m) => m.role === "door").length, 1);
  assert.ok(
    !out.warnings.some((w) =>
      /openings on that wall were not exported/.test(w),
    ),
  );
});

test("a building boundary adds exterior walls and one slab, and keeps doors on it", async () => {
  const p = {
    ...initialPlan(),
    // two rooms flush with the boundary's long sides, hall in between is not a room
    rooms: [
      room({ id: "a", name: "A", x: 0, z: 0, width: 6, depth: 8 }),
      room({ id: "b", name: "B", x: 14, z: 0, width: 6, depth: 8 }),
    ],
    boundaries: [
      {
        id: "bd",
        floorId: "level-1",
        name: "Building boundary",
        height: 3,
        material: "brick",
        points: [
          { x: 0, z: 0 },
          { x: 20, z: 0 },
          { x: 20, z: 8 },
          { x: 0, z: 8 },
        ],
      },
    ],
    // door on room A's north wall, which lies on the boundary's north wall
    doors: [
      {
        id: "d",
        floorId: "level-1",
        roomId: "a",
        wallSide: "north",
        offset: 2,
        width: 1,
        height: 2,
      },
    ],
  };
  const out = await buildSceneFiles(p);
  const roles = out.config.meshes.map((m) => m.role);
  assert.ok(roles.includes("exterior-wall"));
  assert.ok(roles.includes("door"), "door on the boundary wall is kept");
  const exterior = out.config.meshes.find((m) => m.role === "exterior-wall");
  assert.equal(exterior.planMaterial, "brick");
  // the slab covers the whole 20 x 8 footprint once (2 triangles), not per room
  const slab = out.config.meshes.find((m) => m.role === "slab");
  assert.equal(slab.triangles, 2);
  // the room walls on the boundary are not exported a second time
  assert.ok(!out.warnings.some((w) => /outside the building boundary/.test(w)));
  // radio plane spans the boundary
  assert.deepEqual(out.config.floors[0].radioMapPlane.size, [20, 8]);
});

test("rooms outside the boundary warn and a bad boundary is rejected", async () => {
  const boundary = (points) => ({
    id: "bd",
    floorId: "level-1",
    name: "B",
    height: 3,
    material: "concrete",
    points,
  });
  const square = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 4 },
    { x: 0, z: 4 },
  ];
  const away = {
    ...initialPlan(),
    rooms: [room({ x: 30, z: 30, width: 4, depth: 4 })],
    boundaries: [boundary(square)],
  };
  const out = await buildSceneFiles(away);
  assert.ok(out.warnings.some((w) => /outside the building boundary/.test(w)));
  await assert.rejects(
    buildSceneFiles({
      ...initialPlan(),
      rooms: [room({})],
      boundaries: [boundary(square.slice(0, 2))],
    }),
    /boundary/i,
  );
});

test("rooms nested in a building-sized room: no overlap warning, one floor, shared walls merged", async () => {
  // the layout that used to report "Room 1 overlaps Room 2/3/4"
  const r = (id, x, z, w, d) =>
    room({ id, name: id, x, z, width: w, depth: d });
  const p = {
    ...initialPlan(),
    rooms: [
      r("Room 1", 0, 0, 5.76, 26.47),
      r("Room 2", 1.2, 0, 4.56, 8.22),
      r("Room 3", 3.5, 5.3, 2.25, 2.95),
      r("Room 4", 1.2, 5.3, 2.25, 2.95),
    ],
  };
  const out = await buildSceneFiles(p);
  assert.ok(
    !out.warnings.some((w) => /overlaps/.test(w)),
    out.warnings.join("; "),
  );
  const slab = out.config.meshes.find((m) => m.role === "slab");
  assert.equal(slab.triangles, 2, "only the outer room has a floor");
  assert.ok(out.config.stats.sharedEdges > 0);
  assert.ok(!out.warnings.some((w) => /different materials/.test(w)));
});

test("side-by-side rooms export one wall between them", async () => {
  const one = await buildSceneFiles({
    ...initialPlan(),
    rooms: [room({ id: "a", name: "A", width: 5 })],
  });
  const two = await buildSceneFiles({
    ...initialPlan(),
    rooms: [
      room({ id: "a", name: "A", width: 5 }),
      room({ id: "b", name: "B", x: 5, width: 5 }),
    ],
  });
  const triangles = (o) =>
    o.config.meshes
      .filter((m) => /wall/.test(m.role))
      .reduce((s, m) => s + m.triangles, 0);
  // 4 walls of 5 x 6 m become 7 walls: 6 sides + one shared (not 8)
  assert.equal(triangles(one), 4 * 2);
  assert.equal(triangles(two), 7 * 2);
});
