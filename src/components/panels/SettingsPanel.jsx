// Project settings: the project properties (units, carpet area, building
// rotation, static rooms, names shown, materials) and, in a cellular project,
// how the KPI legend and map show the prediction.
import React from "react";
import { PropertyOptions } from "../planner/PropertyMenu.jsx";
import MaterialsEditor from "../planner/MaterialsEditor.jsx";

const KPI_STYLES = [
  {
    id: "smooth",
    label: "Bar",
    note: "Colours blend smoothly between the edges; the legend is a colour bar with the share of the floor above each value.",
  },
  {
    id: "bands",
    label: "Ranges",
    note: "One flat colour per range; the legend lists each range with its share of the floor.",
  },
];

export default function SettingsPanel({
  plan,
  mutate,
  workspace,
  cellular,
  carpetArea,
  isCustomCarpetArea,
  isStatic,
  onStaticChange,
  showRoomNames,
  onShowRoomNamesChange,
  showFurnitureNames,
  onShowFurnitureNamesChange,
  showWifiNames,
  onShowWifiNamesChange,
  onCarpetAreaChange,
  onCarpetAreaReset,
  carpetFit,
  boundaryAreaM2,
  carpetLengthM,
  carpetWidthM,
  onCarpetSize,
  onCarpetFitBoundary,
  rotateWholeBuilding,
}) {
  return (
    <div className="panel-grid settings-page">
      <section className="panel">
        <h2>Project properties</h2>
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
      </section>
      <section className="panel">
        <h2>Materials</h2>
        <MaterialsEditor plan={plan} mutate={mutate} />
      </section>
      {workspace === "cellular" && cellular && (
        <section className="panel">
          <h2>KPI display</h2>
          <div className="settings-choice" role="radiogroup" aria-label="KPI display">
            {KPI_STYLES.map((s) => (
              <label key={s.id} className={cellular.mapStyle === s.id ? "active" : ""}>
                <input
                  type="radio"
                  name="kpi-display"
                  value={s.id}
                  checked={cellular.mapStyle === s.id}
                  onChange={() => cellular.setMapStyle(s.id)}
                />
                <span>
                  <strong>{s.label}</strong>
                  <small>{s.note}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
