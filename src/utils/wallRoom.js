// Turns walls drawn one by one into a room: starting from one wall, follow the
// walls joined end to end (ends closer than `tolerance` count as joined) and use
// their corners as the room outline. A closed loop gives the room as drawn; an
// open chain (e.g. three sides of a box) is closed with a straight side.

const num = (v) => Number(v) || 0;

// returns { points, wallIds, closed } or { error }
export function roomOutlineFromWalls(walls, startId, tolerance = 0.3) {
  const start = walls.find((w) => w.id === startId);
  if (!start) return { error: "Select a wall first." };
  const ends = (w) => [
    { x: num(w.x1), z: num(w.z1) },
    { x: num(w.x2), z: num(w.z2) },
  ];
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) <= tolerance;
  // the other wall (not used yet) with an end at point p; null at a dead end or
  // where three or more walls meet (the way on is not clear)
  const used = new Set([start.id]);
  const next = (p) => {
    const found = walls.filter((w) => !used.has(w.id) && ends(w).some((e) => near(e, p)));
    return found.length === 1 ? found[0] : null;
  };
  // walk forward from the start wall's second end, then backward from its first
  const [a, b] = ends(start);
  const forward = [b];
  let tip = b;
  let closed = false;
  for (let w = next(tip); w; w = next(tip)) {
    used.add(w.id);
    const [p, q] = ends(w);
    tip = near(p, tip) ? q : p;
    if (near(tip, a)) {
      closed = true;
      break;
    }
    forward.push(tip);
  }
  const backward = [];
  if (!closed) {
    tip = a;
    for (let w = next(tip); w; w = next(tip)) {
      used.add(w.id);
      const [p, q] = ends(w);
      tip = near(p, tip) ? q : p;
      backward.unshift(tip);
    }
  }
  const points = [...backward, a, ...forward];
  // corners that are not corners (straight-through joints) are dropped
  const outline = points.filter((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length];
    const nextP = points[(i + 1) % points.length];
    const cross = (p.x - prev.x) * (nextP.z - p.z) - (p.z - prev.z) * (nextP.x - p.x);
    return Math.abs(cross) > 1e-6;
  });
  if (outline.length < 3)
    return {
      error:
        used.size < 2
          ? "This wall is not joined to other walls. Draw the walls so their ends meet."
          : "These walls do not enclose an area.",
    };
  const twice = outline.reduce((s, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return s + p.x * q.z - q.x * p.z;
  }, 0);
  if (Math.abs(twice) / 2 < 0.25) return { error: "These walls enclose almost no area." };
  return { points: outline, wallIds: [...used], closed };
}
