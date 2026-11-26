// Default parts and rules for Wi-Fi cabling. THESE ARE ILLUSTRATIVE
// PLACEHOLDERS: replace them with the parts and standards of the real project.
// Each entry carries its source so a report can say which numbers are defaults.

const ILLUSTRATIVE = "illustrative default - replace with the project's part";

export const DEFAULT_WIFI_CATALOGUE = {
  version: 1,
  // portPowerW = power the switch port must supply (PSE side);
  // 802.3af 15.4 W, 802.3at 30 W, 802.3bt type 3 60 W.
  accessPoints: {
    "ap-af": { id: "ap-af", name: "Wi-Fi AP (PoE 802.3af)", portPowerW: 15.4, poeType: "af", typicalDrawW: 9, portSpeedGbps: 1, source: ILLUSTRATIVE },
    "ap-at": { id: "ap-at", name: "Wi-Fi AP (PoE+ 802.3at)", portPowerW: 30, poeType: "at", typicalDrawW: 14, portSpeedGbps: 1, source: ILLUSTRATIVE },
    "ap-bt": { id: "ap-bt", name: "Wi-Fi AP (PoE++ 802.3bt)", portPowerW: 60, poeType: "bt3", typicalDrawW: 30, portSpeedGbps: 2.5, source: ILLUSTRATIVE },
  },
  switches: {
    sw24: { id: "sw24", name: "24-port PoE+ access switch", poePorts: 24, poeBudgetW: 370, poeBudgetRedundantW: 370, maxPortPowerW: 30, uplinkPorts: 4, uplinkSpeedGbps: 10, rackUnits: 1, baseWatts: 60, source: ILLUSTRATIVE },
    sw48: { id: "sw48", name: "48-port PoE+ access switch", poePorts: 48, poeBudgetW: 740, poeBudgetRedundantW: 740, maxPortPowerW: 30, uplinkPorts: 4, uplinkSpeedGbps: 10, rackUnits: 1, baseWatts: 90, source: ILLUSTRATIVE },
    sw24bt: { id: "sw24bt", name: "24-port PoE++ access switch", poePorts: 24, poeBudgetW: 720, poeBudgetRedundantW: 720, maxPortPowerW: 60, uplinkPorts: 4, uplinkSpeedGbps: 10, rackUnits: 1, baseWatts: 80, source: ILLUSTRATIVE },
  },
  cables: {
    cat6a: { id: "cat6a", name: "Cat6A U/UTP cable", boxM: 305, outerDiameterMm: 7.5, dcResistanceOhmPer100m: 9.38, source: ILLUSTRATIVE },
    cat6: { id: "cat6", name: "Cat6 U/UTP cable", boxM: 305, outerDiameterMm: 6.2, dcResistanceOhmPer100m: 9.38, source: ILLUSTRATIVE },
  },
  // Backbone between a floor room (IDF) and the main room (MDF).
  fibre: {
    cable: { id: "fibre-om4", name: "OM4 multimode fibre cable", maxLengthM: 400, source: ILLUSTRATIVE }, // 10 Gbit/s
    sfp: { id: "sfp-10g-sr", name: "10G SFP+ SR transceiver", speedGbps: 10, source: ILLUSTRATIVE },
    panel: { id: "fibre-panel-24", name: "Fibre patch panel (24 strands)", strands: 24, source: ILLUSTRATIVE },
    cord: { id: "fibre-cord", name: "LC duplex fibre patch cord 3 m", source: ILLUSTRATIVE },
    manager: { id: "cable-manager-1u", name: "1U cable manager", source: ILLUSTRATIVE },
  },
  passive: {
    patchPanel: { id: "patch-panel-24", name: "24-port patch panel (loaded)", ports: 24, source: ILLUSTRATIVE },
    jack: { id: "rj45-jack", name: "RJ45 keystone jack (AP end)", source: ILLUSTRATIVE },
    outletBox: { id: "outlet-box", name: "Surface outlet box (AP end)", source: ILLUSTRATIVE },
    patchCord: { id: "patch-cord", name: "Patch cord", source: ILLUSTRATIVE },
    mountKit: { id: "ap-mount", name: "AP mounting kit", source: ILLUSTRATIVE },
    tray: { id: "tray-3m", name: "Cable tray section", sectionM: 3, widthMm: 300, depthMm: 100, source: ILLUSTRATIVE },
    fireStop: { id: "fire-stop-kit", name: "Fire-stop sleeve kit (up to 12 cables)", cablesPer: 12, source: ILLUSTRATIVE },
    conduit: { id: "conduit-3m", name: "Surface conduit / trunking section", sectionM: 3, source: ILLUSTRATIVE },
    label: { id: "label", name: "Cable label", source: ILLUSTRATIVE },
    ties: { id: "ties", name: "Cable ties / Velcro pack", coverM: 150, source: ILLUSTRATIVE },
  },
};

// Design rules. The two length limits come from structured-cabling standards
// (ISO/IEC 11801, TIA-568): 90 m permanent link, 100 m channel. Everything
// else is a planning default the user can change.
export const DEFAULT_WIFI_RULES = {
  maxPermanentLinkM: 90,
  maxChannelM: 100,
  nearLimitFraction: 0.9, // warn above 90% of the limit
  cellM: 0.5, // routing grid cell
  cableTempC: 20, // copper temperature for the PoE check (add the bundle temperature rise here)
  bundleWarnCount: 24, // warn when more cables than this share one tray section (planning threshold)
  rackClearanceM: 2, // a suggested rack keeps this far from every AP
  crossPenaltyM: 10, // extra routing cost for crossing a wall away from a door
  trayFillLimit: 0.4, // share of a tray's cross-section the cables may fill
  powerSeparationM: 0.3, // keep data cable this far from power cabling (planning default: confirm the local rule)
  trayFactor: 0.5, // routing along a drawn tray costs half: trays are the preferred pathway
  permitPenaltyM: 2, // small steering cost for crossing where a crossing is permitted
  turnPenaltyM: 0.25, // extra cost per bend: straight runs win among equal lengths
  trayShareFactor: 0.6, // an edge that already carries a cable costs 60 % (1 = no sharing)
  maxDetourFraction: 0.15, // a shared route may be at most 15 % longer than the cable's own shortest route
  slackFraction: 0.05, // 5 % extra cable on top of the measured run
  trayBelowCeilingM: 0.3, // cable tray sits this far below the slab
  rackDropM: 2, // tray down to the patch panel
  apLoopM: 1, // service loop at the AP
  rackLoopM: 2, // service loop at the rack
  patchCordM: 1, // each patch cord (one at the rack, one at the AP)
  labelsPerRun: 2,
  useTray: true,
  poeAllocation: "class", // "class" = worst case per PoE class; "actual" = the AP's typical draw
  switchPartId: "sw24", // or "auto": the model that serves each rack with the fewest switches
  poeMargin: 0, // share of the PoE budget kept spare (0.2 = 20 %)
  psuRedundancy: "none", // "N+1": size PoE for the budget left when one power supply fails
  uplinksPerSwitch: 2, // a redundant pair of fibre uplinks per access switch
  fibreSpareFraction: 0.25, // spare fibre strands
  maxOversubscription: 20, // access capacity : uplink capacity, as a ratio
  maxApsPerRack: null, // most APs one rack may serve (null = no limit)
  rackSpareFraction: 0.2, // rack units kept spare

  apPartId: "ap-at",
  cablePartId: "cat6a",
};
