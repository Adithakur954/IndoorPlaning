import React from "react";
import Field from "../ui/Field.jsx";
import { NOISE_PRESETS, noisePresetOf } from "../../hooks/useRayTracedPrediction.js";

export default function NoiseSettings({ settings, setSettings }) {
  return (
    <>
      <div className="inspector-fields">
        <Field
          label="Noise floor for SNR"
          value={noisePresetOf(settings)}
          options={[...NOISE_PRESETS.map((p) => p.id), "custom"]}
          optionLabels={Object.fromEntries([
            ...NOISE_PRESETS.map((p) => [p.id, p.label]), ["custom", "Custom values"],
          ])}
          onChange={(id) => {
            const preset = NOISE_PRESETS.find((p) => p.id === id);
            if (preset) setSettings((s) => ({ ...s,
              noiseFloor24Dbm: preset.noiseFloor24Dbm,
              noiseFloor5Dbm: preset.noiseFloor5Dbm,
              noiseFloor6Dbm: preset.noiseFloor5Dbm,
            }));
          }}
        />
        {[
          ["noiseFloor24Dbm", "2.4 GHz noise floor (dBm)"],
          ["noiseFloor5Dbm", "5 GHz noise floor (dBm)"],
          ["noiseFloor6Dbm", "6 GHz noise floor (dBm)"],
        ].map(([key, label]) => (
          <Field key={key} label={label} type="number" value={settings[key]}
            onChange={(v) => setSettings((s) => ({ ...s, [key]: Number(v) }))} />
        ))}
      </div>
      <small className="hint">
        SNR = signal − noise floor. These are planning assumptions for a 20 MHz
        channel; 40 MHz adds 3 dB of noise and 80 MHz adds 6 dB. Shared with
        prediction and optimisation. Run again after changing them.
      </small>
    </>
  );
}
