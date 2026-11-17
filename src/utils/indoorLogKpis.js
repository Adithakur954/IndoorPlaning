const RED = "#dc2626";
const ORANGE = "#f97316";
const YELLOW = "#eab308";
const LIME = "#84cc16";
const BLUE = "#1d28d0";
const GREEN = "#16a34a";

const bands = (edges, colors, unit) =>
  colors.map((color, index) => {
    const min = index === 0 ? -Infinity : edges[index - 1];
    const max = index === edges.length ? Infinity : edges[index];
    const label = (
      index === 0
        ? `< ${max} ${unit}`
        : index === edges.length
          ? `≥ ${min} ${unit}`
          : `${min} to ${max} ${unit}`
    ).trim();
    return { min, max, color, label };
  });

const highIsGood = [RED, ORANGE, YELLOW, LIME, GREEN];
// Default look for dBm signal maps (RSRP, RSSI): red below -70, then orange,
// yellow, blue and green from -40 dBm up.
const signalBands = [RED, ORANGE, YELLOW, BLUE, GREEN];
const lowIsGood = [...highIsGood].reverse();

export const INDOOR_LOG_KPIS = [
  {
    key: "rsrp",
    label: "RSRP",
    unit: "dBm",
    columns: [
      "ssRSRP / RSRP / RSCP",
      "RSRP",
      "LTE RSRP",
      "Disp RSRP (dBm)",
      "Disp NR ssRSRP (dBm)",
      "csiRsrp",
    ],
    thresholds: bands([-70, -60, -50, -40], signalBands, "dBm"),
  },
  {
    key: "rsrq",
    label: "RSRQ",
    unit: "dB",
    columns: [
      "ssRSRQ / RSRQ / EcNo",
      "RSRQ",
      "LTE RSRQ",
      "Disp RSRQ (dB)",
      "Disp NR ssRSRQ (dB)",
      "csiRsrq",
    ],
    thresholds: bands([-20, -15, -12, -9], highIsGood, "dB"),
  },
  {
    key: "sinr",
    label: "SINR",
    unit: "dB",
    columns: [
      "NR-SINR / SINR / RxQual",
      "SINR",
      "LTE SINR",
      "Disp RSSNR/SINR (dB)",
      "Disp NR ssSINR (dB)",
      "csiSinr",
    ],
    thresholds: bands([0, 5, 10, 20], highIsGood, "dB"),
  },
  {
    key: "rssi",
    label: "RSSI",
    unit: "dBm",
    columns: ["RSSI  (2G-RxLEV)", "RSSI", "Disp RSSI (dBm)"],
    thresholds: bands([-70, -60, -50, -40], signalBands, "dBm"),
  },
  {
    key: "snr",
    label: "SNR",
    unit: "dB",
    columns: ["SNR", "SNR (dB)", "Wi-Fi SNR", "WiFi SNR", "Disp SNR (dB)"],
    // Wi-Fi: below 10 dB is poor, 25 dB and above is good for high data rates
    thresholds: bands([10, 15, 25, 40], highIsGood, "dB"),
  },
  {
    key: "dl_thpt",
    label: "DL throughput",
    unit: "Mbps",
    columns: ["DL THPT", "DL Delivered (Mbps)", "dl_tpt"],
    thresholds: bands([1, 5, 20, 50], highIsGood, "Mbps"),
  },
  {
    key: "ul_thpt",
    label: "UL throughput",
    unit: "Mbps",
    columns: ["UL THPT", "UL Delivered (Mbps)", "ul_tpt"],
    thresholds: bands([1, 5, 20, 50], highIsGood, "Mbps"),
  },
  {
    key: "mos",
    label: "MOS",
    unit: "",
    columns: ["MOS"],
    thresholds: bands([2, 3, 3.5, 4], highIsGood, ""),
  },
  {
    key: "jitter",
    label: "Jitter",
    unit: "ms",
    columns: ["Jitter"],
    thresholds: bands([10, 20, 40, 80], lowIsGood, "ms"),
  },
  {
    key: "latency",
    label: "Latency",
    unit: "ms",
    columns: ["Latency"],
    thresholds: bands([50, 100, 200, 400], lowIsGood, "ms"),
  },
  {
    key: "packet_loss",
    label: "Packet loss",
    unit: "%",
    columns: ["Packet Loss"],
    thresholds: bands([1, 2, 5, 10], lowIsGood, "%"),
  },
  {
    key: "cqi",
    label: "CQI",
    unit: "",
    columns: ["CQI", "Disp CQI"],
    thresholds: bands([4, 7, 10, 13], highIsGood, ""),
  },
  {
    key: "level",
    label: "Signal level",
    unit: "",
    columns: ["Level", "Disp Overall Level (0-4)", "Disp Level (0-4)"],
    thresholds: bands([1, 2, 3, 4], highIsGood, ""),
  },
  {
    key: "dl_bler",
    label: "DL BLER",
    unit: "%",
    columns: ["DL BLER", "NR DL BLER (%)"],
    thresholds: bands([1, 2, 5, 10], lowIsGood, "%"),
  },
];

// Wi-Fi shows RSSI, SNR and throughput only; cellular shows the radio quality
// KPIs (RSRP, RSRQ, SINR ...), not the Wi-Fi RSSI and SNR; mixed shows all.
export const WIFI_KPI_KEYS = ["rssi", "snr", "dl_thpt", "ul_thpt"];
export const kpisForKind = (kind) =>
  kind === "wifi"
    ? INDOOR_LOG_KPIS.filter((k) => WIFI_KPI_KEYS.includes(k.key))
    : kind === "cellular"
      ? INDOOR_LOG_KPIS.filter((k) => k.key !== "rssi" && k.key !== "snr")
      : INDOOR_LOG_KPIS;
export const defaultKpiFor = (kind) => (kind === "cellular" ? "rsrp" : "rssi");

// The network type on a floor: the selected access point's kind, else the kind
// of the floor's sources (wifi when there are none, "all" when mixed).
export const networkKindOf = (sources, selectedSource) => {
  if (selectedSource?.kind === "wifi" || selectedSource?.kind === "cellular")
    return selectedSource.kind;
  const kinds = new Set(
    sources
      .map((s) => s.kind)
      .filter((k) => k === "wifi" || k === "cellular"),
  );
  return kinds.size === 1 ? [...kinds][0] : kinds.size ? "all" : "wifi";
};

export const normalizeLogColumn = (column) =>
  String(column)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const readLogKpi = (fields, kpi) => {
  for (const column of kpi.columns) {
    const value = fields[normalizeLogColumn(column)];
    if (value === undefined || value === null || String(value).trim() === "")
      continue;
    const number = Number(value);
    if (Number.isFinite(number) && Math.abs(number) !== 2147483647)
      return number;
  }
  return null;
};

export const getAvailableLogKpis = (logs) =>
  INDOOR_LOG_KPIS.filter((kpi) =>
    logs.some((log) => {
      const value = log[kpi.key];
      return (
        value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value))
      );
    }),
  );

export const getLogKpiRangeColor = (value, ranges) => {
  const number = Number(value);
  if (
    !Array.isArray(ranges) ||
    !ranges.length ||
    value === null ||
    value === undefined ||
    value === "" ||
    !Number.isFinite(number)
  )
    return "#808080";
  const sorted = ranges;
  return (
    sorted.find(
      (threshold) =>
        number >= Number(threshold.min) && number < Number(threshold.max),
    )?.color ||
    (number < Number(sorted[0].min)
      ? sorted[0].color
      : number >= Number(sorted.at(-1).max)
        ? sorted.at(-1).color
        : "#808080")
  );
};

export const getFallbackLogKpiColor = (value, metric) => {
  const kpi = INDOOR_LOG_KPIS.find((item) => item.key === metric);
  return getLogKpiRangeColor(value, kpi?.thresholds);
};
