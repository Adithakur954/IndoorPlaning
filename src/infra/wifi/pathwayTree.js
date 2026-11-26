// The physical route tree of one rack: every AP's cable path from the rack, merged
// where the paths run together. The result is a trunk out of the rack, branches
// where cables separate, and each AP at the end of its own branch.
//
//   buildPathwayTree(runs) -> { root, leaves }
//   node = { id, x, z, floorId, run | null, children: [{ lengthM, node }] }
//
// A leaf carries exactly one AP (run). lengthM of a branch is the length of the
// route along it, in metres. It is route length only; each AP's own cable length
// (with drops, loops and slack) stays on the run.
const key = (p) => `${p.floorId}:${p.x.toFixed(2)},${p.z.toFixed(2)}`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// The ordered points of a run from the rack to its AP. A run through a riser
// has two legs: the rack's floor first, then the AP's floor.
function sequenceOf(run) {
  const legs =
    run.paths.length === 2 && run.riserId
      ? [run.paths[1], run.paths[0]] // rack leg (rack -> riser), then AP leg (riser -> AP)
      : run.paths;
  const points = [];
  for (const leg of legs)
    for (const p of leg.points) {
      const q = { x: p.x, z: p.z, floorId: leg.floorId };
      const last = points[points.length - 1];
      if (!last || key(last) !== key(q)) points.push(q);
    }
  return points;
}

// Keeps only the corners: points on a straight stretch are dropped.
export function straighten(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function buildPathwayTree(runs) {
  const root = { id: "root", x: 0, z: 0, floorId: null, trie: new Map(), ends: [] };
  let started = false;
  for (const run of runs) {
    const points = sequenceOf(run);
    if (!points.length) continue;
    if (!started) {
      Object.assign(root, { x: points[0].x, z: points[0].z, floorId: points[0].floorId });
      started = true;
    }
    let node = root;
    for (const p of points.slice(1)) {
      const k = key(p);
      if (!node.trie.has(k)) node.trie.set(k, { id: k, ...p, trie: new Map(), ends: [] });
      node = node.trie.get(k);
    }
    node.ends.push(run);
  }

  const leaves = [];
  const leafOf = (node, run) => {
    const leaf = { id: `ap:${run.apId}`, x: node.x, z: node.z, floorId: node.floorId, run, children: [] };
    leaves.push(leaf);
    return leaf;
  };
  const convert = (node) => {
    // a point where one cable ends and nothing continues is just the AP
    if (!node.trie.size && node.ends.length === 1) return leafOf(node, node.ends[0]);
    const out = { id: node.id, x: node.x, z: node.z, floorId: node.floorId, run: null, children: [] };
    for (const child of node.trie.values()) {
      // follow a chain of single-child points that carry no AP: it is one branch
      let length = dist(node, child);
      let cur = child;
      const points = [{ x: node.x, z: node.z }, { x: child.x, z: child.z }];
      while (cur.trie.size === 1 && cur.ends.length === 0) {
        const next = cur.trie.values().next().value;
        length += dist(cur, next);
        points.push({ x: next.x, z: next.z });
        cur = next;
      }
      // the real corner points of the branch (for drawing it where it runs)
      out.children.push({ lengthM: length, points: straighten(points), node: convert(cur) });
    }
    // an AP that sits on another cable's path hangs off that point
    for (const run of node.ends)
      out.children.push({ lengthM: 0, points: [{ x: node.x, z: node.z }], node: leafOf(node, run) });
    return out;
  };
  return { root: convert(root), leaves };
}

// Number of APs below a node.
export const leafCount = (n) => (n.run ? 1 : n.children.reduce((s, c) => s + leafCount(c.node), 0));
