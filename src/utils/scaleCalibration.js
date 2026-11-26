// Scale of an imported floor-plan picture from two known lengths: A-B (usually across) and C-D (usually up-down).
// A picture can be stretched (resized without keeping its proportions): then it has one scale across and another
// up-down, and one length alone cannot show it. Each length mixes both scales by its direction:
//   (dx / kx)^2 + (dy / ky)^2 = L^2
// so two lengths in different directions give both. Same calculation as the worker (printed_scale.two_length_scale).

/** { xPxPerM, yPxPerM, stretchPct } or null (missing input, or the two lines run in nearly the same direction). */
export function twoLengthScale(pointA, pointB, lengthM, pointC, pointD, heightM) {
  if (!pointA || !pointB || !pointC || !pointD || !(lengthM > 0) || !(heightM > 0)) return null;
  const x1 = pointB[0] - pointA[0];
  const y1 = pointB[1] - pointA[1];
  const x2 = pointD[0] - pointC[0];
  const y2 = pointD[1] - pointC[1];
  if (Math.hypot(x1, y1) < 5 || Math.hypot(x2, y2) < 5) return null;
  const det = x1 * x1 * y2 * y2 - y1 * y1 * x2 * x2;
  if (Math.abs(det) < 0.25 * (x1 * x1 + y1 * y1) * (x2 * x2 + y2 * y2)) return null;
  const u = (lengthM * lengthM * y2 * y2 - y1 * y1 * heightM * heightM) / det;
  const v = (x1 * x1 * heightM * heightM - lengthM * lengthM * x2 * x2) / det;
  if (!(u > 0) || !(v > 0)) return null;
  const xPxPerM = 1 / Math.sqrt(u);
  const yPxPerM = 1 / Math.sqrt(v);
  return { xPxPerM, yPxPerM, stretchPct: 100 * Math.abs(xPxPerM / yPxPerM - 1) };
}

/** Points for the scale step from the sizes the worker found printed on the drawing (original picture pixels):
 * the longest horizontal one becomes A-B, the longest vertical one C-D. */
export function pointsFromPrinted(printedLines) {
  const lines = Array.isArray(printedLines) ? printedLines : [];
  const longest = (list) =>
    list.reduce((best, l) => (!best || Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) > Math.hypot(best.b[0] - best.a[0], best.b[1] - best.a[1]) ? l : best), null);
  const across = longest(lines.filter((l) => l.horizontal));
  const upDown = longest(lines.filter((l) => !l.horizontal));
  return {
    ab: across ? { a: across.a, b: across.b, metres: across.metres, text: across.text } : null,
    cd: upDown ? { a: upDown.a, b: upDown.b, metres: upDown.metres, text: upDown.text } : null,
  };
}
