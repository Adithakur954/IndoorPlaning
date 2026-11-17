import React, { useState } from "react";
import Field from "../ui/Field.jsx";
import { buildSceneZip, downloadBlob } from "../../utils/sceneExport.js";
import ApProfileEditor from "../planner/ApProfileEditor.jsx";
export default function NetworkPanel({
  plan,
  mutate,
  sources,
  setTab,
  setSelected,
  optimization,
}) {
  const [exportState, setExportState] = useState(null);
  const [allFloors, setAllFloors] = useState(true);
  const [furniture, setFurniture] = useState(false);
  const exportScene = async () => {
    setExportState({ busy: true });
    try {
      const { blob, config, warnings } = await buildSceneZip(plan, {
        floorIds: allFloors ? undefined : [plan.selectedFloorId],
        includeFurniture: furniture,
      });
      downloadBlob(blob, "ray-tracing-scene.zip");
      setExportState({
        done: `Exported ${config.meshes.length} meshes, ${config.accessPoints.length} access points.`,
        warnings,
      });
    } catch (error) {
      setExportState({ error: error.message, warnings: error.warnings });
    }
  };
  return (
    <div className="panel-grid">
      {optimization && <ApProfileEditor plan={plan} mutate={mutate} optimization={optimization} />}
      <section className="panel">
        <h2>Ray-tracing scene export</h2>
        <p>
          Builds the 3D walls, openings and floor slabs shown in the 3D view as
          PLY meshes with a Mitsuba scene file, ITU-R radio materials and the
          access-point configuration, for a Sionna RT simulation worker. It
          contains geometry and material assumptions only.
        </p>
        <label>
          <input
            type="checkbox"
            checked={allFloors}
            onChange={(e) => setAllFloors(e.target.checked)}
          />{" "}
          All floors (otherwise the selected floor only)
        </label>
        <label>
          <input
            type="checkbox"
            checked={furniture}
            onChange={(e) => setFurniture(e.target.checked)}
          />{" "}
          Include furniture as wooden boxes
        </label>
        <button onClick={exportScene} disabled={exportState?.busy}>
          Export scene (.zip)
        </button>
        {exportState?.done && <p>{exportState.done}</p>}
        {exportState?.error && <p className="error">{exportState.error}</p>}
        {exportState?.warnings?.map((w) => (
          <small key={w} style={{ display: "block" }}>
            ⚠ {w}
          </small>
        ))}
      </section>
      <section className="panel">
        <h2>Network sources</h2>
        <p>
          Use the Cellular or Wi-Fi tool in the editor to place a source. Select
          it to configure power, frequency, gain, pattern, sectors, azimuth and
          mounting height.
        </p>
        {sources.length ? (
          sources.map((s) => (
            <button
              key={s.id}
              className="source-list-item"
              onClick={() => {
                setTab("design");
                setSelected({ type: "source", id: s.id });
              }}
            >
              <span className={s.kind === "wifi" ? "wifi-dot" : "cell-dot"} />
              <strong>{s.name}</strong>
              <small>
                {s.freqMHz} MHz · {s.txPowerDbm} dBm
              </small>
              →
            </button>
          ))
        ) : (
          <div className="empty small">No sources on this floor.</div>
        )}
      </section>
    </div>
  );
}
