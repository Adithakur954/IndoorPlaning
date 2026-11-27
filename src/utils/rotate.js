// Rotating rooms, objects and the whole building. Angles are in degrees,
// positive = clockwise on the 2D plan (plan +z points down).
//
// Rectangular rooms keep their shape under quarter turns (90, 180, 270): their
// doors, windows and per-side wall materials are carried to the new sides. Any
// other angle turns a rectangle into a polygon, which has no sides, so its
// doors, windows and side materials are dropped (see `rotationLosesData`).
import { bbox, pointsOf, roomContents } from "./geometry.js";
import { moveCableBends } from "../infra/cellular/das.js";

const RAD = Math.PI / 180;
const SIDES = ["north", "east", "south", "west"];

export const normalizeDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

// 0..3 when `deg` is a multiple of 90, otherwise null
export const quarterTurns = (deg) => {
  const k = Number(deg) / 90;
  return Math.abs(k - Math.round(k)) < 1e-9 ? ((Math.round(k) % 4) + 4) % 4 : null;
};

export function rotatePoint(p, pivot, deg) {
  const c = Math.cos(deg * RAD),
    s = Math.sin(deg * RAD);
  const dx = p.x - pivot.x,
    dz = p.z - pivot.z;
  return { x: pivot.x + dx * c - dz * s, z: pivot.z + dx * s + dz * c };
}

const round = (v) => Math.round(v * 1e6) / 1e6 + 0; // + 0 turns -0 into 0
const roundPoint = (p) => ({ x: round(p.x), z: round(p.z) });

const boundsOf = (points) => {
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  const x = Math.min(...xs),
    z = Math.min(...zs);
  return {
    x,
    z,
    width: round(Math.max(...xs) - x),
    depth: round(Math.max(...zs) - z),
  };
};

export const isRectangle = (room) => !room.shape || room.shape === "rectangle";

// True when rotating by `deg` would remove doors, windows or side materials.
export function rotationLosesData(plan, roomIds, deg) {
  if (quarterTurns(deg) !== null) return false;
  const ids = new Set(roomIds);
  return plan.rooms
    .filter((r) => ids.has(r.id) && isRectangle(r))
    .some(
      (r) =>
        plan.doors.some((d) => d.roomId === r.id) ||
        plan.windows.some((w) => w.roomId === r.id) ||
        Object.keys(plan.wallTypes || {}).some((k) => k.startsWith(`${r.id}:`)),
    );
}

function rotateRoomShape(room, pivot, deg) {
  if (room.shape === "circle") {
    const r = Number(room.radius || room.width / 2);
    const c = rotatePoint(
      { x: +room.x + room.width / 2, z: +room.z + room.depth / 2 },
      pivot,
      deg,
    );
    return { ...room, x: round(c.x - r), z: round(c.z - r) };
  }
  const corners = pointsOf(room).map((p) => roundPoint(rotatePoint(p, pivot, deg)));
  if (room.shape === "polygon" || quarterTurns(deg) === null)
    return { ...room, shape: "polygon", polygonPoints: corners, ...boundsOf(corners) };
  return { ...room, ...boundsOf(corners) };
}

// Openings of a rectangle turned by `k` quarter turns clockwise. One turn:
// north -> east -> south -> west. A wall whose offset ran down the plan
// (east/west) now runs right-to-left, so its offset flips.
function turnOpenings(items, room, k) {
  return items.map((item) => {
    let side = item.wallSide,
      offset = Number(item.offset || 0),
      rw = +room.width,
      rd = +room.depth;
    const w = Number(item.width || 0);
    for (let i = 0; i < k; i += 1) {
      const wallLength = side === "north" || side === "south" ? rw : rd;
      if (side === "east" || side === "west") offset = wallLength - offset - w;
      side = SIDES[(SIDES.indexOf(side) + 1) % 4];
      [rw, rd] = [rd, rw];
    }
    return { ...item, wallSide: side, offset: Math.max(0, round(offset)) };
  });
}

function turnWallTypes(wallTypes, roomId, k) {
  const next = {};
  for (const [key, value] of Object.entries(wallTypes || {})) {
    const side = key.startsWith(`${roomId}:`) ? key.slice(roomId.length + 1) : null;
    const i = SIDES.indexOf(side);
    next[i < 0 ? key : `${roomId}:${SIDES[(i + k) % 4]}`] = value;
  }
  return next;
}

// Rotates the listed objects of `plan` about `pivot`.
export function rotateParts(
  planIn,
  { rooms = [], furniture = [], sources = [], walls = [], boundaries = [] },
  pivot,
  deg,
) {
  const sourceIds = new Set(sources);
  // DAS cable bends turn with the parts they join
  const plan = moveCableBends(planIn, sourceIds, (p) => roundPoint(rotatePoint({ x: +p.x, z: +p.z }, pivot, deg)));
  const roomIds = new Set(rooms),
    furnitureIds = new Set(furniture),
    wallIds = new Set(walls),
    boundaryIds = new Set(boundaries);
  const k = quarterTurns(deg);
  let { doors, windows, wallTypes } = plan;
  const roomsOut = plan.rooms.map((room) => {
    if (!roomIds.has(room.id)) return room;
    const rect = isRectangle(room);
    const out = rotateRoomShape(room, pivot, deg);
    if (rect && k !== null) {
      const turn = (list) => [
        ...turnOpenings(list.filter((o) => o.roomId === room.id), room, k),
        ...list.filter((o) => o.roomId !== room.id),
      ];
      doors = turn(doors);
      windows = turn(windows);
      wallTypes = turnWallTypes(wallTypes, room.id, k);
    } else if (rect) {
      doors = doors.filter((d) => d.roomId !== room.id);
      windows = windows.filter((w) => w.roomId !== room.id);
      wallTypes = Object.fromEntries(
        Object.entries(wallTypes || {}).filter(([key]) => !key.startsWith(`${room.id}:`)),
      );
    }
    return out;
  });
  return {
    ...plan,
    rooms: roomsOut,
    doors,
    windows,
    wallTypes,
    furniture: plan.furniture.map((f) => {
      if (!furnitureIds.has(f.id)) return f;
      const c = rotatePoint(
        { x: +f.x + +f.width / 2, z: +f.z + +f.depth / 2 },
        pivot,
        deg,
      );
      const rad = deg * RAD;
      // axis-aligned footprint: swapped on odd quarter turns, otherwise the
      // box that encloses the turned one
      const odd = k !== null && k % 2 === 1;
      const width =
        k !== null
          ? odd ? +f.depth : +f.width
          : Math.abs(+f.width * Math.cos(rad)) + Math.abs(+f.depth * Math.sin(rad));
      const depth =
        k !== null
          ? odd ? +f.width : +f.depth
          : Math.abs(+f.width * Math.sin(rad)) + Math.abs(+f.depth * Math.cos(rad));
      return {
        ...f,
        x: round(c.x - width / 2),
        z: round(c.z - depth / 2),
        width: round(width),
        depth: round(depth),
      };
    }),
    sources: plan.sources.map((s) => {
      if (!sourceIds.has(s.id)) return s;
      return {
        ...s,
        ...roundPoint(rotatePoint({ x: +s.x, z: +s.z }, pivot, deg)),
        azimuthDeg: round(normalizeDeg(Number(s.azimuthDeg || 0) + deg)),
        sectors: s.sectors?.map((sec) => ({
          ...sec,
          azimuthDeg: round(normalizeDeg(Number(sec.azimuthDeg || 0) + deg)),
        })),
      };
    }),
    interiorWalls: plan.interiorWalls.map((w) => {
      if (!wallIds.has(w.id)) return w;
      const a = roundPoint(rotatePoint({ x: +w.x1, z: +w.z1 }, pivot, deg));
      const b = roundPoint(rotatePoint({ x: +w.x2, z: +w.z2 }, pivot, deg));
      return { ...w, x1: a.x, z1: a.z, x2: b.x, z2: b.z };
    }),
    boundaries: (plan.boundaries || []).map((b) =>
      boundaryIds.has(b.id)
        ? { ...b, points: b.points.map((p) => roundPoint(rotatePoint(p, pivot, deg))) }
        : b,
    ),
  };
}

const centreOf = (room) => {
  const b = bbox(room);
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
};

// A room and (optionally) what is inside it, turned about the room's centre.
export function rotateRoom(plan, roomId, deg, withContents = true) {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return plan;
  const inside = withContents ? roomContents(plan, room) : null;
  return rotateParts(
    plan,
    {
      rooms: [roomId, ...(inside?.rooms || [])],
      furniture: inside?.furniture,
      sources: inside?.sources,
      walls: inside?.walls,
    },
    centreOf(room),
    deg,
  );
}

// Furniture turned about its own centre.
export function rotateFurniture(plan, id, deg) {
  const f = plan.furniture.find((x) => x.id === id);
  if (!f) return plan;
  return rotateParts(
    plan,
    { furniture: [id] },
    { x: +f.x + +f.width / 2, z: +f.z + +f.depth / 2 },
    deg,
  );
}

// An interior wall turned about its middle.
export function rotateInteriorWall(plan, id, deg) {
  const w = plan.interiorWalls.find((x) => x.id === id);
  if (!w) return plan;
  return rotateParts(
    plan,
    { walls: [id] },
    { x: (+w.x1 + +w.x2) / 2, z: (+w.z1 + +w.z2) / 2 },
    deg,
  );
}

// What a boundary encloses, as an area `roomContents` understands.
export const boundaryArea = (b) => ({
  id: b.id,
  floorId: b.floorId,
  shape: "polygon",
  polygonPoints: b.points,
});

// A building boundary turned about the middle of its bounding box, with what
// is inside it when `withContents` is set.
export function rotateBoundary(plan, id, deg, withContents = false) {
  const b = (plan.boundaries || []).find((x) => x.id === id);
  if (!b) return plan;
  const xs = b.points.map((p) => p.x),
    zs = b.points.map((p) => p.z);
  const inside = withContents ? roomContents(plan, boundaryArea(b)) : null;
  return rotateParts(
    plan,
    {
      boundaries: [id],
      rooms: inside?.rooms,
      furniture: inside?.furniture,
      sources: inside?.sources,
      walls: inside?.walls,
    },
    {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      z: (Math.min(...zs) + Math.max(...zs)) / 2,
    },
    deg,
  );
}

// Centre of everything drawn (all floors): the pivot for the whole building.
export function buildingCentre(plan) {
  const points = [
    ...plan.rooms.flatMap((r) => pointsOf(r)),
    ...(plan.boundaries || []).flatMap((b) => b.points),
  ];
  if (!points.length) return { x: 0, z: 0 };
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

// The whole building on every floor. The map alignment is turned with it, so
// measurement logs (placed through the alignment) stay on the same rooms.
export function rotateBuilding(plan, deg) {
  const pivot = buildingCentre(plan);
  const next = rotateParts(
    plan,
    {
      rooms: plan.rooms.map((r) => r.id),
      furniture: plan.furniture.map((f) => f.id),
      sources: plan.sources.map((s) => s.id),
      walls: plan.interiorWalls.map((w) => w.id),
      boundaries: (plan.boundaries || []).map((b) => b.id),
    },
    pivot,
    deg,
  );
  // floor images turn with the building: the image centre moves about the
  // pivot and the picture is turned by the same angle
  if (plan.images && Object.keys(plan.images).length)
    next.images = Object.fromEntries(
      Object.entries(plan.images).map(([floorId, img]) => {
        const w = Number(img.widthM) || 0,
          h = Number(img.heightM) || 0;
        const centre = {
          x: (Number(img.offsetX) || 0) + w / 2,
          z: (Number(img.offsetZ) || 0) + h / 2,
        };
        const c = rotatePoint(centre, pivot, deg);
        return [
          floorId,
          {
            ...img,
            offsetX: round(c.x - w / 2),
            offsetZ: round(c.z - h / 2),
            rotationDeg: round(normalizeDeg((Number(img.rotationDeg) || 0) + deg)),
          },
        ];
      }),
    );
  const a = plan.alignment;
  if (a && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.z))) {
    const anchor = roundPoint(
      rotatePoint({ x: Number(a.x), z: Number(a.z) }, pivot, deg),
    );
    next.alignment = {
      ...a,
      x: anchor.x,
      z: anchor.z,
      rotationDeg: round(normalizeDeg(Number(a.rotationDeg || 0) + deg)),
    };
  }
  return next;
}
