import React from "react";
import RotateControls from "./RotateControls.jsx";
import {
  MEASUREMENT_UNITS,
  areaUnitFor,
  measurementUnitName,
  metresToUnit,
  squareMetresToUnit,
  unitToMetres,
  unitToSquareMetres,
} from "../../utils/measurementUnits.jsx";

export default function PropertyMenu({ active, onOpen }) {
  return (
    <button
      className="property-menu-trigger"
      type="button"
      aria-pressed={active}
      onClick={onOpen}
    >
      Property
    </button>
  );
}

export function PropertyOptions({
  unit = "m",
  onUnitChange,
  carpetArea,
  isCustom,
  isStatic,
  onStaticChange,
  showRoomNames,
  onShowRoomNamesChange,
  showFurnitureNames,
  onShowFurnitureNamesChange,
  showWifiNames,
  onShowWifiNamesChange,
  onChange,
  onReset,
  fit = false,
  boundaryAreaM2 = 0,
  lengthM = null,
  widthM = null,
  onSize,
  onFitBoundary,
  onRotateBuilding,
}) {
  return (
    <>
      <label className="field">
        <span>Building measurement units</span>
        <select value={unit} onChange={(event) => onUnitChange(event.target.value)}>
          {MEASUREMENT_UNITS.map((option) => (
            <option key={option} value={option}>{measurementUnitName(option)}</option>
          ))}
        </select>
      </label>
      <label className="property-area-field">
        <span>Carpet area</span>
        <span className="property-area-input">
          <input
            aria-label={`Carpet area in ${areaUnitFor(unit)} squared`}
            type="number"
            min="0"
            step={squareMetresToUnit(0.1, unit)}
            value={Number.isFinite(carpetArea) ? squareMetresToUnit(carpetArea, unit) : ""}
            onChange={(event) =>
              onChange(
                event.target.value === "" ? null : unitToSquareMetres(event.target.value, unit),
              )
            }
          />
          <span>{areaUnitFor(unit)}&#178;</span>
        </span>
      </label>
      <div className="property-area-note">
        Length runs east–west (left–right on the plan), width north–south
        (top–bottom).
      </div>
      <div className="property-area-size">
        <label>
          <span>Length ({unit})</span>
          <input
            aria-label={`Carpet length in ${unit}`}
            type="number"
            min="0"
            step={metresToUnit(0.1, unit)}
            value={lengthM == null ? "" : metresToUnit(lengthM, unit)}
            onChange={(e) => onSize(e.target.value === "" ? "" : unitToMetres(e.target.value, unit), widthM)}
          />
        </label>
        <label>
          <span>Width ({unit})</span>
          <input
            aria-label={`Carpet width in ${unit}`}
            type="number"
            min="0"
            step={metresToUnit(0.1, unit)}
            value={widthM == null ? "" : metresToUnit(widthM, unit)}
            onChange={(e) => onSize(lengthM, e.target.value === "" ? "" : unitToMetres(e.target.value, unit))}
          />
        </label>
      </div>
      <div className="button-row">
        <button
          type="button"
          disabled={!boundaryAreaM2}
          aria-pressed={fit}
          title={
            boundaryAreaM2
              ? "Use the area inside the external boundary"
              : "Draw the external boundary first (Boundary tool)"
          }
          onClick={onFitBoundary}
        >
          {fit
            ? `Fitted to boundary (${squareMetresToUnit(boundaryAreaM2, unit).toFixed(1)} ${areaUnitFor(unit)}²)`
            : "Fit to external boundary"}
        </button>
      </div>
      <div className="property-area-note">
        {fit
          ? "Follows the external boundary"
          : isCustom
            ? lengthM && widthM
              ? "Length × width"
              : "Custom project value"
            : "Calculated from room areas"}
        {(isCustom || fit) && (
          <button type="button" className="property-reset" onClick={onReset}>
            Use room total
          </button>
        )}
      </div>
      {onRotateBuilding && (
        <RotateControls
          label="Rotate whole building"
          onRotate={onRotateBuilding}
          note="All floors, rooms, objects and the boundary turn together about the building centre. The map alignment turns with them so logs stay on the same rooms. Floor-plan background images turn with them."
        />
      )}
      <label className="property-hide-rooms">
        <input
          type="checkbox"
          checked={isStatic}
          onChange={(event) => onStaticChange(event.target.checked)}
        />
        Static
      </label>
      <div className="property-static-note">
        Locks room dragging. Edit its position in the properties panel.
      </div>
      <label className="property-hide-rooms">
        <input
          type="checkbox"
          checked={!showRoomNames}
          onChange={(event) => onShowRoomNamesChange(!event.target.checked)}
        />
        Hide room names
      </label>
      <label className="property-hide-rooms">
        <input
          type="checkbox"
          checked={!showFurnitureNames}
          onChange={(event) =>
            onShowFurnitureNamesChange(!event.target.checked)
          }
        />
        Hide furniture/table names
      </label>
      <label className="property-hide-rooms">
        <input
          type="checkbox"
          checked={!showWifiNames}
          onChange={(event) => onShowWifiNamesChange(!event.target.checked)}
        />
        Hide Wi-Fi antenna names
      </label>
    </>
  );
}
