// Keeps the names on the plan from landing on top of each other or on top of
// objects. Everything is in plan metres; a label is a box centred on (x, y).
//
// Labels are placed one by one in priority order. Each one tries its preferred
// spot, then spots around the object it names (above, below, right, left, then
// a second ring further out), and takes the first that is free of every label
// already placed and of every object marker. If none is free it keeps the spot
// with the least overlap.
const CHAR_WIDTH = 0.56; // average glyph width / font size
const LINE_HEIGHT = 1.15;
const GAP = 0.12;

export const labelSize = (text, fontSize) => ({
  w: String(text ?? "").length * fontSize * CHAR_WIDTH + 0.1,
  h: fontSize * LINE_HEIGHT,
});

const boxAt = (x, y, w, h) => ({
  x0: x - w / 2,
  y0: y - h / 2,
  x1: x + w / 2,
  y1: y + h / 2,
});

const overlap = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
    h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};

// candidate centres around an anchor rectangle { x0, y0, x1, y1 }
export function aroundCandidates(anchor, w, h) {
  const cx = (anchor.x0 + anchor.x1) / 2,
    cy = (anchor.y0 + anchor.y1) / 2;
  const out = [];
  for (const ring of [0, 1]) {
    const gap = GAP + ring * (h + GAP);
    out.push(
      { x: cx, y: anchor.y0 - gap - h / 2 }, // above
      { x: cx, y: anchor.y1 + gap + h / 2 }, // below
      { x: anchor.x1 + gap + w / 2, y: cy }, // right
      { x: anchor.x0 - gap - w / 2, y: cy }, // left
    );
  }
  return out;
}

// labels: [{ id, text, fontSize, priority, preferred: {x, y} | null,
//            anchor: rect | null }]   (lower priority number is placed first)
// obstacles: [{ x0, y0, x1, y1, owner? }]  object markers labels must avoid;
//            an obstacle whose `owner` equals the label id is ignored for it.
// Returns { [id]: { x, y } }.
export function layoutLabels(labels, obstacles = []) {
  const placed = [];
  const result = {};
  const ordered = [...labels].sort((a, b) => a.priority - b.priority);
  for (const label of ordered) {
    const { w, h } = labelSize(label.text, label.fontSize);
    const candidates = [
      ...(label.preferred ? [label.preferred] : []),
      ...(label.anchor ? aroundCandidates(label.anchor, w, h) : []),
    ];
    if (!candidates.length) continue;
    let best = null;
    for (const c of candidates) {
      const box = boxAt(c.x, c.y, w, h);
      let cost = 0;
      for (const p of placed) cost += overlap(box, p);
      for (const o of obstacles)
        if (o.owner !== label.id) cost += overlap(box, o);
      if (cost === 0) {
        best = { c, box };
        break;
      }
      if (!best || cost < best.cost) best = { c, box, cost };
    }
    result[label.id] = best.c;
    placed.push(best.box);
  }
  return result;
}
