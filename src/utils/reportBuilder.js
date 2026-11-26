// Assembles the Word planning and design report from the saved prediction and
// optimisation runs. Calculations live in reportData.js, drawing in
// reportImages.js and the file format in docxBuilder.js. Sections the project
// has no data for are left out and listed under "Not available".
import { DocxBuilder } from "./docxBuilder.js";
import { addAppendices } from "./reportAppendix.js";
import { renderFloorImage, renderCdfChart } from "./reportImages.js";
import { areaOf, bbox, boundaryAreas, inside } from "./geometry.js";
import { buildWalls } from "./wallGraph.js";
import { ituProperties } from "./materialModel.js";
import { getFloorLogs } from "./logOverlay.js";
import { getProfiles } from "../config/apProfiles.js";
import { optimizationCells } from "../services/optimization.js";
import {
  DEFAULT_DETECT_DBM,
  DEFAULT_PROFILES,
  FLOOR_DBM,
  DEFAULT_SNR_TARGET_DB,
  areaChecks,
  channelPairs,
  coverageAt,
  errorStats,
  groupByBand,
  overlapClasses,
  pairOverlap,
  predictedAt,
  primarySecondaryGap,
  rankedCells,
  hasSnr,
  noiseAssumptions,
  roomRows,
  signalStats,
  snrBandShares,
  snrCoverage,
  snrStats,
  weakClusters,
} from "./reportData.js";

const AP_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#be185d", "#a16207", "#475569", "#65a30d"];
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–");
const f0 = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "–");
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "–");
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "–");
const dbm = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dBm` : "–");
const bandName = (b) => `${b} GHz`;

const mountingLabel = (rec) =>
  rec.kind === "ceiling" ? "ceiling" : rec.kind === "existing" ? "existing AP" : `wall${rec.wallSide ? ` (${rec.wallSide})` : ""}`;

// Cells of one band as heatmap cells for the drawing.
const heatCells = (cells, pick = (c) => c.best) =>
  cells.map((c) => ({ x: c.x, z: c.z, step: c.step, dbm: pick(c) }));

export async function buildReport({
  plan,
  projectName,
  rt,
  opt,
  ranges,
  thresholdDbm,
  getMap,
  profiles = DEFAULT_PROFILES,
  detectDbm = DEFAULT_DETECT_DBM,
  logos = null, // { left: company logo, right: tool icon } as PNG, see reportLogos.js
  snrRanges = [], // colour bands of the SNR KPI (dB)
  snrTargetDb = DEFAULT_SNR_TARGET_DB,
  onProgress = () => {},
  designLabel = null, // e.g. "Optimised design from the optimiser (not applied to the plan)"
}) {
  if (!rt?.jobId || !rt.result?.floors?.length)
    throw Error("Run a prediction first: the report is built from its result.");

  const doc = new DocxBuilder();
  const missing = []; // what the project cannot provide, listed at the end
  const name = projectName || "Indoor plan";
  const now = new Date();
  const floorName = (id) => plan.floors.find((f) => f.id === id)?.name || id;
  const wifi = plan.sources.filter((s) => s.kind === "wifi");
  const areasOf = (floorId) => [
    ...plan.rooms.filter((r) => r.floorId === floorId),
    ...boundaryAreas(plan, floorId),
  ];
  const skipOf = (floorId) =>
    plan.rooms.filter((r) => r.floorId === floorId && r.receiverGrid === "excluded");
  const roomOf = (s) =>
    plan.rooms.find((r) => r.floorId === s.floorId && inside(s.x, s.z, r));
  const sourceOf = (id) => plan.sources.find((s) => s.id === id);

  // ---- data: maps grouped by band -------------------------------------------
  onProgress("Loading prediction maps");
  const entries = [];
  for (const floor of rt.result.floors)
    entries.push({
      floorId: floor.floorId,
      freqMHz: floor.frequencyMHz,
      raw: await getMap(rt.jobId, floor.file.split("/").pop()),
    });
  const bands = groupByBand(entries).map((b) => {
    const floors = b.floors.map((f) => ({
      ...f,
      areas: areasOf(f.floorId),
      cells: rankedCells(f.raw, areasOf(f.floorId), skipOf(f.floorId)),
    }));
    return { ...b, floors, cells: floors.flatMap((f) => f.cells) };
  });
  // the band used for the AP-overlap, room and weak-zone analysis
  const ref =
    [...bands].sort(
      (a, b) => b.aps.length - a.aps.length || (b.band === "5") - (a.band === "5"),
    )[0];
  const designThr = Number.isFinite(opt?.threshold) ? opt.threshold : thresholdDbm;
  const thresholds = [
    ...new Set([designThr, ...profiles.map((p) => p.thresholdDbm)]),
  ].sort((a, b) => b - a);
  const resolution = ref.floors[0]?.raw.cellSizeM;
  const refCover = coverageAt(ref.cells, [designThr])[0];
  const refApNames = ref.floors[0] ? ref.floors[0].raw.accessPoints.map((a) => a.name) : [];

  // ---- numbering ---------------------------------------------------------------
  let sectionNo = 0,
    subNo = 0;
  const H1 = (text) => {
    sectionNo += 1;
    subNo = 0;
    doc.heading(`${sectionNo}. ${text}`, 1);
  };
  const H2 = (text) => {
    subNo += 1;
    doc.heading(`${sectionNo}.${subNo} ${text}`, 2);
  };
  const image = async (options, alt, maxWidthPx) => {
    const out = await renderFloorImage(options);
    if (out) doc.image(out.bytes, out.width, out.height, alt, maxWidthPx);
    else doc.paragraph("(no drawing available for this floor)", { italic: true });
  };
  const apMarkers = (floorId, { added = [], colorBy = null } = {}) =>
    wifi
      .filter((s) => s.floorId === floorId)
      .map((s, i) => ({
        name: shortName(s.name),
        x: s.x,
        z: s.z,
        color: added.includes(s.id)
          ? "#dc2626"
          : colorBy
            ? colorBy(s, i)
            : s.origin === "optimized"
              ? "#dc2626"
              : "#111827",
      }));
  const shortName = (n) => String(n ?? "").replace(/^AP-detected-(\d+)$/, "AP$1");

  doc.setHeaderFooter({
    header: `${name} · Indoor Wi-Fi Network Planning and Design Report`,
    footer: "",
    logos,
  });

  // ---- cover and contents ------------------------------------------------------------
  doc.paragraph("", {});
  doc.paragraph("", {});
  doc.title("Indoor Wi-Fi Network Planning and Design Report");
  doc.paragraph(name, { bold: true, size: 20, color: "2F6F62" });
  doc.paragraph(
    "Coverage, AP placement and optimisation based on ray-traced radio propagation (Sionna RT).",
    { size: 12, color: "526B62" },
  );
  doc.paragraph("");
  doc.table(
    [
      ["Item", "Value"],
      ["Project", name],
      ["Floors", plan.floors.map((f) => f.name).join(", ")],
      ["Wi-Fi access points", String(wifi.length)],
      ["Bands predicted", bands.map((b) => bandName(b.band)).join(", ")],
      ...(designLabel ? [["Design", designLabel]] : []),
      ["Prediction run", rt.finishedAt ? new Date(rt.finishedAt).toLocaleString() : "saved run"],
      ["Report generated", now.toLocaleString()],
    ],
    [1.4, 4],
  );
  doc.pageBreak();
  doc.paragraph("Contents", { bold: true, size: 18, color: "1F3F3A" });
  doc.toc();
  doc.note(
    "Page numbers in the contents list update when Word asks to refresh fields on opening (choose Yes), or by right-clicking the list and choosing Update field.",
    "info",
  );
  doc.pageBreak();

  // ---- facts used in several sections ---------------------------------------------------
  const existingAps = wifi.filter((s) => s.origin !== "optimized");
  const r = opt?.result;
  const o = r?.outcome;
  const fixed = opt ? (opt.settingsUsed?.existingHandling ?? "fixed") === "fixed" : true;
  let optPlan = null; // retained / moved / added / removed
  if (r) {
    const recsOf = (kind) => r.recommendations.filter((x) => (kind === "existing" ? x.existingId : !x.existingId));
    const added = recsOf("new");
    const onExisting = recsOf("existing");
    const moved = [],
      retained = [];
    for (const rec of onExisting) {
      const src = sourceOf(rec.existingId);
      (src && Math.hypot(src.x - rec.planX, src.z - rec.planZ) > 0.25 ? moved : retained).push(rec);
    }
    const usedIds = new Set(onExisting.map((x) => x.existingId));
    const keptFixed = fixed ? (r.existingAps || existingAps) : [];
    const removed = fixed ? [] : (r.existingAps || []).filter((a) => !usedIds.has(a.id));
    const acts = r.existingActions;
    if (acts?.length) {
      // "use my existing APs": the optimiser says what happens to each AP
      const by = (a) => acts.filter((x) => x.action === a);
      const newOnes = r.recommendations.filter((x) => x.action === "new");
      optPlan = {
        added: newOnes,
        moved: by("move").map((x) => ({ ...x, existingId: x.id, planX: x.to.x, planZ: x.to.z, heightM: x.to.heightM, room: x.to.room, kind: x.to.mounting })),
        retained: [...by("keep"), ...by("fixed")].map((a) => ({ name: a.name, floorId: a.floorId })),
        removed: by("remove"),
        total: by("keep").length + by("move").length + by("fixed").length + newOnes.length,
      };
    } else
    optPlan = {
      added,
      moved,
      retained: fixed ? keptFixed.map((a) => ({ name: a.name, floorId: a.floorId })) : retained.map((x) => ({ name: sourceOf(x.existingId)?.name, floorId: x.floorId })),
      removed,
      total: fixed ? (r.existingAps?.length ?? existingAps.length) + added.length : r.recommendations.length,
    };
  }
  const weakRef = ref.floors.flatMap((f) =>
    weakClusters(f.cells, designThr).map((c) => ({ ...c, floorId: f.floorId })),
  ).sort((a, b) => b.areaM2 - a.areaM2);
  const nearestAp = (floorId, x, z) => {
    let best = null;
    for (const s of wifi.filter((a) => a.floorId === floorId)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (!best || d < best.d) best = { s, d };
    }
    return best;
  };

  // ---- automatic design review: things an engineer should check before trusting the numbers ----
  const findings = [];
  {
    const refClasses = ref.aps.length >= 2 ? overlapClasses(ref.cells, designThr) : null;
    const near = [];
    for (let i = 0; i < wifi.length; i += 1)
      for (let j = i + 1; j < wifi.length; j += 1) {
        const a = wifi[i],
          b = wifi[j];
        if (a.floorId !== b.floorId) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 2.5) near.push(`${shortName(a.name)} and ${shortName(b.name)} (${f1(d)} m apart)`);
      }
    if (near.length)
      findings.push(`Very close access points: ${near.join("; ")}. Two APs this close add little coverage and raise co-channel contention; if the APs were detected from a drawing, check they are not duplicates of one symbol.`);
    for (const band of bands) {
      const aps = wifi.filter((s) => String(s.band) === String(band.band) && s.channel);
      const counts = aps.reduce((m, s) => m.set(String(s.channel), (m.get(String(s.channel)) || 0) + 1), new Map());
      const worst = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
      if (aps.length >= 3 && worst && worst[1] / aps.length > 0.5)
        findings.push(`${worst[1]} of ${aps.length} ${bandName(band.band)} APs share channel ${worst[0]}. This is the main interference risk of the design: assign different channels (20 MHz widths are easier to reuse than 40 MHz) and reduce transmit power where cells overlap.`);
    }
    if (refClasses && refClasses.threePlus.pct > 70)
      findings.push(`${pct(refClasses.threePlus.pct)} of the area has three or more usable APs at ${designThr} dBm, so the network is heavily over-provisioned for coverage. Lower transmit power or test whether some APs can be removed.`);
    if (designThr > -60)
      findings.push(`The design threshold (${designThr} dBm) is much stricter than usual planning targets (-67 to -70 dBm). Coverage figures at the planning profiles are listed in the RF coverage section; judge the AP count against those.`);
    const lowMounted = wifi.filter((s) => {
      const h = Number(roomOf(s)?.height ?? Math.max(...plan.rooms.filter((x) => x.floorId === s.floorId).map((x) => Number(x.height) || 0)));
      return s.mounting === "ceiling" && Number.isFinite(h) && h > 0 && Number(s.heightM) < h - 0.3;
    });
    if (lowMounted.length)
      findings.push(`${lowMounted.map((s) => shortName(s.name)).join(", ")} ${lowMounted.length > 1 ? "are" : "is"} marked as ceiling-mounted but ${lowMounted.length > 1 ? "sit" : "sits"} at least 0.3 m below the ceiling height. Confirm the mounting height or the mounting type.`);
    const artefacts = weakRef.filter((c) => c.minDbm < -110);
    if (artefacts.length)
      findings.push(`${artefacts.length} weak patch(es) (${f1(artefacts.reduce((s, c) => s + c.areaM2, 0))} m²) have no usable signal at all (weakest ${f0(Math.min(...artefacts.map((c) => c.minDbm)))} dBm). This usually points to the model rather than a real coverage hole, such as a strip beside an exterior wall, a boundary offset or a wall drawn through the area. Check the geometry there before adding hardware.`);
    if (opt?.result && fixed)
      findings.push("The optimisation kept all existing APs fixed, so it can only add APs and cannot say how many are really needed. To find a minimum AP count, run it again with existing APs allowed to move or be removed.");
    if (!Number.isFinite(rt.result.settings?.receiver_height_m))
      findings.push("The receiver height used in the prediction is not recorded in the saved run; confirm it matches the client height you design for (typically 1.0–1.5 m).");
  }

  // ====================================================================================
  // 1. Executive summary
  // ====================================================================================
  onProgress("Executive summary");
  H1("Executive summary");
  const footprint = plan.rooms.reduce((sum, rm) => sum + areaOf(rm), 0);
  const boundaryM2 = (plan.boundaries || []).reduce(
    (sum, b) => sum + areaOf({ polygonPoints: b.points, shape: "polygon" }),
    0,
  );
  const totalArea = boundaryM2 || footprint;
  const gapText = weakRef.length
    ? weakRef
        .slice(0, 3)
        .map((c) => `${floorName(c.floorId)} near x ${f1(c.centroid.x)}, z ${f1(c.centroid.z)} (${f1(c.areaM2)} m², weakest ${f0(c.minDbm)} dBm${c.minDbm < -110 ? ", no signal: check geometry" : ""})`)
        .join("; ")
    : `none: no area below ${designThr} dBm in the ${bandName(ref.band)} prediction`;
  doc.table(
    [
      ["Item", "Value"],
      ["Project", name],
      ["Total building area", `${f1(totalArea)} m² (${boundaryM2 ? "building boundary" : "sum of room areas"})`],
      ["Floors", String(plan.floors.length)],
      ["Existing APs", String(existingAps.length)],
      ["Recommended AP count", optPlan ? `${optPlan.total} (${optPlan.added.length} added, ${optPlan.moved.length} repositioned)` : "No optimisation run"],
      [`Predicted coverage (${bandName(ref.band)}, ≥ ${designThr} dBm)`, `${pct(refCover.pct)} of ${f1(refCover.totalM2)} m² target grid`],
      [
        `Predicted SNR (${bandName(ref.band)})`,
        hasSnr(ref.cells)
          ? `median ${f1(snrStats(ref.cells).median)} dB; ${pct(snrCoverage(ref.cells, snrTargetDb).pct)} of the area at ≥ ${snrTargetDb} dB`
          : "not in this prediction run: run the prediction again",
      ],
      ["Coverage target", o ? `${o.targetCoveragePct}% at ${opt.threshold} dBm (optimisation setting)` : "Not set (no optimisation run)"],
      ["Major coverage gaps", gapText],
    ],
    [2.2, 4.4],
  );
  doc.heading("Engineering conclusion", 3);
  const concl = [];
  concl.push(
    `With the ${wifi.length} access point(s) in the plan, ${pct(refCover.pct)} of the target grid in the ${bandName(ref.band)} prediction reaches ${designThr} dBm or better.`,
  );
  if (weakRef.length)
    concl.push(`${weakRef.length} weak patch(es) remain, the largest ${f1(weakRef[0].areaM2)} m² on ${floorName(weakRef[0].floorId)}.`);
  if (o)
    concl.push(
      o.targetAchieved
        ? `The optimiser reached its ${o.targetCoveragePct}% target with ${optPlan.total} AP(s) in total.`
        : `The optimiser did not reach its ${o.targetCoveragePct}% target (${pct(o.achievedCoveragePct)}); ${o.message}`,
    );
  if (findings.length)
    concl.push(`The automatic design review raised ${findings.length} point(s) to check, listed under "Design review findings" in the final recommendations; the coverage figure should be read together with them.`);
  concl.push(
    "These are physics-based predictions, not measurements. Capacity, interference and roaming behaviour are not validated here, and an on-site survey is required before acceptance.",
  );
  doc.paragraph(concl.join(" "));

  // ====================================================================================
  // 2. Building and floor plan
  // ====================================================================================
  onProgress("Building and floor plan");
  doc.pageBreak();
  H1("Building and floor plan analysis");
  const floorRows = [["Floor", "Size (m)", "Rooms", "Room area", "Ceiling height", "Doors / windows"]];
  for (const f of plan.floors) {
    const rooms = plan.rooms.filter((x) => x.floorId === f.id);
    const all = areasOf(f.id);
    const boxes = all.map(bbox);
    const w = boxes.length ? Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX)) : NaN;
    const d = boxes.length ? Math.max(...boxes.map((b) => b.maxZ)) - Math.min(...boxes.map((b) => b.minZ)) : NaN;
    const heights = rooms.map((x) => Number(x.height)).filter(Number.isFinite);
    floorRows.push([
      f.name,
      `${f1(w)} × ${f1(d)}`,
      String(rooms.length),
      `${f1(rooms.reduce((s, x) => s + areaOf(x), 0))} m²`,
      heights.length ? (Math.min(...heights) === Math.max(...heights) ? `${f1(heights[0])} m` : `${f1(Math.min(...heights))}–${f1(Math.max(...heights))} m`) : "not set",
      `${plan.doors.filter((x) => x.floorId === f.id).length} / ${plan.windows.filter((x) => x.floorId === f.id).length}`,
    ]);
  }
  doc.table(floorRows, [1.6, 1.6, 0.8, 1.4, 1.4, 1.4]);
  doc.paragraph(`Size is the overall extent (width × depth) of the rooms and building boundary of each floor.${plan.property?.carpetAreaM2 ? ` Carpet area entered in the project: ${f1(Number(plan.property.carpetAreaM2))} m².` : ""}`, { size: 10, color: "526B62" });
  for (const f of plan.floors) {
    doc.heading(`${f.name}: floor plan with access points`, 3);
    const floorAps = apMarkers(f.id);
    const countOf = (color) => floorAps.filter((a) => a.color === color).length;
    await image(
      {
        plan,
        floorId: f.id,
        aps: floorAps,
        legend: [
          { color: "#111827", label: `Existing AP (${countOf("#111827")})` },
          { color: "#dc2626", label: `Optimised / proposed AP (${countOf("#dc2626")})` },
        ],
        legendTitle: "Markers:",
        title: `${f.name} · rooms, walls and access points`,
      },
      `Floor plan ${f.name}`,
    );
    const rooms = plan.rooms.filter((x) => x.floorId === f.id);
    if (rooms.length)
      doc.table(
        [
          ["Room", "Area", "Height", "Wall material", "Doors", "Windows"],
          ...rooms.map((x) => [
            x.name || x.id,
            `${f1(areaOf(x))} m²`,
            Number.isFinite(Number(x.height)) ? `${f1(Number(x.height))} m` : "–",
            x.material || "–",
            String(plan.doors.filter((d) => d.roomId === x.id).length),
            String(plan.windows.filter((w) => w.roomId === x.id).length),
          ]),
        ],
        [2.6, 1.2, 1, 1.8, 0.8, 0.9],
      );
  }
  // wall and material summary
  const wallTotals = new Map();
  for (const f of plan.floors)
    for (const w of buildWalls(plan, f.id)) {
      const t = wallTotals.get(w.material) || { count: 0, length: 0, exterior: 0 };
      t.count += 1;
      t.length += w.length;
      if (w.exterior) t.exterior += w.length;
      wallTotals.set(w.material, t);
    }
  if (wallTotals.size) {
    doc.heading("Walls and building materials", 3);
    const freq = ref.freqs[0];
    doc.table(
      [
        ["Material", "Wall segments", "Total length", "of which exterior", `Permittivity / conductivity at ${freq} MHz (ITU-R P.2040)`],
        ...[...wallTotals.entries()].map(([material, t]) => {
          let props = "–";
          try {
            const p = ituProperties(material, freq);
            props = `εr ${p.epsR.toFixed(2)} / σ ${p.sigma.toPrecision(3)} S/m`;
          } catch {
            /* a material the model does not know */
          }
          return [material, String(t.count), `${f1(t.length)} m`, `${f1(t.exterior)} m`, props];
        }),
      ],
      [1.4, 1.2, 1.2, 1.4, 2.6],
    );
  }
  const st = rt.result.settings || {};
  doc.heading("Propagation modelling assumptions", 3);
  doc.bullet(`Engine: Sionna RT${rt.result.versions?.["sionna-rt"] ? ` ${rt.result.versions["sionna-rt"]}` : ""}; grid resolution ${f1(resolution)} m; receiver height ${Number.isFinite(st.receiver_height_m) ? `${st.receiver_height_m} m` : "as exported"}; maximum ray depth ${st.max_depth ?? "–"}; ${st.samples_per_tx ?? "–"} samples per AP.`);
  doc.bullet(`Effects modelled: line of sight and specular reflection; refraction ${st.refraction ? "on" : "off"}; diffraction ${st.diffraction ? "on" : "off"}; diffuse reflection ${st.diffuse_reflection ? "on" : "off"}.`);
  for (const a of rt.result.assumptions || []) doc.bullet(a);
  if (!plan.doors.length && !plan.windows.length)
    doc.note("No doors or windows are drawn in this project, so walls are modelled as solid.", "missing");

  // ---- 3D views (one page per floor): the building, and the building with the predicted signal ------------
  // Drawn off-screen with their own camera framed on the floor (src/utils/report3d.js), never a screenshot.
  {
    const { render3dImage } = await import("./report3d.js");
    const put3d = (out, alt) => {
      if (out) doc.image(out.bytes, out.width, out.height, alt);
      else doc.paragraph("(the 3D view needs WebGL, which this computer's browser does not offer)", { italic: true });
    };
    for (const f of plan.floors) {
      if (!areasOf(f.id).length) continue;
      onProgress(`3D view of ${f.name}`);
      doc.pageBreak();
      doc.heading(`${f.name}: 3D view`, 2);
      const aps3d = plan.sources
        .filter((s) => s.kind === "wifi" && s.floorId === f.id)
        .map((s) => ({ name: shortName(s.name), x: s.x, z: s.z, heightM: s.heightM, color: s.origin === "optimized" ? "#dc2626" : "#7c3aed" }));
      put3d(await render3dImage({ plan, floorId: f.id, aps: aps3d, title: `${f.name} · 3D view: rooms, walls and access points` }), `3D view of ${f.name}`);
      const fl = ref.floors.find((x) => x.floorId === f.id);
      if (fl) {
        doc.pageBreak();
        doc.heading(`${f.name}: 3D view with the predicted signal`, 2);
        put3d(await render3dImage({
          plan, floorId: f.id, aps: aps3d, cells: heatCells(fl.cells), ranges,
          title: `${f.name} · 3D view with the predicted signal · ${bandName(ref.band)} · strongest-AP RSSI (dBm)`,
        }), `3D view with prediction of ${f.name}`);
      }
    }
  }

  // ====================================================================================
  // 3. Existing Wi-Fi infrastructure
  // ====================================================================================
  onProgress("Wi-Fi infrastructure");
  doc.pageBreak();
  H1("Wi-Fi infrastructure");
  if (wifi.length) {
    const profileList = getProfiles(plan);
    const model = (s) => profileList.find((p) => p.id === s.profileId)?.name || "not recorded";
    doc.table(
      [
        ["AP", "Model", "Floor / room", "Position x, z (m)", "Height", "Mounting", "Status"],
        ...wifi.map((s) => [
          shortName(s.name),
          model(s),
          `${floorName(s.floorId)}${roomOf(s) ? ` · ${roomOf(s).name}` : ""}`,
          `${f1(s.x)}, ${f1(s.z)}`,
          `${f1(Number(s.heightM))} m`,
          s.mounting || "not recorded",
          s.origin === "optimized" ? "Proposed (optimised)" : s.origin === "detected" ? "Existing (detected from drawing)" : "Existing",
        ]),
      ],
      [0.9, 1.7, 2.2, 1.5, 0.8, 1.1, 1.6],
    );
    doc.table(
      [
        ["AP", "Band", "Channel", "Width", "Tx power", "Antenna gain", "Antenna"],
        ...wifi.map((s) => [
          shortName(s.name),
          s.band ? bandName(s.band) : "–",
          s.channel ? String(s.channel) : "–",
          Number.isFinite(Number(s.bandwidthMHz)) ? `${s.bandwidthMHz} MHz` : "–",
          Number.isFinite(Number(s.txPowerDbm)) ? `${s.txPowerDbm} dBm` : "–",
          Number.isFinite(Number(s.antennaGainDbi)) ? `${s.antennaGainDbi} dBi` : "–",
          s.antennaPattern || "–",
        ]),
      ],
      [0.9, 0.9, 0.9, 0.9, 1, 1.2, 1.2],
    );
    doc.paragraph("The ray-tracing model radiates isotropically: each AP's antenna gain is added to its transmit power (EIRP) and the antenna pattern is not modelled.", { size: 10, color: "526B62" });
  } else doc.paragraph("The plan has no Wi-Fi access points.");

  await addAppendices({
    doc,
    bands,
    plan,
    ranges,
    designThr,
    targetCoveragePct: o?.targetCoveragePct,
    image,
    onProgress,
    sourceOf,
    shortName,
    floorName,
  });

  // ====================================================================================
  // 4. RF coverage
  // ====================================================================================
  onProgress("RF coverage");
  missing.push("Interference (SINR) maps: not calculated; SNR uses an assumed noise floor, not a measured one.");

  // ====================================================================================
  // 5. Primary and secondary AP coverage
  // ====================================================================================
  if (ref.aps.length >= 2) {
    onProgress("Primary and secondary AP coverage");
    doc.pageBreak();
    H1("AP coverage and threshold value");
    doc.paragraph(
      `For every grid cell the strongest, second-strongest and third-strongest AP are ranked (${bandName(ref.band)}). An AP is counted as usable where it reaches the design threshold of ${designThr} dBm.`,
    );
    const classes = overlapClasses(ref.cells, designThr);
    doc.table(
      [
        ["Usable APs per point", "Area", "Share"],
        ["None (no usable AP)", `${f1(classes.none.m2)} m²`, pct(classes.none.pct)],
        ["One AP only (single-AP zone)", `${f1(classes.one.m2)} m²`, pct(classes.one.pct)],
        ["Two APs", `${f1(classes.two.m2)} m²`, pct(classes.two.pct)],
        ["Three or more APs", `${f1(classes.threePlus.m2)} m²`, pct(classes.threePlus.pct)],
      ],
      [3, 1.6, 1.4],
    );
    const gap = primarySecondaryGap(ref.cells);
    doc.paragraph(
      `Where a second AP is heard (${gap.count} grid cells), the median difference between the strongest and the second-strongest AP is ${f1(gap.median)} dB; the difference is within 3 dB for ${pct(gap.withinDb(3))}, within 6 dB for ${pct(gap.withinDb(6))} and within 10 dB for ${pct(gap.withinDb(10))} of those cells.`,
      { size: 10 },
    );
    const colorOf = (i) => AP_COLORS[i % AP_COLORS.length];
    for (const f of ref.floors) {
      const names = f.raw.accessPoints.map((a) => shortName(a.name));
      await image(
        {
          plan,
          floorId: f.floorId,
          flat: true,
          cells: f.cells.map((c) => ({ x: c.x, z: c.z, step: c.step, fill: c.best >= designThr ? colorOf(c.top[0].i) : "#9ca3af" })),
          legend: [...names.map((n, i) => ({ color: colorOf(i), label: n })), { color: "#9ca3af", label: `below ${designThr} dBm` }],
          legendTitle: "Primary AP:",
          aps: apMarkers(f.floorId),
          title: `${bandName(ref.band)} · ${floorName(f.floorId)} · primary (strongest) AP`,
        },
        `Primary AP map ${floorName(f.floorId)}`,
      );
    }
    H2("Single-AP zones and roaming");
    doc.paragraph(
      `${pct(classes.one.pct)} of the target area (${f1(classes.one.m2)} m²) has only one usable AP and ${pct(classes.none.pct)} has none. Where a second usable AP overlaps the first, a client has an alternative AP to move to; where only one AP is usable, there is nothing to roam to.`,
    );
    doc.note(
      "Overlapping predictions show where a roam is possible, not that roaming works. Roaming performance depends on client behaviour and the 802.11k/v/r configuration of the clients and APs, none of which are modelled or recorded in this project, so it has not been validated.",
      "warn",
    );
    missing.push("Roaming validation (802.11k/v/r support): no client or AP roaming configuration is recorded in the project.");
  } else
    missing.push("Primary/secondary AP coverage and roaming overlap: needs at least two APs in one band.");

  // ====================================================================================
  // Signal-to-noise ratio
  // ====================================================================================
  onProgress("SNR");
  doc.pageBreak();
  H1("Signal-to-noise ratio (SNR)");
  if (!bands.some((b) => hasSnr(b.cells))) {
    doc.note("This prediction run has no SNR map. Run the prediction again, then generate the report.", "warn");
  } else {
    doc.paragraph(
      "SNR is the strongest AP's predicted signal minus the noise floor of its channel, in dB. It is worked out from the same ray-traced signal as the RSSI results; interference from other APs (SINR) is not included.",
    );
    for (const band of bands) {
      if (!hasSnr(band.cells)) continue;
      H2(`${bandName(band.band)} band`);
      const noise = noiseAssumptions(band.floors[0].raw);
      if (noise)
        doc.table(
          [
            ["AP", "Channel width", "Noise floor used"],
            ...noise.aps.map((a) => [shortName(a.name), `${f1(a.width)} MHz${a.assumed ? " (assumed)" : ""}`, dbm(a.floor)]),
          ],
          [2.4, 2, 2],
        );
      if (noise)
        doc.paragraph(`The noise floor is a planning assumption of ${dbm(noise.floor20)} for a 20 MHz channel, plus 3 dB for each doubling of the width. It is not a measurement: a busy site can be 5 to 10 dB noisier, which lowers the SNR by the same amount.`, { size: 10, color: "526B62" });
      const stats = snrStats(band.cells);
      const target = snrCoverage(band.cells, snrTargetDb);
      doc.paragraph(`SNR over the target grid: weakest ${f1(stats.min)} dB, median ${f1(stats.median)} dB, strongest ${f1(stats.max)} dB. ${pct(target.pct)} of the area (${f1(target.coveredM2)} of ${f1(target.totalM2)} m²) has at least ${snrTargetDb} dB, a common planning target for data and voice.`, { bold: true });
      if (snrRanges.length)
        doc.table(
          [["SNR band", "Area", "Share"], ...snrBandShares(band.cells, snrRanges).reverse().map((b) => [b.label, `${f1(b.m2)} m²`, pct(b.pct)])],
          [3, 2, 1.4],
        );
      for (const f of band.floors)
        await image(
          {
            plan,
            floorId: f.floorId,
            cells: f.cells.map((c) => ({ x: c.x, z: c.z, step: c.step, dbm: Number.isFinite(c.snr) ? c.snr : -20 })),
            ranges: snrRanges,
            legendTitle: "SNR (dB):",
            aps: apMarkers(f.floorId),
            title: `${bandName(band.band)} · ${floorName(f.floorId)} · SNR (dB)`,
          },
          `${band.band} GHz SNR on ${floorName(f.floorId)}`,
        );
    }
    doc.note("SNR here is for the downlink, from the AP to a client. The prediction has no people, fading or client-side losses, so measured SNR is usually lower than the map.", "warn");
  }

  // ====================================================================================
  // 7. AP placement and installation design
  // ====================================================================================
  onProgress("AP placement");
  doc.pageBreak();
  H1("AP placement and installation design");
  const placement = r
    ? [
        ...(optPlan.retained.map((x) => {
          const s = wifi.find((w) => w.name === x.name) || existingAps.find((w) => w.name === x.name);
          return s && { label: shortName(s.name), floorId: s.floorId, x: s.x, z: s.z, h: Number(s.heightM), mount: s.mounting || "not recorded", status: "Existing, kept in place", room: roomOf(s)?.name || "" };
        }).filter(Boolean)),
        ...optPlan.moved.map((x) => ({ label: shortName(sourceOf(x.existingId)?.name || `#${x.rank}`), floorId: x.floorId, x: x.planX, z: x.planZ, h: x.heightM, mount: mountingLabel(x), status: "Existing, move here", room: x.room })),
        ...optPlan.added.map((x) => ({ label: `NEW-${x.rank}`, floorId: x.floorId, x: x.planX, z: x.planZ, h: x.heightM, mount: mountingLabel(x), status: "New", room: x.room })),
      ]
    : wifi.map((s) => ({ label: shortName(s.name), floorId: s.floorId, x: s.x, z: s.z, h: Number(s.heightM), mount: s.mounting || "not recorded", status: s.origin === "optimized" ? "Proposed (optimised)" : "Existing", room: roomOf(s)?.name || "" }));
  doc.paragraph(r ? "Positions below follow the optimisation result; existing APs the optimiser keeps are listed as well." : "No optimisation has been run, so the positions below are the APs currently in the plan.");
  if (placement.length) {
    doc.table(
      [
        ["Label", "Floor / room", "x, z (m)", "Height", "Mounting", "Status"],
        ...placement.map((p) => [p.label, `${floorName(p.floorId)}${p.room ? ` · ${p.room}` : ""}`, `${f1(p.x)}, ${f1(p.z)}`, `${f1(p.h)} m`, p.mount, p.status]),
      ],
      [1, 2.6, 1.3, 0.9, 1.5, 1.6],
    );
    for (const f of plan.floors) {
      const here = placement.filter((p) => p.floorId === f.id);
      if (!here.length) continue;
      await image(
        {
          plan,
          floorId: f.id,
          aps: here.map((p) => ({ name: p.label, x: p.x, z: p.z, color: p.status === "New" ? "#dc2626" : p.status.startsWith("Existing, move") ? "#ea580c" : "#111827" })),
          legend: [
            { color: "#111827", label: "Existing / kept" },
            { color: "#ea580c", label: "Existing, move" },
            { color: "#dc2626", label: "New" },
          ],
          legendTitle: "AP:",
          title: `${f.name} · installation positions`,
        },
        `AP placement ${f.name}`,
      );
    }
    doc.heading("Deployment summary", 3);
    const mounts = placement.reduce((m, p) => m.set(p.mount, (m.get(p.mount) || 0) + 1), new Map());
    doc.bullet(`Total APs: ${placement.length} (${[...mounts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}).`);
    const hs = placement.map((p) => p.h).filter(Number.isFinite);
    if (hs.length) doc.bullet(`Mounting height: ${f1(Math.min(...hs))}–${f1(Math.max(...hs))} m.`);
    const used = [...new Set(wifi.map((s) => getProfiles(plan).find((p) => p.id === s.profileId)?.name).filter(Boolean))];
    if (used.length) doc.bullet(`AP profile(s) used in the prediction: ${used.join("; ")}.`);
    doc.bullet("Confirm every position against ceiling construction, obstructions and mounting rules on site before installation.");
  }
  missing.push("PoE budget, switch ports and Ethernet cabling: no cabling or switch data in the project.");
  missing.push("Capacity and performance planning (users, client density, application demand, airtime): no such inputs in the project.");
  missing.push("Specific AP hardware recommendations: only the AP profile entered in the project is known.");

  // ====================================================================================
  // 8. Optimisation and minimum AP count
  // ====================================================================================
  if (r) {
    onProgress("Optimisation");
    doc.pageBreak();
    H1("AP optimisation and minimum AP count");
    const changed = optPlan.added.length + optPlan.moved.length + optPlan.removed.length > 0;
    if (!changed) {
      // nothing to add, move or remove: a short statement, no before/after plots
      doc.paragraph(
        `The access points are already optimised: no AP needs to be added, moved or removed. ${optPlan.total} access point(s) give ${pct(r.after.coveragePct)} coverage at ${opt.threshold} dBm (target ${o.targetCoveragePct != null ? `${o.targetCoveragePct}%` : "none"}).`,
        { bold: true },
      );
    } else {
    doc.paragraph(o.message);
    doc.table(
      [
        ["", "Before", "After"],
        ["Target-area coverage", pct(r.before.coveragePct), pct(r.after.coveragePct)],
        ["Access points", String(r.existingAps?.length ?? existingAps.length), String(optPlan.total)],
      ],
      [3, 2, 2],
    );
    doc.table(
      [
        ["Change", "Count", "APs"],
        ["Retained in place", String(optPlan.retained.length), optPlan.retained.map((x) => shortName(x.name)).join(", ") || "–"],
        ["Moved", String(optPlan.moved.length), optPlan.moved.map((x) => shortName(sourceOf(x.existingId)?.name)).join(", ") || "–"],
        ["Added", String(optPlan.added.length), optPlan.added.map((x) => `NEW-${x.rank}`).join(", ") || "–"],
        ["Removed", String(optPlan.removed.length), optPlan.removed.map((x) => shortName(x.name)).join(", ") || "–"],
      ],
      [2, 1, 4],
    );
    doc.heading("Optimisation settings", 3);
    doc.bullet(`Threshold ${opt.threshold} dBm; coverage means ${r.settings.redundancy ?? 1} AP(s) reach the threshold at ${r.settings.receiver_height_m ?? 1.5} m, area weighted.`);
    doc.bullet(`Existing APs: ${fixed ? "fixed (never moved or removed)" : "may be moved or dropped"}. Best achievable with the allowed positions: ${pct(o.bestAchievableWithCandidatesPct)}.`);
    doc.bullet(`Candidate positions: ${r.candidates?.supplied ?? "–"} supplied, ${r.candidates?.shortlisted ?? "–"} shortlisted after coarse ray tracing.`);
    if (opt.threshold !== designThr)
      doc.note(`Threshold differs: the optimisation used ${opt.threshold} dBm and the report design threshold is ${designThr} dBm.`, "warn");
    if (r.recommendations.length) {
      doc.heading("Recommended AP positions", 3);
      doc.table(
        [
          ["#", "Floor / room", "Mounting", "x, z (m)", "Height", "Adds", "Total"],
          ...r.recommendations.map((x) => [String(x.rank), `${x.floor} · ${x.room || "Common area"}`, mountingLabel(x), `${f1(x.planX)}, ${f1(x.planZ)}`, `${f1(x.heightM)} m`, `${signed(x.marginalCoveragePct)}%`, pct(x.cumulativeCoveragePct)]),
        ],
        [0.5, 2.6, 1.6, 1.5, 0.9, 0.9, 1],
      );
    }
    doc.heading("Coverage by floor and room (optimiser's own grid)", 3);
    doc.table(
      [["Floor", "Before", "After"], ...r.after.perFloor.map((f, i) => [f.floor, pct(r.before.perFloor[i]?.coveragePct), pct(f.coveragePct)])],
      [3, 2, 2],
    );
    if (r.after.perRoom.length)
      doc.table(
        [
          ["Room", "Area", "Before", "After"],
          ...r.after.perRoom.map((x) => [x.room, `${f1(x.areaM2)} m²`, pct(r.before.perRoom.find((b) => b.roomId === x.roomId)?.coveragePct), pct(x.coveragePct)]),
        ],
        [3, 1.4, 1.4, 1.4],
      );
    if (r.weakZones?.length) {
      doc.heading("Weak zones remaining after optimisation", 3);
      for (const z of r.weakZones.slice(0, 15))
        doc.bullet(`${z.floor || floorName(z.floorId)}${z.centroid ? ` · around x ${f1(z.centroid.x)}, z ${f1(z.centroid.z)}` : ""}${Number.isFinite(z.areaM2) ? ` · about ${f1(z.areaM2)} m²` : ""}`);
    }
    for (const fl of r.after.perFloor) {
      const map = opt.maps?.[fl.floorId];
      if (!map) continue;
      for (const which of ["before", "after"]) {
        const cells = optimizationCells(map, which, { coverage: false, referenceDbm: opt.threshold }).map((c) => ({ ...c, dbm: c.rawDbm }));
        await image(
          {
            plan,
            floorId: fl.floorId,
            cells,
            ranges,
            aps: [
              ...wifi.filter((s) => s.floorId === fl.floorId && (which === "before" ? s.origin !== "optimized" : true)).map((s) => ({ name: shortName(s.name), x: s.x, z: s.z, color: "#111827" })),
              ...(which === "after" ? r.recommendations.filter((x) => x.floorId === fl.floorId).map((x) => ({ name: `#${x.rank}`, x: x.planX, z: x.planZ, color: "#dc2626" })) : []),
            ],
            title: `${which === "before" ? "Before" : "After"} optimisation · ${fl.floor} · RSSI (dBm) · threshold ${opt.threshold} dBm`,
          },
          `${which} optimisation ${fl.floor}`,
        );
      }
    }
    H2("Minimum APs for full coverage");
    const full = o.achievedCoveragePct >= 99.95;
    const counts = `${optPlan.retained.length} kept, ${optPlan.moved.length} moved, ${optPlan.removed.length} removed, ${optPlan.added.length} added`;
    if (fixed) {
      // every existing AP was kept, so this run cannot say how many APs are really needed
      doc.note(
        `This run kept all ${r.existingAps?.length ?? existingAps.length} existing AP(s) and only added new ones, so ${optPlan.total} is not the minimum number of APs. To get the minimum, run the optimisation with "Use my existing APs: keep, move or remove them" and generate the report again.`,
        "warn",
      );
    } else if (full)
      doc.paragraph(`Minimum: ${optPlan.total} access point(s) give 100% coverage at ${opt.threshold} dBm (${counts}).${o.targetCoveragePct < 100 ? ` This run targeted ${o.targetCoveragePct}% and reached 100%; a run targeting 100% can show whether fewer APs are enough.` : ""}`, { bold: true });
    else if (o.bestAchievableWithCandidatesPct < 100 - 1e-6)
      doc.paragraph(`100% coverage cannot be reached with the allowed AP positions: the best achievable is ${pct(o.bestAchievableWithCandidatesPct)}. With ${optPlan.total} access point(s) (${counts}) coverage is ${pct(o.achievedCoveragePct)}. Allow more mounting positions, lower the threshold or mark non-receiver rooms as excluded, then optimise again.`, { bold: true });
    else
      doc.paragraph(`Fewest found: ${optPlan.total} access point(s) (${counts}) reach ${pct(o.achievedCoveragePct)} at ${opt.threshold} dBm, which was the target of ${o.targetCoveragePct}%. 100% is reachable with the allowed positions, but only a run with the target set to 100% gives the AP count for it.`, { bold: true });
    doc.note(
      "The optimiser is a heuristic (greedy weighted set cover with swap refinement and pruning). It returns a small valid AP set, not a mathematically proven global minimum, and sequential AP addition does not prove that any one AP is necessary or redundant. Channel, capacity and SNR constraints are not part of the optimisation.",
      "warn",
    );
    }
  } else
    missing.push("AP optimisation and minimum AP count: no optimisation has been run (use Optimise APs, then generate the report again).");

  // ====================================================================================
  // 9. Room-level analysis
  // ====================================================================================
  onProgress("Room analysis");
  doc.pageBreak();
  H1("Room-level analysis");
  doc.paragraph(`${bandName(ref.band)} prediction, coverage at ${designThr} dBm. Only grid cells inside the room are counted; rooms marked as not a receiver area are excluded. Primary and secondary AP are the ones most often strongest and second-strongest in the room where they reach the threshold.`, { size: 10 });
  for (const f of ref.floors) {
    const rooms = plan.rooms.filter((x) => x.floorId === f.floorId && x.receiverGrid !== "excluded");
    const rows = roomRows(rooms, f.cells, f.raw.accessPoints.map((a) => shortName(a.name)), designThr);
    if (!rows.length) continue;
    doc.heading(floorName(f.floorId), 3);
    doc.table(
      [
        ["Room", "Area", "Best", "Median", "Worst", "Covered", "APs", "Primary", "Secondary", "SNR"],
        ...rows.map((x) => [x.name, `${f1(x.areaM2)} m²`, f0(x.best), f0(x.median), f0(x.worst), pct(x.coveragePct), String(x.usableAps), x.primary, x.secondary, Number.isFinite(x.snrMedian) ? f0(x.snrMedian) : "–"]),
      ],
      [2, 1, 0.6, 0.7, 0.6, 0.9, 0.5, 0.9, 0.9, 0.6],
    );
  }
  doc.paragraph("RSSI values in dBm; SNR is the median SNR in dB. APs = number of APs reaching the threshold somewhere in the room. Areas here are prediction-grid areas (cells × cell area), so they can differ slightly from the drawn room areas in the floor plan section.", { size: 9, color: "6B7280" });
  missing.push("Room signal-quality status from SINR: interference is not calculated.");

  // ====================================================================================
  // 10. Weak zones
  // ====================================================================================
  onProgress("Weak zones");
  doc.pageBreak();
  H1("Weak zones and problem areas");
  if (weakRef.length) {
    doc.table(
      [
        ["#", "Floor", "Location x, z (m)", "Area", "Weakest", "Nearest AP"],
        ...weakRef.slice(0, 12).map((c, i) => {
          const n = nearestAp(c.floorId, c.centroid.x, c.centroid.z);
          return [String(i + 1), floorName(c.floorId), `${f1(c.centroid.x)}, ${f1(c.centroid.z)}`, `${f1(c.areaM2)} m²`, c.noSignal ? "no signal" : dbm(c.minDbm), n ? `${shortName(n.s.name)} (${f1(n.d)} m)` : "–"];
        }),
      ],
      [0.4, 1.3, 1.6, 1, 1.1, 1.8],
    );
    for (const f of ref.floors) {
      const here = weakRef.filter((c) => c.floorId === f.floorId).slice(0, 12);
      if (!here.length) continue;
      await image(
        {
          plan,
          floorId: f.floorId,
          cells: heatCells(f.cells),
          ranges,
          aps: apMarkers(f.floorId),
          marks: here.map((c) => ({ x: c.centroid.x, z: c.centroid.z, r: Math.sqrt(c.areaM2 / Math.PI) + 0.4, label: String(weakRef.indexOf(c) + 1) })),
          title: `${bandName(ref.band)} · ${floorName(f.floorId)} · weak zones below ${designThr} dBm`,
        },
        `Weak zones ${floorName(f.floorId)}`,
      );
    }
    doc.heading("Recommendations", 3);
    doc.bullet("Patches next to a distant AP are candidates for an extra AP or a repositioned one; the optimisation section shows a ranked placement when it has been run.");
    doc.bullet("Check patches behind dense walls or in enclosed rooms for wall material and door settings before adding hardware.");
  } else doc.paragraph(`No area falls below ${designThr} dBm in the ${bandName(ref.band)} prediction.`);
  const single = ref.aps.length >= 2 ? overlapClasses(ref.cells, designThr).one : null;
  if (single)
    doc.paragraph(`Single-AP zones (one usable AP only): ${f1(single.m2)} m² (${pct(single.pct)}). They are listed in the primary and secondary coverage section.`, { size: 10 });
  missing.push("High-density areas and areas needing capacity: no client density data in the project.");

  // ====================================================================================
  // 11. Validation
  // ====================================================================================
  onProgress("Validation");
  doc.pageBreak();
  H1("Validation and engineering acceptance");
  const pairs = [];
  for (const f of ref.floors)
    for (const log of getFloorLogs(plan, f.floorId)) {
      const measured = Number(log.rssi);
      if (!Number.isFinite(measured) || log.rssi === "" || log.rssi === null) continue;
      const predicted = predictedAt(f.raw, Number(log.x), Number(log.z));
      if (predicted !== null) pairs.push({ predicted, measured });
    }
  const errs = errorStats(pairs);
  if (errs && errs.n >= 3) {
    doc.table(
      [
        ["Measure", "Value"],
        ["Matched measured RSSI points", String(errs.n)],
        ["Mean error (predicted − measured)", `${signed(errs.bias)} dB`],
        ["Mean absolute error (MAE)", `${f1(errs.mae)} dB`],
        ["Root-mean-square error (RMSE)", `${f1(errs.rmse)} dB`],
      ],
      [3, 2],
    );
    doc.note(`Each measured RSSI point is compared with the strongest-AP prediction of the ${bandName(ref.band)} band at the nearest grid cell. The project does not record which band or device a log came from, so treat the figures as indicative until a controlled survey is done.`, "warn");
  } else
    doc.note("Validation pending: the project has no measured RSSI points that fall on the prediction grid (or fewer than three). Predicted-versus-measured error statistics (MAE, RMSE) will be added once survey data is imported.", "missing");
  doc.note("Predicted-versus-measured SNR: not available. The prediction does not model noise.", "missing");
  doc.heading("Site survey and acceptance criteria (proposed)", 3);
  doc.bullet(`Survey the walkable area on every floor with the installed APs at their final settings and record RSSI by position.`);
  doc.bullet(`Proposed acceptance: measured RSSI at or above ${designThr} dBm at the share of survey points agreed with the customer (the predicted coverage is ${pct(refCover.pct)}).`);
  doc.bullet("Compare predicted and measured values; recalibrate or add APs where the error is large.");
  doc.bullet("Test application performance and roaming on site; they cannot be concluded from this report.");
  doc.paragraph("These criteria are proposals for discussion, not requirements taken from a standard.", { italic: true, size: 10, color: "526B62" });

  // ====================================================================================
  // 12. Final recommendations
  // ====================================================================================
  doc.pageBreak();
  H1("Final engineering recommendations");
  doc.bullet(`Coverage: ${pct(refCover.pct)} of the ${bandName(ref.band)} target grid is predicted at ≥ ${designThr} dBm with the ${wifi.length} AP(s) in the plan${weakRef.length ? `; ${weakRef.length} weak patch(es) remain` : ""}.`);
  if (optPlan) doc.bullet(`Deployment: ${optPlan.total} AP(s) in total after optimisation (${optPlan.added.length} added, ${optPlan.moved.length} moved, ${optPlan.removed.length} removed). ${o.targetAchieved ? "The optimisation target was reached." : "The optimisation target was not reached."}`);
  else doc.bullet("Deployment: run the AP optimisation to obtain a recommended AP set and count.");
  doc.bullet("Coverage limitations: values are modelled; furniture, people, door state and device antennas change real signal levels.");
  doc.bullet("Capacity limitations: not assessed; the number of users, applications and airtime per AP are unknown.");
  doc.bullet("Outstanding risks: co-channel contention, roaming behaviour and wall-material assumptions are unvalidated.");
  doc.bullet("Next steps: confirm positions on site, install, survey, compare against this prediction and tune AP power and channels.");
  if (findings.length) {
    doc.heading("Design review findings", 3);
    doc.paragraph("Generated automatically from the plan and the prediction. Each point is something to confirm before relying on the coverage figures.", { size: 10, keepNext: true });
    for (const t of findings) doc.bullet(t);
  }

  return doc.blob();
}
