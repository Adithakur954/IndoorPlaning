// Design plan: the DAS of a cellular project as one schematic, floor by floor
// (top floor first). Each floor is a band; inside it the signal runs left to
// right from the source (BTS / repeater) through couplers, splitters, combiners
// and risers to the antennas. Nothing shows by itself: the plan holds the parts
// added here and the parts, antennas and cables imported from the floors.
// Parts can be dragged anywhere on it; those places are the design plan's own
// (plan.designPlan.pos) and never move anything on the floor plans.
//
// plan.designPlan = { ids: [part / antenna ids], cableIds: [cable ids], pos: { id: { x, y } } }
// The parts and cables themselves are the same ones as on the floor plans.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DAS_TYPES,
  cableLengthM,
  cableLossAt,
  cablePortLabel,
  cableProblem,
  changeDasType,
  dasCatalogue,
  dasPowers,
  newCable,
  newDasPart,
  orientCable,
  withoutLooseCables,
} from "../../infra/cellular/das.js";
import { cellularOf } from "../../infra/cellular/model.js";

const COL_W = 210;
const NODE_W = 118;
const NODE_H = 46;
const ROW_H = 76;
const BAND_PAD = 18;
const LABEL_W = 132;
const GRID = 4; // a dragged part lands on this grid (px)

const TYPE_COLOR = {
  source: "#c2410c",
  splitter: "#0b7660",
  coupler: "#1d4ed8",
  combiner: "#7c3aed",
  riser: "#57534e",
  antenna: "#0e7490",
  cable: "#6b8079",
};

// the filters of the Import window, in this order
const IMPORT_TYPES = [
  ["all", "All"],
  ["source", "BTS"],
  ["riser", "Shaft"],
  ["coupler", "Coupler"],
  ["splitter", "Splitter"],
  ["combiner", "Combiner"],
  ["antenna", "Antenna"],
  ["cable", "Cable"],
];

const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dBm` : "");

// the middle of the floor: its rooms, else its parts, else the origin
function floorCentre(plan, floorId) {
  const xs = [];
  const zs = [];
  for (const r of plan.rooms || [])
    if (r.floorId === floorId) {
      xs.push(+r.x, +r.x + (+r.width || 0));
      zs.push(+r.z, +r.z + (+r.depth || 0));
    }
  if (!xs.length)
    for (const s of plan.sources || [])
      if (s.floorId === floorId) {
        xs.push(+s.x);
        zs.push(+s.z);
      }
  if (!xs.length) return { x: 0, z: 0 };
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
}

// DAS parts and antennas (the items a design plan can show)
const isDasItem = (s) => s.kind === "das" || s.kind === "cellular";
const itemType = (s) => (s.kind === "cellular" ? "antenna" : s.dasType);

// the part and antenna ids on the design plan (ones whose item was deleted drop out)
export function designPlanIds(plan) {
  const ids = new Set(plan?.designPlan?.ids || []);
  return new Set((plan?.sources || []).filter((s) => isDasItem(s) && ids.has(s.id)).map((s) => s.id));
}

// the cable ids on the design plan: imported (or drawn here) and with both ends on it.
// A plan saved before cables were imported one by one shows every cable between its parts.
export function designPlanCableIds(plan, shown = designPlanIds(plan)) {
  const cables = cellularOf(plan).cables.filter((c) => shown.has(c.from) && shown.has(c.to));
  const kept = plan?.designPlan?.cableIds;
  if (!Array.isArray(kept)) return new Set(cables.map((c) => c.id));
  const ids = new Set(kept);
  return new Set(cables.filter((c) => ids.has(c.id)).map((c) => c.id));
}

// the plan with parts / cables put on (or taken off) the design plan
function withDesignPlan(p, { add = [], remove = [], addCables = [], removeCables = [] } = {}) {
  const dp = p.designPlan || {};
  const ids = new Set(dp.ids || []);
  // the first change to the cables keeps the ones shown so far
  const cableIds = new Set(Array.isArray(dp.cableIds) ? dp.cableIds : designPlanCableIds(p));
  const pos = { ...(dp.pos || {}) };
  for (const id of add) ids.add(id);
  for (const id of remove) {
    ids.delete(id);
    delete pos[id];
  }
  for (const id of addCables) cableIds.add(id);
  for (const id of removeCables) cableIds.delete(id);
  return { ...p, designPlan: { ...dp, ids: [...ids], cableIds: [...cableIds], pos } };
}

const TYPE_ORDER = { source: 0, riser: 1, coupler: 2, combiner: 3, splitter: 4, antenna: 5 };
const typeName = (s) => (s.kind === "cellular" ? "Antenna" : DAS_TYPES[s.dasType]?.label || "Part");
const byTypeThenName = (a, b) =>
  (TYPE_ORDER[itemType(a)] ?? 9) - (TYPE_ORDER[itemType(b)] ?? 9) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

// Where each part sits when it has not been dragged: floor bands, the signal left to right.
function layout(plan, shown, shownCables) {
  const cables = cellularOf(plan).cables.filter((c) => shownCables.has(c.id));
  const items = (plan.sources || []).filter((s) => isDasItem(s) && shown.has(s.id));
  const byId = new Map(items.map((s) => [s.id, s]));
  const children = new Map();
  const parent = new Map();
  for (const c of cables) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    if (!children.has(c.from)) children.set(c.from, []);
    children.get(c.from).push(c);
    parent.set(c.to, c.from);
  }
  // depth from the top of each tree (a source, or a part not fed yet)
  const depth = new Map();
  const roots = items.filter((s) => !parent.has(s.id));
  roots.sort((a, b) => (a.dasType === "source" ? -1 : 0) - (b.dasType === "source" ? -1 : 0));
  const order = [];
  const visit = (id, d) => {
    if (depth.has(id)) return;
    depth.set(id, d);
    order.push(id);
    for (const c of children.get(id) || []) visit(c.to, d + 1);
  };
  for (const r of roots) visit(r.id, r.kind === "cellular" ? 1 : 0);
  for (const s of items) visit(s.id, 0); // anything left (should not happen: no loops)

  // rows per floor: a node sits on the row of its first child on the same floor, else on a new row
  const floors = [...plan.floors].sort((a, b) => (+b.elevation || 0) - (+a.elevation || 0));
  const nextRow = new Map(floors.map((f) => [f.id, 0]));
  const row = new Map();
  const taken = new Set();
  const place = (id) => {
    if (row.has(id)) return;
    const s = byId.get(id);
    for (const c of children.get(id) || []) place(c.to);
    const same = (children.get(id) || []).find((c) => byId.get(c.to)?.floorId === s.floorId && !taken.has(c.to));
    if (same) {
      row.set(id, row.get(same.to));
      taken.add(same.to);
    } else {
      const r = nextRow.get(s.floorId) ?? 0;
      nextRow.set(s.floorId, r + 1);
      row.set(id, r);
    }
  };
  for (const id of order) place(id);

  let y = 0;
  const bands = floors.map((f) => {
    const rows = Math.max(1, nextRow.get(f.id) || 0);
    const band = { floor: f, y, h: rows * ROW_H + BAND_PAD * 2 };
    y += band.h;
    return band;
  });
  const bandOf = new Map(bands.map((b) => [b.floor.id, b]));
  const auto = new Map();
  for (const s of items) {
    const b = bandOf.get(s.floorId);
    if (!b) continue;
    auto.set(s.id, {
      x: LABEL_W + 24 + (depth.get(s.id) || 0) * COL_W,
      y: b.y + BAND_PAD + row.get(s.id) * ROW_H + (ROW_H - NODE_H) / 2,
    });
  }
  // a part dragged on the design plan keeps its own place
  const saved = plan.designPlan?.pos || {};
  const pos = new Map();
  for (const [id, p] of auto) {
    const s = saved[id];
    pos.set(id, s && Number.isFinite(+s.x) && Number.isFinite(+s.y) ? { x: +s.x, y: +s.y } : p);
  }
  const edges = cables.filter((c) => pos.has(c.from) && pos.has(c.to));
  return { items: items.filter((s) => pos.has(s.id)), pos, bands, edges, height: Math.max(y, 120) };
}

// The route of a cable between two boxes: out of the right side of the first,
// into the left side of the second (round the back when the second is to the left).
function edgePath(a, b) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  if (x2 - x1 >= 24) {
    const mx = Math.max(x1 + 12, x2 - 22);
    return { d: `M${x1},${y1} H${mx} V${y2} H${x2}`, x1, y1 };
  }
  const midY = Math.abs(y2 - y1) > NODE_H + 8 ? (y1 + y2) / 2 : Math.max(y1, y2) + NODE_H;
  return { d: `M${x1},${y1} H${x1 + 14} V${midY} H${x2 - 14} V${y2} H${x2}`, x1, y1 };
}

// The model of an item, as its datasheet names it
function modelName(s, catalogue) {
  if (s.kind === "cellular") return catalogue.antennas?.[s.antennaModelId]?.name || "";
  if (s.dasType === "source") return "BTS / repeater";
  const group = { splitter: catalogue.splitters, coupler: catalogue.couplers, combiner: catalogue.inline, riser: catalogue.risers }[s.dasType];
  return group?.[s.partId]?.name || "";
}

// Import: floors on the left (all, or one), the floor's BTS, risers, couplers,
// splitters, combiners, antennas and cables on the right (all, or one type).
// The ticked ones go onto the design plan; a cable brings its two ends with it.
export function ImportDialog({ plan, shown, shownCables, catalogue, startFloorId, onImport, onClose }) {
  const floors = useMemo(() => [...plan.floors].sort((a, b) => (+b.elevation || 0) - (+a.elevation || 0)), [plan.floors]);
  const [view, setView] = useState(floors.some((f) => f.id === startFloorId) ? startFloorId : "all");
  const [type, setType] = useState("all");
  const [ticked, setTicked] = useState(() => new Set()); // "part:<id>" / "cable:<id>"
  const items = useMemo(() => new Map((plan.sources || []).filter(isDasItem).map((s) => [s.id, s])), [plan.sources]);
  // every row the window can list: parts first (by type), then the cables, which belong to the floor they start on
  const rows = useMemo(() => {
    const parts = [...items.values()].sort(byTypeThenName).map((s) => ({
      key: `part:${s.id}`,
      kind: "part",
      type: itemType(s),
      floorId: s.floorId,
      item: s,
      on: shown.has(s.id),
    }));
    const cables = cellularOf(plan)
      .cables.filter((c) => items.has(c.from) && items.has(c.to))
      .map((c) => ({ key: `cable:${c.id}`, kind: "cable", type: "cable", floorId: items.get(c.from).floorId, cable: c, on: shownCables.has(c.id) }));
    return [...parts, ...cables];
  }, [plan, items, shown, shownCables]);
  const inType = (r) => type === "all" || r.type === type;
  const onFloor = (floorId) => rows.filter((r) => inType(r) && (floorId === "all" || r.floorId === floorId));
  const groups = (view === "all" ? floors : floors.filter((f) => f.id === view)).map((f) => ({ floor: f, list: onFloor(f.id) }));
  const visible = groups.flatMap((g) => g.list).filter((r) => !r.on);
  const allTicked = visible.length > 0 && visible.every((r) => ticked.has(r.key));
  const toggle = (keys, on) =>
    setTicked((t) => {
      const n = new Set(t);
      for (const k of keys) on ? n.add(k) : n.delete(k);
      return n;
    });
  const name = (id) => items.get(id)?.name || "?";
  const cablesOf = (id) => (plan.cellular?.cables || []).filter((c) => c.from === id || c.to === id).length;
  const typeCount = (t) => rows.filter((r) => !r.on && (t === "all" || r.type === t) && (view === "all" || r.floorId === view)).length;
  const importTicked = () => {
    const parts = [];
    const cables = [];
    for (const k of ticked) {
      const [kind, id] = k.split(":");
      (kind === "part" ? parts : cables).push(id);
    }
    onImport(parts, cables);
  };
  useEffect(() => {
    const key = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="das-import-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="das-import-dialog" role="dialog" aria-modal="true" aria-label="Import to the design plan">
        <header>
          <strong>Import to the design plan</strong>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="das-import-main">
          <nav aria-label="Floors">
            {[{ id: "all", name: "All floors" }, ...floors].map((f) => {
              const list = onFloor(f.id);
              const left = list.filter((r) => !r.on).length;
              return (
                <button key={f.id} type="button" className={view === f.id ? "active" : ""} onClick={() => setView(f.id)}>
                  <span>{f.name}</span>
                  <small title={`${left} not on the design plan, ${list.length} in all`}>
                    {left}/{list.length}
                  </small>
                </button>
              );
            })}
          </nav>
          <section>
            <div className="das-import-types" role="tablist" aria-label="Type">
              {IMPORT_TYPES.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={type === id} className={type === id ? "active" : ""} onClick={() => setType(id)}>
                  {id !== "all" && <i style={{ background: TYPE_COLOR[id] }} />}
                  {label}
                  <small>{typeCount(id)}</small>
                </button>
              ))}
            </div>
            <div className="das-import-tools">
              <label>
                <input type="checkbox" checked={allTicked} disabled={!visible.length} onChange={() => toggle(visible.map((r) => r.key), !allTicked)} />
                Select all
              </label>
              <span>{ticked.size} selected</span>
            </div>
            <div className="das-import-rows">
              {groups.map(({ floor, list }) => (
                <div key={floor.id}>
                  {view === "all" && <h5>{floor.name}</h5>}
                  {!list.length && (
                    <p className="das-import-none">
                      No {type === "all" ? "DAS parts, antennas or cables" : IMPORT_TYPES.find(([id]) => id === type)[1].toLowerCase() + "s"} on {floor.name}.
                    </p>
                  )}
                  {list.map((r) => {
                    const box = (
                      <input type="checkbox" checked={r.on || ticked.has(r.key)} disabled={r.on} onChange={(e) => toggle([r.key], e.target.checked)} />
                    );
                    if (r.kind === "cable") {
                      const c = r.cable;
                      const port = cablePortLabel(plan, c);
                      return (
                        <label key={r.key} className={r.on ? "on-plan" : ""}>
                          {box}
                          <i className="das-import-wire" />
                          <span className="das-import-name">
                            {name(c.from)}
                            {port && port !== "Out" ? ` (${port})` : ""} → {name(c.to)}
                          </span>
                          <span className="das-import-type">Cable</span>
                          <span className="das-import-model">{catalogue.cables[c.cableId]?.name || c.cableId}</span>
                          <span className="das-import-cables">{cableLengthM(plan, c).toFixed(1)} m</span>
                          {r.on && <em>On plan</em>}
                        </label>
                      );
                    }
                    const s = r.item;
                    const n = cablesOf(s.id);
                    return (
                      <label key={r.key} className={r.on ? "on-plan" : ""}>
                        {box}
                        <i style={{ background: TYPE_COLOR[r.type] || "#57534e" }} />
                        <span className="das-import-name">{s.name}</span>
                        <span className="das-import-type">{typeName(s)}</span>
                        <span className="das-import-model">{modelName(s, catalogue)}</span>
                        <span className="das-import-cables">{n ? `${n} cable${n === 1 ? "" : "s"}` : "no cables"}</span>
                        {r.on && <em>On plan</em>}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        </div>
        <footer>
          <span className="das-import-hint">A cable brings its two ends with it.</span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!ticked.size} onClick={importTicked}>
            Import{ticked.size ? ` ${ticked.size}` : ""}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default function DasSchematic({ plan, mutate, uid, carrier, onOpenFloor, setMessage }) {
  const [addFloorId, setAddFloorId] = useState(plan.selectedFloorId || plan.floors[0]?.id);
  const [options, setOptions] = useState({ splitter: "s2", coupler: "c10", combiner: "cm21" });
  const [connect, setConnect] = useState(false);
  const [first, setFirst] = useState(null);
  const [selected, setSelected] = useState(null); // { type: "part" | "cable", id }
  const catalogue = useMemo(() => dasCatalogue(plan), [plan]);
  const shown = useMemo(() => designPlanIds(plan), [plan]);
  const shownCables = useMemo(() => designPlanCableIds(plan, shown), [plan, shown]);
  const { items, pos, bands, edges, height } = useMemo(() => layout(plan, shown, shownCables), [plan, shown, shownCables]);
  const [importOpen, setImportOpen] = useState(false);
  const notShown =
    (plan.sources || []).filter((s) => isDasItem(s) && !shown.has(s.id)).length +
    cellularOf(plan).cables.filter((c) => !shownCables.has(c.id)).length;
  const importItems = (parts, cables) => {
    const all = cellularOf(plan).cables;
    // a cable comes with its two ends
    const ends = cables.flatMap((id) => {
      const c = all.find((x) => x.id === id);
      return c ? [c.from, c.to] : [];
    });
    if (parts.length || cables.length) mutate((p) => withDesignPlan(p, { add: [...parts, ...ends], addCables: cables }));
    setImportOpen(false);
  };
  const powers = useMemo(() => (carrier && (plan.cellular?.cables || []).length ? dasPowers(plan, carrier) : null), [plan, carrier]);
  const floorName = (id) => plan.floors.find((f) => f.id === id)?.name || "?";
  const addTo = plan.floors.some((f) => f.id === addFloorId) ? addFloorId : plan.floors[0]?.id;

  // ---- dragging a part: only its place on the design plan changes
  const [drag, setDrag] = useState(null); // { id, sx, sy, ox, oy, x, y, moved }
  const dragRef = useRef(null); // the same, for the window listeners
  const justDragged = useRef(false);
  const posOf = (id) => (drag?.id === id && drag.moved ? { x: drag.x, y: drag.y } : pos.get(id));
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);
      dragRef.current = { ...d, moved: d.moved || Math.hypot(dx, dy) > 3, x: snap(d.ox + dx), y: snap(d.oy + dy) };
      setDrag(dragRef.current);
    };
    // one change (one undo step) per drag
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return;
      justDragged.current = true;
      mutate((p) => {
        const dp = p.designPlan || {};
        return { ...p, designPlan: { ...dp, pos: { ...(dp.pos || {}), [d.id]: { x: d.x, y: d.y } } } };
      });
      setSelected({ type: "part", id: d.id });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // the listeners live as long as one drag; its values are read from dragRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);
  const startDrag = (e, id) => {
    justDragged.current = false;
    if (e.button !== 0 || connect) return;
    e.stopPropagation();
    e.preventDefault(); // no text selection while dragging
    const p = pos.get(id);
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, x: p.x, y: p.y, moved: false };
    setDrag(dragRef.current);
  };
  const autoArrange = () => {
    if (!Object.keys(plan.designPlan?.pos || {}).length) return;
    mutate((p) => ({ ...p, designPlan: { ...(p.designPlan || {}), pos: {} } }));
    setMessage?.("Design plan arranged by floor again. Undo puts the parts back where you dragged them.");
  };

  const addPart = (dasType) => {
    if (!addTo) return;
    const at = floorCentre(plan, addTo);
    // offset each new part a little so they do not land on top of each other on the floor plan
    const n = (plan.sources || []).filter((s) => s.floorId === addTo && s.kind === "das").length;
    const part = newDasPart(plan, dasType, addTo, { x: at.x + (n % 5) * 1.5, z: at.z + Math.floor(n / 5) * 1.5 }, uid(), {
      partId: options[dasType],
    });
    mutate((p) => withDesignPlan({ ...p, sources: [...p.sources, part] }, { add: [part.id] }));
    setSelected({ type: "part", id: part.id });
    setMessage?.(`${part.name} added to ${floorName(addTo)}. Move it to its place on the floor plan when ready.`);
  };

  const clickNode = (id) => {
    if (!connect) {
      setSelected({ type: "part", id });
      return;
    }
    if (!first) {
      setFirst(id);
      return;
    }
    if (first === id) {
      setFirst(null);
      return;
    }
    const dir = orientCable(plan, first, id);
    const problem = dir.problem || cableProblem(plan, dir.from, dir.to);
    if (problem) {
      setMessage?.(problem);
      setFirst(null);
      return;
    }
    const c = newCable(plan, dir.from, dir.to, uid());
    mutate((p) => {
      const cur = cellularOf(p);
      return withDesignPlan({ ...p, cellular: { ...(p.cellular || {}), ...cur, cables: [...cur.cables, c] } }, { addCables: [c.id] });
    });
    setFirst(null);
    setSelected({ type: "cable", id: c.id });
  };

  // a part turned into another kind (e.g. a BTS that should be a shaft); its cables stay
  const changeKind = (id, dasType) => {
    const r = changeDasType(plan, id, dasType);
    if (r.problem) {
      setMessage?.(r.problem);
      return;
    }
    mutate((p) => {
      const next = changeDasType(p, id, dasType);
      return next.plan ? { ...next.plan, cellular: { ...(p.cellular || {}), ...next.plan.cellular } } : p;
    });
  };
  const updatePart = (id, patch) => mutate((p) => ({ ...p, sources: p.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const updateCable = (id, patch) =>
    mutate((p) => {
      const cur = cellularOf(p);
      return { ...p, cellular: { ...(p.cellular || {}), ...cur, cables: cur.cables.map((c) => (c.id === id ? { ...c, ...patch } : c)) } };
    });
  const removeSelected = () => {
    if (!selected) return;
    if (selected.type === "cable")
      mutate((p) => {
        const cur = cellularOf(p);
        return withDesignPlan(
          { ...p, cellular: { ...(p.cellular || {}), ...cur, cables: cur.cables.filter((c) => c.id !== selected.id) } },
          { removeCables: [selected.id] },
        );
      });
    else mutate((p) => withDesignPlan(withoutLooseCables({ ...p, sources: p.sources.filter((s) => s.id !== selected.id) }), { remove: [selected.id] }));
    setSelected(null);
  };
  // takes the part or cable off the design plan only: it stays on the floor plan
  const hideSelected = () => {
    if (!selected) return;
    mutate((p) => withDesignPlan(p, selected.type === "cable" ? { removeCables: [selected.id] } : { remove: [selected.id] }));
    setSelected(null);
  };

  const part = selected?.type === "part" ? plan.sources.find((s) => s.id === selected.id) : null;
  const cable = selected?.type === "cable" ? cellularOf(plan).cables.find((c) => c.id === selected.id) : null;
  const nameOf = (id) => plan.sources.find((s) => s.id === id)?.name || "?";
  const powerAt = (s) => (s.kind === "cellular" ? powers?.antennas[s.id]?.powerDbm : powers?.nodeInputDbm[s.id]);
  const partChoices = (dasType) =>
    ({ splitter: catalogue.splitters, coupler: catalogue.couplers, combiner: catalogue.inline, riser: catalogue.risers })[dasType] || null;

  // the drawing grows with the parts dragged right or down
  let width = LABEL_W + 24 + COL_W + 40;
  let fullHeight = height;
  for (const s of items) {
    const p = posOf(s.id);
    width = Math.max(width, p.x + NODE_W + 80);
    fullHeight = Math.max(fullHeight, p.y + NODE_H + 40);
  }
  const hasDragged = Object.keys(plan.designPlan?.pos || {}).some((id) => shown.has(id));

  return (
    <div className="das-schematic">
      <div className="das-schematic-toolbar">
        <label>
          Add to
          <select value={addTo || ""} onChange={(e) => setAddFloorId(e.target.value)}>
            {plan.floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <span className="das-schematic-sep" />
        <button type="button" onClick={() => addPart("source")} title="Source: BTS or repeater">
          <i style={{ background: TYPE_COLOR.source }} /> BTS
        </button>
        <span className="das-schematic-split">
          <button type="button" onClick={() => addPart("coupler")}>
            <i style={{ background: TYPE_COLOR.coupler }} /> Coupler
          </button>
          <select value={options.coupler} onChange={(e) => setOptions((o) => ({ ...o, coupler: e.target.value }))} aria-label="Coupler type">
            {Object.values(catalogue.couplers).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </span>
        <span className="das-schematic-split">
          <button type="button" onClick={() => addPart("splitter")}>
            <i style={{ background: TYPE_COLOR.splitter }} /> Splitter
          </button>
          <select value={options.splitter} onChange={(e) => setOptions((o) => ({ ...o, splitter: e.target.value }))} aria-label="Splitter type">
            {Object.values(catalogue.splitters).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </span>
        <span className="das-schematic-split">
          <button type="button" onClick={() => addPart("combiner")}>
            <i style={{ background: TYPE_COLOR.combiner }} /> Combiner
          </button>
          <select value={options.combiner} onChange={(e) => setOptions((o) => ({ ...o, combiner: e.target.value }))} aria-label="Combiner type">
            {Object.values(catalogue.inline).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </span>
        <button type="button" onClick={() => addPart("riser")} title="Shaft (riser): takes the feeder from the BTS or a part and carries it to another floor">
          <i style={{ background: TYPE_COLOR.riser }} /> Shaft
        </button>
        <span className="das-schematic-sep" />
        <button type="button" onClick={() => setImportOpen(true)} title="Choose parts, antennas and cables from the floors to show on the design plan">
          ⇩ Import{notShown ? ` (${notShown})` : ""}
        </button>
        <button
          type="button"
          className={connect ? "active" : ""}
          onClick={() => {
            setConnect((v) => !v);
            setFirst(null);
          }}
          title="Join two parts or a part and an antenna with a cable"
        >
          ⌇ {connect ? (first ? `From ${nameOf(first)}: click the other end` : "Click the first end") : "Connect"}
        </button>
        <button type="button" onClick={autoArrange} disabled={!hasDragged} title="Put every part back in its floor band (the floor plans are not changed)">
          ▦ Auto arrange
        </button>
        <span className="das-schematic-fill" />
        <span className="das-schematic-band">{carrier ? `Power at ${carrier.name || carrier.band || "band"}` : "Choose a band in Prediction to see powers"}</span>
      </div>

      <div className="das-schematic-body">
        <div
          className="das-schematic-canvas"
          onClick={() => {
            if (!connect) setSelected(null);
          }}
        >
          <svg width={width} height={fullHeight} role="img" aria-label="DAS schematic" className={drag?.moved ? "dragging" : ""}>
            {bands.map((b, i) => (
              <g key={b.floor.id}>
                <rect x={0} y={b.y} width={width} height={b.h} fill={i % 2 ? "#f7faf9" : "#fff"} />
                <line x1={0} x2={width} y1={b.y + b.h} y2={b.y + b.h} stroke="#dce7e2" />
                <text x={14} y={b.y + 26} className="das-band-name">
                  {b.floor.name}
                </text>
                <text x={14} y={b.y + 44} className="das-band-sub">
                  {(+b.floor.elevation || 0).toFixed(1)} m
                </text>
                <line x1={LABEL_W} x2={LABEL_W} y1={b.y} y2={b.y + b.h} stroke="#e6eeeb" />
              </g>
            ))}
            {edges.map((c) => {
              const { d, x1, y1 } = edgePath(posOf(c.from), posOf(c.to));
              const on = selected?.type === "cable" && selected.id === c.id;
              const label = cablePortLabel(plan, c);
              return (
                <g
                  key={c.id}
                  className="das-edge"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected({ type: "cable", id: c.id });
                  }}
                >
                  <path d={d} fill="none" stroke="transparent" strokeWidth={10} />
                  <path d={d} fill="none" stroke={on ? "#ea580c" : c.cableId === "7/8" ? "#44403c" : "#6b8079"} strokeWidth={on ? 3 : c.cableId === "7/8" ? 2.5 : 1.6} />
                  {/* the output port above the cable where it leaves, its length below it */}
                  {label && label !== "Out" && (
                    <text x={x1 + 5} y={y1 - 5} className="das-edge-port">
                      {label}
                    </text>
                  )}
                  <text x={x1 + 5} y={y1 + 13} className="das-edge-len">
                    {cableLengthM(plan, c).toFixed(1)} m
                  </text>
                </g>
              );
            })}
            {items.map((s) => {
              const p = posOf(s.id);
              const color = TYPE_COLOR[itemType(s)] || "#57534e";
              const sub = s.kind === "cellular" ? "Antenna" : partChoices(s.dasType)?.[s.partId]?.name || DAS_TYPES[s.dasType]?.label;
              const on = (selected?.type === "part" && selected.id === s.id) || first === s.id;
              const pw = powerAt(s);
              return (
                <g
                  key={s.id}
                  className={`das-node ${drag?.id === s.id && drag.moved ? "is-dragging" : ""}`}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={(e) => startDrag(e, s.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (justDragged.current) {
                      justDragged.current = false;
                      return;
                    }
                    clickNode(s.id);
                  }}
                  onDoubleClick={() => onOpenFloor?.(s.floorId, s.id)}
                >
                  <rect width={NODE_W} height={NODE_H} rx={7} fill="#fff" stroke={on ? "#ea580c" : color} strokeWidth={on ? 2.5 : 1.4} />
                  <rect width={6} height={NODE_H} rx={3} fill={color} />
                  <text x={14} y={18} className="das-node-name">
                    {s.name}
                  </text>
                  <text x={14} y={33} className="das-node-sub">
                    {String(sub || "").slice(0, 18)}
                  </text>
                  {pw != null && (
                    <text x={NODE_W / 2} y={NODE_H + 13} textAnchor="middle" className="das-node-power">
                      {fmt(pw)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {!items.length && (
            <div className="das-schematic-empty">
              The design plan is empty. Add a <strong>BTS</strong>, couplers, splitters or risers with the buttons above, or use{" "}
              <strong>Import</strong> to bring in only the parts, antennas and cables you want from each floor. Join them with{" "}
              <strong>Connect</strong> and drag them where you like.
            </div>
          )}
        </div>

        {(part || cable) && (
          <aside className="das-schematic-inspector">
            {part && (
              <>
                <h4>{typeName(part)}</h4>
                <label>
                  Name
                  <input value={part.name || ""} onChange={(e) => updatePart(part.id, { name: e.target.value })} />
                </label>
                {part.kind === "das" && (
                  <label>
                    Part
                    <select value={part.dasType} onChange={(e) => changeKind(part.id, e.target.value)}>
                      {["source", "riser", "coupler", "splitter", "combiner"].map((t) => (
                        <option key={t} value={t}>
                          {t === "source" ? "BTS / repeater (source)" : DAS_TYPES[t].label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {part.kind === "das" && partChoices(part.dasType) && (
                  <label>
                    Type
                    <select value={part.partId || ""} onChange={(e) => updatePart(part.id, { partId: e.target.value })}>
                      {Object.values(partChoices(part.dasType)).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {part.dasType === "source" && carrier && (
                  <label>
                    Output power ({carrier.name || carrier.band}), dBm
                    <input
                      type="number"
                      value={part.powerDbm?.[carrier.id] ?? part.defaultPowerDbm ?? 43}
                      onChange={(e) => updatePart(part.id, { powerDbm: { ...(part.powerDbm || {}), [carrier.id]: Number(e.target.value) } })}
                    />
                  </label>
                )}
                <label>
                  Floor
                  <select value={part.floorId} onChange={(e) => updatePart(part.id, { floorId: e.target.value })}>
                    {plan.floors.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                {powerAt(part) != null && <p className="das-inspector-note">{part.kind === "cellular" ? "Port power" : "Input"}: {fmt(powerAt(part))}</p>}
                <div className="das-inspector-actions">
                  <button type="button" onClick={() => onOpenFloor?.(part.floorId, part.id)}>
                    Show on floor
                  </button>
                  <button type="button" onClick={hideSelected} title="Take it off the design plan; it stays on its floor plan">
                    Remove from plan
                  </button>
                  <button type="button" className="danger" onClick={removeSelected}>
                    Delete
                  </button>
                </div>
              </>
            )}
            {cable && (
              <>
                <h4>Cable</h4>
                <p className="das-inspector-note">
                  {nameOf(cable.from)} {cablePortLabel(plan, cable) && `(${cablePortLabel(plan, cable)})`} → {nameOf(cable.to)}
                </p>
                <label>
                  Cable
                  <select value={cable.cableId} onChange={(e) => updateCable(cable.id, { cableId: e.target.value })}>
                    {Object.values(catalogue.cables).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Extra length, m
                  <input type="number" min={0} value={cable.extraM ?? 0} onChange={(e) => updateCable(cable.id, { extraM: Number(e.target.value) || 0 })} />
                </label>
                <label>
                  Connectors
                  <input type="number" min={0} value={cable.connectors ?? 2} onChange={(e) => updateCable(cable.id, { connectors: Number(e.target.value) || 0 })} />
                </label>
                <p className="das-inspector-note">Length {cableLengthM(plan, cable).toFixed(1)} m</p>
                {carrier &&
                  (() => {
                    const l = cableLossAt(plan, cable, carrier.freqMHz);
                    return l.error ? null : <p className="das-inspector-note">Loss {l.totalDb.toFixed(2)} dB at {carrier.freqMHz} MHz</p>;
                  })()}
                <div className="das-inspector-actions">
                  <button type="button" onClick={hideSelected} title="Take it off the design plan; it stays on the floor plan">
                    Remove from plan
                  </button>
                  <button type="button" className="danger" onClick={removeSelected}>
                    Delete cable
                  </button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      {importOpen && (
        <ImportDialog
          plan={plan}
          shown={shown}
          shownCables={shownCables}
          catalogue={catalogue}
          startFloorId={plan.selectedFloorId}
          onImport={importItems}
          onClose={() => setImportOpen(false)}
        />
      )}
      {powers && (powers.errors.length > 0 || powers.warnings.length > 0) && (
        <div className="das-schematic-warnings">
          {[...powers.errors, ...powers.warnings].slice(0, 4).map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}
    </div>
  );
}
