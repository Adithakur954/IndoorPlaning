import React, { useEffect, useMemo, useState } from "react";
import Field from "../ui/Field.jsx";
import CablingMap from "../planner/CablingMap.jsx";
import { uid } from "../../models/plan.js";
import { downloadBlob } from "../../utils/sceneExport.js";
import { floorRoutingInput } from "../../infra/core/planGeometry.js";
import { suggestRacks } from "../../infra/wifi/racks.js";
import CatalogueEditor from "../planner/CatalogueEditor.jsx";
import { mergeCatalogue, sourceSummary } from "../../infra/wifi/catalogueEdit.js";
import { emptyHistory, pushHistory, recordChange, redo as redoHistory, undo as undoHistory } from "../../infra/wifi/history.js";
import { compareFieldTest, parseFieldTestCsv } from "../../infra/wifi/fieldTest.js";
import { requestDesign } from "../../infra/wifi/designClient.js";
import {
  CEILING_TYPES,
  SLAB,
  VOID_ACCESS,
  WALL_MARKS,
  WALL_MARK_LABELS,
  withDefaults,
} from "../../infra/core/pathway.js";
import { buildWifiSchematic } from "../../infra/wifi/schematic.js";
import { buildWifiLayoutSchematic } from "../../infra/wifi/layoutSchematic.js";
import { blobToDataUrl, svgToPngBlob } from "../../infra/core/raster.js";
import { buildFloorSvg } from "../../infra/wifi/floorSvg.js";
import { buildRiserSvg } from "../../infra/wifi/riserSvg.js";
import { buildRackElevationSvg, buildTopologySvg } from "../../infra/wifi/rackSvg.js";
import { complianceRows } from "../../infra/wifi/compliance.js";
import { wifiPptx, wifiWorkbook } from "../../infra/wifi/exports.js";
import {
  checkPositionsCabling,
  designWifiCabling,
} from "../../infra/wifi/design.js";
import {
  DEFAULT_WIFI_CATALOGUE,
  DEFAULT_WIFI_RULES,
} from "../../infra/wifi/catalogue.js";

const EMPTY = { racks: [], risers: [], rules: {} };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const names = (group) =>
  Object.fromEntries(Object.values(group).map((p) => [p.id, p.name]));

// Wi-Fi cabling: racks, risers, the routed runs, a bill of quantities and the
// checks. It reads the plan and stores only its own settings in plan.cabling,
// so the rest of the project is not touched.
export default function CablingPanel({ plan, floorId, mutate, optimization, projectName = "" }) {
  const cabling = { ...EMPTY, ...(plan.cabling || {}) };
  const rules = { ...DEFAULT_WIFI_RULES, ...cabling.rules };
  const pathway = withDefaults(cabling.pathway);
  const catalogue = useMemo(() => mergeCatalogue(cabling.catalogue), [cabling.catalogue]);
  const [placing, setPlacing] = useState(null); // "rack" | "riser" | null
  const [wallMode, setWallMode] = useState(false);
  const [drawMode, setDrawMode] = useState(null); // "tray" | "nogo"
  const [routeMode, setRouteMode] = useState(false);
  const [selectedAp, setSelectedAp] = useState(null);
  const [draft, setDraft] = useState([]);
  const [selectedWall, setSelectedWall] = useState(null);
  const [error, setError] = useState("");
  const [suggestNotes, setSuggestNotes] = useState([]);
  const floor = plan.floors.find((f) => f.id === floorId) || plan.floors[0];

  // Every change is recorded in the audit trail and can be undone.
  const [history, setHistory] = useState(emptyHistory());
  const setCabling = (fn, summary) => {
    const before = { ...EMPTY, ...(plan.cabling || {}) };
    const next = recordChange(before, fn(before), { summary });
    if (next === before) return;
    setHistory((h) => pushHistory(h, before));
    mutate((p) => ({ ...p, cabling: next }));
  };
  const undoLast = () => {
    const r = undoHistory(history, { ...EMPTY, ...(plan.cabling || {}) });
    if (!r) return;
    setHistory(r.history);
    mutate((p) => ({ ...p, cabling: r.state }));
  };
  const redoLast = () => {
    const r = redoHistory(history, { ...EMPTY, ...(plan.cabling || {}) });
    if (!r) return;
    setHistory(r.history);
    mutate((p) => ({ ...p, cabling: r.state }));
  };
  const setRule = (key, value) =>
    setCabling((c) => ({ ...c, rules: { ...c.rules, [key]: value } }));
  const patchList = (key, id, changes) =>
    setCabling((c) => ({
      ...c,
      [key]: c[key].map((x) => (x.id === id ? { ...x, ...changes } : x)),
    }));
  // ceiling and wall facts: what a cable may pass (see core/pathway.js)
  const setPathway = (fn) =>
    setCabling((c) => ({ ...c, pathway: fn(withDefaults(c.pathway)) }));
  const setCeiling = (key, value) =>
    setPathway((p) => ({ ...p, ceiling: { ...p.ceiling, [key]: value } }));
  const setRoomCeiling = (roomId, key, value) =>
    setPathway((p) => {
      const room = { ...(p.roomOverrides[roomId] || {}) };
      if (value === "") delete room[key];
      else room[key] = value;
      const overrides = { ...p.roomOverrides };
      if (Object.keys(room).length) overrides[roomId] = room;
      else delete overrides[roomId];
      return { ...p, roomOverrides: overrides };
    });
  // a person's edit of one AP's route: waypoints and approval
  const setRouteEdit = (apId, fn) =>
    setPathway((p) => {
      const next = fn(p.routeEdits[apId] || { waypoints: [], confirmed: false });
      const edits = { ...p.routeEdits };
      if (!next.waypoints.length && !next.confirmed) delete edits[apId];
      else edits[apId] = next;
      return { ...p, routeEdits: edits };
    });
  const onRouteClick = ({ at, apId }) => {
    if (apId) return setSelectedAp(apId);
    if (selectedAp) setRouteEdit(selectedAp, (e) => ({ ...e, waypoints: [...e.waypoints, at] }));
  };
  const startDraw = (mode) => {
    setDrawMode(drawMode === mode ? null : mode);
    setDraft([]);
    setRouteMode(false);
    setWallMode(false);
    setSelectedWall(null);
    setPlacing(null);
  };
  const finishDraw = () => {
    const need = drawMode === "nogo" ? 3 : 2;
    if (draft.length < need) return;
    if (drawMode === "power") {
      setPathway((p) => ({ ...p, powerRoutes: [...p.powerRoutes, { id: uid(), name: `Power ${p.powerRoutes.length + 1}`, floorId: floor.id, points: draft }] }));
      setDraft([]);
      setDrawMode(null);
      return;
    }
    if (drawMode === "tray")
      setPathway((p) => ({
        ...p,
        trays: [...p.trays, { id: uid(), name: `Tray ${p.trays.length + 1}`, floorId: floor.id, points: draft, kind: "new", status: "estimated" }],
      }));
    else
      setPathway((p) => ({
        ...p,
        noGo: [...p.noGo, { id: uid(), name: `No-go ${p.noGo.length + 1}`, floorId: floor.id, polygon: draft, reason: "" }],
      }));
    setDraft([]);
    setDrawMode(null);
  };
  const patchPathwayItem = (key, id, changes) =>
    setPathway((p) => ({ ...p, [key]: p[key].map((x) => (x.id === id ? { ...x, ...changes } : x)) }));
  const removePathwayItem = (key, id) =>
    setPathway((p) => ({ ...p, [key]: p[key].filter((x) => x.id !== id) }));
  const markWall = (key, mark) =>
    setPathway((p) => {
      const marks = { ...p.wallOverrides };
      if (mark === "default") delete marks[key];
      else marks[key] = mark;
      return { ...p, wallOverrides: marks };
    });
  const removeFrom = (key, id) =>
    setCabling((c) => ({ ...c, [key]: c[key].filter((x) => x.id !== id) }));

  const centre = () => {
    const input = floorRoutingInput(plan, floor.id);
    if (!input) return { x: 1, z: 1 };
    const b = input.bounds;
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  };
  const addRack = (at = centre()) =>
    setCabling((c) => ({
      ...c,
      racks: [
        ...c.racks,
        { id: uid(), name: `Rack ${c.racks.length + 1}`, floorId: floor.id, ...at },
      ],
    }));
  const addRiser = (at = centre()) =>
    setCabling((c) => ({
      ...c,
      risers: [...c.risers, { id: uid(), name: `Riser ${c.risers.length + 1}`, ...at }],
    }));
  // Suggest racks for the floors that have APs but no rack of your own. Racks
  // you placed or confirmed are kept; earlier suggestions are replaced.
  const suggest = () => {
    const kept = cabling.racks.filter((r) => !r.suggested);
    const wanted = plan.floors
      .map((f) => f.id)
      .filter((id) => !kept.some((r) => r.floorId === id));
    const result = suggestRacks({ plan, rules: cabling.rules, pathway: cabling.pathway, floorIds: wanted });
    setCabling((c) => ({ ...c, racks: [...c.racks.filter((r) => !r.suggested), ...result.racks] }));
    setSuggestNotes([
      ...result.notes,
      ...result.uncovered.map((u) => `${u.apName}: no rack within reach`),
    ]);
  };
  // "Optimise and cable": put the optimiser's APs in the plan, then suggest racks for them.
  const [pendingSuggest, setPendingSuggest] = useState(false);
  const applyAndCable = () => {
    optimization.applyRecommendations();
    setPendingSuggest(true);
  };
  useEffect(() => {
    if (!pendingSuggest) return;
    setPendingSuggest(false);
    suggest();
  }, [plan.sources]); // eslint-disable-line react-hooks/exhaustive-deps
  const onPlace = (at) => {
    if (placing === "rack") addRack(at);
    if (placing === "riser") addRiser(at);
    setPlacing(null);
  };

  const wallsNow = useMemo(
    () => floorRoutingInput(plan, floor.id, cabling.pathway)?.walls || [],
    [plan.rooms, plan.doors, plan.interiorWalls, plan.boundaries, floor.id, plan.cabling], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The design is calculated off the page's main thread, and only when something it
  // depends on changes. Only the parts of the plan it needs are sent to the worker.
  const designPlan = useMemo(
    () => ({
      floors: plan.floors, rooms: plan.rooms, doors: plan.doors, windows: plan.windows,
      interiorWalls: plan.interiorWalls, boundaries: plan.boundaries, furniture: plan.furniture,
      sources: plan.sources, wallTypes: plan.wallTypes,
    }),
    [plan.floors, plan.rooms, plan.doors, plan.windows, plan.interiorWalls, plan.boundaries, plan.furniture, plan.sources, plan.wallTypes],
  );
  const [designState, setDesignState] = useState({ value: null, error: "", busy: true });
  useEffect(() => {
    let alive = true;
    setDesignState((st) => ({ ...st, busy: true }));
    const timer = setTimeout(() => {
      requestDesign({
        plan: designPlan,
        racks: cabling.racks,
        risers: cabling.risers,
        pathway: cabling.pathway,
        rules: cabling.rules,
        catalogue,
      })
        .then((r) => {
          if (alive && r.design) setDesignState({ value: r.design, error: "", busy: false });
        })
        .catch((e) => alive && setDesignState((st) => ({ ...st, error: e.message, busy: false })));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [designPlan, plan.cabling]); // eslint-disable-line react-hooks/exhaustive-deps (the catalogue is part of plan.cabling)
  const design = designState.error ? { error: designState.error } : { value: designState.value };
  const d = design.value;
  const errors = d?.violations.filter((v) => v.severity === "error") || [];
  const warnings = d?.violations.filter((v) => v.severity === "warning") || [];
  const apCount = plan.sources.filter((s) => s.kind === "wifi").length;

  // "layout": drawn where the rack and APs really are. "tree": branches in levels, APs in one row.
  const [schematicView, setSchematicView] = useState("layout");
  const [view, setView] = useState("layout");
  const [fitDiagrams, setFitDiagrams] = useState(true);
  const schematic = useMemo(() => {
    if (!d || !d.runs.length) return null;
    const build = schematicView === "tree" ? buildWifiSchematic : buildWifiLayoutSchematic;
    return build({
      design: d,
      plan,
      racks: cabling.racks,
      catalogue,
      projectName,
      date: new Date().toISOString().slice(0, 10),
    });
  }, [d, schematicView]); // eslint-disable-line react-hooks/exhaustive-deps
  const downloadSchematic = async (kind) => {
    try {
      if (kind === "svg")
        downloadBlob(new Blob([schematic.svg], { type: "image/svg+xml" }), "wifi-network-schematic.svg");
      else
        downloadBlob(await svgToPngBlob(schematic.svg, schematic.width, schematic.height), "wifi-network-schematic.png");
    } catch (e) {
      setError(e.message);
    }
  };

  // Rasterises the drawings (a browser job) for the Excel and PowerPoint files.
  const drawings = async () => {
    const out = { floors: [], schematic: null, riser: null };
    for (const [key, diagram] of [["rack", rackDiagram], ["topology", topology]]) {
      if (!diagram) continue;
      const blob = await svgToPngBlob(diagram.svg, diagram.width, diagram.height);
      out[key] = { dataUrl: await blobToDataUrl(blob), width: diagram.width, height: diagram.height };
    }
    if (riserDiagram) {
      const blob = await svgToPngBlob(riserDiagram.svg, riserDiagram.width, riserDiagram.height);
      out.riser = { dataUrl: await blobToDataUrl(blob), width: riserDiagram.width, height: riserDiagram.height };
    }
    if (schematic) {
      const blob = await svgToPngBlob(schematic.svg, schematic.width, schematic.height);
      out.schematic = { dataUrl: await blobToDataUrl(blob), width: schematic.width, height: schematic.height };
    }
    for (const f of plan.floors) {
      if (!d.runs.some((r) => r.floorId === f.id)) continue;
      const drawn = buildFloorSvg({ plan, floorId: f.id, design: d, racks: cabling.racks, risers: cabling.risers, pathway: cabling.pathway, title: f.name });
      if (!drawn) continue;
      const blob = await svgToPngBlob(drawn.svg, drawn.width, drawn.height, 1.5);
      out.floors.push({ name: f.name, dataUrl: await blobToDataUrl(blob), width: drawn.width, height: drawn.height });
    }
    return out;
  };
  const fieldTest = useMemo(
    () => (d && cabling.fieldTest?.length ? compareFieldTest(d, cabling.fieldTest) : null),
    [d, cabling.fieldTest],
  );
  const [fieldTestError, setFieldTestError] = useState("");
  const loadFieldTest = async (file) => {
    try {
      const rows = parseFieldTestCsv(await file.text());
      setCabling((c) => ({ ...c, fieldTest: rows }), "Field test results imported");
      setFieldTestError("");
    } catch (e) {
      setFieldTestError(e.message);
    }
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const [exporting, setExporting] = useState("");
  const download = async (kind) => {
    setExporting(kind);
    setError("");
    try {
      const images = await drawings();
      const meta = { projectName, date: today(), history: cabling.auditLog || [], fieldTest };
      if (kind === "excel") {
        const wb = await wifiWorkbook(d, { ...meta, schematic: images.schematic });
        downloadBlob(new Blob([await wb.xlsx.writeBuffer()], { type: XLSX }), "wifi-cabling-design.xlsx");
      } else {
        const pptx = await wifiPptx(d, { ...meta, images });
        downloadBlob(await pptx.write({ outputType: "blob" }), "wifi-cabling-report.pptx");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting("");
    }
  };

  const rackDiagram = useMemo(() => (d ? buildRackElevationSvg({ design: d, racks: cabling.racks }) : null), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const topology = useMemo(() => (d && d.network?.racks?.length > 1 ? buildTopologySvg({ design: d }) : null), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const riserDiagram = useMemo(
    () => (d ? buildRiserSvg({ design: d, plan, risers: cabling.risers, racks: cabling.racks }) : null),
    [d], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // the optimiser's recommended positions are not in the plan yet: check them
  const recommendations = optimization?.opt?.result?.recommendations || [];
  const positionCheck = useMemo(() => {
    if (!recommendations.length || !cabling.racks.length) return null;
    try {
      return checkPositionsCabling({
        plan,
        racks: cabling.racks,
        risers: cabling.risers,
        pathway: cabling.pathway,
        rules: cabling.rules,
        catalogue,
        positions: recommendations.map((r, i) => ({
          id: `rec-${i}`,
          name: `Recommended AP ${i + 1}`,
          floorId: r.floorId,
          x: r.planX,
          z: r.planZ,
          heightM: r.heightM,
        })),
      });
    } catch {
      return null;
    }
  }, [optimization?.opt?.jobId, plan.cabling, plan.rooms]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (key, group, label) => (
    <Field
      label={label}
      type="select"
      value={rules[key]}
      options={Object.keys(group)}
      optionLabels={names(group)}
      onChange={(v) => setRule(key, v)}
    />
  );

  const tabs = [["layout", "Layout"], ["results", "Results"], ["settings", "Settings"]];
  const lengthBars = d?.runs?.length
    ? [...d.runs].sort((a, b) => b.permanentLinkM - a.permanentLinkM).slice(0, 40)
    : [];

  return (
    <>
    <div className="segmented" role="tablist" aria-label="Cabling view" style={{ marginBottom: 12 }}>
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
          {label}
        </button>
      ))}
    </div>
    <div className="panel-grid">
      {view === "layout" && (<>
      <section className="panel">
        <h2>Wi-Fi cabling</h2>
        <p className="panel-note">
          Routes one cable from every access point to a rack, then lists the
          cable, switches, outlets and other parts. This is a{" "}
          <strong>preliminary estimate</strong> from the plan geometry; lengths
          and parts are not verified on site. Nothing here changes your plan,
          predictions or optimisation.
        </p>
        {apCount === 0 && (
          <p className="warn">
            The plan has no access points yet. Place APs in the Editor, or run
            the optimiser and apply its result.
          </p>
        )}

        {(optimization?.opt?.result?.recommendations || []).length > 0 && (
          <div className="opt-section">
            <small className="hint">
              The optimiser has a recommendation of {optimization.opt.result.recommendations.length} AP position(s) that is not in the
              plan yet. You can put those APs in the plan and let the tool suggest racks and cable them in one step. You can
              undo the APs in the optimiser.
            </small>
            <button type="button" onClick={applyAndCable}>Apply the optimiser's APs and cable them</button>
          </div>
        )}

        <h3>Racks</h3>
        {cabling.racks.length === 0 && (
          <p className="hint">
            A rack is the room that holds the switches and patch panels. Let
            the tool suggest where, or add one yourself on every floor that has
            APs (or a riser to a rack on another floor).
          </p>
        )}
        <div className="button-row" style={{ marginBottom: 10 }}>
          <button type="button" onClick={suggest} disabled={apCount === 0}>
            Suggest rack locations
          </button>
        </div>
        {suggestNotes.map((n, i) => (
          <small key={i} className="hint">{n}</small>
        ))}
        {cabling.racks.map((r) => (
          <div key={r.id} className="opt-section">
            {r.suggested && (
              <small className="warn">
                Suggested{r.roomName ? ` in ${r.roomName}` : ""}
                {r.covers ? `, reaches ${r.covers} AP(s)` : ""}. To confirm:
                electrical supply, ventilation, security and space.
              </small>
            )}
            <div className="inspector-fields">
              <Field label="Name" value={r.name} onChange={(v) => patchList("racks", r.id, { name: v })} />
              <Field label="Floor" type="select" value={r.floorId}
                options={plan.floors.map((f) => f.id)}
                optionLabels={Object.fromEntries(plan.floors.map((f) => [f.id, f.name]))}
                onChange={(v) => patchList("racks", r.id, { floorId: v })} />
              <Field label="Role" type="select" value={r.role || ""} options={["", "mdf", "idf"]}
                optionLabels={{ "": "Automatic", mdf: "Main room (MDF)", idf: "Floor room (IDF)" }}
                onChange={(v) => patchList("racks", r.id, { role: v || undefined })} />
              <Field label="x (m)" type="number" value={r.x} onChange={(v) => patchList("racks", r.id, { x: v })} />
              <Field label="z (m)" type="number" value={r.z} onChange={(v) => patchList("racks", r.id, { z: v })} />
              <Field label="Max APs (blank = any)" type="number" value={r.maxAps ?? ""}
                onChange={(v) => patchList("racks", r.id, { maxAps: v > 0 ? v : undefined })} />
              <Field label="Space (U, blank = 42)" type="number" value={r.rackUnits ?? ""}
                onChange={(v) => patchList("racks", r.id, { rackUnits: v > 0 ? v : undefined })} />
              <Field label="Power supplied (W)" type="number" value={r.powerW ?? ""}
                onChange={(v) => patchList("racks", r.id, { powerW: v > 0 ? v : undefined })} />
              <Field label="Cooling (W heat)" type="number" value={r.coolingW ?? ""}
                onChange={(v) => patchList("racks", r.id, { coolingW: v > 0 ? v : undefined })} />
            </div>
            <small className="hint">Blank power or cooling = not limited.</small>
            <div className="button-row">
              {r.suggested && (
                <button type="button" onClick={() => patchList("racks", r.id, { suggested: false })}>
                  Confirm this rack
                </button>
              )}
              <button type="button" onClick={() => removeFrom("racks", r.id)}>Remove rack</button>
            </div>
          </div>
        ))}
        <div className="button-row">
          <button type="button" onClick={() => addRack()}>Add rack to {floor.name}</button>
          <button type="button" className={placing === "rack" ? "active" : ""} onClick={() => setPlacing(placing === "rack" ? null : "rack")}>
            {placing === "rack" ? "Click the map…" : "Place rack on map"}
          </button>
        </div>

        <h3>Risers (shafts between floors)</h3>
        {cabling.risers.map((r) => (
          <div key={r.id} className="opt-section">
            <div className="inspector-fields">
              <Field label="Name" value={r.name} onChange={(v) => patchList("risers", r.id, { name: v })} />
              <Field label="x (m)" type="number" value={r.x} onChange={(v) => patchList("risers", r.id, { x: v })} />
              <Field label="z (m)" type="number" value={r.z} onChange={(v) => patchList("risers", r.id, { z: v })} />
              <Field label="Cross-section (mm², blank = unknown)" type="number" value={r.areaMm2 ?? ""}
                onChange={(v) => patchList("risers", r.id, { areaMm2: v > 0 ? v : undefined })} />
            </div>
            <button type="button" onClick={() => removeFrom("risers", r.id)}>Remove riser</button>
          </div>
        ))}
        <div className="button-row">
          <button type="button" onClick={() => addRiser()}>Add riser</button>
          <button type="button" className={placing === "riser" ? "active" : ""} onClick={() => setPlacing(placing === "riser" ? null : "riser")}>
            {placing === "riser" ? "Click the map…" : "Place riser on map"}
          </button>
        </div>
        <small className="hint">A riser is at the same x, z on every floor it joins.</small>

        <h3>Ceiling and walls</h3>
        <small className="hint">
          The plan cannot show whether the ceiling is accessible or which walls
          a cable may pass. Until you say, every route is an estimate that
          assumes cable can run above the ceiling and over walls.
        </small>
        <Field label="Ceiling" type="select" value={pathway.ceiling.type}
          options={CEILING_TYPES}
          optionLabels={{ unknown: "Unknown", false: "False (suspended) ceiling", open: "Open ceiling", solid: "Solid ceiling" }}
          onChange={(v) => setCeiling("type", v)} />
        <Field label="Space above the ceiling" type="select" value={pathway.ceiling.voidAccess}
          options={VOID_ACCESS}
          optionLabels={{ unknown: "Unknown", accessible: "Accessible", restricted: "Restricted", none: "Not accessible" }}
          onChange={(v) => setCeiling("voidAccess", v)} />
        <Field label="Do partitions reach the slab?" type="select" value={pathway.ceiling.partitionToSlab}
          options={SLAB}
          optionLabels={{ unknown: "Unknown", no: "No, they stop below the slab", yes: "Yes, they reach the slab" }}
          onChange={(v) => setCeiling("partitionToSlab", v)} />
        <details>
          <summary>Rooms that differ from this ({floor.name})</summary>
          {plan.rooms.filter((r) => r.floorId === floor.id).map((room) => {
            const o = pathway.roomOverrides[room.id] || {};
            return (
              <div key={room.id} className="opt-section">
                <strong>{room.name || "Room"}</strong>
                <Field label="Ceiling" type="select" value={o.type ?? ""}
                  options={["", ...CEILING_TYPES]}
                  optionLabels={{ "": "Same as project", unknown: "Unknown", false: "False ceiling", open: "Open ceiling", solid: "Solid ceiling" }}
                  onChange={(v) => setRoomCeiling(room.id, "type", v)} />
                <Field label="Space above" type="select" value={o.voidAccess ?? ""}
                  options={["", ...VOID_ACCESS]}
                  optionLabels={{ "": "Same as project", unknown: "Unknown", accessible: "Accessible", restricted: "Restricted", none: "Not accessible" }}
                  onChange={(v) => setRoomCeiling(room.id, "voidAccess", v)} />
                <Field label="Partitions reach the slab?" type="select" value={o.partitionToSlab ?? ""}
                  options={["", ...SLAB]}
                  optionLabels={{ "": "Same as project", unknown: "Unknown", no: "No", yes: "Yes" }}
                  onChange={(v) => setRoomCeiling(room.id, "partitionToSlab", v)} />
              </div>
            );
          })}
        </details>
        <div className="button-row">
          <button type="button" className={wallMode ? "active" : ""}
            onClick={() => { setWallMode(!wallMode); setPlacing(null); setSelectedWall(null); setRouteMode(false); setDrawMode(null); setDraft([]); }}>
            {wallMode ? "Click a wall on the map…" : "Mark a wall on the map"}
          </button>
        </div>
        <div className="button-row">
          <button type="button" className={drawMode === "tray" ? "active" : ""} onClick={() => startDraw("tray")}>
            {drawMode === "tray" ? "Click along the tray…" : "Draw a cable tray"}
          </button>
          <button type="button" className={drawMode === "nogo" ? "active" : ""} onClick={() => startDraw("nogo")}>
            {drawMode === "nogo" ? "Click the corners…" : "Draw a no-go area"}
          </button>
          <button type="button" className={drawMode === "power" ? "active" : ""} onClick={() => startDraw("power")}>
            {drawMode === "power" ? "Click along the power cable…" : "Draw power cabling"}
          </button>
        </div>
        {drawMode && (
          <div className="button-row">
            <button type="button" onClick={finishDraw} disabled={draft.length < (drawMode === "nogo" ? 3 : 2)}>
              Finish ({draft.length} point{draft.length === 1 ? "" : "s"})
            </button>
            <button type="button" onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length}>Undo last point</button>
            <button type="button" onClick={() => { setDrawMode(null); setDraft([]); }}>Cancel</button>
          </div>
        )}
        <small className="hint">
          A cable tray is where cable should run: routes prefer it. A no-go area
          (no ceiling access, fire-rated, restricted) is never crossed.
        </small>
        {pathway.trays.filter((t) => t.floorId === floor.id).map((t) => (
          <div key={t.id} className="opt-section">
            <Field label="Tray" value={t.name} onChange={(v) => patchPathwayItem("trays", t.id, { name: v })} />
            <Field label="Kind" type="select" value={t.kind} options={["new", "existing"]}
              optionLabels={{ new: "New tray (to buy)", existing: "Existing tray (not bought)" }}
              onChange={(v) => patchPathwayItem("trays", t.id, { kind: v })} />
            <Field label="Status" type="select" value={t.status} options={["estimated", "confirmed"]}
              optionLabels={{ estimated: "Estimated (not checked)", confirmed: "Confirmed on site" }}
              onChange={(v) => patchPathwayItem("trays", t.id, { status: v })} />
            <button type="button" onClick={() => removePathwayItem("trays", t.id)}>Remove tray</button>
          </div>
        ))}
        {pathway.powerRoutes.filter((t) => t.floorId === floor.id).map((t) => (
          <div key={t.id} className="opt-section">
            <Field label="Power cabling" value={t.name} onChange={(v) => patchPathwayItem("powerRoutes", t.id, { name: v })} />
            <button type="button" onClick={() => removePathwayItem("powerRoutes", t.id)}>Remove power cabling</button>
          </div>
        ))}
        {pathway.noGo.filter((a) => a.floorId === floor.id).map((a) => (
          <div key={a.id} className="opt-section">
            <Field label="No-go area" value={a.name} onChange={(v) => patchPathwayItem("noGo", a.id, { name: v })} />
            <Field label="Why" value={a.reason || ""} onChange={(v) => patchPathwayItem("noGo", a.id, { reason: v })} />
            <button type="button" onClick={() => removePathwayItem("noGo", a.id)}>Remove no-go area</button>
          </div>
        ))}
        {selectedWall && (() => {
          const current = wallsNow.find((w) => w.key === selectedWall.key) || selectedWall;
          return (
            <div className="opt-section">
              <small className="hint">
                Selected wall: {current.policy === "blocked" ? "cable may not pass" : current.policy === "permitted" ? "cable may pass" : "estimate (access unknown)"}
                {current.reason ? ` (${current.reason})` : ""}
              </small>
              <Field label="This wall" type="select"
                value={pathway.wallOverrides[selectedWall.key] ?? "default"}
                options={["default", ...WALL_MARKS]}
                optionLabels={{ default: "Use the ceiling settings", ...WALL_MARK_LABELS }}
                onChange={(v) => markWall(selectedWall.key, v)} />
            </div>
          );
        })()}
        {Object.keys(pathway.wallOverrides).length > 0 && (
          <small className="hint">
            {Object.keys(pathway.wallOverrides).length} wall(s) marked by you.{" "}
            <button type="button" onClick={() => setPathway((p) => ({ ...p, wallOverrides: {} }))}>Clear all marks</button>
          </small>
        )}

        <h3>Routes</h3>
        <div className="button-row">
          <button type="button" className={routeMode ? "active" : ""}
            onClick={() => { setRouteMode(!routeMode); setWallMode(false); setDrawMode(null); setDraft([]); setPlacing(null); setSelectedAp(null); }}>
            {routeMode ? "Click an AP, then the points to pass…" : "Edit a route on the map"}
          </button>
        </div>
        {routeMode && (
          <small className="hint">
            Click an AP to choose its route, then click the map to add points the
            cable must pass, in order. Drag a point to move it.
          </small>
        )}
        {selectedAp && (() => {
          const ap = plan.sources.find((s) => s.id === selectedAp);
          const edit = pathway.routeEdits[selectedAp] || { waypoints: [], confirmed: false };
          const run = d?.runs.find((r) => r.apId === selectedAp);
          return (
            <div className="opt-section">
              <strong>{ap?.name || "AP"}</strong>
              <small className="hint">
                {run ? `${run.permanentLinkM} m · ${run.pathwayStatus}${run.edited ? " · edited" : ""}` : "no route"}
                {run?.layers ? ` · tray ${run.layers.trayM} m · conduit ${run.layers.conduitM} m · penetrations ${run.layers.penetrations}` : ""}
              </small>
              <div className="button-row">
                <button type="button" onClick={() => setRouteEdit(selectedAp, (e) => ({ ...e, waypoints: e.waypoints.slice(0, -1) }))} disabled={!edit.waypoints.length}>Remove last point</button>
                <button type="button" onClick={() => setRouteEdit(selectedAp, (e) => ({ ...e, waypoints: [] }))} disabled={!edit.waypoints.length}>Clear points</button>
              </div>
              <div className="button-row">
                <button type="button" className={edit.confirmed ? "active" : ""}
                  onClick={() => setRouteEdit(selectedAp, (e) => ({ ...e, confirmed: !e.confirmed }))}>
                  {edit.confirmed ? "Route confirmed (click to undo)" : "Confirm this route"}
                </button>
              </div>
            </div>
          );
        })()}

      </section>

      <section className="panel">
        <h2>{floor.name}</h2>
        <CablingMap
          plan={plan}
          floorId={floor.id}
          design={d}
          racks={cabling.racks}
          risers={cabling.risers}
          placing={placing}
          onPlace={onPlace}
          pathway={cabling.pathway}
          wallMode={wallMode}
          selectedWall={selectedWall}
          onWallClick={setSelectedWall}
          drawMode={drawMode}
          draft={draft}
          onDraftPoint={(p) => setDraft((d) => [...d, p])}
          routeMode={routeMode}
          selectedAp={selectedAp}
          routeEdits={pathway.routeEdits}
          onRouteClick={onRouteClick}
          onMoveWaypoint={(apId, index, at) => setRouteEdit(apId, (e) => ({ ...e, waypoints: e.waypoints.map((w, i) => (i === index ? at : w)) }))}
          // moving a rack by hand is the user's decision, so it is no longer a suggestion
          onMoveRack={(id, at) => patchList("racks", id, { ...at, suggested: false, needsRoom: false })}
        />
        <small className="hint">
          Green cable is within the limit, orange is near it, red is over it. Blue = cable tray, red area = no-go. Markers on a wall crossing: orange ring = estimate, green square = over the partition (ceiling void), purple diamond = through a marked opening or sleeve.
          Drag a rack to move it. The number at each AP is that cable's length.
          A dashed cable rests on an assumption you have not confirmed. Walls:
          brown = cable may not pass, green dashed = cable may pass, grey =
          estimate.
        </small>
      </section>
      </>)}

      {view === "settings" && (
      <section className="panel" style={{ gridColumn: "1 / -1" }}>
        <h2>Cabling settings</h2>
        <h3>Approval</h3>
        {d && (
          <>
            <p className={d.approval.level === "preliminary" ? "warn" : "ok"}>
              <strong>{d.approval.level}</strong>: {d.approval.routes.confirmed} confirmed,{" "}
              {d.approval.routes.stated} stated, {d.approval.routes.estimated} estimated route(s)
            </p>
            {d.approval.checks.map((c) => (
              <small key={c.id} className={c.ok ? "hint" : "warn"}>{c.ok ? "✓" : "○"} {c.label}</small>
            ))}
          </>
        )}
        {["dimensions", "pathways", "equipment"].map((key) => (
          <label key={key} className="check">
            <input type="checkbox" checked={pathway.verification[key]}
              onChange={(e) => setPathway((p) => ({ ...p, verification: { ...p.verification, [key]: e.target.checked } }))} />{" "}
            I have verified the {key === "dimensions" ? "plan dimensions" : key === "pathways" ? "cable pathways" : "equipment and parts"} on site
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={pathway.columnsBlock}
            onChange={(e) => setPathway((p) => ({ ...p, columnsBlock: e.target.checked }))} />{" "}
          Columns on the plan block cable runs
        </label>

        <h3>Equipment and limits</h3>
        {select("apPartId", catalogue.accessPoints, "AP PoE class")}
        <Field label="Switch" type="select" value={rules.switchPartId}
          options={["auto", ...Object.keys(catalogue.switches)]}
          optionLabels={{ auto: "Automatic (fewest switches per rack)", ...names(catalogue.switches) }}
          onChange={(v) => setRule("switchPartId", v)} />
        <Field label="PoE margin kept spare (%)" type="number" value={Math.round(rules.poeMargin * 100)} onChange={(v) => setRule("poeMargin", Math.max(0, Math.min(90, v)) / 100)} />
        <Field label="Switch power supply" type="select" value={rules.psuRedundancy}
          options={["none", "N+1"]} optionLabels={{ none: "No redundancy", "N+1": "N+1 (size for one failed supply)" }}
          onChange={(v) => setRule("psuRedundancy", v)} />
        <Field label="Fibre uplinks per switch" type="number" value={rules.uplinksPerSwitch} onChange={(v) => setRule("uplinksPerSwitch", Math.max(1, Math.round(v)))} />
        <Field label="Highest oversubscription (x : 1)" type="number" value={rules.maxOversubscription} onChange={(v) => setRule("maxOversubscription", v)} />
        {select("cablePartId", catalogue.cables, "Cable")}
        <Field label="PoE allocation" type="select" value={rules.poeAllocation}
          options={["class", "actual"]}
          optionLabels={{ class: "Worst case per PoE class", actual: "Typical AP draw" }}
          onChange={(v) => setRule("poeAllocation", v)} />
        <details>
          <summary>Advanced</summary>
          <Field label="Max permanent link (m)" type="number" value={rules.maxPermanentLinkM} onChange={(v) => setRule("maxPermanentLinkM", v)} />
          <Field label="Wall-crossing cost (m)" type="number" value={rules.crossPenaltyM} onChange={(v) => setRule("crossPenaltyM", v)} />
          <Field label="Slack (%)" type="number" value={rules.slackFraction * 100} onChange={(v) => setRule("slackFraction", v / 100)} />
          <Field label="Rack drop (m)" type="number" value={rules.rackDropM} onChange={(v) => setRule("rackDropM", v)} />
          <Field label="AP service loop (m)" type="number" value={rules.apLoopM} onChange={(v) => setRule("apLoopM", v)} />
          <Field label="Rack service loop (m)" type="number" value={rules.rackLoopM} onChange={(v) => setRule("rackLoopM", v)} />
        </details>
        <small className="hint">
          Part values are illustrative defaults until replaced with the
          project's real parts.
          {d ? ` ${sourceSummary(d.boq).illustrative} of ${sourceSummary(d.boq).lines} bill-of-materials lines still rest on illustrative values.` : ""}
        </small>
        <CatalogueEditor overrides={cabling.catalogue || {}} onChange={(next, summary) => setCabling((c) => ({ ...c, catalogue: next }), summary)} />

        <h3>History</h3>
        <div className="button-row">
          <button type="button" onClick={undoLast} disabled={!history.past.length}>Undo</button>
          <button type="button" onClick={redoLast} disabled={!history.future.length}>Redo</button>
        </div>
        <details>
          <summary>Audit trail ({(cabling.auditLog || []).length} change(s))</summary>
          {[...(cabling.auditLog || [])].reverse().slice(0, 30).map((e, i) => (
            <small key={i} className="hint">{e.at.replace("T", " ").slice(0, 19)} · {e.summary}</small>
          ))}
        </details>
        <h3>Field test results</h3>
        <small className="hint">
          Import a certifier's results (CSV with the AP or link name, length and
          pass or fail). The tool plans a cabling system; it cannot certify one.
        </small>
        <label className="button">
          Import field test (CSV)
          <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadFieldTest(f); }} />
        </label>
        {fieldTestError && <p className="error">{fieldTestError}</p>}
        {fieldTest && (
          <>
            <p className={fieldTest.summary.failed ? "error" : "hint"}>
              {fieldTest.summary.tested} tested, {fieldTest.summary.failed} failed, {fieldTest.summary.lengthDiffers} differ in
              length from the design, {fieldTest.summary.untested} not tested.
              {fieldTest.unknown.length ? ` Not in the design: ${fieldTest.unknown.join(", ")}.` : ""}
            </p>
            <table>
              <thead><tr><th>AP</th><th>Designed</th><th>Measured</th><th>Difference</th><th>Result</th></tr></thead>
              <tbody>
                {fieldTest.rows.map((r) => (
                  <tr key={r.ap}>
                    <td>{r.ap}</td><td>{r.designedM} m</td><td>{r.measuredM ?? "-"}</td>
                    <td className={r.differs ? "warn" : ""}>{r.deltaM ?? "-"}</td>
                    <td className={r.pass === false ? "error" : ""}>{r.pass == null ? "-" : r.pass ? "pass" : "FAIL"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

      </section>
      )}

      {view === "results" && (
      <section className="panel" style={{ gridColumn: "1 / -1" }}>
        <h2>Result {designState.busy && <small className="hint">calculating…</small>}</h2>
        {design.error && <p className="error">{design.error}</p>}
        {d && (
          <>
            <p>
              <strong>{d.runs.length}</strong> of {apCount} AP(s) routed ·{" "}
              {d.runs.reduce((s, r) => s + r.permanentLinkM, 0).toFixed(1)} m of
              cable · {d.racks.reduce((s, r) => s + r.switches, 0)} switch(es)
            </p>
            <p className="hint">{d.status}</p>
            {d.trayFill && (
              <p className={d.trayFill.fillPct > d.trayFill.limitPct ? "error" : "hint"}>
                Busiest tray section: {d.trayFill.maxCables} cables, {d.trayFill.fillPct}% of a {d.trayFill.trayWidthMm} mm tray
                (limit {d.trayFill.limitPct}%; {d.trayFill.requiredWidthMm} mm needed).
                {d.powerSeparationM > 0 ? ` ${d.powerSeparationM} m of route is close to power cabling.` : ""}
                {d.fireStopKits > 0 ? ` ${d.fireStopKits} fire-stop kit(s).` : ""}
              </p>
            )}
            {d.runs.some((r) => r.pathwayStatus === "estimated") && (
              <p className="warn">
                {d.runs.filter((r) => r.pathwayStatus === "estimated").length} of {d.runs.length} route(s) are
                estimates: they assume cable can run above the ceiling or over walls. Give the ceiling and wall
                settings to confirm them.
              </p>
            )}
            {errors.map((v, i) => (
              <p key={`e${i}`} className="error">✖ {v.item}: {v.message}</p>
            ))}
            {warnings.slice(0, 3).map((v, i) => (
              <p key={`w${i}`} className="warn">⚠ {v.item}: {v.message}</p>
            ))}
            {warnings.length > 3 && (
              <details style={{ marginBottom: 12 }}>
                <summary>{warnings.length - 3} more warning(s)</summary>
                {warnings.slice(3).map((v, i) => (
                  <p key={`w3${i}`} className="warn">⚠ {v.item}: {v.message}</p>
                ))}
              </details>
            )}
            {d.boq.length > 0 && (
              <table>
                <thead>
                  <tr><th>Item</th><th>Qty</th><th>Unit</th></tr>
                </thead>
                <tbody>
                  {d.boq.map((l) => (
                    <tr key={`${l.group}-${l.partId}`} title={l.basis}>
                      <td>{l.name}</td><td>{l.qty}</td><td>{l.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.runs.length > 0 && (
              <details>
                <summary>Cable runs ({d.runs.length})</summary>
                <table>
                  <thead>
                    <tr><th>AP</th><th>Rack</th><th>Link (m)</th><th>AP V</th><th>Check</th></tr>
                  </thead>
                  <tbody>
                    {d.runs.map((r) => (
                      <tr key={r.apId}>
                        <td>{r.apName}</td>
                        <td>{cabling.racks.find((x) => x.id === r.rackId)?.name}</td>
                        <td>{r.permanentLinkM}</td>
                        <td>{r.pdVoltageV ?? "-"}</td>
                        <td>{r.check}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <div className="button-row">
              <button type="button" onClick={() => download("excel")} disabled={!d.runs.length || Boolean(exporting)}>
                {exporting === "excel" ? "Preparing…" : "Download Excel (equipment list, cable schedule)"}
              </button>
              <button type="button" onClick={() => download("pptx")} disabled={!d.runs.length || Boolean(exporting)}>
                {exporting === "pptx" ? "Preparing…" : "Download PowerPoint report"}
              </button>
            </div>
            {error && <p className="error">{error}</p>}
          </>
        )}

        {lengthBars.length > 0 && (
          <>
            <h3>Cable length per AP</h3>
            <div style={{ display: "grid", gap: 3 }}>
              {lengthBars.map((r) => {
                const limit = rules.maxPermanentLinkM;
                const pct = Math.min(100, (r.permanentLinkM / limit) * 100);
                const color = r.permanentLinkM > limit ? "#b91c1c" : r.permanentLinkM > limit * 0.9 ? "#d97706" : "#15803d";
                return (
                  <div key={r.apId} style={{ display: "grid", gridTemplateColumns: "90px 1fr 56px", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.apName}</span>
                    <span style={{ position: "relative", background: "#e5e7eb", height: 10, borderRadius: 5 }}>
                      <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color, borderRadius: 5 }} />
                    </span>
                    <span>{r.permanentLinkM} m</span>
                  </div>
                );
              })}
            </div>
            <small className="hint">Full bar = the {rules.maxPermanentLinkM} m limit. Longest {lengthBars.length} shown.</small>
          </>
        )}
        {d?.network?.racks?.length > 0 && (
          <>
            <h3>PoE and space per rack</h3>
            <div style={{ display: "grid", gap: 3 }}>
              {d.network.racks.map((r) => {
                const sp = d.racks.find((x) => x.rackId === r.rackId);
                const used = sp?.poeAllocatedW ?? 0;
                const cap = (sp?.usableBudgetW ?? 0) * (sp?.switches ?? 0);
                const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
                return (
                  <div key={r.rackId} style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <span>{r.name}</span>
                    <span style={{ background: "#e5e7eb", height: 10, borderRadius: 5 }}>
                      <span style={{ display: "block", width: `${pct}%`, height: "100%", background: pct > 90 ? "#d97706" : "#2563eb", borderRadius: 5 }} />
                    </span>
                    <span>{Math.round(used)} W · {r.unitsUsed}/{r.unitsUsable} U</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {schematic && (
          <>
            <h3>Network schematic</h3>
            <div className="button-row">
              <button type="button" className={schematicView === "layout" ? "active" : ""} onClick={() => setSchematicView("layout")}>
                Layout (where it is on the floor)
              </button>
              <button type="button" className={schematicView === "tree" ? "active" : ""} onClick={() => setSchematicView("tree")}>
                Tree (branches in levels)
              </button>
              <button type="button" onClick={() => setFitDiagrams((f) => !f)}>
                {fitDiagrams ? "Show full size" : "Fit to screen"}
              </button>
            </div>
            <div
              className={fitDiagrams ? "fit-svg" : ""}
              style={{ overflow: "auto", border: "1px solid var(--line, #d0d7de)", borderRadius: 8 }}
              // the drawing is built by our own code with every name escaped
              dangerouslySetInnerHTML={{ __html: schematic.svg }}
            />
            <div className="button-row">
              <button type="button" onClick={() => downloadSchematic("svg")}>Download schematic (SVG)</button>
              <button type="button" onClick={() => downloadSchematic("png")}>Download schematic (PNG)</button>
            </div>
          </>
        )}

        {d?.network?.racks?.length > 0 && (
          <>
            <h3>Network and racks</h3>
            <table>
              <thead>
                <tr><th>Room</th><th>Role</th><th>Space</th><th>Power</th><th>Heat</th><th>Fibre</th><th>Over-sub.</th></tr>
              </thead>
              <tbody>
                {d.network.racks.map((r) => (
                  <tr key={r.rackId}>
                    <td>{r.name}</td>
                    <td>{r.role === "mdf" ? "main" : "floor"}</td>
                    <td>{r.unitsUsed} / {r.unitsUsable} U</td>
                    <td>{r.powerW} W</td>
                    <td>{r.heatBtuHr} BTU/h</td>
                    <td>{r.fibreStrands ? `${r.fibreStrands} strands` : "-"}</td>
                    <td>{r.oversubscription ? `${r.oversubscription.ratio}:1` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.network.uplinks.length > 0 && (
              <>
                <small className="hint">Fibre uplinks</small>
                <table>
                  <thead><tr><th>From</th><th>To</th><th>Length</th><th>Strands</th></tr></thead>
                  <tbody>
                    {d.network.uplinks.map((u) => (
                      <tr key={u.from}><td>{u.fromName}</td><td>{u.toName}</td><td>{u.lengthM} m</td><td>{u.strands}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {d && (
          <>
            <h3>Compliance</h3>
            <table>
              <thead><tr><th>Requirement</th><th>Limit</th><th>Design reaches</th><th></th></tr></thead>
              <tbody>
                {complianceRows(d).map((r, i) => (
                  <tr key={i} title={r.note}>
                    <td>{r.requirement}</td><td>{r.limit}</td><td>{r.actual}</td>
                    <td className={r.status === "pass" ? "ok" : "error"}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {topology && (
          <>
            <h3>MDF / IDF topology</h3>
            <div className={fitDiagrams ? "fit-svg" : ""} style={{ overflow: "auto", border: "1px solid var(--line, #d0d7de)", borderRadius: 8 }}
              dangerouslySetInnerHTML={{ __html: topology.svg }} />
          </>
        )}
        {rackDiagram && (
          <>
            <h3>Rack elevation</h3>
            <div className={fitDiagrams ? "fit-svg" : ""} style={{ overflow: "auto", border: "1px solid var(--line, #d0d7de)", borderRadius: 8 }}
              dangerouslySetInnerHTML={{ __html: rackDiagram.svg }} />
          </>
        )}
        {riserDiagram && (
          <>
            <h3>Riser diagram</h3>
            <div className={fitDiagrams ? "fit-svg" : ""} style={{ overflow: "auto", border: "1px solid var(--line, #d0d7de)", borderRadius: 8 }}
              dangerouslySetInnerHTML={{ __html: riserDiagram.svg }} />
          </>
        )}

        {positionCheck && (
          <>
            <h3>Optimiser recommendation: cabling check</h3>
            <small className="hint">
              The optimiser places APs for coverage only. This shows whether
              each recommended position can be cabled within the limit.
            </small>
            <table>
              <thead>
                <tr><th>Position</th><th>Link (m)</th><th>Cabling</th></tr>
              </thead>
              <tbody>
                {positionCheck.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.permanentLinkM ?? "-"}</td>
                    <td>{p.feasible ? "ok" : p.routed ? "too long" : "no route"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      )}
    </div>
    </>
  );
}
