import * as THREE from "three";
import JSZip from "jszip";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import {
  areaOf,
  bbox,
  boundaryAreas,
  inside,
  nestedRooms,
  overlapWarnings,
  pointsOf,
} from "./geometry.js";
import { buildWalls } from "./wallGraph.js";
import { sanitizeOverrides } from "./materialModel.js";

// Plan space is Y-up with the floor on the X/Z plane (as in Plan3D).
// Sionna RT / Mitsuba is Z-up. (x, y, z) -> (x, -z, y) is a pure rotation, so
// triangle winding is preserved.
const toScene = (x, y, z) => [x, -z, y];

export const EXPORT_VERSION = 1;

// Plan material -> ITU-R P.2040 material name known to Sionna RT.
export const RADIO_MATERIALS = {
  drywall: "itu_plasterboard",
  wood: "itu_wood",
  glass: "itu_glass",
  brick: "itu_brick",
  concrete: "itu_concrete",
  metal: "itu_metal",
};
const DISPLAY_COLORS = {
  itu_plasterboard: "0.80 0.84 0.82",
  itu_wood: "0.73 0.59 0.47",
  itu_glass: "0.54 0.78 0.86",
  itu_brick: "0.72 0.53 0.47",
  itu_concrete: "0.55 0.61 0.65",
  itu_metal: "0.55 0.61 0.65",
};
const radioName = (material) =>
  RADIO_MATERIALS[material] || RADIO_MATERIALS.drywall;

const finite = (...values) => values.every((v) => Number.isFinite(Number(v)));
class MeshSet {
  constructor() {
    this.groups = new Map();
  }
  group(role, material) {
    const key = `${role}__${material}`;
    if (!this.groups.has(key))
      this.groups.set(key, { role, material, positions: [], indices: [] });
    return this.groups.get(key);
  }
  // Points are plan-space [x, y, z]; stored in scene space.
  quad(role, material, p0, p1, p2, p3) {
    const g = this.group(role, material),
      base = g.positions.length / 3;
    for (const p of [p0, p1, p2, p3]) g.positions.push(...toScene(...p));
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  polygon(role, material, points, y) {
    const contour = points.map((p) => new THREE.Vector2(p.x, p.z));
    const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
    const g = this.group(role, material),
      base = g.positions.length / 3;
    for (const p of points) g.positions.push(...toScene(p.x, y, p.z));
    for (const t of triangles)
      g.indices.push(base + t[0], base + t[1], base + t[2]);
  }
  box(role, material, x0, y0, z0, x1, y1, z1) {
    const c = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const g = this.group(role, material),
      base = g.positions.length / 3;
    for (const p of c) g.positions.push(...toScene(...p));
    for (const f of [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ])
      g.indices.push(base + f[0], base + f[1], base + f[2]);
  }
}

export function writePly({ positions, indices }) {
  const vertexCount = positions.length / 3,
    faceCount = indices.length / 3;
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\ncomment Indoor Planner scene export\n` +
      `element vertex ${vertexCount}\nproperty float x\nproperty float y\nproperty float z\n` +
      `element face ${faceCount}\nproperty list uchar uint vertex_indices\nend_header\n`,
  );
  const body = new DataView(new ArrayBuffer(vertexCount * 12 + faceCount * 13));
  let o = 0;
  for (const v of positions) {
    body.setFloat32(o, v, true);
    o += 4;
  }
  for (let i = 0; i < indices.length; i += 3) {
    body.setUint8(o++, 3);
    for (let k = 0; k < 3; k++) {
      body.setUint32(o, indices[i + k], true);
      o += 4;
    }
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header);
  out.set(new Uint8Array(body.buffer), header.length);
  return out;
}

function validate(plan, floors) {
  const errors = [],
    warnings = [];
  const sorted = [...floors].sort((a, b) => a.elevation - b.elevation);
  for (const floor of floors) {
    if (!finite(floor.elevation))
      errors.push(`Floor "${floor.name}" has an invalid elevation.`);
    const rooms = plan.rooms.filter((r) => r.floorId === floor.id);
    if (!rooms.length) warnings.push(`Floor "${floor.name}" has no rooms.`);
    for (const room of rooms) {
      const points = pointsOf(room);
      if (
        points.length < 3 ||
        !points.every((p) => finite(p.x, p.z)) ||
        areaOf(room) < 0.01
      )
        errors.push(`Room "${room.name}" has invalid or zero-area geometry.`);
      if (!(Number(room.height) > 0))
        warnings.push(`Room "${room.name}" has no height; 3 m assumed.`);
    }
    const outlines = boundaryAreas(plan, floor.id);
    for (const outline of outlines) {
      const points = pointsOf(outline);
      if (
        points.length < 3 ||
        !points.every((p) => finite(p.x, p.z)) ||
        areaOf(outline) < 0.01
      )
        errors.push(`Building boundary "${outline.name}" is invalid.`);
    }
    if (outlines.length)
      for (const room of rooms) {
        const pts = pointsOf(room),
          cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
          cz = pts.reduce((sum, p) => sum + p.z, 0) / pts.length;
        if (!outlines.some((o) => inside(cx, cz, o)))
          warnings.push(
            `Room "${room.name}" lies outside the building boundary on ${floor.name}.`,
          );
      }
    overlapWarnings(rooms).forEach((w) =>
      warnings.push(
        `${floor.name}: ${w}. Coincident surfaces may be double counted.`,
      ),
    );
    const next = sorted[sorted.indexOf(floor) + 1];
    if (next)
      for (const room of rooms)
        if (
          floor.elevation + (Number(room.height) || 3) >
          next.elevation + 0.01
        )
          warnings.push(
            `Room "${room.name}" is taller than the gap to "${next.name}".`,
          );
  }
  for (const item of [...plan.doors, ...plan.windows])
    if (!plan.rooms.some((r) => r.id === item.roomId))
      warnings.push(
        `Opening ${item.id} references a missing room and is ignored.`,
      );
  return { errors, warnings };
}

// Builds the scene files. Pure geometry: no browser APIs besides TextEncoder
// and crypto.subtle (both also exist in Node).
export async function buildSceneFiles(plan, options = {}) {
  const {
    floorIds,
    includeFurniture = false,
    receiverHeightM = 1.5,
    slabThicknessM = 0.2,
    // which transmitters the scene carries: "wifi" (the Wi-Fi prediction and
    // optimiser), "cellular" (cellular antennas only) or "none" (the building
    // only, as the cellular prediction sends its antennas in the job instead)
    sources = "wifi",
  } = options;
  if (!["wifi", "cellular", "none"].includes(sources))
    throw new Error(`Unknown scene sources: ${sources}`);
  const isExported = (s) =>
    sources === "wifi"
      ? s.kind !== "cellular"
      : sources === "cellular" && s.kind === "cellular";
  const wallThicknessM = Number(plan.wallThickness) || 0.2;
  const { overrides: materialOverrides, errors: overrideErrors } =
    sanitizeOverrides(plan.materialOverrides, wallThicknessM);
  const floors = plan.floors
    .filter((f) => !floorIds || floorIds.includes(f.id))
    .map((f) => ({ ...f, elevation: Number(f.elevation) || 0 }))
    .sort((a, b) => a.elevation - b.elevation);
  const { errors, warnings } = validate(plan, floors);
  errors.push(...overrideErrors);
  if (!floors.length) errors.push("The plan has no floors to export.");
  if (!plan.rooms.some((r) => floors.some((f) => f.id === r.floorId)))
    errors.push("The selected floors have no rooms.");
  if (errors.length) {
    const error = new Error(errors.join(" "));
    error.errors = errors;
    error.warnings = warnings;
    throw error;
  }

  const meshes = new MeshSet();
  const top = floors.at(-1);
  const stats = { wallPieces: 0, openings: 0, sharedEdges: 0 };

  for (const floor of floors) {
    const y0 = floor.elevation;
    const rooms = plan.rooms.filter((r) => r.floorId === floor.id);
    const outlines = boundaryAreas(plan, floor.id);
    // Floor and ceiling surfaces: the building boundary when there is one, else
    // the rooms. A room inside another room (or inside the boundary) adds no
    // second floor on top of the first.
    const nestedInside = new Set(nestedRooms(rooms).map(([inner]) => inner.id));
    for (const outline of outlines) {
      const pts = pointsOf(outline),
        height = Number(outline.height) || 3;
      meshes.polygon("slab", "concrete", pts, y0);
      if (floor === top)
        meshes.polygon("ceiling", "concrete", pts, y0 + height);
    }
    if (!outlines.length)
      for (const room of rooms) {
        if (nestedInside.has(room.id)) continue;
        const pts = pointsOf(room),
          height = Number(room.height) || 3;
        meshes.polygon("slab", "concrete", pts, y0);
        if (floor === top)
          meshes.polygon("ceiling", "concrete", pts, y0 + height);
      }
    // Walls: shared walls, walls on the boundary and walls of rooms inside
    // other rooms are merged into one wall each (see wallGraph.js).
    for (const wall of buildWalls(plan, floor.id)) {
      if (wall.shared) stats.sharedEdges++;
      if (wall.materialConflict)
        warnings.push(
          `A wall shared by ${wall.owners.map((o) => o.name).join(" and ")} has different materials (${wall.materialConflict.join(", ")}); using ${wall.material}.`,
        );
      const { a, b, length } = wall;
      const at = (t, y) => [
        a.x + ((b.x - a.x) * t) / length,
        y0 + y,
        a.z + ((b.z - a.z) * t) / length,
      ];
      for (const p of wall.pieces) {
        meshes.quad(
          wall.exterior ? "exterior-wall" : "wall",
          wall.material,
          at(p.from, p.bottom),
          at(p.to, p.bottom),
          at(p.to, p.top),
          at(p.from, p.top),
        );
        stats.wallPieces++;
      }
      for (const o of wall.openings) {
        meshes.quad(
          o.kind,
          o.kind === "window" ? "glass" : "wood",
          at(o.start, o.bottom),
          at(o.end, o.bottom),
          at(o.end, o.top),
          at(o.start, o.top),
        );
        stats.openings++;
      }
    }
    for (const w of plan.interiorWalls.filter((w) => w.floorId === floor.id)) {
      if (!finite(w.x1, w.z1, w.x2, w.z2)) {
        warnings.push(
          `Interior wall ${w.id} has invalid coordinates and was skipped.`,
        );
        continue;
      }
      const h = Number(w.height) || 3;
      meshes.quad(
        "interior-wall",
        w.material || "drywall",
        [+w.x1, y0, +w.z1],
        [+w.x2, y0, +w.z2],
        [+w.x2, y0 + h, +w.z2],
        [+w.x1, y0 + h, +w.z1],
      );
      stats.wallPieces++;
    }
    if (includeFurniture)
      for (const f of plan.furniture.filter((f) => f.floorId === floor.id)) {
        if (!finite(f.x, f.z, f.width, f.depth)) continue;
        meshes.box(
          "furniture",
          "wood",
          +f.x,
          y0,
          +f.z,
          +f.x + +f.width,
          y0 + Number(f.height || 0.8),
          +f.z + +f.depth,
        );
      }
  }

  // a material's own wall thickness (set manually) wins over the plan's
  const wallThickness = (material) =>
    materialOverrides[material]?.thicknessM ?? wallThicknessM;
  const thicknessFor = (role, material) =>
    ({
      wall: wallThickness(material),
      "exterior-wall": wallThickness(material),
      "interior-wall": wallThickness(material),
      slab: slabThicknessM,
      ceiling: slabThicknessM,
      door: 0.04,
      window: 0.01,
      furniture: 0.03,
    })[role];

  const files = {};
  const meshEntries = [];
  const radioMaterials = new Set();
  for (const g of [...meshes.groups.values()].sort((a, b) =>
    `${a.role}${a.material}`.localeCompare(`${b.role}${b.material}`),
  )) {
    if (!g.indices.length) continue;
    const material = radioName(g.material),
      file = `meshes/${g.role}__${g.material}.ply`;
    files[file] = writePly(g);
    radioMaterials.add(material);
    meshEntries.push({
      shapeId: `mesh-${g.role}-${g.material}`,
      file,
      role: g.role,
      planMaterial: g.material,
      radioMaterial: material,
      thicknessM: thicknessFor(g.role, g.material),
      vertices: g.positions.length / 3,
      triangles: g.indices.length / 3,
    });
  }

  const xml = [
    `<scene version="2.1.0">`,
    ...[...radioMaterials]
      .sort()
      .map(
        (m) =>
          `  <bsdf type="twosided" id="mat-${m}">\n    <bsdf type="principled">\n      <rgb value="${DISPLAY_COLORS[m] || "0.6 0.6 0.6"}" name="base_color"/>\n    </bsdf>\n  </bsdf>`,
      ),
    ...meshEntries.map(
      (m) =>
        `  <shape type="ply" id="${m.shapeId}">\n    <string name="filename" value="${m.file}"/>\n    <ref id="mat-${m.radioMaterial}" name="bsdf"/>\n  </shape>`,
    ),
    `</scene>`,
    ``,
  ].join("\n");
  files["scene.xml"] = xml;

  const bounds = (floor) => {
    const b = [
      ...plan.rooms.filter((r) => r.floorId === floor.id),
      ...boundaryAreas(plan, floor.id),
    ].map(bbox);
    if (!b.length) return null;
    const minX = Math.min(...b.map((v) => v.minX)),
      maxX = Math.max(...b.map((v) => v.maxX)),
      minZ = Math.min(...b.map((v) => v.minZ)),
      maxZ = Math.max(...b.map((v) => v.maxZ));
    return { minX, maxX, minZ, maxZ };
  };
  const floorEntries = floors.map((f) => {
    const b = bounds(f);
    return {
      id: f.id,
      name: f.name,
      elevationM: f.elevation,
      radioMapPlane: b && {
        heightM: f.elevation + receiverHeightM,
        center: toScene(
          (b.minX + b.maxX) / 2,
          f.elevation + receiverHeightM,
          (b.minZ + b.maxZ) / 2,
        ),
        size: [b.maxX - b.minX, b.maxZ - b.minZ],
        cellSizeM: Math.max(0.1, Number(plan.rf?.gridStepM) || 1),
      },
    };
  });
  const elevation = new Map(floors.map((f) => [f.id, f.elevation]));
  const elevationOf = elevation;
  const accessPoints = plan.sources
    .filter((s) => isExported(s) && elevation.has(s.floorId))
    .map((s) => {
      const y = elevation.get(s.floorId) + Number(s.heightM || 2);
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        technology: s.technology ?? null,
        floorId: s.floorId,
        position: toScene(+s.x, y, +s.z),
        planPosition: {
          x: +s.x,
          z: +s.z,
          heightAboveFloorM: Number(s.heightM || 2),
        },
        txPowerDbm: Number(s.txPowerDbm ?? 20),
        frequencyMHz: Number(s.freqMHz || 2400),
        channel: s.channel ?? null,
        bandwidthMHz: s.bandwidthMHz ?? null,
        antennaGainDbi: Number(s.antennaGainDbi ?? 0),
        antennaPattern: s.antennaPattern || "omni",
        azimuthDeg: Number(s.azimuthDeg ?? 0),
        beamwidthDeg: Number(s.beamwidthDeg ?? 120),
      };
    });
  if (!accessPoints.length && sources === "wifi")
    warnings.push(
      "No access points on the exported floors; only geometry was exported.",
    );
  if (accessPoints.some((a) => a.bandwidthMHz == null))
    warnings.push(
      "Access points have no bandwidth set; the simulation worker must state its assumption.",
    );

  const config = {
    exportVersion: EXPORT_VERSION,
    generator: "Indoor Planner scene export",
    note: "Geometry and material assumptions only. Not a prediction and not calibrated.",
    coordinateSystem: {
      scene: "Z-up, metres (Mitsuba/Sionna RT)",
      transform: "scene = (plan.x, -plan.z, plan.y_up)",
    },
    materials: Object.fromEntries(
      Object.entries(RADIO_MATERIALS).map(([k, v]) => [k, v]),
    ),
    ...(Object.keys(materialOverrides).length ? { materialOverrides } : {}),
    materialThicknessAssumptions: {
      wallM: wallThicknessM,
      slabM: slabThicknessM,
      doorM: 0.04,
      windowM: 0.01,
      furnitureM: 0.03,
      source: "Assumed. Doors are modelled closed.",
    },
    floors: floorEntries,
    // Semantic geometry (plan coordinates) for the receiver grid, coverage by
    // room and AP placement; the meshes alone do not carry it.
    rooms: plan.rooms
      .filter((r) => elevationOf.has(r.floorId))
      .map((r) => ({
        id: r.id,
        name: r.name,
        floorId: r.floorId,
        heightM: Number(r.height) || 3,
        points: pointsOf(r).map((p) => ({ x: p.x, z: p.z })),
      })),
    boundaries: (plan.boundaries || [])
      .filter((b) => elevationOf.has(b.floorId))
      .map((b) => ({
        id: b.id,
        floorId: b.floorId,
        points: b.points.map((p) => ({ x: +p.x, z: +p.z })),
      })),
    accessPoints,
    meshes: meshEntries,
    stats: {
      ...stats,
      boundaries: floors.reduce(
        (n, f) => n + boundaryAreas(plan, f.id).length,
        0,
      ),
      includeFurniture,
    },
    warnings,
  };
  // Content hash: usable as a cache key for completed radio maps.
  const digestInput = new Uint8Array([
    ...new TextEncoder().encode(
      JSON.stringify({ ...config, warnings: undefined }),
    ),
    ...new TextEncoder().encode(xml),
    ...Object.keys(files)
      .filter((k) => k.endsWith(".ply"))
      .sort()
      .flatMap((k) => [...files[k]]),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  config.contentSha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  files["scene_config.json"] = JSON.stringify(config, null, 2);
  return { files, config, warnings };
}

export async function buildSceneZip(plan, options) {
  const { files, config, warnings } = await buildSceneFiles(plan, options);
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
  });
  return { blob, config, warnings };
}

export async function buildSceneGlb(plan, options) {
  const { files, config, warnings } = await buildSceneFiles(plan, options);
  const zUpScene = new THREE.Group();
  zUpScene.name = "Indoor Planner scene (Z-up, metres)";

  for (const entry of config.meshes) {
    const bytes = files[entry.file];
    if (!bytes) continue;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const geometry = new PLYLoader().parse(buffer);
    geometry.computeVertexNormals();
    const color = (DISPLAY_COLORS[entry.radioMaterial] || "0.6 0.6 0.6")
      .split(" ")
      .map(Number);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color[0], color[1], color[2]),
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    material.name = entry.radioMaterial;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = entry.shapeId;
    mesh.userData = {
      role: entry.role,
      planMaterial: entry.planMaterial,
      radioMaterial: entry.radioMaterial,
      vertices: entry.vertices,
      triangles: entry.triangles,
    };
    zUpScene.add(mesh);
  }

  for (const ap of config.accessPoints) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 8),
      new THREE.MeshStandardMaterial({
        color: ap.kind === "wifi" ? "#7c3aed" : "#0891b2",
        roughness: 0.65,
      }),
    );
    marker.name = ap.name || `${ap.kind} access point`;
    marker.position.set(...ap.position);
    marker.userData = { ...ap, marker: true };
    zUpScene.add(marker);
  }

  // The source meshes use the ray-tracing export's Z-up axes. glTF viewers
  // expect Y-up, so rotate the exported root while retaining metre units.
  zUpScene.rotation.x = -Math.PI / 2;
  const arrayBuffer = await new GLTFExporter().parseAsync(zUpScene, {
    binary: true,
    onlyVisible: true,
  });
  return {
    blob: new Blob([arrayBuffer], { type: "model/gltf-binary" }),
    config,
    warnings,
  };
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
