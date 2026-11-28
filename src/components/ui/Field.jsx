import React, { useEffect, useState } from "react";
import {
  areaUnitFor,
  metresToUnit,
  densityPerSquareMetreToUnit,
  densityPerUnitToSquareMetre,
  squareMetresToUnit,
  unitToMetres,
  unitToSquareMetres,
  useMeasurementUnit,
} from "../../utils/measurementUnits.jsx";

export default Field;

// Number box that keeps what is being typed ("-", "0.", "-7") and passes on
// only complete numbers, so negative values can be typed from scratch.
function NumberInput({ value, onChange, step, min }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => {
    // follow outside changes, but never overwrite a half-typed number
    if (Number(text) !== Number(value) || text === "")
      setText(String(value ?? ""));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      type="number"
      step={step}
      min={min}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setText(String(value ?? ""))}
    />
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  step = "any",
  min,
  options,
  optionLabels, // optional { value: text shown } for the options
  measurement = null,
  allowEmpty = false,
}) {
  const unit = useMeasurementUnit();
  const isLength = type === "number" && (measurement === "length" || /\(m\)$/.test(label));
  const isArea = type === "number" && (measurement === "area" || /\(m²\)$/.test(label));
  const isDensity = type === "number" && measurement === "density";
  const displayValue = (value) =>
    value === "" || value == null
      ? value
      : isLength
        ? metresToUnit(value, unit)
        : isArea
          ? squareMetresToUnit(value, unit)
          : isDensity
            ? densityPerSquareMetreToUnit(value, unit)
          : value;
  const displayMin =
    min == null
      ? min
      : isLength
        ? metresToUnit(min, unit)
        : isArea
          ? squareMetresToUnit(min, unit)
          : isDensity
            ? densityPerSquareMetreToUnit(min, unit)
          : min;
  const displayStep =
    step === "any"
      ? step
      : isLength
        ? metresToUnit(step, unit)
        : isArea
          ? squareMetresToUnit(step, unit)
          : isDensity
            ? densityPerSquareMetreToUnit(step, unit)
          : step;
  const displayLabel = isLength
    ? /\(m\)$/.test(label)
      ? label.replace(/\(m\)$/, `(${unit})`)
      : `${label} (${unit})`
    : isArea
      ? /\(m²\)$/.test(label)
        ? label.replace(/\(m²\)$/, `(${areaUnitFor(unit)}²)`)
        : `${label} (${areaUnitFor(unit)}²)`
      : isDensity
        ? label.replace(/m²/g, `${areaUnitFor(unit)}²`)
        : label;
  const handleChange = (value) =>
    onChange(
      allowEmpty && value === ""
        ? ""
        : isLength
        ? unitToMetres(value, unit)
        : isArea
          ? unitToSquareMetres(value, unit)
          : isDensity
            ? densityPerUnitToSquareMetre(value, unit)
          : value,
    );
  return (
    <label className="field">
      <span>{displayLabel}</span>
      {options ? (
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {optionLabels?.[o] ?? o}
            </option>
          ))}
        </select>
      ) : type === "number" ? (
        <NumberInput
          value={displayValue(value)}
          onChange={handleChange}
          step={displayStep}
          min={displayMin}
        />
      ) : (
        <input
          type={type}
          step={step}
          min={min}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
