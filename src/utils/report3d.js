// A 3D picture of one floor for the Word reports: floor slabs, walls (with their door and window gaps, in the
// colour of their material), the access points with their names and, when given, the prediction heatmap on
// the floor. It is drawn off-screen at a fixed size with its own camera framed on the building, so it never
// depends on what the 3D view on screen shows (or whether it is open), and never comes out cut off or blank.
// Browser only (WebGL). Returns { bytes, width, height } like renderFloorImage, or null without WebGL.
import * as THREE from "three";
import { bbox, boundaryAreas, pointsOf } from "./geometry.js";
import { buildWalls } from "./wallGraph.js";
import { heatmapCanvas } from "./heatmapImage.js";
import { materialColors, materialLabels } from "../config/materialColors.js";

// legend text of one colour band (the same wording as the 2D report maps)
const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "");
const bandLabel = (r) =>
  !Number.isFinite(r.min) ? `< ${fmt(r.max)}` : !Number.isFinite(r.max) ? `≥ ${fmt(r.min)}` : `${fmt(r.min)} to ${fmt(r.max)}`;

const W = 1800;
const VIEW_H = 1050;
const TITLE_H = 44;
const LEGEND_H = 80;

const slab = (shape, y, color) => {
  const pts = pointsOf(shape);
  if (pts.length < 3) return null;
  // the shape is drawn in (x, -z) and laid flat: after rotateX(-90°) it lies at (x, y, z)
  const s = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(
    g,
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1 }),
  );
  m.position.y = y;
  return m;
};

const wallBox = (a, b, from, to, bottom, top, thickness, color) => {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 1e-6 || to - from < 0.01 || top - bottom < 0.01) return null;
  const ux = (b.x - a.x) / len,
    uz = (b.z - a.z) / len;
  const mid = (from + to) / 2;
  const g = new THREE.BoxGeometry(to - from, top - bottom, thickness);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
  m.position.set(a.x + ux * mid, (bottom + top) / 2, a.z + uz * mid);
  m.rotation.y = -Math.atan2(uz, ux);
  return m;
};

const label = (text, size) => {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = "700 44px sans-serif";
  c.width = Math.ceil(ctx.measureText(text).width) + 28;
  c.height = 64;
  ctx.font = "700 44px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#111827";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set((size * c.width) / c.height, size, 1);
  sprite.renderOrder = 10;
  return sprite;
};

export async function render3dImage(options) {
  // no browser drawing surface (tests, a server) or no WebGL: no 3D picture, the report says so
  if (typeof document === "undefined") return null;
  try {
    return await draw3d(options);
  } catch {
    return null;
  }
}

async function draw3d({ plan, floorId, cells = [], ranges = [], aps = [], title = "", legendTitle = "Signal (dBm):" }) {
  const rooms = plan.rooms.filter((r) => r.floorId === floorId);
  const areas = [...rooms, ...boundaryAreas(plan, floorId)];
  if (!areas.length) return null;
  const boxes = areas.map(bbox);
  const minX = Math.min(...boxes.map((b) => b.minX)),
    maxX = Math.max(...boxes.map((b) => b.maxX)),
    minZ = Math.min(...boxes.map((b) => b.minZ)),
    maxZ = Math.max(...boxes.map((b) => b.maxZ));
  const spanX = maxX - minX,
    spanZ = maxZ - minZ,
    span = Math.max(spanX, spanZ, 4);
  const cx = (minX + maxX) / 2,
    cz = (minZ + maxZ) / 2;

  const view = document.createElement("canvas");
  view.width = W;
  view.height = VIEW_H;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true, preserveDrawingBuffer: true, alpha: false });
  } catch {
    return null; // no WebGL on this computer
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#f4f7f6");
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(cx + span, span * 1.6, cz + span * 1.2);
  scene.add(sun);

  // ground and floor slabs
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(spanX + span * 0.08, spanZ + span * 0.08),
    new THREE.MeshLambertMaterial({ color: "#e4e9e7" }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -0.05, cz);
  scene.add(ground);
  for (const a of areas) {
    const m = slab(a, 0, "#fbfcfb");
    if (m) scene.add(m);
  }

  // the prediction on the floor
  const heat = cells.length && ranges.length
    ? heatmapCanvas(cells, areas, ranges, Math.max(2, Math.min(12, 2048 / span)))
    : null;
  if (heat) {
    const tex = new THREE.CanvasTexture(heat.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(heat.widthM, heat.heightM),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(heat.x + heat.widthM / 2, 0.04, heat.z + heat.heightM / 2);
    scene.add(plane);
  }

  // walls: real height, a thickness that stays visible on a large building
  const overrides = plan.materialOverrides || {};
  const thicknessOf = (m) =>
    Math.max(Number(overrides[m]?.thicknessM) || Number(plan.wallThickness) || 0.2, span / 450);
  const usedMaterials = new Set();
  for (const w of buildWalls(plan, floorId)) {
    const mat = w.material || "drywall";
    usedMaterials.add(mat);
    const color = materialColors[mat] || materialColors.drywall;
    for (const p of w.pieces?.length ? w.pieces : [{ from: 0, to: w.length, bottom: 0, top: w.height }]) {
      const box = wallBox(w.a, w.b, p.from, p.to, p.bottom, p.top, thicknessOf(mat), color);
      if (box) scene.add(box);
    }
  }
  for (const w of (plan.interiorWalls || []).filter((x) => x.floorId === floorId)) {
    const mat = w.material || "drywall";
    usedMaterials.add(mat);
    const a = { x: +w.x1, z: +w.z1 },
      b = { x: +w.x2, z: +w.z2 };
    const box = wallBox(a, b, 0, Math.hypot(b.x - a.x, b.z - a.z), 0, Number(w.height) || 3, thicknessOf(mat),
      materialColors[mat] || materialColors.drywall);
    if (box) scene.add(box);
  }

  // access points: a marker at mounting height, a thin stem to the floor and the name above
  const apR = Math.max(0.35, span / 140);
  for (const ap of aps) {
    const h = Number(ap.heightM) || 2.5;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(apR, 24, 16),
      new THREE.MeshLambertMaterial({ color: ap.color || "#7c3aed", emissive: ap.color || "#7c3aed", emissiveIntensity: 0.35 }),
    );
    dot.position.set(ap.x, h, ap.z);
    scene.add(dot);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(apR * 0.12, apR * 0.12, h, 8),
      new THREE.MeshBasicMaterial({ color: "#475569" }),
    );
    stem.position.set(ap.x, h / 2, ap.z);
    scene.add(stem);
    if (ap.name) {
      const s = label(ap.name, apR * 2.4);
      s.position.set(ap.x, h + apR * 3.2, ap.z);
      scene.add(s);
    }
  }

  // camera: from the south-east, above, the whole floor in view
  const camera = new THREE.PerspectiveCamera(32, W / VIEW_H, span / 200, span * 20);
  const target = new THREE.Vector3(cx, 0, cz);
  const dir = new THREE.Vector3(0.55, 0.75, 1).normalize();
  // distance at which the floor's bounding sphere fits the narrower field of view
  const radius = Math.hypot(spanX, spanZ) / 2 + 2;
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(fovV, fovH) / 2)) * 0.74;
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.lookAt(target);
  renderer.setPixelRatio(1);
  renderer.setSize(W, VIEW_H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.render(scene, camera);

  // the page image: title, the 3D view, the legend
  const legendItems = ranges.length && heat ? ranges.map((r) => ({ color: r.color, label: bandLabel(r) })) : [];
  const height = TITLE_H + VIEW_H + LEGEND_H;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, height);
  ctx.fillStyle = "#193c39";
  ctx.font = "700 22px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, 14, TITLE_H / 2);
  ctx.drawImage(view, 0, TITLE_H);
  let x = 14,
    y = TITLE_H + VIEW_H + 18;
  ctx.font = "14px sans-serif";
  const item = (color, text) => {
    if (x + 26 + ctx.measureText(text).width > W - 14) {
      x = 14;
      y += 28;
    }
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 9, 18, 18);
    ctx.fillStyle = "#35504a";
    ctx.fillText(text, x + 26, y);
    x += 26 + ctx.measureText(text).width + 18;
  };
  if (legendItems.length) {
    ctx.fillStyle = "#35504a";
    ctx.fillText(legendTitle, x, y);
    x += ctx.measureText(legendTitle).width + 14;
    for (const r of legendItems) item(r.color, r.label);
    x = 14;
    y += 30;
  }
  ctx.fillStyle = "#35504a";
  ctx.fillText("Walls:", x, y);
  x += ctx.measureText("Walls:").width + 14;
  for (const m of usedMaterials) if (materialLabels[m]) item(materialColors[m], materialLabels[m]);

  // free the GPU memory of this picture
  scene.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
  renderer.dispose();
  renderer.forceContextLoss?.();

  const blob = await new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(Error("Could not draw the 3D view."))), "image/png"),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height };
}
