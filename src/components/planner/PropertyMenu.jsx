import React from "react";

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
}) {
  return (
    <>
      <label className="property-area-field">
        <span>Carpet area</span>
        <span className="property-area-input">
          <input
            aria-label="Carpet area in square metres"
            type="number"
            min="0"
            step="0.1"
            value={Number.isFinite(carpetArea) ? carpetArea : ""}
            onChange={(event) =>
              onChange(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
          />
          <span>m&#178;</span>
        </span>
      </label>
      <div className="property-area-note">
        {isCustom ? "Custom project value" : "Calculated from room areas"}
        {isCustom && (
          <button type="button" className="property-reset" onClick={onReset}>
            Use room total
          </button>
        )}
      </div>
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
