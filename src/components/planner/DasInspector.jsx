// Properties of a selected DAS part (source, splitter, coupler, riser) or cable,
// with what the network gives at the band chosen in Prediction.
import React from "react";
import Field from "../ui/Field.jsx";
import { carrierLabel } from "../../infra/cellular/bands.js";
import { DEFAULT_CATALOGUE } from "../../infra/cellular/engine/catalogue.js";
import { couplerTapLossDb, couplerThroughLossDb, splitterLossDb } from "../../infra/cellular/engine/passive.js";
import { cellularOf } from "../../infra/cellular/model.js";
import { DAS_TYPES, DEFAULT_SOURCE_POWER_DBM, cableLengthM, cableLossAt, dasPowers } from "../../infra/cellular/das.js";

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const PLACEHOLDER = "Loss values are placeholders until the cable, splitter and coupler datasheets are entered.";

const activeCarrier = (plan, cellular) => cellularOf(plan).carriers.find((x) => x.id === cellular?.carrierId) || null;

export function DasPartInspector({ plan, part, mutate, cellular }) {
  const c = cellularOf(plan);
  const carrier = activeCarrier(plan, cellular);
  const patch = (fields) =>
    mutate((p) => ({ ...p, sources: p.sources.map((s) => (s.id === part.id ? { ...s, ...fields } : s)) }));
  const outputs = c.cables.filter((x) => x.from === part.id);
  const input = c.cables.find((x) => x.to === part.id);
  const name = (id) => plan.sources.find((s) => s.id === id)?.name || "?";
  const das = carrier ? dasPowers(plan, carrier) : null;
  const inDbm = das?.nodeInputDbm[part.id];
  return (
    <div className="inspector-fields">
      <p className="hint">
        <strong>{DAS_TYPES[part.dasType]?.label}</strong>
        {input ? ` · fed from ${name(input.from)}` : part.dasType === "source" ? "" : " · not connected yet"}
        {outputs.length ? ` · ${outputs.length} output${outputs.length === 1 ? "" : "s"}: ${outputs.map((o) => name(o.to)).join(", ")}` : ""}
      </p>
      {part.dasType === "source" &&
        (c.carriers.length ? (
          c.carriers.map((x) => (
            <Field
              key={x.id}
              label={`Output power at ${carrierLabel(x)} (dBm)`}
              type="number"
              value={part.powerDbm?.[x.id] ?? DEFAULT_SOURCE_POWER_DBM}
              onChange={(v) => patch({ powerDbm: { ...(part.powerDbm || {}), [x.id]: Number(v) } })}
            />
          ))
        ) : (
          <p className="hint">Add a band in Network &amp; RF to set this source's output power.</p>
        ))}
      {part.dasType === "splitter" && (
        <div className="segmented" role="group" aria-label="Splitter outputs">
          {Object.values(DEFAULT_CATALOGUE.splitters).map((sp) => (
            <button
              key={sp.id}
              type="button"
              className={part.partId === sp.id ? "active" : ""}
              disabled={outputs.length > sp.ways}
              title={`${sp.name}: ${fmt(splitterLossDb(sp))} dB per output`}
              onClick={() => patch({ partId: sp.id })}
            >
              {sp.ways}-way · {fmt(splitterLossDb(sp))} dB
            </button>
          ))}
        </div>
      )}
      {part.dasType === "coupler" && (
        <>
          <Field
            label="Coupling"
            value={part.partId || "c10"}
            options={Object.keys(DEFAULT_CATALOGUE.couplers)}
            optionLabels={Object.fromEntries(
              Object.values(DEFAULT_CATALOGUE.couplers).map((cp) => [
                cp.id,
                `${cp.couplingDb} dB: tap −${fmt(couplerTapLossDb(cp))} dB, through −${fmt(couplerThroughLossDb(cp))} dB`,
              ]),
            )}
            onChange={(v) => patch({ partId: v })}
          />
          <p className="hint">The first cable drawn from a coupler is its through output, the second its tap (each cable can be switched).</p>
        </>
      )}
      {part.dasType === "riser" && (
        <p className="hint">
          Where the cable changes floor: draw a cable from the shaft part on one floor to a riser on the next (the floor height
          is added to its length), then go on from the riser.
        </p>
      )}
      {carrier && Number.isFinite(inDbm) && (
        <p className="hint">
          At {carrierLabel(carrier)}: {fmt(inDbm)} dBm {part.dasType === "source" ? "output" : "arriving at this part"}.
        </p>
      )}
      {das?.errors.map((e) => (
        <p key={e} className="warn">
          {e}
        </p>
      ))}
      <p className="hint">{PLACEHOLDER}</p>
    </div>
  );
}

export function DasCableInspector({ plan, cable, mutate, cellular, onDelete }) {
  const carrier = activeCarrier(plan, cellular);
  const name = (id) => plan.sources.find((s) => s.id === id)?.name || "?";
  const from = plan.sources.find((s) => s.id === cable.from);
  const to = plan.sources.find((s) => s.id === cable.to);
  const floorName = (id) => plan.floors.find((f) => f.id === id)?.name || "";
  const patch = (fields) =>
    mutate((p) => ({
      ...p,
      cellular: { ...p.cellular, cables: (p.cellular?.cables || []).map((x) => (x.id === cable.id ? { ...x, ...fields } : x)) },
    }));
  const lengthM = cableLengthM(plan, cable);
  const loss = carrier ? cableLossAt(plan, cable, carrier.freqMHz) : null;
  return (
    <div className="inspector-fields">
      <p className="hint">
        <strong>
          {name(cable.from)} → {name(cable.to)}
        </strong>
        {from && to && from.floorId !== to.floorId ? ` · ${floorName(from.floorId)} → ${floorName(to.floorId)}` : ""}
      </p>
      <Field
        label="Cable"
        value={cable.cableId || "1/2"}
        options={Object.keys(DEFAULT_CATALOGUE.cables)}
        optionLabels={Object.fromEntries(Object.values(DEFAULT_CATALOGUE.cables).map((x) => [x.id, x.name]))}
        onChange={(v) => patch({ cableId: v })}
      />
      <Field label="Extra length (m)" type="number" value={cable.extraM ?? 0} onChange={(v) => patch({ extraM: Number(v) || 0 })} />
      <Field label="Connectors" type="number" value={cable.connectors ?? 2} onChange={(v) => patch({ connectors: Math.max(0, Math.round(Number(v) || 0)) })} />
      {from?.dasType === "coupler" && (
        <Field
          label="Coupler output"
          value={cable.port || "through"}
          options={["through", "tap"]}
          optionLabels={{ through: "Through", tap: "Tap" }}
          onChange={(v) => patch({ port: v })}
        />
      )}
      <p className="hint">
        Length {fmt(lengthM)} m (along the plan{from && to && from.floorId !== to.floorId ? " plus the floor height" : ""}
        {Number(cable.extraM) ? ` plus ${fmt(Number(cable.extraM))} m extra` : ""}).
        {loss && !loss.error && carrier
          ? ` Loss at ${carrierLabel(carrier)}: cable ${fmt(loss.cableDb)} dB + connectors ${fmt(loss.connectorsDb)} dB = ${fmt(loss.totalDb)} dB.`
          : ""}
      </p>
      {loss?.error && <p className="warn">{loss.error}</p>}
      <p className="hint">{PLACEHOLDER}</p>
      <button type="button" className="danger-text" onClick={onDelete}>
        Delete cable
      </button>
    </div>
  );
}

// The loss chain of one antenna from its source, for the antenna's panel.
export function AntennaFeed({ plan, antenna, carrier }) {
  if (!carrier) return null;
  const das = dasPowers(plan, carrier);
  const fed = das.antennas[antenna.id];
  if (!fed) return null;
  const name = (id) => plan.sources.find((s) => s.id === id)?.name || id;
  const source = plan.sources.find((s) => s.id === fed.sourceId);
  return (
    <div className="das-feed">
      <p className="hint">
        <strong>Port power from the DAS network: {fmt(fed.powerDbm)} dBm</strong> at {carrierLabel(carrier)} (the typed value is
        not used while a cable feeds this antenna).
      </p>
      <ol className="hint">
        <li>
          {source?.name}: {fmt(fed.powerDbm + fed.pathLossDb)} dBm
        </li>
        {fed.steps.map((s, i) => (
          <li key={i}>
            {s.kind === "cable"
              ? `${fmt(s.lengthM)} m ${DEFAULT_CATALOGUE.cables[s.cableId]?.name || s.cableId}`
              : s.kind === "connectors"
                ? "connectors"
                : `${name(s.id)}${s.port ? ` (${s.port})` : ""}`}
            : −{fmt(s.lossDb, 2)} dB → {fmt(s.powerAfterDbm)} dBm
          </li>
        ))}
      </ol>
    </div>
  );
}
