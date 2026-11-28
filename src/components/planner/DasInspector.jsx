// Properties of a selected DAS part (source, splitter, coupler, riser) or cable,
// with what the network gives at the band chosen in Prediction.
import React from "react";
import Field from "../ui/Field.jsx";
import { carrierLabel } from "../../infra/cellular/bands.js";
import { DEFAULT_CATALOGUE } from "../../infra/cellular/engine/catalogue.js";
import { couplerTapLossDb, couplerThroughLossDb, splitterLossDb } from "../../infra/cellular/engine/passive.js";
import { cellularOf } from "../../infra/cellular/model.js";
import {
  DAS_TYPES,
  DEFAULT_SOURCE_POWER_DBM,
  cableLengthM,
  cableLossAt,
  connectorOf,
  dasCatalogue,
  dasPowers,
  outputPorts,
  portsOf,
} from "../../infra/cellular/das.js";

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
// where the loss values come from (engine/catalogue.js)
const sourceNote = (entry) => (entry?.source ? <p className="hint">Values: {entry.source}.</p> : null);

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
          {Object.values(dasCatalogue(plan).splitters).map((sp) => (
            <button
              key={sp.id}
              type="button"
              className={part.partId === sp.id ? "active" : ""}
              disabled={outputs.length > sp.ways}
              title={`${sp.name} ${sp.model || ""}: ${fmt(splitterLossDb(sp))} dB per output`}
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
            options={Object.keys(dasCatalogue(plan).couplers)}
            optionLabels={Object.fromEntries(
              Object.values(dasCatalogue(plan).couplers).map((cp) => [
                cp.id,
                `${cp.couplingDb} dB: tap −${fmt(couplerTapLossDb(cp))} dB, through −${fmt(couplerThroughLossDb(cp))} dB`,
              ]),
            )}
            onChange={(v) => patch({ partId: v })}
          />
          <p className="hint">The first cable drawn from a coupler is its through output, the second its tap (each cable can be switched).</p>
        </>
      )}
      {part.dasType === "combiner" && (
        <Field
          label="Combiner"
          value={part.partId || "cm21"}
          options={Object.values(dasCatalogue(plan).inline).filter((x) => x.model || x.imported).map((x) => x.id)}
          optionLabels={Object.fromEntries(
            Object.values(dasCatalogue(plan).inline).filter((x) => x.model || x.imported).map((x) => [x.id, `${x.model || x.name}: −${fmt(x.lossDb)} dB`]),
          )}
          onChange={(v) => patch({ partId: v })}
        />
      )}
      {part.dasType === "riser" && Object.keys(dasCatalogue(plan).risers).length > 1 && (
        <Field
          label="Riser"
          value={part.partId || "riser"}
          options={Object.keys(dasCatalogue(plan).risers)}
          optionLabels={Object.fromEntries(
            Object.values(dasCatalogue(plan).risers).map((x) => [x.id, `${x.model || x.name}: −${fmt(x.lossDb)} dB`]),
          )}
          onChange={(v) => patch({ partId: v })}
        />
      )}
      {part.dasType === "riser" && (
        <p className="hint">
          The shaft, where the feeder changes floor. It is not a source: it takes a cable from the BTS (or any part) and
          passes it on to the next floor's shaft or part (the floor height is added to the cable length). Shaft cables default
          to the 7/8" low-loss feeder.
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
      {sourceNote(
        part.dasType === "splitter"
          ? dasCatalogue(plan).splitters[part.partId]
          : part.dasType === "coupler"
            ? dasCatalogue(plan).couplers[part.partId]
            : part.dasType === "combiner"
              ? dasCatalogue(plan).inline[part.partId]
              : part.dasType === "riser"
                ? dasCatalogue(plan).risers[part.partId]
                : null,
      )}
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
  const hasSpecifiedLength = Number.isFinite(cable.specifiedLengthM) && cable.specifiedLengthM >= 0;
  const loss = carrier ? cableLossAt(plan, cable, carrier.freqMHz) : null;
  const ports = from ? outputPorts(plan, from) : [];
  return (
    <div className="inspector-fields">
      <p className="hint">
        <strong>
          {name(cable.from)} {ports.find((p) => p.cableId === cable.id)?.label || ""} → {name(cable.to)} {to?.kind === "cellular" ? "Ant" : "In"}
        </strong>
        {from && to && from.floorId !== to.floorId ? ` · ${floorName(from.floorId)} → ${floorName(to.floorId)}` : ""}
      </p>
      <Field
        label="Cable"
        value={cable.cableId || "1/2"}
        options={Object.keys(dasCatalogue(plan).cables)}
        optionLabels={Object.fromEntries(Object.values(dasCatalogue(plan).cables).map((x) => [x.id, x.name]))}
        onChange={(v) => patch({ cableId: v })}
      />
      <Field
        label="Specified length (m)"
        type="number"
        min={0}
        allowEmpty
        value={hasSpecifiedLength ? cable.specifiedLengthM : ""}
        onChange={(v) => patch({ specifiedLengthM: String(v).trim() === "" ? null : Math.max(0, Number(v) || 0) })}
      />
      {!hasSpecifiedLength && (
        <Field label="Extra length (m)" type="number" value={cable.extraM ?? 0} onChange={(v) => patch({ extraM: Number(v) || 0 })} />
      )}
      <Field label="Connectors" type="number" value={cable.connectors ?? 2} onChange={(v) => patch({ connectors: Math.max(0, Math.round(Number(v) || 0)) })} />
      {ports.length > 1 && (
        // the output this cable leaves from: its own or a free one
        <Field
          label={`Output of ${name(cable.from)}`}
          value={ports.find((p) => p.cableId === cable.id)?.id || ""}
          options={ports.filter((p) => !p.cableId || p.cableId === cable.id).map((p) => p.id)}
          optionLabels={Object.fromEntries(ports.map((p) => [p.id, p.label]))}
          onChange={(v) => patch({ port: v })}
        />
      )}
      <p className="hint">
        Connectors: {connectorOf(from)} → {connectorOf(to)}.
      </p>
      <p className="hint">
        Length {fmt(lengthM)} m {hasSpecifiedLength
          ? "(specified cable length)."
          : `(along the plan${from && to && from.floorId !== to.floorId ? " plus the floor height" : ""}${Number(cable.extraM) ? ` with ${fmt(Number(cable.extraM))} m adjustment` : ""}).`}
        {loss && !loss.error && carrier
          ? ` Loss at ${carrierLabel(carrier)}: cable ${fmt(loss.cableDb)} dB + connectors ${fmt(loss.connectorsDb)} dB = ${fmt(loss.totalDb)} dB.`
          : ""}
      </p>
      {loss?.error && <p className="warn">{loss.error}</p>}
      {sourceNote(dasCatalogue(plan).cables[cable.cableId || "1/2"])}
      {sourceNote(DEFAULT_CATALOGUE.connector)}
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
              ? `${fmt(s.lengthM)} m ${dasCatalogue(plan).cables[s.cableId]?.name || s.cableId}`
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

// Options of the DAS tool in use, shown over the plan: the type the next part
// gets (2/3/4-way splitter, coupler value, combiner) or the cable type, with the
// state of the cable being drawn.
export const DAS_TOOL_IDS = ["dassource", "splitter", "coupler", "combiner", "riser", "dascable"];

export function DasToolBar({
  tool,
  plan,
  dasOptions,
  setDasOptions,
  cableFrom,
  cablePoints = [],
  cancelCable,
  undoCableBend,
  cablePick,
  cableStartPort,
  chooseCableEnd,
  onCableSettings,
  onPartSettings,
}) {
  if (!DAS_TOOL_IDS.includes(tool)) return null;
  const nameOf = (id) => plan.sources.find((s) => s.id === id)?.name || "?";
  const pickItem = tool === "dascable" && cablePick ? plan.sources.find((s) => s.id === cablePick) : null;
  if (pickItem)
    return (
      <div className="das-toolbar" role="toolbar" aria-label="Choose the end">
        <strong>{pickItem.name}</strong>
        <small>{cableStartPort ? "Connect to which end?" : "Start the cable at which end?"}</small>
        <div className="segmented" role="group">
          {portsOf(plan, pickItem).map((o) => {
            const cp = pickItem.dasType === "coupler" ? dasCatalogue(plan).couplers[pickItem.partId] : null;
            const loss = cp ? (o.id === "tap" ? couplerTapLossDb(cp) : o.id === "through" ? couplerThroughLossDb(cp) : null) : null;
            return (
              <button
                key={o.id}
                type="button"
                disabled={Boolean(o.other)}
                title={o.other ? `used: ${o.dir === "in" ? "from" : "to"} ${o.other}` : "free"}
                onClick={() => chooseCableEnd({ id: pickItem.id, port: o.id, dir: o.dir })}
              >
                {o.label}
                {Number.isFinite(loss) ? ` (−${fmt(loss)} dB)` : ""}
                {o.other ? " · used" : ""}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={cancelCable}>
          Cancel
        </button>
      </div>
    );
  const set = (key, value) => setDasOptions((o) => ({ ...o, [key]: value }));
  const choice = (key, items) => (
    <div className="segmented" role="group">
      {items.map(([value, label, title]) => (
        <button key={value} type="button" title={title} className={dasOptions[key] === value ? "active" : ""} onClick={() => set(key, value)}>
          {label}
        </button>
      ))}
    </div>
  );
  const start = cableFrom ? plan.sources.find((s) => s.id === cableFrom) : null;
  return (
    <div className="das-toolbar" role="toolbar" aria-label="DAS tool options">
      {tool === "splitter" && (
        <>
          <strong>Splitter: {dasCatalogue(plan).splitters[dasOptions.splitter]?.model || dasCatalogue(plan).splitters[dasOptions.splitter]?.name || "–"}</strong>
          <small>{dasCatalogue(plan).splitters[dasOptions.splitter]?.name}</small>
          {onPartSettings && (
            <button type="button" onClick={onPartSettings}>
              Change…
            </button>
          )}
          <small>Click on the plan to place it.</small>
        </>
      )}
      {tool === "coupler" && (
        <>
          <strong>Coupler: {dasCatalogue(plan).couplers[dasOptions.coupler]?.model || dasCatalogue(plan).couplers[dasOptions.coupler]?.name || "–"}</strong>
          <small>{dasCatalogue(plan).couplers[dasOptions.coupler]?.name}</small>
          {onPartSettings && (
            <button type="button" onClick={onPartSettings}>
              Change…
            </button>
          )}
          <small>Click on the plan to place it.</small>
        </>
      )}
      {tool === "combiner" && (
        <>
          <strong>Combiner: {dasCatalogue(plan).inline[dasOptions.combiner]?.model || dasCatalogue(plan).inline[dasOptions.combiner]?.name || "–"}</strong>
          <small>{dasCatalogue(plan).inline[dasOptions.combiner]?.name}</small>
          {onPartSettings && (
            <button type="button" onClick={onPartSettings}>
              Change…
            </button>
          )}
          <small>Click on the plan to place it.</small>
        </>
      )}
      {tool === "riser" && (
        <>
          <strong>Shaft: {dasCatalogue(plan).risers[dasOptions.riser]?.model || dasCatalogue(plan).risers[dasOptions.riser]?.name || "–"}</strong>
          {onPartSettings && (
            <button type="button" onClick={onPartSettings}>
              Change…
            </button>
          )}
          <small>Click on the plan to place the shaft (where the feeder changes floor).</small>
        </>
      )}
      {tool === "dassource" && <small>Click on the plan to place the source (BTS / repeater).</small>}
      {tool === "dascable" && (
        <>
          <strong>
            Cable: {dasOptions.cable === "auto" || !dasCatalogue(plan).cables[dasOptions.cable]
              ? "Auto"
              : dasCatalogue(plan).cables[dasOptions.cable].name}
          </strong>
          {onCableSettings && (
            <button type="button" onClick={onCableSettings}>
              Change…
            </button>
          )}
          <small>
            {start && cableStartPort
              ? `From ${start.name} ${portsOf(plan, start).find((p) => p.id === cableStartPort.port)?.label || ""}: click corners along the route${
                  cablePoints.length ? ` (${cablePoints.length} so far)` : ""
                }, then the other antenna or part and its end.`
              : "Click an antenna or part, then the end (orange square) the cable starts at."}
          </small>
          {start && cablePoints.length > 0 && (
            <button type="button" onClick={undoCableBend}>
              Undo bend
            </button>
          )}
          {start && (
            <button type="button" onClick={cancelCable}>
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  );
}
