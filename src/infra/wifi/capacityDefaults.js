// Defaults and form limits of the capacity engine, available before the engine
// has loaded (the panel renders its fields with them). The engine (capacity/)
// is the authority: test/capacityEngine.test.js fails if these drift from it.

export const DEFAULT_CAPACITY_MODEL = {
  // people and traffic
  totalPeople: null, // the number of people; null = estimate from usersPerM2 and the room areas
  usersPerM2: 0.2,
  devicesPerUser: 1.5,
  activeFraction: 0.6, // share of devices that are sending or receiving at a time
  minMbps: 5, // the speed every active device should get
  demandMbpsPerActive: 5, // typical traffic of an active device
  peakMbps: 10, // an active device at its busiest
  roomUsers: {},
  distribution: "uniform", // "uniform" | "furniture" (more people near desks and seats)
  seatWeight: 5, // how much more likely a point near a desk or seat is to hold someone
  zones: [], // [{ id, floorId, name, x, z, width, depth, people }]: people 0 = nobody there
  // internet plan
  wanDownMbps: 300,
  wanUpMbps: 300,
  wanHeadroomPct: 15, // kept spare for overhead and bursts
  uploadShare: 0.2, // upload demand as a share of download demand
  // radio
  standard: "wifi6",
  band: "5",
  widthMHz: 80,
  apStreams: 2,
  clientStreams: 2,
  macEfficiency: 0.65, // application speed as a share of the data rate (MAC overhead, retries, contention)
  targetUtilisation: 0.5, // keep the air at most this busy at typical load
  maxClientsPerAp: 100,
  interferenceM: 25,
  channels: null, // null = chosen from the band and width
  // association
  association: "strongest", // "strongest" | "load-aware"
  roamMarginDb: 6, // load-aware: APs within this many dB of the strongest are candidates
  // used only when there is no ray-traced prediction
  txEirpDbm: 20,
  noiseFigureDb: 7,
  pathLossExponent: 3.5,
};

// Monte Carlo settings, stored in plan.capacity.monteCarlo.
export const DEFAULT_MONTE_CARLO = {
  iterations: 200, // at least this many
  maxIterations: 2000, // more are run, in batches, until the overload probabilities are within targetCiPct
  targetCiPct: 3, // half-width of the 95% interval to reach (percentage points)
  seed: 1, // the same seed gives the same result
  traffic: "simple", // "simple" (the activity share and speeds above) | "profiles"
  peopleVariationPct: 0, // each iteration scales the headcount by up to ± this much
  binM: 2, // size of the squares the problem map is drawn with
  profiles: [
    { id: "idle", name: "Idle / background", share: 0.5, active: false, minMbps: 0, lowMbps: 0, highMbps: 0, uploadShare: 0.5 },
    { id: "browsing", name: "Web, email, chat", share: 0.22, active: true, minMbps: 1, lowMbps: 0.5, highMbps: 2, uploadShare: 0.1 },
    { id: "video-call", name: "Video call", share: 0.12, active: true, minMbps: 1.5, lowMbps: 1.5, highMbps: 4, uploadShare: 1 },
    { id: "streaming", name: "Video streaming", share: 0.08, active: true, minMbps: 3, lowMbps: 3, highMbps: 8, uploadShare: 0.05 },
    { id: "download", name: "Large download or upload", share: 0.03, active: true, minMbps: 5, lowMbps: 10, highMbps: 50, uploadShare: 0.2 },
    { id: "voice", name: "Voice call", share: 0.05, active: true, minMbps: 0.1, lowMbps: 0.1, highMbps: 0.2, uploadShare: 1 },
  ],
};

// The load test (plan.capacity.loadTest); checked against the engine by a test.
export const DEFAULT_LOAD_TEST = {
  startUsers: 50,
  maxUsers: 500,
  stepUsers: 50,
  refineUsers: 5,
  runsPerStep: 60,
  confidencePct: 95,
  passMeetsPct: 95,
  warnMeetsPct: 99,
  warnPct: 85,
  stopAfterFailSteps: 2,
  heatmapM: 1,
  heatmapRuns: 12,
  maxHeatmapSteps: 12,
  txopMs: 2,
  latencyWarnMs: 30,
  latencyFailMs: 100,
  retryWarnPct: 15,
  retryFailPct: 30,
  estimatesDecide: false,
  // load test's per-user model (capacity/src/loadmodel.rs)
  fairness: "airtime", // "airtime" (modern APs) | "throughput" (plain DCF: equal Mbps for everyone)
  ccaDbm: -82, // same-channel APs heard above this share airtime (carrier sense)
  uplinkLossDb: 5, // the client sends this much weaker than the AP: its upload runs at a lower rate
  collisions: true,
  interference: false, // off: data rates follow the SNR alone
  adjacentRejectionDb: 25,
  convergenceDamping: 0.5,
  convergenceTolerance: 0.005,
  convergenceIterations: 40,
  maxUserDots: 3000,
};

export const STANDARDS = {
  wifi4: "Wi-Fi 4 (802.11n)",
  wifi5: "Wi-Fi 5 (802.11ac)",
  wifi6: "Wi-Fi 6 / 6E (802.11ax)",
  wifi7: "Wi-Fi 7 (802.11be)",
};

// the signal-to-noise ratio (dB) a receiver needs for each rate index (illustrative)
export const MIN_SNR_DB = [5, 8, 11, 14, 18, 21, 24, 26, 30, 32, 35, 37, 40, 42];

const TOP_WIDTH_MHZ = { wifi4: 40, wifi5: 160, wifi6: 160, wifi7: 320 };

// widest channel each standard and band allows
export const maxWidthMHz = (standard, band) => {
  const top = TOP_WIDTH_MHZ[standard] ?? TOP_WIDTH_MHZ.wifi6;
  return band === "2.4" ? Math.min(top, 40) : top;
};
