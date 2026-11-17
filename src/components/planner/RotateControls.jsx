import React, { useState } from "react";

// One input box: type the angle in degrees (positive turns clockwise, negative
// counter-clockwise) and press Enter or the button.
export default function RotateControls({ label = "Rotate", onRotate, note }) {
  const [angle, setAngle] = useState("");
  const value = Number(angle);
  const valid = angle !== "" && Number.isFinite(value) && value !== 0;
  const apply = () => {
    if (!valid) return;
    onRotate(value);
    setAngle("");
  };
  return (
    <section className="rotate-controls" aria-label={label}>
      <label className="rotate-free">
        <span>{label} (°)</span>
        <input
          type="number"
          step="any"
          placeholder="e.g. 90 or -30"
          aria-label={`${label}, angle in degrees`}
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
        <button
          type="button"
          disabled={!valid}
          title="Positive turns clockwise, negative counter-clockwise"
          onClick={apply}
        >
          Rotate
        </button>
      </label>
      {note && <small className="hint">{note}</small>}
    </section>
  );
}
