// Word report that compares 2.4 GHz with 5 GHz for the same access points, in
// the layout of the single-band report (cover, contents, numbered sections).
// Each band comes from its own saved ray-traced run of the same plan.
import { DocxBuilder } from "./docxBuilder.js";
import { renderFloorImage, renderCdfChart, renderCoverageCompareChart } from "./reportImages.js";
import { areaOf, bbox, boundaryAreas, inside } from "./geometry.js";
import { buildWalls } from "./wallGraph.js";
import { addAppendices } from "./reportAppendix.js";
import { COMPARED_BANDS, planForBand, radioFor } from "./bandVariants.js";
import {
  DEFAULT_PROFILES,
  DEFAULT_SNR_TARGET_DB,
  coverageAt,
  groupByBand,
  hasSnr,
  noiseAssumptions,
  overlapClasses,
  rankedCells,
  roomRows,
  signalStats,
  snrBandShares,
  snrCoverage,
  snrStats,
  weakClusters,
} from "./reportData.js";

const AP_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#be185d", "#a16207", "#475569", "#65a30d"];
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–");
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "–");
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "–");
const dbm = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dBm` : "–");
const name = (b) => `${b} GHz`;
const heatCells = (cells, pick = (c) => c.best) => cells.map((c) => ({ x: c.x, z: c.z, step: c.step, dbm: pick(c) }));

// runs: { "2.4": { jobId, result }, "5": { jobId, result } } (see PlannerPage)
export async function buildBandComparisonReport({
  plan,
  projectName,
  runs,
  ranges,
  designThr,
  getMap,
  profiles = DEFAULT_PROFILES,
  logos = null,
  snrRanges = [],
  snrTargetDb = DEFAULT_SNR_TARGET_DB,
  includeAppendices = false, // Appendix A / B and the coverage-build chart: off keeps the report to the standard layout
  onProgress = () => {},
  // the optimiser's designs: { "2.4": plan with the 2.4 GHz proposed APs, "5": plan with the 5 GHz ones }. Without
  // it (the usual case) both bands use `plan`: the same APs on each band, exactly as before.
  planByBand = null,
  designLabel = null, // e.g. "Optimised designs (not applied to the plan)"
}) {
  const planOf = (band) => planByBand?.[band] || plan;
  const doc = new DocxBuilder();
  const title = projectName || "Indoor plan";
  const now = new Date();
  const floorName = (id) => plan.floors.find((f) => f.id === id)?.name || id;
  const areasOf = (floorId) => [...plan.rooms.filter((r) => r.floorId === floorId), ...boundaryAreas(plan, floorId)];
  const skipOf = (floorId) => plan.rooms.filter((r) => r.floorId === floorId && r.receiverGrid === "excluded");
  const roomOf = (s) => plan.rooms.find((r) => r.floorId === s.floorId && inside(s.x, s.z, r));
  const shortName = (n) => String(n ?? "").replace(/^AP-detected-(\d+)$/, "AP$1");
  const thresholds = [...new Set([designThr, ...profiles.map((p) => p.thresholdDbm)])].sort((a, b) => b - a);

  // ---- data: one entry per band ---------------------------------------------
  const data = {};
  for (const band of COMPARED_BANDS) {
    onProgress(`Loading ${name(band)} prediction`);
    const run = runs[band];
    const entries = [];
    for (const floor of run.result.floors)
      entries.push({ floorId: floor.floorId, freqMHz: floor.frequencyMHz, raw: await getMap(run.jobId, floor.file.split("/").pop()) });
    const grouped = groupByBand(entries)[0];
    const floors = grouped.floors.map((f) => ({
      ...f,
      cells: rankedCells(f.raw, areasOf(f.floorId), skipOf(f.floorId)),
    }));
    const cells = floors.flatMap((f) => f.cells);
    const aps = planOf(band).sources.filter((s) => s.kind === "wifi").map((s) => ({ source: s, radio: radioFor(planOf(band), s, band) }));
    const covers = coverageAt(cells, thresholds);
    data[band] = {
      band,
      floors,
      cells,
      aps,
      apList: grouped.aps,
      covers,
      cover: covers[thresholds.indexOf(designThr)],
      stats: signalStats(cells.map((c) => c.best)),
      snrStats: snrStats(cells),
      snrCover: snrCoverage(cells, snrTargetDb),
      hasSnr: hasSnr(cells),
      noise: noiseAssumptions(grouped.floors[0].raw),
      weakM2: cells.filter((c) => c.best < designThr).length * (cells[0]?.step || 1) ** 2,
      classes: grouped.aps.length >= 2 ? overlapClasses(cells, designThr) : null,
      apNames: grouped.floors[0].raw.accessPoints.map((a) => shortName(a.name)),
    };
  }
  // coverage as the APs are switched on one by one (AP 1, then 1 + 2, ...), per band
  const buildSteps = (d) =>
    d.apList.map((_, k) => {
      const used = d.apList.slice(0, k + 1);
      const best = d.floors.flatMap((f) => {
        const idxs = used.map((a) => f.raw.accessPoints.findIndex((x) => x.id === a.id)).filter((i) => i >= 0);
        return f.cells.map((c) => {
          const ix = Math.round((c.x - f.raw.xCentersM[0]) / f.raw.cellSizeM);
          const iz = Math.round((c.z - f.raw.zCentersM[0]) / (f.raw.zCentersM[1] - f.raw.zCentersM[0] || f.raw.cellSizeM));
          let top = -150;
          for (const i of idxs) {
            const v = f.raw.perApDbm[i][iz]?.[ix];
            if (v !== null && v !== undefined && v > top) top = v;
          }
          return { x: c.x, z: c.z, step: c.step, best: top };
        });
      });
      return { pct: coverageAt(best, [designThr])[0].pct };
    });
  for (const band of COMPARED_BANDS) data[band].steps = buildSteps(data[band]);
  const [lo, hi] = COMPARED_BANDS.map((b) => data[b]);
  const diffPts = hi.cover.pct - lo.cover.pct;

  // ---- numbering -------------------------------------------------------------
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
  const apMarkers = (floorId, band = null) =>
    (band ? planOf(band) : plan).sources.filter((s) => s.kind === "wifi" && s.floorId === floorId).map((s) => ({ name: shortName(s.name), x: s.x, z: s.z, color: "#111827" }));

  doc.setHeaderFooter({ header: `${title} · 2.4 GHz vs 5 GHz Wi-Fi Comparison Report`, footer: "", logos });

  // ---- cover and contents ----------------------------------------------------
  doc.paragraph("", {});
  doc.paragraph("", {});
  doc.title("2.4 GHz vs 5 GHz Wi-Fi Comparison Prediction Report");
  doc.paragraph(title, { bold: true, size: 20, color: "2F6F62" });
  doc.paragraph(
    planByBand
      ? "The optimiser's proposed design for each band, predicted with ray-traced radio propagation (Sionna RT). Each band was planned on its own, so the two designs have their own APs and positions: this compares the 2.4 GHz design with the 5 GHz design, not the same APs on two bands."
      : "The same access points, positions and building predicted on each band with ray-traced radio propagation (Sionna RT).",
    { size: 12, color: "526B62" },
  );
  doc.paragraph("");
  doc.table(
    [
      ["Item", "Value"],
      ["Project", title],
      ["Floors", plan.floors.map((f) => f.name).join(", ")],
      ["Wi-Fi access points", planByBand ? `${lo.aps.length} (${name(lo.band)} design) / ${hi.aps.length} (${name(hi.band)} design)` : String(lo.aps.length)],
      ...(designLabel ? [["Design", designLabel]] : []),
      ["Bands compared", COMPARED_BANDS.map(name).join(" and ")],
      ["Design threshold", `${designThr} dBm`],
      ["Report generated", now.toLocaleString()],
    ],
    [1.4, 4],
  );
  doc.pageBreak();
  doc.paragraph("Contents", { bold: true, size: 18, color: "1F3F3A" });
  doc.toc();
  doc.pageBreak();

  // ==== 1. Executive summary ====================================================
  onProgress("Summary");
  H1("Executive summary");
  doc.table(
    [
      ["Item", name(lo.band), name(hi.band), "Difference (5 − 2.4)"],
      ["Access points", String(lo.aps.length), String(hi.aps.length), ""],
      [`Coverage at ≥ ${designThr} dBm`, pct(lo.cover.pct), pct(hi.cover.pct), `${signed(diffPts)} pts`],
      ["Covered area", `${f1(lo.cover.coveredM2)} of ${f1(lo.cover.totalM2)} m²`, `${f1(hi.cover.coveredM2)} of ${f1(hi.cover.totalM2)} m²`, `${signed(hi.cover.coveredM2 - lo.cover.coveredM2)} m²`],
      ["Area below the threshold", `${f1(lo.weakM2)} m²`, `${f1(hi.weakM2)} m²`, `${signed(hi.weakM2 - lo.weakM2)} m²`],
      ["Median signal", dbm(lo.stats.median), dbm(hi.stats.median), `${signed(hi.stats.median - lo.stats.median)} dB`],
      ["Weakest signal heard", dbm(lo.stats.min), dbm(hi.stats.min), `${signed(hi.stats.min - lo.stats.min)} dB`],
      ["Strongest signal", dbm(lo.stats.max), dbm(hi.stats.max), `${signed(hi.stats.max - lo.stats.max)} dB`],
      ...(lo.hasSnr && hi.hasSnr
        ? [
            ["Median SNR", `${f1(lo.snrStats.median)} dB`, `${f1(hi.snrStats.median)} dB`, `${signed(hi.snrStats.median - lo.snrStats.median)} dB`],
            [`Area with SNR ≥ ${snrTargetDb} dB`, pct(lo.snrCover.pct), pct(hi.snrCover.pct), `${signed(hi.snrCover.pct - lo.snrCover.pct)} pts`],
          ]
        : []),
    ],
    [2.4, 1.7, 1.7, 1.7],
  );
  const minus = (v) => String(v).replace(/-/g, "−");
  const full = (d) => d.cover.pct >= 99.95;
  const better = Math.abs(diffPts) < 0.5 ? null : diffPts > 0 ? hi : lo;
  const font = { font: "Arial", size: 12, after: 200 };
  doc.paragraph("Engineering Conclusion:", { bold: true, size: 24, font: "Arial" });
  doc.bullet(
    full(lo) && full(hi)
      ? "The prediction indicates that both 2.4 GHz and 5 GHz bands meet the defined coverage threshold across the modelled area."
      : `At ${minus(designThr)} dBm the prediction covers ${pct(lo.cover.pct)} of the modelled area on 2.4 GHz and ${pct(hi.cover.pct)} on 5 GHz.`,
    font,
  );
  const dMedian = hi.stats.median - lo.stats.median;
  const withSnr = lo.hasSnr && hi.hasSnr;
  if (Math.abs(dMedian) < 0.1) doc.bullet(`Both bands show the same median signal strength (${minus(f1(lo.stats.median))} dBm).`, font);
  else {
    const [a, b] = dMedian < 0 ? [lo, hi] : [hi, lo];
    doc.bullet(
      `The ${name(a.band)} band shows stronger median signal strength (${minus(f1(a.stats.median))} dBm)${withSnr ? ` and median SNR (${f1(a.snrStats.median)} dB)` : ""} compared with ${name(b.band)} (${minus(f1(b.stats.median))} dBm${withSnr ? ` and ${f1(b.snrStats.median)} dB, respectively` : ""}).`,
      font,
    );
  }
  doc.bullet("These results provide a baseline for Wi-Fi network planning, subject to on-site validation of actual coverage and performance.", font);
  doc.pageBreak();

  // ==== 2. Building measurements ====================================================
  onProgress("Building measurements");
  H1("Building measurements");
  doc.paragraph("The building used for both predictions. Every figure is read from the plan, so the 2.4 GHz and 5 GHz runs see exactly the same geometry.");
  const floorRows = [["Floor", "Overall size (m)", "Footprint", "Ceiling height", "Volume", "Rooms", "Doors / windows", "Columns"]];
  for (const f of plan.floors) {
    const all = areasOf(f.id),
      boxes = all.map(bbox).filter(Boolean),
      rooms = plan.rooms.filter((x) => x.floorId === f.id);
    const w = boxes.length ? Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX)) : NaN,
      d = boxes.length ? Math.max(...boxes.map((b) => b.maxZ)) - Math.min(...boxes.map((b) => b.minZ)) : NaN;
    const outline = boundaryAreas(plan, f.id);
    const footprint = outline.length ? outline.reduce((sum, o) => sum + areaOf(o), 0) : rooms.reduce((sum, r) => sum + areaOf(r), 0);
    const hs = rooms.map((r) => Number(r.height)).filter(Number.isFinite);
    const h = hs.length ? Math.max(...hs) : NaN;
    floorRows.push([
      f.name,
      `${f1(w)} × ${f1(d)}`,
      `${f1(footprint)} m²`,
      Number.isFinite(h) ? `${f1(h)} m` : "not set",
      Number.isFinite(h) ? `${f1(footprint * h)} m³` : "–",
      String(rooms.length),
      `${(plan.doors || []).filter((x) => x.floorId === f.id).length} / ${(plan.windows || []).filter((x) => x.floorId === f.id).length}`,
      String((plan.furniture || []).filter((x) => x.floorId === f.id && x.kind === "column").length),
    ]);
  }
  doc.table(floorRows, [1.3, 1.5, 1.1, 1.1, 1.1, 0.7, 1.2, 0.9]);
  for (const f of plan.floors) {
    doc.heading(`${f.name}: dimensions`, 3);
    await image(
      { plan, floorId: f.id, aps: apMarkers(f.id), dimensions: true, title: `${f.name} · measurements (m)` },
      `Dimensions ${f.name}`,
      560,
    );
    const rooms = plan.rooms.filter((x) => x.floorId === f.id);
    if (rooms.length)
      doc.table(
        [
          ["Room", "Size (m)", "Area", "Height", "Wall material"],
          ...rooms.map((x) => {
            const b = bbox(x);
            return [x.name || x.id, b ? `${f1(b.maxX - b.minX)} × ${f1(b.maxZ - b.minZ)}` : "–", `${f1(areaOf(x))} m²`, Number.isFinite(Number(x.height)) ? `${f1(Number(x.height))} m` : "–", x.material || "–"];
          }),
        ],
        [2.4, 1.6, 1.2, 1, 1.6],
      );
    const interior = (plan.interiorWalls || []).filter((w) => w.floorId === f.id);
    if (interior.length)
      doc.paragraph(`${interior.length} partition wall(s) outside the rooms, ${f1(interior.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.z2 - w.z1), 0))} m in total; their lengths are marked on the drawing.`, { size: 10 });
  }
  const wallTotals = new Map();
  for (const f of plan.floors) {
    for (const w of buildWalls({ doors: [], windows: [], interiorWalls: [], ...plan }, f.id)) {
      const t = wallTotals.get(w.material) || { count: 0, length: 0, exterior: 0 };
      t.count += 1;
      t.length += w.length;
      if (w.exterior) t.exterior += w.length;
      wallTotals.set(w.material, t);
    }
    for (const w of (plan.interiorWalls || []).filter((x) => x.floorId === f.id)) {
      const m = w.material || "drywall",
        t = wallTotals.get(m) || { count: 0, length: 0, exterior: 0 };
      t.count += 1;
      t.length += Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
      wallTotals.set(m, t);
    }
  }
  if (wallTotals.size) {
    doc.heading("Walls by material", 3);
    doc.table(
      [["Material", "Wall segments", "Total length", "of which exterior"], ...[...wallTotals.entries()].map(([m, t]) => [m, String(t.count), `${f1(t.length)} m`, `${f1(t.exterior)} m`])],
      [2, 1.4, 1.4, 1.6],
    );
  }
  doc.pageBreak();

  // ==== 3. Wi-Fi infrastructure ====================================================
  onProgress("Infrastructure");
  H1("Wi-Fi infrastructure");
  for (const d of [lo, hi]) {
    H2(`${name(d.band)} radios`);
    doc.table(
      [
        ["AP", "Floor / room", "Position x, z (m)", "Height", "Channel", "Width", "Tx power", "Gain", "EIRP"],
        ...d.aps.map(({ source: s, radio: r }) => [
          shortName(s.name),
          `${floorName(s.floorId)}${roomOf(s) ? ` · ${roomOf(s).name}` : ""}`,
          `${f1(s.x)}, ${f1(s.z)}`,
          `${f1(Number(s.heightM))} m`,
          String(r.channel),
          `${r.bandwidthMHz} MHz`,
          `${r.txPowerDbm} dBm`,
          `${r.antennaGainDbi} dBi`,
          `${f1(r.txPowerDbm + r.antennaGainDbi)} dBm`,
        ]),
      ],
      [0.8, 1.9, 1.3, 0.7, 0.7, 0.8, 0.8, 0.7, 0.8],
    );
    if (d.aps.some((a) => a.radio.assumed))
      doc.note(`Some APs have no ${name(d.band)} radio in their profile. Defaults were used for them (20 dBm, 3 dBi, 20 MHz channel).`, "warn");
  }
  doc.paragraph("The ray-tracing model radiates isotropically: each AP's antenna gain is added to its transmit power (EIRP) and the antenna pattern is not modelled.", { size: 10, color: "526B62" });
  doc.pageBreak();

  // ==== 3. Coverage comparison ===================================================
  onProgress("Coverage");
  H1("Coverage comparison");
  doc.paragraph("Coverage is the share of the target grid whose strongest predicted signal reaches a threshold. The same threshold is applied to both bands.");
  doc.table(
    [
      ["Threshold", `${name(lo.band)} coverage`, `${name(hi.band)} coverage`, "Difference"],
      ...thresholds.map((t, i) => [`≥ ${t} dBm`, pct(lo.covers[i].pct), pct(hi.covers[i].pct), `${signed(hi.covers[i].pct - lo.covers[i].pct)} pts`]),
    ],
    [2, 1.8, 1.8, 1.4],
  );
  if (lo.floors.length > 1)
    doc.table(
      [
        ["Floor", ...COMPARED_BANDS.map((b) => `${name(b)} at ≥ ${designThr} dBm`)],
        ...lo.floors.map((f, i) => [floorName(f.floorId), pct(coverageAt(f.cells, [designThr])[0].pct), pct(coverageAt(hi.floors[i]?.cells || [], [designThr])[0]?.pct)]),
      ],
      [2.4, 2, 2],
    );
  for (const [i] of lo.floors.entries()) {
    for (const d of [lo, hi]) {
      const fl = d.floors[i];
      if (!fl) continue;
      await image(
        {
          plan,
          floorId: fl.floorId,
          cells: heatCells(fl.cells),
          ranges,
          aps: apMarkers(fl.floorId, d.band),
          title: `${name(d.band)} · ${floorName(fl.floorId)} · strongest-AP RSSI (dBm) · design threshold ${designThr} dBm`,
        },
        `${d.band} GHz coverage on ${floorName(fl.floorId)}`,
        520,
      );
    }
  }
  const cdf = await renderCdfChart({
    title: "Distribution of the strongest-AP signal: 2.4 GHz vs 5 GHz",
    thresholds,
    series: COMPARED_BANDS.map((b) => ({ label: `${name(b)}: ${pct(data[b].cover.pct)} at ≥ ${designThr} dBm`, values: data[b].cells.map((c) => c.best) })),
  });
  if (cdf) doc.image(cdf.bytes, cdf.width, cdf.height, "Signal distribution of both bands", 520);
  doc.caption("Cumulative distribution: the height of the curve is the share of the target area at or below that signal level. A curve further right means a stronger signal. Dashed lines mark the thresholds.");
  if (includeAppendices) {
    const buildChart = await renderCoverageCompareChart({
      title: "Coverage as Wi-Fi access points are added: 2.4 GHz vs 5 GHz",
      thresholdDbm: designThr,
      series: [
        { label: name(lo.band), color: "#ea580c", points: lo.steps },
        { label: name(hi.band), color: "#2563eb", points: hi.steps },
      ],
    });
    if (buildChart) {
      doc.image(buildChart.bytes, buildChart.width, buildChart.height, "Coverage as access points are added, both bands", 600);
      doc.caption(`Share of the target area at or above ${designThr} dBm as the access points are switched on in order (AP 1, then AP 1 + 2, and so on), for each band. The order of the APs is the order in the project, so the curve shows how coverage builds up, not that any one AP is necessary.`);
    }

    // ==== Appendix A and B: each AP alone, then APs added one by one, per band =======
    const variants = Object.fromEntries(COMPARED_BANDS.map((b) => [b, planForBand(plan, b)]));
    await addAppendices({
      doc,
      bands: [lo, hi].map((d) => ({ band: d.band, aps: d.apList, floors: d.floors })),
      plan,
      ranges,
      designThr,
      targetCoveragePct: undefined,
      image,
      onProgress,
      // the radio settings shown for an AP are those it has on that band
      sourceOf: (id, band) => variants[band].sources.find((s) => s.id === id),
      shortName,
      floorName,
    });
    doc.pageBreak();
  }
  doc.pageBreak();

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
      for (const d of [lo, hi]) {
        const fl = d.floors.find((x) => x.floorId === f.id);
        if (!fl) continue;
        doc.pageBreak();
        doc.heading(`${f.name}: 3D view with the predicted ${name(d.band)} signal`, 2);
        put3d(await render3dImage({
          plan, floorId: f.id, cells: heatCells(fl.cells), ranges,
          aps: planOf(d.band).sources
            .filter((s) => s.kind === "wifi" && s.floorId === f.id)
            .map((s) => ({ name: shortName(s.name), x: s.x, z: s.z, heightM: s.heightM, color: s.origin === "optimized" ? "#dc2626" : "#7c3aed" })),
          title: `${f.name} · 3D view with the predicted signal · ${name(d.band)} · strongest-AP RSSI (dBm)`,
        }), `3D view with ${d.band} GHz prediction of ${f.name}`);
      }
    }
  }

  // ==== SNR comparison ====================================================================
  onProgress("SNR");
  H1("Signal-to-noise ratio (SNR) comparison");
  if (!lo.hasSnr || !hi.hasSnr) {
    doc.note("One of the predictions has no SNR map. Run the report again to predict both bands with the current model.", "warn");
  } else {
    doc.paragraph("SNR is the strongest AP's predicted signal minus the noise floor of its channel, in dB. Each band has its own noise floor; interference from other APs (SINR) is not included.");
    for (const d of [lo, hi]) {
      H2(`${name(d.band)} noise floor`);
      if (d.noise) {
        doc.table(
          [
            ["AP", "Channel width", "Noise floor used"],
            ...d.noise.aps.map((a) => [shortName(a.name), `${f1(a.width)} MHz${a.assumed ? " (assumed)" : ""}`, dbm(a.floor)]),
          ],
          [2.4, 2, 2],
        );
        doc.paragraph(`Planning assumption: ${dbm(d.noise.floor20)} for a 20 MHz channel, plus 3 dB for each doubling of the width. It is not a measurement.`, { size: 10, color: "526B62" });
      }
    }
    H2("SNR distribution");
    doc.table(
      [
        ["Item", name(lo.band), name(hi.band), "Difference (5 − 2.4)"],
        ["Weakest SNR", `${f1(lo.snrStats.min)} dB`, `${f1(hi.snrStats.min)} dB`, `${signed(hi.snrStats.min - lo.snrStats.min)} dB`],
        ["Median SNR", `${f1(lo.snrStats.median)} dB`, `${f1(hi.snrStats.median)} dB`, `${signed(hi.snrStats.median - lo.snrStats.median)} dB`],
        ["Strongest SNR", `${f1(lo.snrStats.max)} dB`, `${f1(hi.snrStats.max)} dB`, `${signed(hi.snrStats.max - lo.snrStats.max)} dB`],
        [`Area with SNR ≥ ${snrTargetDb} dB`, pct(lo.snrCover.pct), pct(hi.snrCover.pct), `${signed(hi.snrCover.pct - lo.snrCover.pct)} pts`],
      ],
      [2.4, 1.7, 1.7, 1.7],
    );
    if (snrRanges.length) {
      const a = snrBandShares(lo.cells, snrRanges).reverse();
      const b = snrBandShares(hi.cells, snrRanges).reverse();
      doc.table(
        [["SNR band", `${name(lo.band)} share`, `${name(hi.band)} share`], ...a.map((x, i) => [x.label, pct(x.pct), pct(b[i].pct)])],
        [3, 1.8, 1.8],
      );
    }
    for (const [i] of lo.floors.entries())
      for (const d of [lo, hi]) {
        const fl = d.floors[i];
        if (!fl) continue;
        await image(
          {
            plan,
            floorId: fl.floorId,
            cells: fl.cells.map((c) => ({ x: c.x, z: c.z, step: c.step, dbm: Number.isFinite(c.snr) ? c.snr : -20 })),
            ranges: snrRanges,
            legendTitle: "SNR (dB):",
            aps: apMarkers(fl.floorId, d.band),
            title: `${name(d.band)} · ${floorName(fl.floorId)} · SNR (dB)`,
          },
          `${d.band} GHz SNR on ${floorName(fl.floorId)}`,
        );
      }
    doc.note("SNR here is for the downlink, from the AP to a client. The prediction has no people, fading or client-side losses, and the noise floor is an assumption, so measured SNR is usually lower than the map.", "warn");
  }

  // ==== 4. AP coverage and threshold value ===========================================
  onProgress("AP coverage");
  H1("AP coverage and threshold value");
  doc.paragraph(`An AP is counted as usable where it reaches the design threshold of ${designThr} dBm.`);
  if (lo.classes && hi.classes)
    doc.table(
      [
        ["Usable APs per point", `${name(lo.band)} area`, `${name(lo.band)} share`, `${name(hi.band)} area`, `${name(hi.band)} share`],
        ...[["None (no usable AP)", "none"], ["One AP only", "one"], ["Two APs", "two"], ["Three or more APs", "threePlus"]].map(([label, k]) => [
          label,
          `${f1(lo.classes[k].m2)} m²`,
          pct(lo.classes[k].pct),
          `${f1(hi.classes[k].m2)} m²`,
          pct(hi.classes[k].pct),
        ]),
      ],
      [2.4, 1.3, 1.1, 1.3, 1.1],
    );
  else doc.paragraph("The overlap table needs at least two APs.", { italic: true });
  for (const d of [lo, hi])
    for (const f of d.floors)
      await image(
        {
          plan,
          floorId: f.floorId,
          flat: true,
          cells: f.cells.map((c) => ({ x: c.x, z: c.z, step: c.step, fill: c.best >= designThr ? AP_COLORS[c.top[0].i % AP_COLORS.length] : "#9ca3af" })),
          legend: [...d.apNames.map((n, i) => ({ color: AP_COLORS[i % AP_COLORS.length], label: n })), { color: "#9ca3af", label: `below ${designThr} dBm` }],
          legendTitle: "Primary AP:",
          aps: apMarkers(f.floorId, d.band),
          title: `${name(d.band)} · ${floorName(f.floorId)} · primary (strongest) AP`,
        },
        `Primary AP map ${name(d.band)} ${floorName(f.floorId)}`,
      );
  doc.pageBreak();

  // ==== 5. Room-level comparison ====================================================
  onProgress("Rooms");
  H1("Room-level comparison");
  doc.paragraph(`Coverage and median signal of each room on both bands at ${designThr} dBm. Only grid cells inside the room are counted.`);
  const roomTable = [["Room", "Area", `${name(lo.band)} coverage`, `${name(hi.band)} coverage`, `${name(lo.band)} median`, `${name(hi.band)} median`, `${name(lo.band)} SNR`, `${name(hi.band)} SNR`]];
  for (const room of plan.rooms.filter((r) => r.receiverGrid !== "excluded")) {
    const a = roomRows([room], lo.cells, lo.apNames, designThr)[0];
    const b = roomRows([room], hi.cells, hi.apNames, designThr)[0];
    if (!a && !b) continue;
    roomTable.push([room.name || room.id, `${f1((a || b).areaM2)} m²`, pct(a?.coveragePct), pct(b?.coveragePct), dbm(a?.median), dbm(b?.median), Number.isFinite(a?.snrMedian) ? `${f1(a.snrMedian)} dB` : "–", Number.isFinite(b?.snrMedian) ? `${f1(b.snrMedian)} dB` : "–"]);
  }
  if (roomTable.length > 1) doc.table(roomTable, [1.9, 0.9, 1, 1, 1.1, 1.1, 0.9, 0.9]);
  else doc.paragraph("The plan has no rooms to compare.", { italic: true });

  // ==== 6. Weak zones ================================================================
  onProgress("Weak zones");
  H1("Weak zones and problem areas");
  for (const d of [lo, hi]) {
    H2(name(d.band));
    const clusters = d.floors
      .flatMap((f) => weakClusters(f.cells, designThr).map((c) => ({ ...c, floorId: f.floorId })))
      .sort((a, b) => b.areaM2 - a.areaM2)
      .slice(0, 8);
    if (clusters.length)
      doc.table(
        [
          ["#", "Floor", "Near x, z (m)", "Area", "Weakest"],
          ...clusters.map((c, i) => [String(i + 1), floorName(c.floorId), `${f1(c.centroid.x)}, ${f1(c.centroid.z)}`, `${f1(c.areaM2)} m²`, dbm(c.minDbm)]),
        ],
        [0.5, 1.8, 1.8, 1.2, 1.3],
      );
    else doc.paragraph(`No area is below ${designThr} dBm on ${name(d.band)}.`);
  }
  // cells weak on one band only (both runs share the grid and the rooms)
  const key = (c) => `${Math.round(c.x / c.step)},${Math.round(c.z / c.step)}`;
  const loWeak = new Set(lo.cells.filter((c) => c.best < designThr).map(key));
  const hiWeak = new Set(hi.cells.filter((c) => c.best < designThr).map(key));
  const step = lo.cells[0]?.step || 1;
  const onlyHi = [...hiWeak].filter((k) => !loWeak.has(k)).length * step * step;
  const onlyLo = [...loWeak].filter((k) => !hiWeak.has(k)).length * step * step;
  const both = [...hiWeak].filter((k) => loWeak.has(k)).length * step * step;
  H2("Where the bands differ");
  doc.table(
    [
      ["Area below the threshold", "Size"],
      ["On both bands", `${f1(both)} m²`],
      ["On 5 GHz only", `${f1(onlyHi)} m²`],
      ["On 2.4 GHz only", `${f1(onlyLo)} m²`],
    ],
    [3.4, 1.6],
  );

  // ==== 7. Recommendations ============================================================
  onProgress("Recommendations");
  H1("Engineering recommendations");
  const rec = [];
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const apCount = lo.aps.length;
  rec.push(
    full(lo) && full(hi)
      ? `Both bands provide 100% predicted coverage at the ${minus(designThr)} dBm threshold with the existing ${words[apCount] ?? apCount}-AP layout.`
      : better === lo
        ? `2.4 GHz gives the wider coverage here (${pct(lo.cover.pct)} against ${pct(hi.cover.pct)}). Use it for coverage-critical areas and low-rate devices.`
        : better === hi
          ? `5 GHz covers more of this building than 2.4 GHz (${pct(hi.cover.pct)} against ${pct(lo.cover.pct)}); both bands can be used with this AP layout.`
          : "Both bands cover the building about equally with this AP layout.",
  );
  if (onlyHi > 0.5) rec.push(`${f1(onlyHi)} m² is covered on 2.4 GHz but not on 5 GHz. Clients there will fall back to 2.4 GHz unless an AP is added or moved close to those areas.`);
  if (both > 0.5) rec.push(`${f1(both)} m² is below ${minus(designThr)} dBm on both bands: these are the real coverage gaps to fix with a new or moved AP.`);
  rec.push("Review channel allocation to minimise co-channel interference and optimise network performance.");
  rec.push("Validate coverage, SNR and throughput through an on-site survey, as SNR values are simulation-based estimates.");
  for (const t of rec) doc.bullet(t, { font: "Times New Roman", size: 12, after: 0 });

  onProgress("Writing the file");
  return doc.blob();
}
