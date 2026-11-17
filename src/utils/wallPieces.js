// Openings (doors/windows) on one room wall, measured from the wall's start
// point. Shared by the 3D view and the ray-tracing scene export.
//
// A rectangle's openings sit on a side (north/east/south/west, offset from the
// left or top). Any other room has no sides: its openings name the polygon edge
// (`edgeIndex`, from vertex i to i + 1) and the offset runs along that edge.
export function wallOpenings({ length, side, edgeIndex, room, doors, windows }) {
  const height = Number(room.height) || 3;
  if (!side && !Number.isInteger(edgeIndex)) return [];
  return [
    ...doors.map((o) => ({ ...o, kind: "door" })),
    ...windows.map((o) => ({ ...o, kind: "window" })),
  ]
    .filter(
      (o) =>
        o.roomId === room.id &&
        (side ? o.wallSide === side : Number(o.edgeIndex) === edgeIndex),
    )
    .map((o) => {
      let start = Number(o.offset || 0);
      const width = Number(o.width || 1);
      if (side === "south" || side === "west") start = length - start - width;
      const bottom =
          o.kind === "window" ? Math.max(0, Number(o.sillHeight || 1)) : 0,
        top = Math.min(height, bottom + Number(o.height || 2));
      return {
        ...o,
        start: Math.max(0, start),
        end: Math.min(length, start + width),
        bottom,
        top,
      };
    })
    .filter((o) => o.end > o.start);
}

// Solid wall pieces around the given openings (openings that overlap an
// earlier one are skipped).
export function splitWall({ length, height, openings }) {
  const sorted = [...openings].sort((a, b) => a.start - b.start);
  const pieces = [];
  const used = [];
  let cursor = 0;
  const push = (from, to, bottom, top, key) => {
    if (to - from > 0.015 && top - bottom > 0.015)
      pieces.push({ from, to, bottom, top, key });
  };
  for (const o of sorted) {
    if (o.start < cursor) continue;
    push(cursor, o.start, 0, height, `before-${o.id}`);
    push(o.start, o.end, 0, o.bottom, `below-${o.id}`);
    push(o.start, o.end, o.top, height, `above-${o.id}`);
    used.push(o);
    cursor = o.end;
  }
  push(cursor, length, 0, height, "after");
  return { pieces, openings: used, height };
}

export function wallPieces({ length, side, edgeIndex, room, doors, windows }) {
  return splitWall({
    length,
    height: Number(room.height) || 3,
    openings: wallOpenings({ length, side, edgeIndex, room, doors, windows }),
  });
}
