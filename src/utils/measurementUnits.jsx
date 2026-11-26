import React, { createContext, useContext } from "react";

export const MEASUREMENT_UNITS = ["m", "ft"];

const METRES_PER_UNIT = {
  m: 1,
  ft: 0.3048,
};

const UNIT_NAMES = {
  m: "Metres (m)",
  ft: "Feet (ft)",
};

const MeasurementUnitContext = createContext("m");

export function MeasurementUnitProvider({ unit = "m", children }) {
  return (
    <MeasurementUnitContext.Provider value={METRES_PER_UNIT[unit] ? unit : "m"}>
      {children}
    </MeasurementUnitContext.Provider>
  );
}

export const useMeasurementUnit = () => useContext(MeasurementUnitContext);
export const measurementUnitName = (unit) => UNIT_NAMES[unit] || UNIT_NAMES.m;
export const areaUnitFor = (unit = "m") => (unit === "ft" ? "ft" : "m");

export function metresToUnit(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const converted = n / (METRES_PER_UNIT[unit] || 1);
  return Number(converted.toPrecision(7));
}

export function unitToMetres(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n * (METRES_PER_UNIT[unit] || 1);
}

export function squareMetresToUnit(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const factor = METRES_PER_UNIT[areaUnitFor(unit)] || 1;
  return Number((n / (factor * factor)).toPrecision(7));
}

export function unitToSquareMetres(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const factor = METRES_PER_UNIT[areaUnitFor(unit)] || 1;
  return n * factor * factor;
}

export function densityPerSquareMetreToUnit(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const factor = METRES_PER_UNIT[areaUnitFor(unit)] || 1;
  return Number((n * factor * factor).toPrecision(7));
}

export function densityPerUnitToSquareMetre(value, unit = "m") {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const factor = METRES_PER_UNIT[areaUnitFor(unit)] || 1;
  return n / (factor * factor);
}

export function formatLength(valueM, unit = "m", digits = 2) {
  const value = metresToUnit(valueM, unit);
  return `${Number(value).toFixed(digits)} ${unit}`;
}

export function formatArea(valueM2, unit = "m", digits = 1) {
  const value = squareMetresToUnit(valueM2, unit);
  return `${Number(value).toFixed(digits)} ${areaUnitFor(unit)}²`;
}
