import React from "react";
import { num } from "../../utils/number.js";

export default Field;

function Field({
  label,
  value,
  onChange,
  type = "text",
  step = "any",
  min,
  options,
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          step={step}
          min={min}
          value={value ?? ""}
          onChange={(e) =>
            onChange(type === "number" ? num(e.target.value) : e.target.value)
          }
        />
      )}
    </label>
  );
}
