import React, { useState } from "react";
import Field from "../ui/Field.jsx";
import { buildSceneGlb, buildSceneZip, downloadBlob } from "../../utils/sceneExport.js";
import ApProfileEditor from "../planner/ApProfileEditor.jsx";
import CellularPanel from "../planner/CellularPanel.jsx";
import { antennaModels } from "../../infra/cellular/model.js";

// Network & RF of one project: the Wi-Fi AP profile in a Wi-Fi project, the
// cellular network (carriers, sectors, antenna models) in a cellular one.
export default function NetworkPanel({
  plan,
  mutate,
  sources: floorSources,
  setTab,
  setSelected,
  optimization,
  workspace = "wifi",
  cellular,
  floorId,
  setTool,
}) {
  const isCellular = workspace === "cellular";
  const sources = floorSources.filter((s) => (s.kind === "cellular") === isCellular);
  const sceneSources = isCellular ? "cellular" : "wifi";
  const transmitters = isCellular ? "antennas" : "access points";
  const models = isCellular ? antennaModels(plan) : {};
  const [exportState, setExportState] = useState(null);
  const [allFloors, setAllFloors] = useState(true);
  const [furniture, setFurniture] = useState(false);
  const exportScene = async () => {
    setExportState({ busy: true });
    try {
      const { blob, config, warnings } = await buildSceneZip(plan, {
        floorIds: allFloors ? undefined : [plan.selectedFloorId],
        includeFurniture: furniture,
        sources: sceneSources,
      });
      downloadBlob(blob, "ray-tracing-scene.zip");
      setExportState({
        done: `Exported ${config.meshes.length} meshes, ${config.accessPoints.length} ${transmitters}.`,
        warnings,
      });
    } catch (error) {
      setExportState({ error: error.message, warnings: error.warnings });
    }
  };
  const exportSceneGlb = async () => {
    setExportState({ busy: true });
    try {
      const { blob, config, warnings } = await buildSceneGlb(plan, {
        floorIds: allFloors ? undefined : [plan.selectedFloorId],
        includeFurniture: furniture,
        sources: sceneSources,
      });
      downloadBlob(blob, "indoor-planner-scene.glb");
      setExportState({
        done: `Exported GLB with ${config.floors.length} floor${config.floors.length === 1 ? "" : "s"} (${config.floors.map((floor) => floor.name).join(", ")}), ${config.meshes.length} meshes and ${config.accessPoints.length} ${transmitters}.`,
        warnings,
      });
    } catch (error) {
      setExportState({ error: error.message, warnings: error.warnings });
    }
  };
  return (
    <div className="panel-grid">
      {isCellular ? (
        <section className="panel">
          <h2>Cellular network</h2>
          {cellular && (
            <CellularPanel
              parts="network"
              plan={plan}
              mutate={mutate}
              cellular={cellular}
              floorId={floorId}
              selectedSource={null}
              setTool={setTool}
            />
          )}
        </section>
      ) : (
        optimization && <ApProfileEditor plan={plan} mutate={mutate} optimization={optimization} />
      )}
      <section className="panel">
        <h2>Ray-tracing scene export</h2>
        <p>
          Builds the 3D walls, openings and floor slabs shown in the 3D view as
          PLY meshes with a Mitsuba scene file, ITU-R radio materials and the
          {isCellular ? " cellular antennas" : " access-point configuration"}, for a Sionna RT simulation worker. Export
          a GLB as well for general 3D viewers and browser-based tools.
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
        <div className="button-row">
          <button onClick={exportScene} disabled={exportState?.busy}>
            Export ray-tracing scene (.zip)
          </button>
          <button onClick={exportSceneGlb} disabled={exportState?.busy}>
            Export {allFloors ? "all floors" : "selected floor"} (.glb)
          </button>
        </div>
        {exportState?.done && <p>{exportState.done}</p>}
        {exportState?.error && <p className="error">{exportState.error}</p>}
        {exportState?.warnings?.map((w) => (
          <small key={w} style={{ display: "block" }}>
            ⚠ {w}
          </small>
        ))}
      </section>
      <section className="panel">
        <h2>{isCellular ? "Antennas" : "Access points"}</h2>
        <p>
          {isCellular
            ? "Use the Antenna tool in the editor to place an antenna. Select it to set its model, sector, port power, height, mounting, azimuth and downtilt."
            : "Use the Wi-Fi AP tool in the editor to place an access point. Select it to configure power, frequency, gain, pattern, azimuth and mounting height."}
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
              <span className={isCellular ? "cell-dot" : "wifi-dot"} />
              <strong>{s.name}</strong>
              <small>
                {isCellular
                  ? `${models[s.antennaModelId]?.name || "no model"} · ${s.inputPowerDbm ?? "–"} dBm at port`
                  : `${s.freqMHz} MHz · ${s.txPowerDbm} dBm`}
              </small>
              →
            </button>
          ))
        ) : (
          <div className="empty small">No {transmitters} on this floor.</div>
        )}
      </section>
    </div>
  );
}
