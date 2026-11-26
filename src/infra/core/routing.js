// Cable routing on a floor plan. Shared by every system type (Wi-Fi now,
// cellular later). Pure functions, no UI.
//
// The floor is a grid. A cable moves between neighbouring cells (right angles,
// like a real run along a corridor or tray). Crossing a wall is allowed, because
// cable can pass above the ceiling, but it costs extra, so the route prefers
// doors and open space. The extra cost steers the route; it is never added to
// the cable length.

const EPS = 1e-9;

const cross = (ax, az, bx, bz) => ax * bz - az * bx;

// Does the move a->b pass through the wall c-d? Touching counts, except at the
// far end b: a wall that sits exactly on a cell centre is then counted once (on
// the move that starts there), not on both neighbouring moves.
function segmentsMeet(a, b, c, d) {
  const d1 = cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z);
  const d2 = cross(b.x - a.x, b.z - a.z, d.x - a.x, d.z - a.z);
  const d3 = cross(d.x - c.x, d.z - c.z, a.x - c.x, a.z - c.z);
  const d4 = cross(d.x - c.x, d.z - c.z, b.x - c.x, b.z - c.z);
  if (
    Math.abs(d1) < EPS &&
    Math.abs(d2) < EPS &&
    Math.abs(d3) < EPS &&
    Math.abs(d4) < EPS
  )
    return false;
  if (!(d1 * d2 <= EPS && d3 * d4 <= EPS)) return false;
  const denominator = cross(b.x - a.x, b.z - a.z, d.x - c.x, d.z - c.z);
  if (Math.abs(denominator) < EPS) return false;
  const t = cross(c.x - a.x, c.z - a.z, d.x - c.x, d.z - c.z) / denominator;
  return t < 1 - 1e-9;
}

// walls: [{ a: {x,z}, b: {x,z}, policy? }]  solid pieces only (doors already cut out)
//   policy: "penalty" (default: crossing is an estimate), "permitted", "blocked"
// bounds: { minX, maxX, minZ, maxZ }
// footprint(x, z): true where a cable may go (inside the building)
// trays: [{ points: [{x,z}], kind: "new" | "existing" }]  drawn cable trays: cheaper to route along
export function buildRoutingGrid({ walls, bounds, footprint, cellM = 0.5, trays = [] }) {
  if (!(cellM > 0)) throw new RangeError("cellM must be above 0");
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellM));
  const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellM));
  if (nx * nz > 2_000_000)
    throw new RangeError("routing grid too large; use a larger cell size");
  const grid = {
    nx,
    nz,
    cellM,
    minX: bounds.minX,
    minZ: bounds.minZ,
    allowed: new Uint8Array(nx * nz),
    // What a move crosses: 0 nothing, 1 a wall crossing that is only an estimate,
    // 2 a crossing that is permitted (opening, sleeve, accessible ceiling void),
    // 3 a crossing that is not permitted (the move is impossible).
    crossRight: new Uint8Array(nx * nz), // edge to (ix+1, iz)
    crossDown: new Uint8Array(nx * nz), // edge to (ix, iz+1)
    // Edges that lie on a drawn tray: 1 new tray, 2 existing tray.
    trayRight: new Uint8Array(nx * nz),
    trayDown: new Uint8Array(nx * nz),
  };
  const cx = (ix) => grid.minX + (ix + 0.5) * cellM;
  const cz = (iz) => grid.minZ + (iz + 0.5) * cellM;
  grid.centerX = cx;
  grid.centerZ = cz;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++)
      grid.allowed[iz * nx + ix] = footprint(cx(ix), cz(iz)) ? 1 : 0;

  // an edge is on a tray when both its ends are within reach of the same tray segment
  const REACH = Math.max(0.3, cellM * 0.75);
  const distSeg = (px, pz, a, b) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2)) : 0;
    return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
  };
  for (const tray of trays) {
    const code = tray.kind === "existing" ? 2 : 1;
    for (let i = 1; i < (tray.points || []).length; i++) {
      const a = tray.points[i - 1];
      const b = tray.points[i];
      const ixLo = Math.max(0, Math.floor((Math.min(a.x, b.x) - REACH - grid.minX) / cellM) - 1);
      const ixHi = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x) + REACH - grid.minX) / cellM) + 1);
      const izLo = Math.max(0, Math.floor((Math.min(a.z, b.z) - REACH - grid.minZ) / cellM) - 1);
      const izHi = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z) + REACH - grid.minZ) / cellM) + 1);
      const near = (x, z) => distSeg(x, z, a, b) <= REACH;
      for (let iz = izLo; iz <= izHi; iz++)
        for (let ix = ixLo; ix <= ixHi; ix++) {
          const i0 = iz * nx + ix;
          if (!grid.allowed[i0] || !near(cx(ix), cz(iz))) continue;
          if (ix + 1 < nx && grid.allowed[i0 + 1] && near(cx(ix + 1), cz(iz)) && !grid.trayRight[i0]) grid.trayRight[i0] = code;
          if (iz + 1 < nz && grid.allowed[i0 + nx] && near(cx(ix), cz(iz + 1)) && !grid.trayDown[i0]) grid.trayDown[i0] = code;
        }
    }
  }

  // 4 is a crossing through a marked opening or sleeve; it is permitted like 2
  const CODE = { penalty: 1, permitted: 2, blocked: 3, penetration: 4 };
  // blocked beats an estimated crossing, which beats a permitted one
  const merge = (old, code) => (old === 0 ? code : old === 3 || code === 3 ? 3 : old === 1 || code === 1 ? 1 : old === 4 && code === 4 ? 4 : 2);
  for (const wall of walls) {
    const code = CODE[wall.policy] || 1;
    const x0 = Math.min(wall.a.x, wall.b.x);
    const x1 = Math.max(wall.a.x, wall.b.x);
    const z0 = Math.min(wall.a.z, wall.b.z);
    const z1 = Math.max(wall.a.z, wall.b.z);
    const ixLo = Math.max(0, Math.floor((x0 - grid.minX) / cellM) - 1);
    const ixHi = Math.min(nx - 1, Math.floor((x1 - grid.minX) / cellM) + 1);
    const izLo = Math.max(0, Math.floor((z0 - grid.minZ) / cellM) - 1);
    const izHi = Math.min(nz - 1, Math.floor((z1 - grid.minZ) / cellM) + 1);
    for (let iz = izLo; iz <= izHi; iz++)
      for (let ix = ixLo; ix <= ixHi; ix++) {
        const here = { x: cx(ix), z: cz(iz) };
        if (ix + 1 < nx && segmentsMeet(here, { x: cx(ix + 1), z: here.z }, wall.a, wall.b))
          grid.crossRight[iz * nx + ix] = merge(grid.crossRight[iz * nx + ix], code);
        if (iz + 1 < nz && segmentsMeet(here, { x: here.x, z: cz(iz + 1) }, wall.a, wall.b))
          grid.crossDown[iz * nx + ix] = merge(grid.crossDown[iz * nx + ix], code);
      }
  }
  return grid;
}

// Nearest allowed cell to a point (searches outwards a few cells).
export function cellOf(grid, x, z) {
  const ix0 = Math.min(grid.nx - 1, Math.max(0, Math.floor((x - grid.minX) / grid.cellM)));
  const iz0 = Math.min(grid.nz - 1, Math.max(0, Math.floor((z - grid.minZ) / grid.cellM)));
  if (grid.allowed[iz0 * grid.nx + ix0]) return iz0 * grid.nx + ix0;
  for (let r = 1; r <= 40; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let iz = iz0 - r; iz <= iz0 + r; iz++)
      for (let ix = ix0 - r; ix <= ix0 + r; ix++) {
        if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) continue;
        if (Math.max(Math.abs(ix - ix0), Math.abs(iz - iz0)) !== r) continue;
        if (!grid.allowed[iz * grid.nx + ix]) continue;
        const d = Math.hypot(grid.centerX(ix) - x, grid.centerZ(iz) - z);
        if (d < bestD) {
          bestD = d;
          best = iz * grid.nx + ix;
        }
      }
    if (best >= 0) return best;
  }
  return -1;
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(key, item) {
    const keys = this.keys;
    const items = this.items;
    let i = items.length;
    keys.push(key);
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= keys[i]) break;
      [keys[parent], keys[i]] = [keys[i], keys[parent]];
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const { keys, items } = this;
    const top = { key: keys[0], item: items[0] };
    const lastKey = keys.pop();
    const lastItem = items.pop();
    if (items.length) {
      keys[0] = lastKey;
      items[0] = lastItem;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && keys[l] < keys[m]) m = l;
        if (r < items.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

// Directions of a move: +x, -x, +z, -z.
const DIRS = 4;
// How much more an early turn costs than a late one (see shortestFrom).
const EARLY_TURN = 4;

// Which grid edges already carry a cable. Later routes find these cheaper, so
// cables share a trunk instead of each taking its own path.
export const newUsage = (grid) => ({
  right: new Uint8Array(grid.nx * grid.nz),
  down: new Uint8Array(grid.nx * grid.nz),
});

export function markRoute(grid, usage, route) {
  for (const key of route.edges) {
    const [a, b] = key.split("-").map(Number);
    if (b - a === 1) usage.right[a] = 1;
    else usage.down[a] = 1;
  }
}

// Cheapest route from one point to every cell.
//   crossPenaltyM  extra cost (in metres) of passing through a wall away from a door
//   turnPenaltyM   extra cost of each change of direction: among routes of equal
//                  length it picks the one with the fewest turns, so open space
//                  gets straight runs with one turn, not a staircase
//   used, usedFactor  edges that already carry a cable cost usedFactor times as much
// None of these costs is added to the cable length.
export function shortestFrom(
  grid,
  source,
  { crossPenaltyM = 10, permitPenaltyM = 2, turnPenaltyM = 0, used = null, usedFactor = 1, trayFactor = 0.5 } = {},
) {
  const { nx, nz, cellM } = grid;
  const start = cellOf(grid, source.x, source.z);
  if (start < 0) throw new Error("the start point is outside the building");
  const dist = new Float64Array(nx * nz * DIRS).fill(Infinity);
  const prev = new Int32Array(nx * nz * DIRS).fill(-1);
  const heap = new MinHeap();
  for (let d = 0; d < DIRS; d++) {
    dist[start * DIRS + d] = 0;
    heap.push(0, start * DIRS + d);
  }
  const edgeCost = (cell, dir) => {
    let crossing;
    let carries = false;
    let tray = 0;
    if (dir === 0) { crossing = grid.crossRight[cell]; carries = used?.right[cell]; tray = grid.trayRight[cell]; }
    else if (dir === 1) { crossing = grid.crossRight[cell - 1]; carries = used?.right[cell - 1]; tray = grid.trayRight[cell - 1]; }
    else if (dir === 2) { crossing = grid.crossDown[cell]; carries = used?.down[cell]; tray = grid.trayDown[cell]; }
    else { crossing = grid.crossDown[cell - nx]; carries = used?.down[cell - nx]; tray = grid.trayDown[cell - nx]; }
    if (crossing === 3) return Infinity; // a wall that may not be crossed
    const extra = crossing === 1 ? crossPenaltyM : crossing === 2 || crossing === 4 ? permitPenaltyM : 0;
    // a drawn tray and a trunk that already carries cables are both cheaper to follow
    const factor = Math.min(carries ? usedFactor : 1, tray ? trayFactor : 1);
    return cellM * factor + extra;
  };
  while (heap.size) {
    const { key, item: state } = heap.pop();
    if (key > dist[state]) continue;
    const cell = Math.floor(state / DIRS);
    const heading = state % DIRS;
    const ix = cell % nx;
    const iz = (cell - ix) / nx;
    for (let dir = 0; dir < DIRS; dir++) {
      let other;
      if (dir === 0) other = ix + 1 < nx ? cell + 1 : -1;
      else if (dir === 1) other = ix > 0 ? cell - 1 : -1;
      else if (dir === 2) other = iz + 1 < nz ? cell + nx : -1;
      else other = iz > 0 ? cell - nx : -1;
      if (other < 0 || !grid.allowed[other]) continue;
      // A turn costs more the earlier it is: among equal-length routes, cables
      // keep going straight and turn late, so they leave the start on a common
      // line (a trunk) and split near their destinations.
      const move = edgeCost(cell, dir);
      if (move === Infinity) continue;
      const turnCost =
        dir !== heading && key > 0 ? turnPenaltyM * (1 + EARLY_TURN / (1 + key)) : 0;
      const cost = key + move + turnCost;
      const next = other * DIRS + dir;
      if (cost < dist[next]) {
        dist[next] = cost;
        prev[next] = state;
        heap.push(cost, next);
      }
    }
  }
  return { start, dist, prev, crossPenaltyM };
}

const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Cheapest state (cell + heading) reaching a cell.
function bestState(tree, cell) {
  let best = -1;
  let bestCost = Infinity;
  for (let d = 0; d < DIRS; d++)
    if (tree.dist[cell * DIRS + d] < bestCost) {
      bestCost = tree.dist[cell * DIRS + d];
      best = cell * DIRS + d;
    }
  return best;
}

// The route to a point. horizontalM is the cable length along the route, plus
// the short hop between each real point and the centre of its grid cell.
export function pathTo(grid, tree, source, target) {
  const end = cellOf(grid, target.x, target.z);
  if (end < 0) return null;
  let state = bestState(tree, end);
  if (state < 0 || !Number.isFinite(tree.dist[state])) return null;
  const cells = [end];
  const edges = [];
  let crossings = 0; // crossings that are only an estimate
  let permitted = 0; // crossings over a partition with an accessible ceiling void
  let penetrations = 0; // crossings through a marked opening or sleeve
  const crossingPoints = []; // where the route crosses a wall, and how
  let turns = 0;
  let onTray = 0;
  let lastHeading = state % DIRS;
  while (tree.prev[state] >= 0) {
    const before = tree.prev[state];
    const cell = Math.floor(state / DIRS);
    const beforeCell = Math.floor(before / DIRS);
    edges.push(edgeKey(beforeCell, cell));
    const lo = Math.min(beforeCell, cell);
    const hi = Math.max(beforeCell, cell);
    const crossCode = hi - lo === 1 ? grid.crossRight[lo] : grid.crossDown[lo];
    if (crossCode === 1) crossings++;
    else if (crossCode === 2) permitted++;
    else if (crossCode === 4) penetrations++;
    if (crossCode === 1 || crossCode === 2 || crossCode === 4) {
      const ax = grid.centerX(beforeCell % grid.nx);
      const az = grid.centerZ(Math.floor(beforeCell / grid.nx));
      const bx = grid.centerX(cell % grid.nx);
      const bz = grid.centerZ(Math.floor(cell / grid.nx));
      crossingPoints.push({ x: (ax + bx) / 2, z: (az + bz) / 2, kind: crossCode === 1 ? "estimated" : crossCode === 2 ? "ceiling" : "penetration" });
    }
    if (hi - lo === 1 ? grid.trayRight[lo] : grid.trayDown[lo]) onTray++;
    const heading = before % DIRS;
    if (heading !== lastHeading && tree.prev[before] >= 0) turns++;
    lastHeading = heading;
    cells.push(beforeCell);
    state = before;
  }
  cells.reverse();
  const hop = (cell, p) =>
    Math.abs(grid.centerX(cell % grid.nx) - p.x) +
    Math.abs(grid.centerZ(Math.floor(cell / grid.nx)) - p.z);
  const snapM = hop(tree.start, source) + hop(end, target);
  return {
    cells,
    edges,
    crossings,
    permittedCrossings: permitted,
    penetrations,
    crossingPoints,
    onTrayM: onTray * grid.cellM,
    turns,
    gridM: edges.length * grid.cellM,
    snapM,
    horizontalM: edges.length * grid.cellM + snapM,
  };
}

// Joins routes that follow one another (rack -> waypoint -> ... -> AP) into one.
export function joinRoutes(routes) {
  const sum = (f) => routes.reduce((s, r) => s + (r[f] || 0), 0);
  const cells = [];
  for (const r of routes) cells.push(...(cells.length ? r.cells.slice(1) : r.cells));
  return {
    cells,
    edges: routes.flatMap((r) => r.edges),
    crossings: sum("crossings"),
    permittedCrossings: sum("permittedCrossings"),
    penetrations: sum("penetrations"),
    crossingPoints: routes.flatMap((r) => r.crossingPoints || []),
    turns: sum("turns"),
    gridM: sum("gridM"),
    snapM: sum("snapM"),
    horizontalM: sum("horizontalM"),
    onTrayM: sum("onTrayM"),
  };
}

// Tray length: every grid edge any route uses, counted once (shared trunks).
export const trayLengthM = (grid, routes) =>
  new Set(routes.flatMap((r) => r.edges)).size * grid.cellM;

// The same tray, split into what must be bought (new, or no tray drawn there)
// and what already exists (a drawn existing tray).
export function trayBreakdown(grid, routes) {
  let newEdges = 0;
  let existingEdges = 0;
  for (const key of new Set(routes.flatMap((r) => r.edges))) {
    const [a, b] = key.split("-").map(Number);
    const code = b - a === 1 ? grid.trayRight[a] : grid.trayDown[a];
    if (code === 2) existingEdges++;
    else newEdges++;
  }
  return { newM: newEdges * grid.cellM, existingM: existingEdges * grid.cellM };
}
