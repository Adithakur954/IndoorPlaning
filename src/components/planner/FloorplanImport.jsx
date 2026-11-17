import React, { useRef, useState } from "react";
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

const VIEWS = [
  ["overlay.png", "Detected structure"],
  ["walls_mask.png", "Wall mask"],
  ["deskewed.png", "Original (straightened)"],
  ["model_overlay.png", "What the model sees"],
];

// Image or PDF -> walls, openings and rooms, locally and for free. The scale
// must come from a length you know; nothing is guessed from the picture.
export default function FloorplanImport({ plan, floorId, mutate, setMessage, setTab, hideImage }) {
  const [upload, setUpload] = useState(null);
  const [points, setPoints] = useState([]); // preview pixels
  const [knownLength, setKnownLength] = useState("");
  const [imageWidthM, setImageWidthM] = useState("");
  const [style, setStyle] = useState("auto");
  const [ocr, setOcr] = useState(true);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState(null);
  const [view, setView] = useState("overlay.png");
  const [replace, setReplace] = useState(true);
  const [engine, setEngine] = useState("auto");   // auto = learned model when available | hybrid | classical
  const [excelMeta, setExcelMeta] = useState(null);   // FloorMeta of an Excel given with the plan: the scale when nothing is printed
  const [addAps, setAddAps] = useState(true);          // Wi-Fi markers found on the drawing -> access points
  const [error, setError] = useState("");
  const imageRef = useRef(null);

  const floorHasContent = plan.rooms.some((r) => r.floorId === floorId);

  const pick = async (file) => {
    if (!file) return;
    setError("");
    setResult(null);
    setPoints([]);
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

  const click = (event) => {
    const box = imageRef.current.getBoundingClientRect();
    const scale = upload.width / box.width;
    const p = [
      Math.round((event.clientX - box.left) * scale),
      Math.round((event.clientY - box.top) * scale),
    ];
    setPoints((current) => (current.length >= 2 ? [p] : [...current, p]));
  };

  // pixels of the preview image between the two points
  const pickedPx =
    points.length === 2
      ? Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
      : null;
  const length = Number(knownLength);
  const widthM = Number(imageWidthM);
  const scale =
    pickedPx && length > 0
      ? {
          pointA: points[0].map((v) => v / upload.previewScale),
          pointB: points[1].map((v) => v / upload.previewScale),
          lengthM: length,
        }
      : widthM > 0
        ? { imageWidthM: widthM }
        : null;
  const scaleNote = !scale
    ? "No scale yet: click two points whose real distance you know and enter it, or enter the real width of the whole image."
    : scale.lengthM
      ? `${(pickedPx / upload.previewScale / scale.lengthM).toFixed(1)} px per metre from your known length (most reliable).`
      : `${(upload.originalWidth / scale.imageWidthM).toFixed(1)} px per metre from the image width (check it against a known length).`;

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
      setView("overlay.png");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const useInEditor = async () => {
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
      const accessPoints = addAps
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
        `Added ${converted.rooms.length} rooms, ${converted.doors.length} doors, ${converted.windows.length} windows` +
          (Object.keys(converted.furnitureCounts || {}).length
            ? `, ${Object.entries(converted.furnitureCounts).map(([k, n]) => `${n} ${k}`).join(", ")}`
            : "") +
          (accessPoints.length ? `, ${accessPoints.length} access points (Wi-Fi markers found on the drawing). ` : ". ") +
          `${review.rooms + review.openings + review.walls} item(s) are marked for review (orange dashes). ` +
          "Use the Picture button in the toolbar to show or hide your imported picture.",
      );
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
        enough readable sizes; otherwise you give one known length. Check the
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
          Excel read: picture size {excelMeta.imageWidthM ?? "?"} × {excelMeta.imageHeightM ?? "?"} m. It is used as the scale
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
          <small className="hint">
            Wall thickness ≈ {result.wallThickness.m} m · scale {result.scale.source} ·
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
          {result.markers?.length > 0 && (
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
            disabled={Boolean(busy) || !result.scale.pxPerM}
            title={result.scale.pxPerM ? "" : "Give one known length below first"}
            onClick={useInEditor}
          >
            Use in the editor
          </button>
        </>
      )}

      {upload && result && (
        <section className="scale-step">
          <h3>Scale</h3>
          {result.scale.pxPerM ? (
            <p className="panel-note">
              Scale: {result.scale.pxPerM.toFixed(1)} px per metre ({result.scale.source}).
              {result.scale.confidence < 1
                ? " Not from a length you gave: check it against one known length below."
                : ""}
            </p>
          ) : (
            <p className="panel-note">
              <strong>One known length is needed.</strong> This drawing does not print enough readable
              sizes to find the scale itself. Follow the three steps below: mark two points A and B whose real distance you
              know (the ends of a dimension line, a wall you have measured), then type it.
            </p>
          )}
          <ol className="calibrate-steps">
            <li className={points.length === 0 ? "now" : "done"}>
              Click one end of a length you know on the plan below: point <b>A</b>.
            </li>
            <li className={points.length === 1 ? "now" : points.length > 1 ? "done" : ""}>
              Click the other end: point <b>B</b>.
            </li>
            <li className={points.length === 2 ? "now" : ""}>
              Type the real distance between A and B (in metres) in the box under the plan.
            </li>
          </ol>
          <div className="calibrate">
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
              {points.length === 2 && (
                <line
                  x1={points[0][0]}
                  y1={points[0][1]}
                  x2={points[1][0]}
                  y2={points[1][1]}
                  stroke="#dc2626"
                  strokeWidth={Math.max(2, upload.width / 400)}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {points.map((p, i) => (
              <span
                key={i}
                className="calibrate-dot"
                style={{
                  left: `${(100 * p[0]) / upload.width}%`,
                  top: `${(100 * p[1]) / upload.height}%`,
                }}
              >
                {"AB"[i]}
              </span>
            ))}
          </div>
          <div className="calibrate-status">
            {points.length === 0 && "Waiting for point A: click on the plan."}
            {points.length === 1 && "Point A is placed. Now click point B."}
            {points.length === 2 && (
              <>
                A and B are placed ({Math.round(pickedPx / upload.previewScale)} px apart).{" "}
                <button type="button" onClick={() => setPoints([])}>
                  Pick again
                </button>
              </>
            )}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Real distance between A and B (m)</span>
              <input
                type="number"
                min="0"
                step="any"
                placeholder={points.length < 2 ? "place A and B first" : "e.g. 4.52"}
                value={knownLength}
                onChange={(e) => setKnownLength(e.target.value)}
                disabled={points.length < 2}
              />
            </label>
            <label className="field">
              <span>or real width of the whole image (m)</span>
              <input
                type="number"
                min="0"
                step="any"
                value={imageWidthM}
                onChange={(e) => setImageWidthM(e.target.value)}
              />
            </label>
          </div>
          <small className="hint">{scaleNote}</small>
          <button className="primary" disabled={Boolean(busy) || !scale} onClick={() => detect(scale)}>
            Apply this scale
          </button>
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
