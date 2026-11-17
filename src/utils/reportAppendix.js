// Appendix A (each AP alone) and Appendix B (adding APs one by one) of the Word
// reports, shared by the single-band report and the 2.4 GHz vs 5 GHz comparison.
import { renderCdfChart, renderCoverageBuildChart } from "./reportImages.js";
import { FLOOR_DBM, coverageAt, signalStats } from "./reportData.js";

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–");
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "–");
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "–");
const bandName = (b) => `${b} GHz`;
const heatCells = (cells, pick = (c) => c.best) =>
  cells.map((c) => ({ x: c.x, z: c.z, step: c.step, dbm: pick(c) }));

// bands: [{ band, aps: [{ id, name }], floors: [{ floorId, raw, cells }] }]
// image(options, alt, maxWidthPx) draws one floor picture into the document.
export async function addAppendices({
  doc,
  bands,
  plan,
  ranges,
  designThr,
  targetCoveragePct,
  image,
  onProgress = () => {},
  sourceOf,
  shortName,
  floorName,
}) {
  const o = { targetCoveragePct };
  // Appendix A: each AP alone;  Appendix B: adding APs one by one
  doc.pageBreak();
  doc.heading("Appendix A. Individual AP predictions", 1);
  doc.paragraph("Each access point alone: the signal it would deliver if it were the only AP.");
  let apNo = 0;
  for (const band of bands)
    for (const ap of band.aps) {
      apNo += 1;
      onProgress(`Individual prediction ${apNo}`);
      const src = sourceOf(ap.id, band.band);
      // one AP per page, so a heading, its table and its map stay together
      if (apNo > 1) doc.pageBreak();
      doc.heading(`A.${apNo} ${shortName(ap.name)} (${bandName(band.band)})`, 2);
      if (src)
        doc.paragraph(`${floorName(src.floorId)} · x ${f1(src.x)}, z ${f1(src.z)} · ${f1(Number(src.heightM))} m${Number.isFinite(Number(src.txPowerDbm)) ? ` · ${src.txPowerDbm} dBm` : ""}${src.channel ? ` · channel ${src.channel}` : ""}`, { size: 10, keepNext: true });
      const rows = [["Floor", `Covered at ≥ ${designThr} dBm`, "Min / median / max (dBm)", "Best server for"]];
      const pics = [];
      for (const f of band.floors) {
        const idx = f.raw.accessPoints.findIndex((a) => a.id === ap.id);
        if (idx < 0) continue;
        const own = f.cells.map((c) => {
          const v = f.raw.perApDbm[idx][Math.round((c.z - f.raw.zCentersM[0]) / (f.raw.zCentersM[1] - f.raw.zCentersM[0] || f.raw.cellSizeM))]?.[Math.round((c.x - f.raw.xCentersM[0]) / f.raw.cellSizeM)];
          return { x: c.x, z: c.z, step: c.step, best: v === null || v === undefined ? FLOOR_DBM : v, primary: c.top[0].i === idx };
        });
        const cov = coverageAt(own, [designThr])[0];
        const s = signalStats(own.map((c) => c.best));
        rows.push([floorName(f.floorId), `${pct(cov.pct)} (${f1(cov.coveredM2)} of ${f1(cov.totalM2)} m²)`, `${f1(s.min)} / ${f1(s.median)} / ${f1(s.max)}`, pct((100 * own.filter((c) => c.primary && c.best > FLOOR_DBM).length) / own.length)]);
        pics.push({ f, own });
      }
      doc.table(rows, [1.4, 2.8, 2.2, 1.4]);
      for (const { f, own } of pics)
        await image(
          {
            plan,
            floorId: f.floorId,
            cells: heatCells(own),
            ranges,
            aps: src && src.floorId === f.floorId ? [{ name: shortName(ap.name), x: src.x, z: src.z }] : [],
            title: `${shortName(ap.name)} alone · ${bandName(band.band)} · ${floorName(f.floorId)} · RSSI (dBm)`,
          },
          `${ap.name} alone`,
        );
    }

  doc.pageBreak();
  doc.heading("Appendix B. Adding access points one by one", 1);
  doc.paragraph("APs are switched on in order: AP 1 alone, then AP 1 + 2, then 1 + 2 + 3, and so on. This shows how coverage builds up. It does not show that any one AP is necessary or redundant, because the result depends on the order.");
  for (const band of bands) {
    if (band.aps.length < 2 && bands.length > 1) continue;
    const steps = [];
    for (let k = 1; k <= band.aps.length; k += 1) {
      const used = band.aps.slice(0, k);
      const floors = band.floors.map((f) => {
        const idxs = used.map((a) => f.raw.accessPoints.findIndex((x) => x.id === a.id)).filter((i) => i >= 0);
        const cells = f.cells.map((c) => {
          const ix = Math.round((c.x - f.raw.xCentersM[0]) / f.raw.cellSizeM);
          const iz = Math.round((c.z - f.raw.zCentersM[0]) / (f.raw.zCentersM[1] - f.raw.zCentersM[0] || f.raw.cellSizeM));
          let best = FLOOR_DBM;
          for (const i of idxs) {
            const v = f.raw.perApDbm[i][iz]?.[ix];
            if (v !== null && v !== undefined && v > best) best = v;
          }
          return { x: c.x, z: c.z, step: c.step, best };
        });
        return { floorId: f.floorId, cells };
      });
      const all = floors.flatMap((f) => f.cells);
      steps.push({ k, used, floors, all, cover: coverageAt(all, [designThr])[0], stats: signalStats(all.map((c) => c.best)) });
    }
    const label = (st) => (st.k === 1 ? shortName(st.used[0].name) : `AP 1–${st.k}`);
    doc.heading(`${bandName(band.band)} band`, 2);
    doc.table(
      [
        ["Step", "APs on", `Covered at ≥ ${designThr} dBm`, "Coverage", "Change"],
        ...steps.map((st, i) => [String(st.k), st.used.map((a) => shortName(a.name)).join(" + "), `${f1(st.cover.coveredM2)} of ${f1(st.cover.totalM2)} m²`, pct(st.cover.pct), i ? `${signed(st.cover.pct - steps[i - 1].cover.pct)} pts (${signed(st.cover.coveredM2 - steps[i - 1].cover.coveredM2)} m²)` : "first AP"]),
      ],
      [0.6, 3, 2.4, 1.2, 2.4],
    );
    // coverage as APs are added: y = covered area %, x = AP1, AP1+AP2, AP1+AP2+AP3 ...
    const buildChart = await renderCoverageBuildChart({
      title: `${bandName(band.band)}: coverage as access points are added`,
      thresholdDbm: designThr,
      targetPct: o?.targetCoveragePct,
      points: steps.map((st) => ({ label: st.used.map((a) => shortName(a.name)).join("+"), pct: st.cover.pct })),
    });
    if (buildChart) {
      doc.image(buildChart.bytes, buildChart.width, buildChart.height, "Coverage as APs are added", 600);
      doc.caption(`Share of the target area at or above ${designThr} dBm as the access points are switched on in order. Each x label lists the APs that are on.`);
    }
    for (const [i, st] of steps.entries()) {
      const added = st.used[st.used.length - 1];
      onProgress(`Adding APs: step ${st.k} of ${steps.length}`);
      // one step per page: heading, text, map and its CDF graph stay together
      doc.pageBreak();
      doc.heading(`B.${st.k} ${st.used.map((a) => shortName(a.name)).join(" + ")}`, 2);
      doc.paragraph(`${pct(st.cover.pct)} at ≥ ${designThr} dBm. Signal min / median / max: ${f1(st.stats.min)} / ${f1(st.stats.median)} / ${f1(st.stats.max)} dBm.${i ? ` Adding ${shortName(added.name)} changed coverage by ${signed(st.cover.pct - steps[i - 1].cover.pct)} percentage points (${signed(st.cover.coveredM2 - steps[i - 1].cover.coveredM2)} m²) and the median signal by ${signed(st.stats.median - steps[i - 1].stats.median)} dB.` : ""}`, { size: 10, keepNext: true });
      for (const f of st.floors)
        await image(
          {
            plan,
            floorId: f.floorId,
            cells: heatCells(f.cells),
            ranges,
            aps: st.used.map((a) => ({ a, s: sourceOf(a.id, band.band) })).filter(({ s }) => s && s.floorId === f.floorId).map(({ a, s }) => ({ name: shortName(a.name), x: s.x, z: s.z, color: a.id === added.id ? "#dc2626" : "#111827" })),
            title: `${label(st)} · ${bandName(band.band)} · ${floorName(f.floorId)}${st.k > 1 ? ` (new: ${shortName(added.name)})` : ""}`,
          },
          `Step ${st.k}`,
          480,
        );
      // CDF of this prediction; the previous step is drawn beside it for comparison
      const stepChart = await renderCdfChart({
        title: `${bandName(band.band)} · ${label(st)}: distribution of the strongest signal`,
        thresholds: [designThr],
        series: [
          ...(i ? [{ label: `${label(steps[i - 1])}: ${pct(steps[i - 1].cover.pct)} at ≥ ${designThr} dBm (previous step)`, values: steps[i - 1].all.map((c) => c.best) }] : []),
          { label: `${label(st)}: ${pct(st.cover.pct)} at ≥ ${designThr} dBm`, values: st.all.map((c) => c.best) },
        ],
      });
      if (stepChart) {
        doc.image(stepChart.bytes, stepChart.width, stepChart.height, `CDF for step ${st.k}`, 520);
        doc.caption(`Cumulative distribution of the strongest-AP signal for ${label(st)}. The height of the curve is the share of the target area at or below that level; the dashed line is the design threshold of ${designThr} dBm.`);
      }
    }
    doc.pageBreak();
    doc.heading(`${bandName(band.band)}: all steps compared`, 2);
    const chart = await renderCdfChart({
      title: `${bandName(band.band)}: signal distribution as APs are added`,
      thresholds: [designThr],
      series: steps.map((st) => ({ label: `${label(st)}: ${pct(st.cover.pct)} covered`, values: st.all.map((c) => c.best) })),
    });
    if (chart) doc.image(chart.bytes, chart.width, chart.height, "CDF as APs are added", 640);
    doc.caption("Each curve is the cumulative distribution of the strongest signal; curves moving right mean stronger signal. The dashed line is the design threshold.");
  }

}
