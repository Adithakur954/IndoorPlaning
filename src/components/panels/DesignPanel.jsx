import React, { useEffect, useState } from "react";
import Plan2D from "../planner/Plan2D.jsx";
import Plan3D from "../planner/Plan3D.jsx";
import RoomMaterials from "../planner/RoomMaterials.jsx";
import { EditorToolOptions } from "../planner/EditorMenu.jsx";
import { PropertyOptions } from "../planner/PropertyMenu.jsx";
import Field from "../ui/Field.jsx";
import { uid } from "../../models/plan.js";
import { areaOf, pointsOf, resizePolygonPoints } from "../../utils/geometry.js";
import { num } from "../../utils/number.js";

export default function DesignPanel({
  tool,
  setTool,
  view,
  setView,
  plan,
  floorId,
  snap,
  setSnap,
  isStatic,
  showRoomNames,
  showFurnitureNames = true,
  showWifiNames = true,
  selected,
  setSelected,
  place,
  move,
  movePolygonPart,
  predictions,
  heatmap,
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
  warnings,
  panelMode,
  setPanelMode,
  carpetArea,
  isCustomCarpetArea,
  onCarpetAreaChange,
  onCarpetAreaReset,
  onStaticChange,
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
}) {
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
      ? ["name", "shape", "x", "z", "radius", "height", "material"]
      : obj?.shape === "polygon"
        ? ["name", "shape", "x", "z", "height", "material"]
        : ["name", "shape", "x", "z", "width", "depth", "height", "material"];
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
      <div className={`editor-grid ${panelMode ? "" : "panel-closed"}`}>
        <div className="view-stack">
          {(view === "2d" || view === "split") && (
            <Plan2D
              {...{
                plan,
                floorId,
                tool,
                snap,
                isStatic,
                showRoomNames,
                showFurnitureNames,
                showWifiNames,
                selected,
                onSelect: setSelected,
                onPlace: place,
                onMove: move,
                onMovePolygonPart: movePolygonPart,
                predictions,
                heatmap,
                logsVisible,
                logGrid,
                metric,
                gridSize,
                aggregation,
                draft,
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
                selected,
                onSelect: setSelected,
                onPlace: place,
                onMove: move,
                predictions,
                heatmap,
                logsVisible,
                logGrid,
                metric,
                gridSize,
                aggregation,
              }}
            />
          )}
        </div>
        {panelMode && (
          <aside className="inspector">
            <div className="inspector-heading">
              <h3>
                {panelMode === "tools"
                  ? "Tools"
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
            {panelMode === "tools" ? (
              <EditorToolOptions
                tool={tool}
                setTool={setTool}
                view={view}
                setView={setView}
                snap={snap}
                setSnap={setSnap}
              />
            ) : panelMode === "property" ? (
              <PropertyOptions
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
              />
            ) : obj ? (
              <>
                <div className="inspector-fields">
                  {(selected.type === "room"
                    ? roomFieldKeys
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
                        label={key.replace(/([A-Z])/g, " $1")}
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
                                    ? ["cellular", "wifi"]
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
                    Area: {areaOf(obj).toFixed(2)} m²
                  </div>
                )}
                {selected.type === "room" && (
                  <RoomMaterials room={obj} plan={plan} mutate={mutate} />
                )}
                {selected.type === "source" && (
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
