import React, { useEffect, useRef, useState } from "react";
import {
  fetchDataUrl,
  fileUrl,
  removeReconstruction,
  runReconstruction,
  uploadFloorplan,
  waitForReconstruction,
} from "../../services/floorplan.js";
import {
  applyReconstruction,
  reconstructionToPlan,
} from "../../utils/reconstruction.js";
import { getProfiles, sourceFieldsFromProfile } from "../../config/apProfiles.js";
import { readFloorMeta } from "../../utils/excelPlan.js";
import { uid } from "../../models/plan.js";
import { pointsFromPrinted, twoLengthScale } from "../../utils/scaleCalibration.js";
import { formatLength, metresToUnit, unitToMetres, useMeasurementUnit } from "../../utils/measurementUnits.jsx";

const VIEWS = [
  ["overlay.png", "Detected structure"],
  ["walls_mask.png", "Wall mask"],
  ["deskewed.png", "Original (straightened)"],
  ["model_overlay.png", "What the model sees"],
];

const POINT_KEYS = ["A", "B", "C", "D"];

// Image or PDF -> walls, openings and rooms, locally and for free. The scale
// must come from lengths you confirm; nothing is guessed from the picture. Two
// lengths are asked for, A-B across and C-D up-down, because a picture can be
// stretched (one scale across, another up-down) and one length cannot show it.
// When the drawing prints its sizes ("190.00 m", "80.00 m"), A-B and C-D are
// placed on those dimension lines for you to check.
// The reading of a drawing runs on the server and can take minutes: the panel
// stays mounted (hidden) when another tab is opened, reports what it is doing
// (onBusyChange) and says when the reading is done (onFinished).
export default function FloorplanImport({
  plan,
  floorId,
  mutate,
  setMessage,
  setTab,
  hideImage,
  showImage,
  workspace = "wifi",
  onBusyChange,
  onFinished,
}) {
  const unit = useMeasurementUnit();
  const [upload, setUpload] = useState(null);
  const [pts, setPts] = useState({}); // { A, B, C, D }: preview pixels
  const [knownLength, setKnownLength] = useState("");   // A-B (m, stored internally)
  const [knownHeight, setKnownHeight] = useState("");   // C-D (m, stored internally)
  const [notStretched, setNotStretched] = useState(false);
  const [printedNote, setPrintedNote] = useState("");
  const [dragging, setDragging] = useState(null);
  const [style, setStyle] = useState("auto");
  const [ocr, setOcr] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const [result, setResult] = useState(null);
  const [appliedScale, setAppliedScale] = useState(null);
  const [view, setView] = useState("overlay.png");
  const [replace, setReplace] = useState(true);
  const [engine, setEngine] = useState("auto");   // auto = learned model when available | hybrid | classical
  const [excelMeta, setExcelMeta] = useState(null);   // FloorMeta of an Excel given with the plan: the scale when nothing is printed
  // Wi-Fi markers found on the drawing -> access points (Wi-Fi projects only)
  const [addAps, setAddAps] = useState(workspace === "wifi");
  const [error, setError] = useState("");
  const imageRef = useRef(null);

  const floorHasContent = plan.rooms.some((r) => r.floorId === floorId);

  const pick = async (file) => {
    if (!file) return;
    setError("");
    setResult(null);
    setPts({});
    setKnownLength("");
    setKnownHeight("");
    setNotStretched(false);
    setPrintedNote("");
    setBusy("Reading the file…");
    try {
      if (upload) removeReconstruction(upload.id);
      const uploaded = await uploadFloorplan(file);
      setUpload(uploaded);
      setBusy("");
      await detect(null, uploaded);       // no clicks needed: start straight away
    } catch (e) {
      setUpload(null);
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const toPreview = (event) => {
    const box = imageRef.current.getBoundingClientRect();
    const k = upload.width / box.width;
    return [
      Math.max(0, Math.min(upload.width, Math.round((event.clientX - box.left) * k))),
      Math.max(0, Math.min(upload.height, Math.round((event.clientY - box.top) * k))),
    ];
  };
  // a click places the next missing point (A, B, then C, D); placed points are moved by dragging them
  const click = (event) => {
    const p = toPreview(event);
    const next = POINT_KEYS.slice(0, notStretched ? 2 : 4).find((key) => !pts[key]);
    if (next) setPts((cur) => ({ ...cur, [next]: p }));
  };
  const drag = (event) => {
    if (!dragging) return;
    const p = toPreview(event);
    setPts((cur) => ({ ...cur, [dragging]: p }));
  };

  const orig = (p) => p.map((v) => v / upload.previewScale);
  const dist = (p, q) => (p && q ? Math.hypot(q[0] - p[0], q[1] - p[1]) / upload.previewScale : null);
  const abPx = dist(pts.A, pts.B);
  const cdPx = dist(pts.C, pts.D);
  const length = Number(knownLength);
  const height = Number(knownHeight);
  const abOk = abPx > 5 && length > 0;
  const cdOk = !notStretched && cdPx > 5 && height > 0;
  const two = abOk && cdOk ? twoLengthScale(orig(pts.A), orig(pts.B), length, orig(pts.C), orig(pts.D), height) : null;
  const scale =
    abOk && two
      ? { pointA: orig(pts.A), pointB: orig(pts.B), lengthM: length, pointC: orig(pts.C), pointD: orig(pts.D), heightM: height }
      : abOk && notStretched
        ? { pointA: orig(pts.A), pointB: orig(pts.B), lengthM: length, notStretched: true }
        : null;
  const scaleIsCurrent = Boolean(scale) && JSON.stringify(scale) === appliedScale;
  const canUseInEditor = scaleIsCurrent && result?.scale.pxPerM && result.scale.confirmed;
  const scaleNote = two
    ? `Across ${(two.xPxPerM * unitToMetres(1, unit)).toFixed(2)} px/${unit} · up-down ${(two.yPxPerM * unitToMetres(1, unit)).toFixed(2)} px/${unit} · ` +
      (two.stretchPct > 1
        ? `the picture is stretched by ${two.stretchPct.toFixed(1)} %: it will be corrected.`
        : "the picture is not stretched.")
    : abOk && cdOk
      ? "C-D must run in another direction than A-B (one across, one up-down)."
      : abOk && notStretched
        ? `${(abPx / (length / unitToMetres(1, unit))).toFixed(2)} px per ${unit} from A-B, used both ways (you confirmed the picture is not stretched).`
        : "Place A-B and C-D and type both real lengths (or tick that the picture is not stretched).";

  const detect = async (givenScale = scale, target = upload) => {
    setError("");
    // the previous result stays on screen while the new run goes (the scale step and the plan to click on need it)
    try {
      setBusy("Queued…");
      await runReconstruction(target.id, {
        scale: givenScale,
        options: {
          wall_style: style,
          ocr,
          engine,
          ...(excelMeta?.imageWidthM ? { fallback_scale: { imageWidthM: excelMeta.imageWidthM } } : {}),
        },
      });
      const done = await waitForReconstruction(target.id, {
        onStatus: (st) =>
          setBusy(st.status === "running" ? "Detecting walls, openings and rooms…" : "Queued…"),
      });
      setResult(done);
      setAppliedScale(givenScale ? JSON.stringify({ ...givenScale, verifiedDimensionLabels: undefined }) : null);
      setView("overlay.png");
      onFinished?.(true);
      // sizes printed on the drawing: A-B and C-D are placed on their dimension lines for you to check (only on
      // the first run of a picture, never over points you placed)
      if (!givenScale) {
        const found = pointsFromPrinted(done.scale?.printedLines);
        const toPv = (p) => p.map((v) => Math.round(v * target.previewScale));
        if (found.ab || found.cd) {
          setPts((cur) => {
            if (Object.keys(cur).length) return cur;
            return {
              ...(found.ab ? { A: toPv(found.ab.a), B: toPv(found.ab.b) } : {}),
              ...(found.cd ? { C: toPv(found.cd.a), D: toPv(found.cd.b) } : {}),
            };
          });
          if (found.ab) setKnownLength((v) => v || String(found.ab.metres));
          if (found.cd) setKnownHeight((v) => v || String(found.cd.metres));
          setPrintedNote(
            "Found on the drawing: " +
              [found.ab && `${found.ab.text} across (A-B)`, found.cd && `${found.cd.text} up-down (C-D)`].filter(Boolean).join(" and ") +
              ". The points are placed on those dimension lines: check that each sits on the line's end marks (drag to adjust), then press Apply.",
          );
        }
      }
    } catch (e) {
      setError(e.message);
      onFinished?.(false, e.message);
    } finally {
      setBusy("");
    }
  };

  const useInEditor = async () => {
    if (!canUseInEditor) return;
    try {
      setBusy("Building the plan…");
      const converted = reconstructionToPlan(result, floorId);
      const url = await fetchDataUrl(fileUrl(upload.id, "deskewed.png"));
      const profile = getProfiles(plan)[0];
      const fields = sourceFieldsFromProfile(profile, profile.bands["5"] ? "5" : Object.keys(profile.bands)[0]);
      // short names (AP1, AP2, ...) that do not clash with APs already in the plan
      const taken = new Set(plan.sources.map((s) => s.name));
      let apNumber = 0;
      const nextApName = () => {
        do apNumber += 1;
        while (taken.has(`AP${apNumber}`));
        return `AP${apNumber}`;
      };
      const accessPoints = addAps && workspace === "wifi"
        ? converted.apMarkers.map((m) => ({
            id: uid(),
            floorId,
            kind: "wifi",
            name: nextApName(),
            origin: "detected",
            x: m.x,
            z: m.z,
            heightM: 2.5,
            azimuthDeg: 0,
            beamwidthDeg: 120,
            sectors: [],
            mounting: "ceiling",
            ...fields,
          }))
        : [];
      mutate((p) =>
        applyReconstruction(p, converted, floorId, {
          replace,
          accessPoints,
          image: {
            url,
            widthM: converted.image.widthM,
            heightM: converted.image.heightM,
          },
        }),
      );
      const { review } = converted;
      setMessage(
        `Added ${converted.rooms.length} rooms, ${converted.interiorWalls.length} walls, ${converted.doors.length} doors, ${converted.windows.length} windows` +
          (Object.keys(converted.furnitureCounts || {}).length
            ? `, ${Object.entries(converted.furnitureCounts).map(([k, n]) => `${n} ${k}`).join(", ")}`
            : "") +
          (accessPoints.length ? `, ${accessPoints.length} access points (Wi-Fi markers found on the drawing). ` : ". ") +
          `${review.rooms + review.openings + review.walls} item(s) are marked for review (orange dashes). ` +
          "Use the Picture button in the toolbar to show or hide your imported picture.",
      );
      // the drawing is shown under the imported walls, so every wall can be checked against it
      showImage?.();
      setTab("design");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const m = result?.metrics;
  return (
    <section className="panel floorplan-import">
      <h2>Floor plan image → building</h2>
      <p>
        Upload a PNG, JPG or PDF plan. Walls, doors, windows and rooms are found
        automatically on this computer with free open-source tools (no cloud
        service, no key). The scale is taken from the drawing when it prints
        sizes (you check where it was read); otherwise you give two known lengths, one across and one up-down. Check the
        result and correct it in the editor.
      </p>
      <label className="upload">
        ⇪ Choose floor plan (PNG / JPG / PDF)
        <input
          type="file"
          accept="image/png,image/jpeg,application/pdf,.pdf"
          onChange={(e) => pick(e.target.files[0])}
        />
      </label>
      <label className="upload">
        ⇪ Excel with this plan (optional): sizes and heights
        <input
          type="file"
          accept=".xlsx"
          onChange={async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              setExcelMeta(await readFloorMeta(await file.arrayBuffer()));
              setError("");
            } catch (err) {
              setExcelMeta(null);
              setError(`Could not read the Excel: ${err.message}`);
            }
          }}
        />
      </label>
      {excelMeta && (
        <small className="hint">
          Excel read: picture size {excelMeta.imageWidthM == null ? "?" : metresToUnit(excelMeta.imageWidthM, unit)} × {excelMeta.imageHeightM == null ? "?" : metresToUnit(excelMeta.imageHeightM, unit)} {unit}. It is used as the scale
          only when the drawing prints no size.
        </small>
      )}
      {busy && <p className="panel-note">{busy}</p>}
      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <h3>Result</h3>
          <div className="stat-row">
            <div>
              <strong>{result.walls.length}</strong>
              <small>Walls</small>
            </div>
            <div>
              <strong>{result.rooms.length}</strong>
              <small>Rooms</small>
            </div>
            <div>
              <strong>{result.openings.length}</strong>
              <small>Doors / windows</small>
            </div>
            <div>
              <strong>{result.uncertain.length}</strong>
              <small>To review</small>
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Preview">
            {VIEWS.filter(([file]) => file !== "model_overlay.png" || result.files?.modelOverlay).map(([file, label]) => (
              <button
                key={file}
                type="button"
                className={view === file ? "active" : ""}
                onClick={() => setView(file)}
              >
                {label}
              </button>
            ))}
          </div>
          <img
            className="floorplan-overlay"
            src={fileUrl(upload.id, view)}
            alt="Detected floor plan structure"
          />
          <small className="hint">
            Walls: green = confident, orange = unsure, red = doubtful. Openings: blue door,
            cyan window, purple unclear. Red circles = wall ends that join nothing.
          </small>
          <small className="hint">
            {result.engine === "model"
              ? `Read by the learned model (${result.model?.name}, ${result.model?.seconds}s) · ${result.markers.length} Wi-Fi marker${result.markers.length === 1 ? "" : "s"} found · ${result.columns.length} column${result.columns.length === 1 ? "" : "s"}.`
              : result.engine === "hybrid"
                ? "Read by the classical method with the learned model's walls added."
                : "Read by the classical method (no model)."}
          </small>
          {result.quality && (
            <p className={result.quality.modelWallsCoveredPct < 85 || result.quality.resolutionOk === false ? "warn" : "panel-note"}>
              {Number.isFinite(result.quality.modelWallsCoveredPct) &&
                `Walls matched to the drawing: ${result.quality.modelWallsCoveredPct}% of the walls the model sees in the building. `}
              {Number.isFinite(result.quality.cmPerPixel) &&
                `Picture detail: ${result.quality.cmPerPixel} cm per pixel${result.quality.resolutionOk === false ? " (too coarse: thin walls and small gaps can be missed; ask for a larger PNG, at least 20 px per metre)" : " (good)"}.`}
            </p>
          )}
          <small className="hint">
            Drawn wall width ≈ {formatLength(result.wallThickness.m, unit)} (the line on the drawing, not always the real wall) · scale {result.scale.source} ·
            straightened by {result.image.deskewDeg}° · {m.totalSeconds}s on the CPU, peak{" "}
            {m.peakRamMB} MB RAM.
          </small>
          {result.warnings.map((w) => (
            <small key={w} className="warn">
              ⚠ {w}
            </small>
          ))}
          <details>
            <summary>What was assumed</summary>
            {result.assumptions.map((a) => (
              <small key={a} style={{ display: "block" }}>
                {a}
              </small>
            ))}
          </details>
          {workspace === "wifi" && result.markers?.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={addAps} onChange={(e) => setAddAps(e.target.checked)} />{" "}
              Add the {result.markers.length} Wi-Fi marker{result.markers.length === 1 ? "" : "s"} found on the drawing as access points
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />{" "}
            Replace what is already on this floor
            {floorHasContent && !replace ? " (it will be added to instead)" : ""}
          </label>
          <button
            className="primary"
            disabled={Boolean(busy) || !canUseInEditor}
            title={canUseInEditor ? "" : "Confirm the scale below first (A-B and C-D, then Apply)"}
            onClick={useInEditor}
          >
            Use in the editor
          </button>
        </>
      )}

      {upload && result && (
        <section className="scale-step">
          <h3>Scale</h3>
          {canUseInEditor ? (
            <p className="panel-note">
              Scale confirmed: {(result.scale.pxPerM * unitToMetres(1, unit)).toFixed(1)} px per {unit} ({result.scale.source}).
              {result.scale.twoLengths && result.scale.twoLengths.stretchPct > 1
                ? ` The picture was stretched by ${result.scale.twoLengths.stretchPct.toFixed(1)} % and has been corrected.`
                : ""}
            </p>
          ) : (
            <p className="panel-note">
              <strong>Confirm the scale both ways before the plan is used.</strong> A picture can be stretched (resized
              without keeping its proportions): then one length gets the sizes across right but every size up-down wrong.
              Give two lengths you know: <b>A-B across</b> and <b>C-D up-down</b> (the ends of the dimension lines, or
              walls you have measured).
              {result.scale.pxPerM ? ` Found so far: ${(result.scale.pxPerM * unitToMetres(1, unit)).toFixed(1)} px per ${unit} (${result.scale.source}), not yet confirmed.` : ""}
            </p>
          )}
          {printedNote && <p className="panel-note">{printedNote}</p>}
          {scaleIsCurrent && result.scale.dimensionConflicts?.map(({ segment, enteredM, printedM }) => (
            <p key={segment} className={result.scale.dimensionsVerified ? "hint" : "warn"}>
              {segment} spans a line the drawing reader labels {formatLength(printedM, unit)}.
              {" "}You entered {formatLength(enteredM, unit)}. Check the endpoints and dimension label.
            </p>
          ))}
          <ol className="calibrate-steps">
            <li className={pts.A && pts.B ? "done" : "now"}>
              Click both ends of a length you know across the plan: points <b>A</b> and <b>B</b>.
            </li>
            <li className={notStretched ? "done" : pts.C && pts.D ? "done" : pts.A && pts.B ? "now" : ""}>
              Click both ends of a length you know up-down: points <b>C</b> and <b>D</b>.
            </li>
            <li className={(pts.A && pts.B && (notStretched || (pts.C && pts.D))) ? "now" : ""}>
              Type both real lengths in {unit} under the plan and press <b>Apply this scale</b>. Drag a point to move it.
            </li>
          </ol>
          <div className="calibrate" onPointerMove={drag} onPointerUp={() => setDragging(null)} onPointerLeave={() => setDragging(null)}>
            <img
              ref={imageRef}
              src={fileUrl(upload.id, "preview.png")}
              alt="Floor plan to calibrate"
              onClick={click}
              draggable={false}
            />
            <svg
              className="calibrate-line"
              viewBox={`0 0 ${upload.width} ${upload.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {[["A", "B", "#dc2626"], ["C", "D", "#2563eb"]].map(([p, q, colour]) =>
                pts[p] && pts[q] && !(p === "C" && notStretched) ? (
                  <line
                    key={p}
                    x1={pts[p][0]}
                    y1={pts[p][1]}
                    x2={pts[q][0]}
                    y2={pts[q][1]}
                    stroke={colour}
                    strokeWidth={Math.max(2, upload.width / 400)}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </svg>
            {POINT_KEYS.filter((key) => pts[key] && !(notStretched && (key === "C" || key === "D"))).map((key) => (
              <span
                key={key}
                className={`calibrate-dot drag${key === "C" || key === "D" ? " cd" : ""}`}
                style={{
                  left: `${(100 * pts[key][0]) / upload.width}%`,
                  top: `${(100 * pts[key][1]) / upload.height}%`,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDragging(key);
                }}
                title={`Drag to move point ${key}`}
              >
                {key}
              </span>
            ))}
          </div>
          <div className="calibrate-status">
            {!pts.A && "Waiting for point A: click on the plan."}
            {pts.A && !pts.B && "Point A is placed. Now click point B."}
            {pts.A && pts.B && !notStretched && !pts.C && "A-B is placed. Now click point C (one end of an up-down length)."}
            {pts.C && !pts.D && !notStretched && "Point C is placed. Now click point D."}
            {pts.A && pts.B && (
              <>
                {" "}A-B {Math.round(abPx)} px
                {!notStretched && pts.C && pts.D ? ` · C-D ${Math.round(cdPx)} px` : ""}.
                <button type="button" onClick={() => setPts((cur) => ({ C: cur.C, D: cur.D }))}>
                  Pick A-B again
                </button>
                {!notStretched && pts.C && (
                  <button type="button" onClick={() => setPts((cur) => ({ A: cur.A, B: cur.B }))}>
                    Pick C-D again
                  </button>
                )}
              </>
            )}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Real length A-B, across ({unit})</span>
              <input
                type="number"
                min="0"
                step="any"
                placeholder={pts.A && pts.B ? "e.g. 190" : "place A and B first"}
                value={knownLength === "" ? "" : metresToUnit(knownLength, unit)}
                onChange={(e) => setKnownLength(e.target.value === "" ? "" : unitToMetres(e.target.value, unit))}
                disabled={!(pts.A && pts.B)}
              />
            </label>
            <label className="field">
              <span>Real length C-D, up-down ({unit})</span>
              <input
                type="number"
                min="0"
                step="any"
                placeholder={notStretched ? "not needed" : pts.C && pts.D ? "e.g. 80" : "place C and D first"}
                value={knownHeight === "" ? "" : metresToUnit(knownHeight, unit)}
                onChange={(e) => setKnownHeight(e.target.value === "" ? "" : unitToMetres(e.target.value, unit))}
                disabled={notStretched || !(pts.C && pts.D)}
              />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={notStretched} onChange={(e) => setNotStretched(e.target.checked)} />{" "}
            I have no up-down length: I confirm the picture is not stretched (A-B is used both ways)
          </label>
          <small className="hint">{scaleNote}</small>
          <button className="primary" disabled={Boolean(busy) || !scale} onClick={() => detect(scale)}>
            Apply this scale
          </button>
          {scaleIsCurrent && !!result.scale.dimensionConflicts?.length && !result.scale.dimensionsVerified && (
            <button type="button" disabled={Boolean(busy) || !scale} onClick={() => detect({ ...scale, verifiedDimensionLabels: true })}>
              I checked the endpoints and verified my dimensions
            </button>
          )}
        </section>
      )}
      {upload && (
        <details className="detect-settings">
          <summary>Detection settings</summary>
          <div className="form-grid">
            <label className="field">
              <span>Wall drawing</span>
              <select value={style} onChange={(e) => setStyle(e.target.value)}>
                <option value="auto">Automatic</option>
                <option value="solid">Solid (filled) walls</option>
                <option value="double">Double lines</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />{" "}
              Read room names and dimension text
            </label>
            <label className="field">
              <span>Method</span>
              <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="auto">Learned model (default)</option>
                <option value="hybrid">Hybrid (classical + model walls)</option>
                <option value="classical">Classical (no model)</option>
              </select>
            </label>
          </div>
          <button disabled={Boolean(busy)} onClick={() => detect(scale)}>
            Detect again
          </button>

        </details>
      )}
    </section>
  );
}
