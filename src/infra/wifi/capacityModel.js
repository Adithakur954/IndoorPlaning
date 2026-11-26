// Wi-Fi capacity planning, in two separate checks:
//
//  1. Internet (WAN): can the plan carry what all the active devices need?
//     Adding access points never raises this limit.
//  2. Wi-Fi radio: can each AP serve its devices? Each device's signal gives
//     its data rate, the rate gives the airtime it needs, and the airtime
//     shared by APs on the same channel gives each device's speed.
//
// Two modes:
//  - deterministic (planWifiCapacity): expected loads, people spread over the
//    floor as fractions; instant, recalculated on every edit;
//  - Monte Carlo (runMonteCarlo, capacityWorkerClient.js): individual users at
//    x, z positions with their own devices and traffic, over many seeded
//    iterations; gives P50/P95 loads and the probability of overload;
//  - load test (runLoadTest, capacityWorkerClient.js): the same APs under a
//    rising number of users: the breaking point, which KPI fails first and
//    where, with capacity heat maps per number of users.
//
// The engine is written in Rust (capacity/) and runs here as WebAssembly; the
// same crate can run natively in the Rust service. This module is the planner's
// entry point to it. Everything is a planning estimate from stated assumptions.
export {
  capacityReady,
  isCapacityReady,
  capacityLoadError,
  planWifiCapacity,
  capacitySensitivity,
  monteCarloCapacity,
  loadTestCapacity,
  loadTestHeatmap,
  capacityLinks,
  capacityMeta,
  phyRateMbps,
  channelsFor,
} from "./capacityEngine.js";
export { DEFAULT_CAPACITY_MODEL, DEFAULT_MONTE_CARLO, DEFAULT_LOAD_TEST, STANDARDS, MIN_SNR_DB, maxWidthMHz } from "./capacityDefaults.js";
