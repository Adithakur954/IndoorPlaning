import React, { useMemo, useState } from "react";
import { INDOOR_LOG_KPIS } from "../../utils/indoorLogKpis.js";
import {
  countLogs,
  hasNoPosition,
  isFromSource,
  isKpiOutOfRange,
  isOnFloor,
  isOutsideBuilding,
  logSources,
  removeLogs,
} from "../../utils/logCleanup.js";

const numberOrNull = (text) =>
  text === "" || !Number.isFinite(Number(text)) ? null : Number(text);

// Lets the user pick what to remove from the imported logs (a file or session,
// points outside the building, points without a position, bad values, a floor)
// and from the other imports (floor images).
export default function LogManager({ plan, mutate, floorId, metric, kpiOptions = INDOOR_LOG_KPIS }) {
  const [kpi, setKpi] = useState(metric);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [note, setNote] = useState("");
  const sources = useMemo(() => logSources(plan), [plan.logs]); // eslint-disable-line react-hooks/exhaustive-deps
  const noPosition = countLogs(plan, hasNoPosition(plan));
  const outside = countLogs(plan, isOutsideBuilding(plan));
  const range = isKpiOutOfRange(kpi, numberOrNull(min), numberOrNull(max));
  const outOfRange =
    numberOrNull(min) === null && numberOrNull(max) === null
      ? 0
      : countLogs(plan, range);
  const onThisFloor = countLogs(plan, isOnFloor(floorId));
  const kpiInfo = INDOOR_LOG_KPIS.find((k) => k.key === kpi);
  const remove = (predicate, label, count) => {
    if (!count) return;
    if (!window.confirm(`Remove ${count} log point${count === 1 ? "" : "s"}: ${label}?`))
      return;
    mutate((p) => removeLogs(p, predicate));
    setNote(`Removed ${count}: ${label}.`);
  };
  const image = plan.images?.[floorId];
  return (
    <div className="log-manager">
      <h4>Remove from imported logs</h4>
      {!plan.logs?.length && <small className="hint">No logs imported.</small>}
      {sources.map((s) => (
        <div key={s.source} className="log-source-row">
          <span>
            <strong>{s.source}</strong>
            <small>
              {s.count} points · {s.floors.join(", ")}
            </small>
          </span>
          <button
            type="button"
            onClick={() => remove(isFromSource(s.source), s.source, s.count)}
          >
            Remove
          </button>
        </div>
      ))}
      {plan.logs?.length > 0 && (
        <>
          <div className="log-source-row">
            <span>
              <strong>Points outside the building</strong>
              <small>
                {outside} not inside any room or the boundary (floors with no
                drawn rooms are skipped)
              </small>
            </span>
            <button
              type="button"
              disabled={!outside}
              onClick={() =>
                remove(isOutsideBuilding(plan), "outside the building", outside)
              }
            >
              Remove
            </button>
          </div>
          <div className="log-source-row">
            <span>
              <strong>Points without a position</strong>
              <small>{noPosition} (GPS logs still waiting for alignment)</small>
            </span>
            <button
              type="button"
              disabled={!noPosition}
              onClick={() =>
                remove(hasNoPosition(plan), "no position on the plan", noPosition)
              }
            >
              Remove
            </button>
          </div>
          <div className="log-source-row">
            <span>
              <strong>Points on this floor</strong>
              <small>{onThisFloor}</small>
            </span>
            <button
              type="button"
              disabled={!onThisFloor}
              onClick={() =>
                remove(isOnFloor(floorId), "all logs of this floor", onThisFloor)
              }
            >
              Remove
            </button>
          </div>
          <div className="log-range">
            <strong>By value</strong>
            <div className="row">
              <select
                aria-label="KPI"
                value={kpi}
                onChange={(e) => setKpi(e.target.value)}
              >
                {kpiOptions.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                aria-label="Remove values below"
                placeholder="below"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
              <input
                type="number"
                aria-label="Remove values above"
                placeholder="above"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            </div>
            <small className="hint">
              Removes points whose {kpiInfo?.label} is below the first or above
              the second number{kpiInfo?.unit ? ` (${kpiInfo.unit})` : ""}.{" "}
              {outOfRange} would be removed.
            </small>
            <button
              type="button"
              disabled={!outOfRange}
              onClick={() =>
                remove(
                  range,
                  `${kpiInfo?.label} outside ${min || "−∞"} … ${max || "+∞"}`,
                  outOfRange,
                )
              }
            >
              Remove these points
            </button>
          </div>
        </>
      )}
      {image && (
        <div className="log-source-row">
          <span>
            <strong>Floor image of this floor</strong>
            <small>The uploaded plan picture (rooms stay)</small>
          </span>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("Remove the floor image of this floor?")) return;
              mutate((p) => {
                const images = { ...p.images };
                delete images[floorId];
                return { ...p, images };
              });
              setNote("Floor image removed.");
            }}
          >
            Remove
          </button>
        </div>
      )}
      {note && <small className="hint">{note}</small>}
    </div>
  );
}
