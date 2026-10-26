import React from "react";
import Field from "../ui/Field.jsx";
import { INDOOR_LOG_KPIS } from "../../utils/indoorLogKpis.js";
import { num } from "../../utils/number.js";

export default function DataPanel({
  importBuilding,
  template,
  imageWidth,
  setImageWidth,
  importImage,
  traceImage,
  plan,
  floorId,
  busy,
  draftRooms,
  setDraftRooms,
  draftWalls,
  draftFurniture,
  draftFloorId,
  draftMethod,
  applyDraft,
  discardDraft,
  mutate,
  setTab,
  reviewedWorkbook,
  importLogs,
  sessionInput,
  setSessionInput,
  loadSession,
  browseSessions,
  availableSessions,
  metric,
  setMetric,
  logsVisible,
  setLogsVisible,
  logGrid,
  setLogGrid,
  gridSize,
  setGridSize,
  aggregation,
  setAggregation,
  currentLogs,
  sampledCells,
  sampledArea,
  totalArea,
  metricRanges,
}) {
  return (
    <div className="panel-grid">
      <section className="panel">
        <h2>Building plans</h2>
        <p>
          Import the existing BuildingMeta + Floor_1/Floor_2 format, or
          FloorMeta + Rooms. Coordinates are converted to metres.
        </p>
        <label className="upload">
          ⇪ Import building Excel
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => importBuilding(e.target.files[0])}
          />
        </label>
        <button onClick={template}>Download example template</button>
        <hr />
        <h3>Floor image to playground</h3>
        <p>
          Upload a floor-plan image. The quick scan finds enclosed rooms only.
          For open offices like your drawing, run the AI trace to propose rooms,
          walls, and desk groups. Check the overlay before applying it.
        </p>
        <Field
          label="Image width in metres"
          type="number"
          min={0.1}
          value={imageWidth}
          onChange={setImageWidth}
        />
        <label className="upload">
          ⇪ Upload image and quick scan
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => importImage(e.target.files[0])}
          />
        </label>
        {plan.images[floorId] && (
          <div className="row">
            <button className="primary" disabled={busy} onClick={traceImage}>
              Trace full plan with AI
            </button>
            <small>
              AI tracing uses the uploaded image and may take a minute. Review
              its geometry before applying.
            </small>
          </div>
        )}
        {draftRooms && draftFloorId === floorId && (
          <div className="review">
            <h4>
              {draftMethod} proposals: spaces ({draftRooms.length}), walls (
              {draftWalls.length}
              ), desk groups ({draftFurniture.length})
            </h4>
            <div className="review-list">
              {draftRooms.map((r, i) => (
                <div key={r.id} className="review-row">
                  <input
                    aria-label="Room name"
                    value={r.name}
                    onChange={(e) =>
                      setDraftRooms((a) =>
                        a.map((q, j) =>
                          j === i ? { ...q, name: e.target.value } : q,
                        ),
                      )
                    }
                  />
                  {["x", "z", "width", "depth"].map((k) => (
                    <input
                      key={k}
                      aria-label={k}
                      type="number"
                      step="any"
                      value={r[k]}
                      onChange={(e) =>
                        setDraftRooms((a) =>
                          a.map((q, j) =>
                            j === i ? { ...q, [k]: num(e.target.value) } : q,
                          ),
                        )
                      }
                    />
                  ))}
                  <button
                    onClick={() =>
                      setDraftRooms((a) => a.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="row">
              <button className="primary" onClick={applyDraft}>
                Apply to playground
              </button>
              <button onClick={() => setTab("design")}>
                Preview in editor
              </button>
              <button onClick={discardDraft}>Discard</button>
              <button onClick={reviewedWorkbook}>
                Download full trace Excel
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Network logs</h2>
        <p>
          Import ZIP containing NetworkLog_*.csv, a CSV, or an Excel Logs sheet.
          GPS logs project after alignment.
        </p>
        <label className="upload">
          ⇪ Import ZIP / CSV / Excel
          <input
            type="file"
            accept=".zip,.csv,.xlsx"
            onChange={(e) => importLogs(e.target.files[0])}
          />
        </label>
        <div className="row">
          <input
            placeholder="Session ID"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
          />
          <button onClick={loadSession}>Load session</button>
          <button onClick={browseSessions}>Browse</button>
        </div>
        {availableSessions.length > 0 && (
          <select
            aria-label="Available sessions"
            value=""
            onChange={(e) => setSessionInput(e.target.value)}
          >
            <option value="">Choose available session</option>
            {availableSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        )}
        <small>
          Sessions load from the Node service’s data/sessions folder.
        </small>
        <hr />
        <Field
          label="KPI"
          value={metric}
          options={INDOOR_LOG_KPIS.map((k) => k.key)}
          onChange={setMetric}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={logsVisible}
            onChange={(e) => setLogsVisible(e.target.checked)}
          />{" "}
          Show logs
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={logGrid}
            onChange={(e) => setLogGrid(e.target.checked)}
          />{" "}
          Aggregate to grid
        </label>
        <div className="form-grid">
          <Field
            label="Grid size (m)"
            type="number"
            value={gridSize}
            onChange={setGridSize}
          />
          <Field
            label="Aggregation"
            value={aggregation}
            options={["mean", "median", "min", "max"]}
            onChange={setAggregation}
          />
        </div>
        <div className="stat-row">
          <div>
            <strong>{currentLogs.length}</strong>
            <small>Floor samples</small>
          </div>
          <div>
            <strong>{sampledCells}</strong>
            <small>Sampled cells</small>
          </div>
          <div>
            <strong>{sampledArea.toFixed(1)} m²</strong>
            <small>Measured area</small>
          </div>
          <div>
            <strong>
              {Math.max(0, totalArea - sampledArea).toFixed(1)} m²
            </strong>
            <small>Unmeasured area</small>
          </div>
        </div>
        <h4>Threshold bands</h4>
        {metricRanges.map((r, i) => (
          <div className="threshold" key={i}>
            <input
              type="color"
              value={r.color}
              onChange={(e) =>
                mutate((p) => ({
                  ...p,
                  thresholds: {
                    ...p.thresholds,
                    [metric]: metricRanges.map((q, j) =>
                      j === i ? { ...q, color: e.target.value } : q,
                    ),
                  },
                }))
              }
            />
            <input
              type="number"
              value={Number.isFinite(r.min) ? r.min : ""}
              placeholder="−∞"
              onChange={(e) =>
                mutate((p) => ({
                  ...p,
                  thresholds: {
                    ...p.thresholds,
                    [metric]: metricRanges.map((q, j) =>
                      j === i
                        ? {
                            ...q,
                            min:
                              e.target.value === ""
                                ? -Infinity
                                : num(e.target.value),
                          }
                        : q,
                    ),
                  },
                }))
              }
            />
            <span>to</span>
            <input
              type="number"
              value={Number.isFinite(r.max) ? r.max : ""}
              placeholder="+∞"
              onChange={(e) =>
                mutate((p) => ({
                  ...p,
                  thresholds: {
                    ...p.thresholds,
                    [metric]: metricRanges.map((q, j) =>
                      j === i
                        ? {
                            ...q,
                            max:
                              e.target.value === ""
                                ? Infinity
                                : num(e.target.value),
                          }
                        : q,
                    ),
                  },
                }))
              }
            />
          </div>
        ))}
        <div className="row">
          <button onClick={() => setTab("design")}>
            View overlays in editor
          </button>
          <button
            className="danger-text"
            onClick={() => mutate((p) => ({ ...p, logs: [] }))}
          >
            Clear logs
          </button>
        </div>
      </section>
    </div>
  );
}
