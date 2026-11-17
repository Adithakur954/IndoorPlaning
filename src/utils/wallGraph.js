// One wall model for a floor, shared by the 3D view and the ray-tracing export.
//
// Every room edge and building-boundary edge is a segment. Segments that lie on
// the same line and overlap (two rooms side by side, a room inside a building
// shell, a room against the boundary) are merged: each stretch of line becomes
// ONE wall, with the doors and windows of every segment that covers it. This is
// what stops a shared wall being counted twice.
import { boundaryAreas, pointsOf } from "./geometry.js";
import { splitWall, wallOpenings } from "./wallPieces.js";

const SIDES = ["north", "east", "south", "west"];
const LINE_TOLERANCE = 0.03; // metres between two lines that count as one
const ANGLE_TOLERANCE = 1e-3;
const MIN_LENGTH = 0.015;

export function buildWalls(plan, floorId) {
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const doors = plan.doors.filter((d) => d.floorId === floorId);
  const windows = plan.windows.filter((w) => w.floorId === floorId);
  const segments = [];

  const addEdges = (shape, extra) => {
    const pts = pointsOf(shape);
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length],
        length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < MIN_LENGTH) return;
      const side =
        extra.type === "room" && shape.shape === "rectangle" ? SIDES[i] : "";
      segments.push({
        a,
        b,
        length,
        side,
        owner: { type: extra.type, id: shape.id, name: shape.name, side },
        exterior: extra.type === "boundary",
        material:
          (extra.type === "room" && plan.wallTypes?.[`${shape.id}:${side}`]) ||
          shape.material ||
          (extra.type === "boundary" ? "concrete" : "drywall"),
        height: Number(shape.height) || 3,
        openings:
          extra.type === "room"
            ? wallOpenings({
                length,
                side,
                edgeIndex: i,
                room: shape,
                doors,
                windows,
              })
            : [],
      });
    });
  };
  // the boundary first, so it wins the material of a wall it shares with rooms
  for (const outline of boundaryAreas(plan, floorId))
    addEdges(outline, { type: "boundary" });
  for (const room of rooms) addEdges(room, { type: "room" });

  // ---- group segments on the same line -----------------------------------
  const groups = [];
  for (const seg of segments) {
    let dx = (seg.b.x - seg.a.x) / seg.length,
      dz = (seg.b.z - seg.a.z) / seg.length;
    const flipped = dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dz < 0);
    if (flipped) {
      dx = -dx;
      dz = -dz;
    }
    let group = groups.find((g) => {
      if (Math.abs(g.dir.x * dz - g.dir.z * dx) > ANGLE_TOLERANCE) return false;
      const off =
        -g.dir.z * (seg.a.x - g.origin.x) + g.dir.x * (seg.a.z - g.origin.z);
      return Math.abs(off) <= LINE_TOLERANCE;
    });
    if (!group) {
      group = {
        dir: { x: dx, z: dz },
        origin: flipped ? seg.b : seg.a,
        items: [],
      };
      groups.push(group);
    }
    const along = (p) =>
      (p.x - group.origin.x) * group.dir.x +
      (p.z - group.origin.z) * group.dir.z;
    const ta = along(seg.a),
      tb = along(seg.b);
    group.items.push({
      seg,
      lo: Math.min(ta, tb),
      hi: Math.max(ta, tb),
      // the segment runs against the group's direction
      reversed: tb < ta,
    });
  }

  // ---- one wall per stretch of line covered by at least one segment ---------
  const walls = [];
  for (const g of groups) {
    const stops = [...new Set(g.items.flatMap((i) => [i.lo, i.hi]))].sort(
      (x, y) => x - y,
    );
    const breaks = stops.filter((t, i) => i === 0 || t - stops[i - 1] > 1e-3);
    for (let k = 0; k + 1 < breaks.length; k++) {
      const t0 = breaks[k],
        t1 = breaks[k + 1],
        length = t1 - t0;
      if (length < MIN_LENGTH) continue;
      const covering = g.items.filter(
        (i) => i.lo <= t0 + 1e-3 && i.hi >= t1 - 1e-3,
      );
      if (!covering.length) continue;
      const primary = covering.find((i) => i.seg.exterior) || covering[0];
      const materials = [...new Set(covering.map((i) => i.seg.material))];
      const height = Math.max(...covering.map((i) => i.seg.height));

      // openings of every covering segment, in distance from t0
      const openings = [];
      for (const item of covering)
        for (const o of item.seg.openings) {
          const u0 = item.reversed ? item.hi - o.end : item.lo + o.start,
            u1 = item.reversed ? item.hi - o.start : item.lo + o.end;
          const start = Math.max(u0, t0) - t0,
            end = Math.min(u1, t1) - t0;
          if (end - start < 0.01) continue;
          // the same door seen from both rooms of a shared wall: keep one
          const twin = openings.find(
            (x) => x.kind === o.kind && start < x.end && end > x.start,
          );
          if (twin) {
            twin.start = Math.min(twin.start, start);
            twin.end = Math.max(twin.end, end);
          } else openings.push({ ...o, start, end });
        }
      const { pieces, openings: used } = splitWall({
        length,
        height,
        openings,
      });
      const at = (t) => ({
        x: g.origin.x + g.dir.x * t,
        z: g.origin.z + g.dir.z * t,
      });
      walls.push({
        a: at(t0),
        b: at(t1),
        length,
        height,
        material: primary.seg.material,
        exterior: covering.some((i) => i.seg.exterior),
        shared: covering.length > 1,
        owners: covering.map((i) => i.seg.owner),
        materialConflict: materials.length > 1 ? materials : null,
        pieces,
        openings: used,
      });
    }
  }
  return walls;
}
