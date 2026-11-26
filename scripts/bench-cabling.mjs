// Speed test for the Wi-Fi cabling design on synthetic buildings.
// Usage: node scripts/bench-cabling.mjs
import { designWifiCabling } from "../src/infra/wifi/design.js";
import { suggestRacks } from "../src/infra/wifi/racks.js";

function building(floors, perFloor) {
  const cols = Math.ceil(Math.sqrt(perFloor));
  const rows = Math.ceil(perFloor / cols);
  const rooms = [], sources = [], fl = [];
  for (let f = 0; f < floors; f++) {
    const id = `f${f}`;
    fl.push({ id, name: `Level ${f}`, elevation: f * 3.5 });
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const n = r * cols + c;
        if (n >= perFloor) break;
        const rid = `${id}r${n}`;
        rooms.push({ id: rid, floorId: id, name: rid, shape: "rectangle", x: c * 8, z: r * 8, width: 8, depth: 8, height: 3 });
        sources.push({ id: `${rid}ap`, kind: "wifi", name: `${rid}ap`, floorId: id, x: c * 8 + 4, z: r * 8 + 4, heightM: 2.7 });
      }
  }
  return { floors: fl, rooms, doors: [], windows: [], interiorWalls: [], boundaries: [], sources };
}

for (const [floors, perFloor] of [[1, 100], [10, 50], [20, 100], [50, 40]]) {
  const plan = building(floors, perFloor);
  const t0 = performance.now();
  const sug = suggestRacks({ plan });
  const t1 = performance.now();
  const risers = [{ id: "rs", name: "Riser", x: 1, z: 1 }];
  const design = designWifiCabling({ plan, racks: sug.racks, risers });
  const t2 = performance.now();
  console.log(
    `${floors} floors x ${perFloor} = ${plan.sources.length} APs | racks ${sug.racks.length} in ${((t1 - t0) / 1000).toFixed(1)} s | design ${((t2 - t1) / 1000).toFixed(1)} s | runs ${design.runs.length} | errors ${design.violations.filter((v) => v.severity === "error").length}`,
  );
}
