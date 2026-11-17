import { geographicToLocal } from "./geographicAlignment.js";
import { INDOOR_LOG_KPIS } from "./indoorLogKpis.js";
import { buildAggregatedLogGridCells } from "./indoorPlanningUtils.js";
import { inside } from "./geometry.js";

export function getFloorLogs(plan, floorId) {
  return plan.logs
    .filter((log) => log.floorId === floorId)
    .map((log) =>
      log.lat !== undefined
        ? {
            ...log,
            ...(geographicToLocal(log, plan.alignment) || { x: null, z: null }),
          }
        : log,
    )
    .filter(
      (log) =>
        log.x !== null &&
        log.z !== null &&
        log.x !== "" &&
        log.z !== "" &&
        Number.isFinite(Number(log.x)) &&
        Number.isFinite(Number(log.z)),
    );
}

export function getMetricRanges(plan, metric) {
  return (
    plan.thresholds[metric] ||
    INDOOR_LOG_KPIS.find((kpi) => kpi.key === metric)?.thresholds ||
    []
  );
}

// The bands with open ends: a value below the lowest band or above the highest
// takes that band's colour instead of falling outside every band (grey). A
// strong signal next to an AP is "very good", not "no data".
export function openEndedBands(ranges) {
  if (!ranges?.length) return ranges || [];
  const order = ranges
    .map((r, i) => [Number(r.min ?? -Infinity), i])
    .sort((a, b) => a[0] - b[0]);
  const first = order[0][1],
    last = order[order.length - 1][1];
  return ranges.map((r, i) => ({
    ...r,
    min: i === first ? -Infinity : r.min,
    max: i === last ? Infinity : r.max,
  }));
}

export function getMetricColor(value, ranges) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    !Number.isFinite(Number(value))
  )
    return "#808080";
  return (
    openEndedBands(ranges).find(
      (range) =>
        Number(value) >= Number(range.min ?? -Infinity) &&
        Number(value) < Number(range.max ?? Infinity),
    )?.color || "#808080"
  );
}

export function getLogGridCells({
  logs,
  rooms,
  gridSize,
  aggregation,
  metric,
  ranges,
}) {
  return buildAggregatedLogGridCells({
    enabled: true,
    showLogs: true,
    logs,
    rooms,
    gridSizeM: gridSize,
    aggregationMethod: aggregation,
    metric,
    getMetricColor: (value) => getMetricColor(value, ranges),
  });
}

export function getMeasuredArea({ logs, rooms, gridSize, totalArea }) {
  const size = Math.max(0.25, Number(gridSize) || 1);
  const sampled = new Set(
    logs
      .filter((log) =>
        rooms.some((room) => inside(Number(log.x), Number(log.z), room)),
      )
      .map(
        (log) =>
          `${Math.floor(Number(log.x) / size)}:${Math.floor(Number(log.z) / size)}`,
      ),
  );
  return {
    sampledCells: sampled.size,
    measuredArea: Math.min(totalArea, sampled.size * size * size),
  };
}
