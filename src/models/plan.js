export const uid = () => crypto.randomUUID();
export const initialPlan = () => ({
  floors: [{ id: "level-1", name: "Level 1", elevation: 0 }],
  selectedFloorId: "level-1",
  rooms: [],
  doors: [],
  windows: [],
  interiorWalls: [],
  furniture: [],
  boundaries: [],
  savedResults: {}, // latest prediction / optimisation run (job references)
  sources: [],
  wallTypes: {},
  wallThickness: 0.2,
  property: { carpetAreaM2: null, static: true },
  rf: {
    gridStepM: 1,
    rxGainDbi: 0,
    wallLossDb: 8,
    doorLossDb: 3,
    thresholdDbm: -95,
    newApHeightM: 2.7, // height of a newly placed Wi-Fi AP
    newCellHeightM: 3, // height of a newly placed cellular site
  },
  logs: [],
  thresholds: {},
  alignment: null,
  images: {},
  sessionIds: [],
  preferences: {
    view: "2d",
    heatmap: false,
    logsVisible: true,
    logGrid: false,
    metric: "rsrp",
    gridSize: 1,
    aggregation: "mean",
    snap: true,
    showRoomNames: true,
    showFurnitureNames: true,
    showWifiNames: true,
    showMeasurements: false,
  },
});
