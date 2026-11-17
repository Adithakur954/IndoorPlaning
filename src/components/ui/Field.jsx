import React, { useEffect, useState } from "react";

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
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {optionLabels?.[o] ?? o}
            </option>
          ))}
        </select>
      ) : type === "number" ? (
        <NumberInput value={value} onChange={onChange} step={step} min={min} />
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
