// Candidate access-point mounting positions on real surfaces (walls and
// ceilings) of one floor, with the reason for every rejected position.
import { bbox, boundaryAreas, inside, pointsOf } from "./geometry.js";
import { wallOpenings, looseWallOpenings } from "./wallPieces.js";

export const DEFAULT_CANDIDATE_OPTIONS = {
  mounting: ["wall"], // "wall" and/or "ceiling"
  wallSpacingM: 1.5,
  wallHeightM: 2.5, // above the floor
  ceilingSpacingM: 3,
  ceilingDropM: 0.05, // below the ceiling
  cornerClearanceM: 0.5,
  openingClearanceM: 0.5,
  wallOffsetM: 0.15, // AP centre away from the wall, into the room
  furnitureClearanceM: 0.3,
  minSeparationM: 0.75,
};

export const REJECTION_REASONS = {
  corner: "too close to a corner",
  opening: "in or next to a door or window",
  lowWall: "wall is lower than the mounting height",
  excludedRoom: "room is excluded from AP mounting",
  excludedWall: "wall is marked not mountable",
  furniture: "blocked by furniture",
  outside: "outside the building (or in a room standing apart from it)",
  wallClearance: "too close to a wall for ceiling mounting",
};

const SIDES = ["north", "east", "south", "west"];

const distToSegment = (p, a, b) => {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    len2 = dx * dx + dz * dz;
  const t = len2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

const round = (v) => Math.round(v * 100) / 100;

const polygonArea = (shape) => {
  const pts = pointsOf(shape);
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  });
  return Math.abs(a) / 2;
};

// The building an AP may be mounted in (what Hamina calls the in-scope zone). With a drawn building outline,
// that outline. Without one, the rooms joined to the largest room (an imported plan's "Floor" and everything
// touching it), plus any other group of joined rooms at least a tenth of its size (a separate wing). A small
// room standing on its own (a mark on the road or the site that the import read as a room) is outside: no
// position is offered there. Returns { areas, outsideRoomIds }.
export function buildingScope(plan, floorId, touchM = 1.0) {
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const outlines = boundaryAreas(plan, floorId);
  if (outlines.length) {
    const inOutline = (r) => {
      const b = bbox(r);
      return outlines.some((o) => inside((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, o));
    };
    return { areas: outlines, outsideRoomIds: new Set(rooms.filter((r) => !inOutline(r)).map((r) => r.id)) };
  }
  if (!rooms.length) return { areas: [], outsideRoomIds: new Set() };
  const boxes = rooms.map((r) => bbox(r));
  const near = (i, j) =>
    boxes[i].minX - touchM <= boxes[j].maxX &&
    boxes[j].minX - touchM <= boxes[i].maxX &&
    boxes[i].minZ - touchM <= boxes[j].maxZ &&
    boxes[j].minZ - touchM <= boxes[i].maxZ;
  // groups of rooms that touch each other
  const group = rooms.map(() => -1);
  let groups = 0;
  for (let i = 0; i < rooms.length; i++) {
    if (group[i] >= 0) continue;
    const stack = [i];
    group[i] = groups;
    while (stack.length) {
      const a = stack.pop();
      for (let j = 0; j < rooms.length; j++)
        if (group[j] < 0 && near(a, j)) {
          group[j] = groups;
          stack.push(j);
        }
    }
    groups += 1;
  }
  const size = Array(groups).fill(0);
  rooms.forEach((r, i) => (size[group[i]] += polygonArea(r)));
  const biggest = Math.max(...size);
  const keepGroup = size.map((a) => a >= 0.1 * biggest);
  return {
    areas: rooms.filter((_, i) => keepGroup[group[i]]),
    outsideRoomIds: new Set(rooms.filter((_, i) => !keepGroup[group[i]]).map((r) => r.id)),
  };
}

export function generateCandidates(plan, floorId, userOptions = {}) {
  const o = { ...DEFAULT_CANDIDATE_OPTIONS, ...userOptions };
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const outlines = boundaryAreas(plan, floorId);
  // only inside the building: rooms standing apart from it are not offered (see buildingScope)
  const scope = buildingScope(plan, floorId);
  const areas = scope.areas.length ? scope.areas : [...rooms, ...outlines];
  const doors = plan.doors.filter((d) => d.floorId === floorId);
  const windows = plan.windows.filter((w) => w.floorId === floorId);
  const furniture = plan.furniture.filter((f) => f.floorId === floorId);
  const valid = [],
    rejected = [];
  const roomAt = (x, z) => rooms.find((r) => inside(x, z, r));
  const insideBuilding = (x, z) => areas.some((a) => inside(x, z, a));
  const reject = (c, reason) => rejected.push({ ...c, reason });
  const blockedByFurniture = (x, z) =>
    furniture.some(
      (f) =>
        x >= +f.x - o.furnitureClearanceM &&
        x <= +f.x + +f.width + o.furnitureClearanceM &&
        z >= +f.z - o.furnitureClearanceM &&
        z <= +f.z + +f.depth + o.furnitureClearanceM,
    );

  // World-space door/window segments of every rectangular room wall, so that
  // a candidate on either side of a shared wall sees the opening.
  const openingSegments = [];
  for (const room of rooms) {
    const pts = pointsOf(room);
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length],
        length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.015) return;
      for (const op of wallOpenings({
        length,
        side: room.shape === "rectangle" ? SIDES[i] : "",
        edgeIndex: i,
        room,
        doors,
        windows,
      })) {
        const at = (d) => ({
          x: a.x + ((b.x - a.x) * d) / length,
          z: a.z + ((b.z - a.z) * d) / length,
        });
        openingSegments.push({ a: at(op.start), b: at(op.end) });
      }
    });
  }
  for (const w of plan.interiorWalls.filter((x) => x.floorId === floorId)) {
    const length = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    if (length < 0.015) continue;
    for (const op of looseWallOpenings(w, doors, windows)) {
      const at = (d) => ({
        x: +w.x1 + ((w.x2 - w.x1) * d) / length,
        z: +w.z1 + ((w.z2 - w.z1) * d) / length,
      });
      openingSegments.push({ a: at(op.start), b: at(op.end) });
    }
  }

  const roomOk = (room) => room?.apMounting !== "excluded";
  const roomInScope = (room) => !room || !scope.outsideRoomIds.has(room.id);

  // ---- wall surfaces ------------------------------------------------------
  const surfaces = [];
  for (const room of rooms)
    pointsOf(room).forEach((a, i, pts) =>
      surfaces.push({
        a,
        b: pts[(i + 1) % pts.length],
        owner: room,
        side: room.shape === "rectangle" ? SIDES[i] : "",
        both: false,
        wallHeight: Number(room.height) || 3,
      }),
    );
  for (const outline of outlines)
    pointsOf(outline).forEach((a, i, pts) =>
      surfaces.push({
        a,
        b: pts[(i + 1) % pts.length],
        owner: null,
        side: "",
        both: false,
        wallHeight: Number(outline.height) || 3,
      }),
    );
  for (const w of plan.interiorWalls.filter((w) => w.floorId === floorId))
    surfaces.push({
      a: { x: +w.x1, z: +w.z1 },
      b: { x: +w.x2, z: +w.z2 },
      owner: null,
      side: "",
      both: true,
      wallHeight: Number(w.height) || 3,
    });

  if (o.mounting.includes("wall"))
    for (const s of surfaces) {
      const length = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
      if (length < 0.05) continue;
      const dir = { x: (s.b.x - s.a.x) / length, z: (s.b.z - s.a.z) / length };
      const normals = [
        { x: -dir.z, z: dir.x },
        { x: dir.z, z: -dir.x },
      ];
      const count = Math.max(1, Math.floor(length / o.wallSpacingM));
      const step = length / count;
      for (let k = 0; k < count; k++) {
        const along = step * (k + 0.5);
        const onWall = { x: s.a.x + dir.x * along, z: s.a.z + dir.z * along };
        for (const n of normals) {
          const probe = { x: onWall.x + n.x * 0.05, z: onWall.z + n.z * 0.05 };
          // the room side of the wall: the side that is inside the owner room
          // (room walls) or inside the building (boundary / interior walls)
          const sideOk = s.owner
            ? inside(probe.x, probe.z, s.owner)
            : insideBuilding(probe.x, probe.z);
          if (!sideOk) continue;
          const pos = {
            x: round(onWall.x + n.x * o.wallOffsetM),
            z: round(onWall.z + n.z * o.wallOffsetM),
          };
          const room = roomAt(pos.x, pos.z);
          const cand = {
            kind: "wall",
            floorId,
            x: pos.x,
            z: pos.z,
            heightM: o.wallHeightM,
            roomId: room?.id ?? null,
            roomName: room?.name ?? "Common area",
            wallSide: s.side,
          };
          if (!insideBuilding(pos.x, pos.z) || !roomInScope(room)) {
            reject(cand, "outside");
            continue;
          }
          if (room && !roomOk(room)) {
            reject(cand, "excludedRoom");
            continue;
          }
          if (
            s.owner &&
            s.side &&
            plan.wallMountable?.[`${s.owner.id}:${s.side}`] === false
          ) {
            reject(cand, "excludedWall");
            continue;
          }
          if (o.wallHeightM > s.wallHeight - 0.2) {
            reject(cand, "lowWall");
            continue;
          }
          if (Math.min(along, length - along) < o.cornerClearanceM) {
            reject(cand, "corner");
            continue;
          }
          if (
            openingSegments.some(
              (seg) =>
                distToSegment(onWall, seg.a, seg.b) < o.openingClearanceM,
            )
          ) {
            reject(cand, "opening");
            continue;
          }
          if (blockedByFurniture(pos.x, pos.z)) {
            reject(cand, "furniture");
            continue;
          }
          valid.push(cand);
        }
      }
    }

  // ---- ceilings -----------------------------------------------------------
  if (o.mounting.includes("ceiling")) {
    const ceilingAreas = [
      ...rooms.map((r) => ({ shape: r, room: r })),
      ...outlines.map((b) => ({ shape: b, room: null })),
    ];
    const edgeDistance = (x, z, shape) =>
      Math.min(
        ...pointsOf(shape).map((a, i, pts) =>
          distToSegment({ x, z }, a, pts[(i + 1) % pts.length]),
        ),
      );
    for (const { shape, room } of ceilingAreas) {
      const b = bbox(shape),
        height = (Number(shape.height) || 3) - o.ceilingDropM;
      for (
        let x = b.minX + o.ceilingSpacingM / 2;
        x < b.maxX;
        x += o.ceilingSpacingM
      )
        for (
          let z = b.minZ + o.ceilingSpacingM / 2;
          z < b.maxZ;
          z += o.ceilingSpacingM
        ) {
          if (!inside(x, z, shape)) continue;
          const host = room ?? roomAt(x, z);
          // a boundary grid point inside a room belongs to the room's own grid
          if (!room && host) continue;
          const cand = {
            kind: "ceiling",
            floorId,
            x: round(x),
            z: round(z),
            heightM: round(height),
            roomId: host?.id ?? null,
            roomName: host?.name ?? "Common area",
            wallSide: "",
          };
          if (!roomInScope(host) || !insideBuilding(x, z)) {
            reject(cand, "outside");
            continue;
          }
          if (host && !roomOk(host)) {
            reject(cand, "excludedRoom");
            continue;
          }
          if (edgeDistance(x, z, shape) < o.cornerClearanceM) {
            reject(cand, "wallClearance");
            continue;
          }
          valid.push(cand);
        }
    }
  }

  // ---- de-duplicate, then give every candidate a stable id ----------------
  const kept = [];
  for (const c of valid)
    if (
      !kept.some(
        (k) =>
          Math.hypot(k.x - c.x, k.z - c.z, k.heightM - c.heightM) <
          o.minSeparationM,
      )
    )
      kept.push(c);
  const id = (c) =>
    `${c.floorId}:${c.kind}:${Math.round(c.x * 100)}:${Math.round(c.z * 100)}`;
  const stats = { valid: kept.length, rejected: rejected.length, byReason: {} };
  for (const r of rejected)
    stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
  return {
    valid: kept.map((c) => ({ ...c, id: id(c) })),
    rejected: rejected.map((c) => ({
      ...c,
      id: id(c),
      reasonText: REJECTION_REASONS[c.reason],
    })),
    stats,
  };
}

export function generateAllCandidates(plan, floorIds, options) {
  const all = {
    valid: [],
    rejected: [],
    stats: { valid: 0, rejected: 0, byReason: {} },
  };
  for (const floorId of floorIds) {
    const part = generateCandidates(plan, floorId, options);
    all.valid.push(...part.valid);
    all.rejected.push(...part.rejected);
    all.stats.valid += part.stats.valid;
    all.stats.rejected += part.stats.rejected;
    for (const [k, v] of Object.entries(part.stats.byReason))
      all.stats.byReason[k] = (all.stats.byReason[k] || 0) + v;
  }
  return all;
}
