import LogManager from "../planner/LogManager.jsx";
import ReviewPanel from "../planner/ReviewPanel.jsx";
import CollisionsPanel from "../planner/CollisionsPanel.jsx";
import RotateControls from "../planner/RotateControls.jsx";
import React, { useEffect, useState } from "react";
import Plan2D from "../planner/Plan2D.jsx";
import Plan3D from "../planner/Plan3D.jsx";
import RoomMaterials from "../planner/RoomMaterials.jsx";
import { EditorToolOptions } from "../planner/EditorMenu.jsx";
import { PropertyOptions } from "../planner/PropertyMenu.jsx";
import Field from "../ui/Field.jsx";
import { formatArea, useMeasurementUnit } from "../../utils/measurementUnits.jsx";

const DEFAULT_PANEL_WIDTH = 340;
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 760;
const getPanelMaxWidth = () =>
  Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, window.innerWidth - 240 - 360),
  );
import MapLegend from "../planner/MapLegend.jsx";
import CellularPanel from "../planner/CellularPanel.jsx";
import CellularLegend from "../planner/CellularLegend.jsx";
import PredictionPanel from "../planner/PredictionPanel.jsx";
import OptimizationPanel from "../planner/OptimizationPanel.jsx";
import MaterialsEditor from "../planner/MaterialsEditor.jsx";
import { uid } from "../../models/plan.js";
import { areaOf, pointsOf, resizePolygonPoints } from "../../utils/geometry.js";
import { num } from "../../utils/number.js";

export default function DesignPanel({
  zoom,
  setZoom,
  tool,
  setTool,
  view,
  plan,
  floorId,
  snap,
  setSnap,
  isStatic,
  showRoomNames,
  showFurnitureNames = true,
  showWifiNames = true,
  showMeasurements = false,
  cableDesign = null,
  selected,
  setSelected,
  place,
  move,
  moveShapePart,
  predictions,
  predictionMetric,
  predictionRanges,
  weakBelowDbm,
  rt,
  setRt,
  prediction,
  optimization,
  heatRanges,
  legendSections,
  setMetric,
  kpiOptions,
  metricRanges,
  overlay,
  setSelectedFloor,
  setTab,
  nestedNotes = [],
  convertRoomToBoundary,
  convertBoundaryToRoom,
  moveBoundaryTo,
  heatmap,
  heatmapOpacity,
  logsVisible,
  logGrid,
  metric,
  gridSize,
  aggregation,
  obj,
  patchObj,
  mutate,
  rooms,
  deleteObj,
  floor,
  deleteFloor,
  clearFloor,
  warnings,
  panelMode,
  setPanelMode,
  carpetArea,
  isCustomCarpetArea,
  onCarpetAreaChange,
  onCarpetAreaReset,
  carpetFit,
  boundaryAreaM2,
  carpetLengthM,
  carpetWidthM,
  onCarpetSize,
  onCarpetFitBoundary,
  onStaticChange,
  moveWithContents,
  mapMode,
  hiddenLayers,
  mergeWall,
  snapWalls,
  setCollisionFocus,
  setMoveWithContents,
  setMapMode,
  rotateSelected,
  rotateWholeBuilding,
  onShowRoomNamesChange,
  onShowFurnitureNamesChange,
  onShowWifiNamesChange,
  draftRooms,
  draftWalls,
  draftFurniture,
  draftFloorId,
  draftMethod,
  applyDraft,
  discardDraft,
  workspace = "wifi",
  cellular,
}) {
  const unit = useMeasurementUnit();
  const [panelWidth, setPanelWidthState] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("planner.panelWidth"));
      const maxWidth = window.innerWidth > 1100
        ? getPanelMaxWidth()
        : MAX_PANEL_WIDTH;
      return saved >= MIN_PANEL_WIDTH
        ? Math.min(saved, maxWidth)
        : Math.min(DEFAULT_PANEL_WIDTH, maxWidth);
    } catch {
      return DEFAULT_PANEL_WIDTH;
    }
  });
  const setPanelWidth = (width) => {
    const maxWidth = getPanelMaxWidth();
    const next = Math.round(
      Math.min(Math.max(width, MIN_PANEL_WIDTH), maxWidth),
    );
    setPanelWidthState(next);
    try {
      localStorage.setItem("planner.panelWidth", String(next));
    } catch {
      /* storage unavailable: the width just is not remembered */
    }
  };
  useEffect(() => {
    const clampPanelWidth = () => {
      if (window.innerWidth > 1100 && panelWidth > getPanelMaxWidth())
        setPanelWidth(getPanelMaxWidth());
    };
    window.addEventListener("resize", clampPanelWidth);
    return () => window.removeEventListener("resize", clampPanelWidth);
  }, [panelWidth]);
  const drag = React.useRef(null);
  const startResize = (e) => {
    drag.current = { x: e.clientX, width: panelWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-panel");
  };
  const moveResize = (e) => {
    if (drag.current)
      setPanelWidth(drag.current.width + (drag.current.x - e.clientX));
  };
  const endResize = () => {
    drag.current = null;
    document.body.classList.remove("resizing-panel");
  };
  const [sizeDirections, setSizeDirections] = useState({ width: 1, depth: 1 });
  useEffect(() => {
    setSizeDirections({ width: 1, depth: 1 });
  }, [selected?.id]);
  const draft =
    draftRooms && draftFloorId === floorId
      ? { rooms: draftRooms, walls: draftWalls, furniture: draftFurniture }
      : null;
  const polygonVertices =
    selected?.type === "room" && obj?.shape === "polygon" ? pointsOf(obj) : [];
  const roomFieldKeys =
    obj?.shape === "circle"
      ? ["name", "shape", "x", "z", "radius", "height", "material", "apMounting", "receiverGrid"]
      : obj?.shape === "polygon"
        ? ["name", "shape", "x", "z", "height", "material", "apMounting", "receiverGrid"]
        : ["name", "shape", "x", "z", "width", "depth", "height", "material", "apMounting", "receiverGrid"];
  return (
    <>
      {draft && (
        <div className="trace-review-banner">
          <span>
            {draftMethod} preview: {draft.rooms.length} spaces,{" "}
            {draft.walls.length} walls, {draft.furniture.length} desk groups
          </span>
          <button className="primary" onClick={applyDraft}>
            Apply trace
          </button>
          <button onClick={discardDraft}>Discard</button>
        </div>
      )}
      <div
        className={`editor-grid ${panelMode ? "" : "panel-closed"}`}
        style={{ "--panel-width": `${panelWidth}px` }}
      >
        <div className="view-stack">
          {workspace === "cellular" && cellular?.hasResult && cellular.show ? (
            <CellularLegend cellular={cellular} floorId={floorId} />
          ) : (
          <MapLegend
            workspace={workspace}
            optimization={optimization}
            sections={legendSections}
            metric={metric}
            setMetric={setMetric}
            kpiOptions={kpiOptions}
            metricRanges={metricRanges}
            heatmap={heatmap}
            predictionMetric={predictionMetric}
            predictionRanges={heatRanges}
            overlay={overlay}
            provenance={
              optimization.opt && optimization.show !== "off" && mapMode === "optimise"
                ? "opt"
                : rt.active
                  ? "rt"
                  : "none"
            }
            hasLogs={logsVisible && plan.logs.some((l) => l.floorId === floorId)}
            kpiOnMap={
              (heatmap && predictions?.length > 0) ||
              (logsVisible && plan.logs.some((l) => l.floorId === floorId))
            }
            hasBoundary={(plan.boundaries || []).some((b) => b.floorId === floorId)}
          />
          )}
          {mapMode === "prediction" && (prediction.busy || prediction.run?.error) && (
            <div
              className={`map-status ${prediction.run?.error ? "error" : ""}`}
              role="status"
            >
              {prediction.run?.error
                ? prediction.run.error
                : `${prediction.run.phase}… updating the ray-traced prediction`}
            </div>
          )}
          {(view === "2d" || view === "split") && (
            <Plan2D
              {...{
                zoom,
                onZoom: setZoom,
                plan,
                floorId,
                tool,
                snap,
                isStatic,
                showRoomNames,
                showFurnitureNames,
                showWifiNames,
                showMeasurements,
                cables: cableDesign,
                racks: plan.cabling?.racks,
                selected,
                onSelect: setSelected,
                onPlace: place,
                onMove: move,
                onMoveShapePart: moveShapePart,
                predictions,
                overlay,
                heatmap,
                heatmapOpacity,
                logsVisible,
                logGrid,
                metric,
                gridSize,
                aggregation,
                draft,
                hiddenLayers,
              }}
            />
          )}
          {(view === "3d" || view === "split") && (
            <Plan3D
              {...{
                plan,
                floorId,
                tool,
                snap,
                isStatic,
                showRoomNames,
                showFurnitureNames,
                showWifiNames,
                showMeasurements,
                cables: cableDesign,
                racks: plan.cabling?.racks,
                selected,
                onSelect: setSelected,
                onPlace: place,
                onMove: move,
                predictions,
                overlay,
                heatmap,
                heatmapOpacity,
                logsVisible,
                logGrid,
                metric,
                gridSize,
                aggregation,
                hiddenLayers,
              }}
            />
          )}
        </div>
        {panelMode && (
          <div
            className="panel-resizer"
            style={{ right: panelWidth }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the right panel (double-click to reset)"
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={() => setPanelWidth(DEFAULT_PANEL_WIDTH)}
          />
        )}
        {panelMode && (
          <aside className="inspector">
            <div className="inspector-heading">
              <h3>
                {panelMode === "tools"
                  ? "Tools"
                  : panelMode === "cellular"
                    ? "Prediction"
                  : panelMode === "prediction"
                    ? "Prediction"
                  : panelMode === "optimize"
                    ? "Optimise AP placement"
                  : panelMode === "property"
                    ? "Project properties"
                    : obj
                      ? `${selected.type[0].toUpperCase() + selected.type.slice(1)} properties`
                      : "Floor properties"}
              </h3>
              <button
                className="inspector-close"
                type="button"
                aria-label="Close right panel"
                onClick={() => setPanelMode(null)}
              >
                &#x2715;
              </button>
            </div>
            {(panelMode === "prediction" || panelMode === "optimize") && (
              <div className="segmented mode-switch" role="group" aria-label="Mode">
                <button
                  type="button"
                  className={panelMode === "prediction" ? "active" : ""}
                  onClick={() => {
                    setMapMode("prediction");
                    setPanelMode("prediction");
                  }}
                >
                  A · Existing APs
                </button>
                <button
                  type="button"
                  className={panelMode === "optimize" ? "active" : ""}
                  onClick={() => {
                    setMapMode("optimise");
                    setPanelMode("optimize");
                  }}
                >
                  B · Optimised
                </button>
              </div>
            )}
            {panelMode === "tools" ? (
              <EditorToolOptions
                tool={tool}
                setTool={setTool}
                snap={snap}
                setSnap={setSnap}
                workspace={workspace}
              />
            ) : panelMode === "cellular" && workspace === "cellular" ? (
              <CellularPanel
                plan={plan}
                mutate={mutate}
                cellular={cellular}
                floorId={floorId}
                selectedSource={selected?.type === "source" ? obj : null}
                setTool={setTool}
                setTab={setTab}
              />
            ) : panelMode === "optimize" ? (
              <OptimizationPanel
                plan={plan}
                optimization={optimization}
                setSelectedFloor={setSelectedFloor}
                setTab={setTab}
              />
            ) : panelMode === "prediction" ? (
              <PredictionPanel
                plan={plan}
                rt={rt}
                setRt={setRt}
                prediction={prediction}
                predictionMetric={predictionMetric}
                predictionRanges={predictionRanges}
                weakBelowDbm={weakBelowDbm}
              />
            ) : panelMode === "property" ? (
              <>
              <PropertyOptions
                workspace={workspace}
                unit={plan.property?.unit || "m"}
                onUnitChange={(unit) =>
                  mutate((p) => ({
                    ...p,
                    property: { ...p.property, unit },
                  }))
                }
                carpetArea={carpetArea}
                isCustom={isCustomCarpetArea}
                isStatic={isStatic}
                onStaticChange={onStaticChange}
                showRoomNames={showRoomNames}
                onShowRoomNamesChange={onShowRoomNamesChange}
                showFurnitureNames={showFurnitureNames}
                onShowFurnitureNamesChange={onShowFurnitureNamesChange}
                showWifiNames={showWifiNames}
                onShowWifiNamesChange={onShowWifiNamesChange}
                onChange={onCarpetAreaChange}
                onReset={onCarpetAreaReset}
                fit={carpetFit}
                boundaryAreaM2={boundaryAreaM2}
                lengthM={carpetLengthM}
                widthM={carpetWidthM}
                onSize={onCarpetSize}
                onFitBoundary={onCarpetFitBoundary}
                onRotateBuilding={rotateWholeBuilding}
              />
              <MaterialsEditor plan={plan} mutate={mutate} />
              </>
            ) : obj ? (
              <>
                <div className="inspector-fields">
                  {(selected.type === "room"
                    ? roomFieldKeys
                    : selected.type === "source" && workspace === "cellular"
                      ? ["name", "x", "z", "heightM"] // the rest is in the Cellular panel
                    : selected.type === "source"
                      ? [
                          "name",
                          "kind",
                          "technology",
                          "antennaPattern",
                          "x",
                          "z",
                          "heightM",
                          "txPowerDbm",
                          "freqMHz",
                          "antennaGainDbi",
                          "azimuthDeg",
                          "beamwidthDeg",
                        ]
                      : selected.type === "boundary"
                        ? ["name", "height", "material"]
                      : selected.type === "wall"
                        ? ["name", "x1", "z1", "x2", "z2", "material"]
                        : selected.type === "furniture"
                          ? ["name", "x", "z", "width", "depth", "height"]
                          : [
                              "roomId",
                              "wallSide",
                              "offset",
                              "width",
                              "height",
                              ...(selected.type === "window"
                                ? ["sillHeight"]
                                : []),
                            ]
                  ).map((key) => {
                    const hasGrowthDirection =
                      selected.type === "room" &&
                      obj.shape === "rectangle" &&
                      (key === "width" || key === "depth");
                    const direction = sizeDirections[key] || 1;
                    const directionLabel =
                      key === "width"
                        ? direction > 0
                          ? "right"
                          : "left"
                        : direction > 0
                          ? "down"
                          : "up";
                    const field = (
                      <Field
                        label={key === "heightM" ? "Mounting height" : key.replace(/([A-Z])/g, " $1")}
                        measurement={[
                          "x", "z", "width", "depth", "height", "radius", "heightM",
                          "x1", "x2", "z1", "z2", "offset", "sillHeight",
                        ].includes(key) ? "length" : undefined}
                        value={obj[key] ?? ""}
                        type={
                          [
                            "x",
                            "z",
                            "width",
                            "depth",
                            "height",
                            "radius",
                            "heightM",
                            "txPowerDbm",
                            "freqMHz",
                            "antennaGainDbi",
                            "azimuthDeg",
                            "beamwidthDeg",
                            "x1",
                            "x2",
                            "z1",
                            "z2",
                            "offset",
                            "sillHeight",
                          ].includes(key)
                            ? "number"
                            : "text"
                        }
                        min={key === "radius" ? 0.1 : undefined}
                        options={
                          key === "shape"
                            ? ["rectangle", "circle", "polygon"]
                            : key === "apMounting" || key === "receiverGrid"
                              ? key === "receiverGrid"
                                ? ["included", "excluded"]
                                : ["allowed", "excluded"]
                            : key === "material"
                              ? [
                                  "drywall",
                                  "wood",
                                  "glass",
                                  "brick",
                                  "concrete",
                                  "metal",
                                ]
                              : key === "wallSide"
                                ? ["north", "south", "east", "west"]
                                : key === "antennaPattern"
                                  ? ["omni", "directional"]
                                  : key === "kind"
                                    ? [workspace] // a project holds one network
                                    : key === "roomId"
                                      ? rooms.map((r) => r.id)
                                      : null
                        }
                        onChange={(v) =>
                          patchObj(key, v, hasGrowthDirection ? direction : 1)
                        }
                      />
                    );
                    if (!hasGrowthDirection) return React.cloneElement(field, { key });
                    return (
                      <div className="room-size-field" key={key}>
                        {field}
                        <button
                          className="room-growth-direction"
                          type="button"
                          aria-label={`Grow room ${key} toward the ${directionLabel}`}
                          title={`Grow toward the ${directionLabel}; click to reverse`}
                          onClick={() =>
                            setSizeDirections((current) => ({
                              ...current,
                              [key]: -direction,
                            }))
                          }
                        >
                          {key === "width"
                            ? direction > 0
                              ? "→"
                              : "←"
                            : direction > 0
                              ? "↓"
                              : "↑"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {selected.type === "boundary" && (
                  <div className="inspector-fields">
                    <Field
                      label="X (left edge)"
                      type="number"
                      measurement="length"
                      value={Math.min(...obj.points.map((q) => q.x))}
                      onChange={(v) => moveBoundaryTo(obj.id, "x", v)}
                    />
                    <Field
                      label="Z (top edge)"
                      type="number"
                      measurement="length"
                      value={Math.min(...obj.points.map((q) => q.z))}
                      onChange={(v) => moveBoundaryTo(obj.id, "z", v)}
                    />
                  </div>
                )}
                {(selected.type === "room" || selected.type === "boundary") && (
                  <>
                    <label className="property-hide-rooms move-contents">
                      <input
                        type="checkbox"
                        checked={moveWithContents}
                        onChange={(e) => setMoveWithContents(e.target.checked)}
                      />
                      <span>Move and rotate contents with the {selected.type}</span>
                    </label>
                    <div className="property-static-note">
                      On: furniture, Wi-Fi/cellular sources, inner walls and
                      rooms inside move and rotate together with it (doors and
                      windows always follow). Off: only the {selected.type}{" "}
                      moves.
                    </div>
                  </>
                )}
                {obj?.needsReview && (
                  <div className="review-note">
                    <small>
                      Read from the drawing with {Math.round((obj.confidence ?? 0) * 100)}%
                      confidence. Check it against the picture.
                    </small>
                    <button type="button" onClick={() => patchObj("needsReview", false)}>
                      Confirm
                    </button>
                  </div>
                )}
                {["room", "furniture", "wall", "boundary"].includes(selected.type) && (
                  <RotateControls
                    label={`Rotate ${selected.type === "wall" ? "wall" : selected.type}`}
                    onRotate={rotateSelected}
                    note={
                      selected.type === "room"
                        ? moveWithContents
                          ? "Turns about the room's centre together with its contents. 90° steps keep doors, windows and wall materials."
                          : "Turns only the room, about its centre. 90° steps keep doors, windows and wall materials."
                        : selected.type === "furniture"
                          ? "Turns about its own centre. Angles other than multiples of 90° use the box that encloses the turned desk."
                          : undefined
                    }
                  />
                )}
                {selected.type === "room" && obj.shape === "polygon" && (
                  <section className="polygon-editor">
                    <div className="polygon-editor-heading">
                      <strong>Custom polygon</strong>
                      <span>{polygonVertices.length} vertices</span>
                    </div>
                    <Field
                      label="Vertex count"
                      type="number"
                      min={3}
                      step={1}
                      value={polygonVertices.length}
                      onChange={(value) =>
                        patchObj(
                          "polygonPoints",
                          resizePolygonPoints(polygonVertices, value),
                        )
                      }
                    />
                    <div className="polygon-vertices">
                      {polygonVertices.map((vertex, index) => (
                        <div className="polygon-vertex-row" key={index}>
                          <strong>V{index + 1}</strong>
                          <Field
                            label="X"
                            type="number"
                            measurement="length"
                            value={vertex.x}
                            onChange={(value) =>
                              patchObj(
                                "polygonPoints",
                                polygonVertices.map((point, pointIndex) =>
                                  pointIndex === index
                                    ? { ...point, x: value }
                                    : point,
                                ),
                              )
                            }
                          />
                          <Field
                            label="Z"
                            type="number"
                            measurement="length"
                            value={vertex.z}
                            onChange={(value) =>
                              patchObj(
                                "polygonPoints",
                                polygonVertices.map((point, pointIndex) =>
                                  pointIndex === index
                                    ? { ...point, z: value }
                                    : point,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div className="hint">
                      Drag a corner or wall in the 2D view to reshape the
                      polygon.
                    </div>
                  </section>
                )}
                {selected.type === "room" && (
                  <div className="mini-stat">
                    Area: {formatArea(areaOf(obj), unit, 2)}
                  </div>
                )}
                {selected.type === "room" && (
                  <RoomMaterials room={obj} plan={plan} mutate={mutate} />
                )}
                {selected.type === "source" && workspace === "cellular" && (
                  <button type="button" className="secondary-button" onClick={() => setPanelMode("cellular")}>
                    Antenna model, sector, power and direction →
                  </button>
                )}
                {selected.type === "source" && workspace === "wifi" && (
                  <div className="sectors">
                    <div className="section-title">
                      <h4>Sectors</h4>
                      <button
                        onClick={() =>
                          patchObj("sectors", [
                            ...(obj.sectors || []),
                            {
                              id: uid(),
                              name: `Sector ${(obj.sectors || []).length + 1}`,
                              azimuthDeg: 0,
                              beamwidthDeg: 120,
                              txPowerDbm: obj.txPowerDbm,
                              antennaGainDbi: obj.antennaGainDbi,
                              freqMHz: obj.freqMHz,
                            },
                          ])
                        }
                      >
                        + Sector
                      </button>
                    </div>
                    {(obj.sectors || []).map((s, i) => (
                      <div className="sector" key={s.id}>
                        <Field
                          label="Name"
                          value={s.name}
                          onChange={(v) =>
                            patchObj(
                              "sectors",
                              obj.sectors.map((a, j) =>
                                j === i ? { ...a, name: v } : a,
                              ),
                            )
                          }
                        />
                        {[
                          "azimuthDeg",
                          "beamwidthDeg",
                          "txPowerDbm",
                          "antennaGainDbi",
                          "freqMHz",
                        ].map((k) => (
                          <Field
                            key={k}
                            label={k}
                            type="number"
                            value={s[k]}
                            onChange={(v) =>
                              patchObj(
                                "sectors",
                                obj.sectors.map((a, j) =>
                                  j === i ? { ...a, [k]: v } : a,
                                ),
                              )
                            }
                          />
                        ))}
                        <button
                          className="danger-text"
                          onClick={() =>
                            patchObj(
                              "sectors",
                              obj.sectors.filter((_, j) => j !== i),
                            )
                          }
                        >
                          Remove sector
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {selected.type === "room" && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={[...plan.doors, ...plan.windows].some(
                      (o) => o.roomId === obj.id,
                    )}
                    title="Turns this room into the building outline (exterior wall, one floor slab). Rooms inside it stay. Not available while it has doors or windows."
                    onClick={() => convertRoomToBoundary(obj.id)}
                  >
                    Use as building boundary
                  </button>
                )}
                {selected.type === "boundary" && (
                  <button
                    type="button"
                    className="secondary-button"
                    title="Turns this outline back into an ordinary room. An upright four-corner outline becomes a rectangle room."
                    onClick={() => convertBoundaryToRoom(obj.id)}
                  >
                    Convert to room
                  </button>
                )}
                <button className="delete-button" onClick={deleteObj}>
                  Delete {selected.type}
                </button>
              </>
            ) : (
              <>
                <Field
                  label="Floor name"
                  value={floor?.name || ""}
                  onChange={(v) =>
                    mutate((p) => ({
                      ...p,
                      floors: p.floors.map((f) =>
                        f.id === floorId ? { ...f, name: v } : f,
                      ),
                    }))
                  }
                />
                <Field
                  label="Elevation (m)"
                  type="number"
                  value={floor?.elevation || 0}
                  onChange={(v) =>
                    mutate((p) => ({
                      ...p,
                      floors: p.floors.map((f) =>
                        f.id === floorId ? { ...f, elevation: v } : f,
                      ),
                    }))
                  }
                />
                <Field
                  label="Wall thickness (m)"
                  type="number"
                  value={plan.wallThickness}
                  onChange={(v) => mutate((p) => ({ ...p, wallThickness: v }))}
                />
                {plan.logs?.length > 0 && (
                  <LogManager
                    plan={plan}
                    mutate={mutate}
                    floorId={floorId}
                    metric={metric}
                  />
                )}
                {plan.images?.[floorId] && (
                  <Field
                    label="Floor image rotation (°)"
                    type="number"
                    value={plan.images[floorId].rotationDeg || 0}
                    onChange={(v) =>
                      mutate((p) => ({
                        ...p,
                        images: {
                          ...p.images,
                          [floorId]: { ...p.images[floorId], rotationDeg: v },
                        },
                      }))
                    }
                  />
                )}
                <button className="delete-button" onClick={clearFloor}>
                  Clear this floor
                </button>
                {plan.floors.length > 1 && (
                  <button className="delete-button" onClick={deleteFloor}>
                    Delete floor
                  </button>
                )}
                <div className="hint">
                  Choose a drawing tool, then click the plan. Select an object
                  to edit it here. Drag rooms, sources, and furniture to
                  reposition them.
                </div>
              </>
            )}
            {panelMode === "selection" && (
              <ReviewPanel
                plan={plan}
                floorId={floorId}
                onSelect={setSelected}
                onConfirm={(item) =>
                  mutate((p) => {
                    const list = { room: "rooms", door: "doors", window: "windows", wall: "interiorWalls" }[item.type];
                    return {
                      ...p,
                      [list]: p[list].map((x) =>
                        x.id === item.id ? { ...x, needsReview: false, confirmed: true } : x,
                      ),
                    };
                  })
                }
              />
            )}
            {panelMode === "selection" && (
              <CollisionsPanel
                plan={plan}
                floorId={floorId}
                onMergeWall={mergeWall}
                onSnapWalls={snapWalls}
                onFocus={setCollisionFocus}
              />
            )}
            {panelMode === "selection" && nestedNotes.length > 0 && (
              <div className="note-box">
                <strong>Rooms inside rooms</strong>
                {nestedNotes.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
                <small>
                  Shared walls count once and the inner room gets no second
                  floor. If the outer room is really the building outline, use
                  "Use as building boundary" in its properties.
                </small>
              </div>
            )}
            {panelMode === "selection" && warnings.length > 0 && (
              <div className="warning">
                <strong>Overlap warnings</strong>
                {warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
