// What can be switched on and off on the editor workspace. Layers listed in
// `plan.preferences.hiddenLayers` are hidden; everything else is shown.
export const LAYERS = [
  { id: "rooms", label: "Rooms" },
  { id: "walls", label: "Walls" },
  { id: "openings", label: "Doors & windows" },
  { id: "furniture", label: "Furniture" },
  { id: "sources", label: "Wi-Fi / cellular sources" },
  { id: "boundary", label: "Building boundary" },
  { id: "image", label: "Imported plan picture (not detected)" },
  { id: "grid", label: "Grid" },
  { id: "compass", label: "Direction markers" },
];
