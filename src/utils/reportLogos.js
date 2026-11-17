// Browser only: the company logo and the tool icon as PNG for the report header.
// The SVG files are drawn on a canvas because Word headers need a bitmap.
import companySvg from "../assets/company-logo.svg?raw";
import toolSvg from "../assets/tool-logo.svg?raw";

// Crops keep only the drawn part of each SVG (the company logo has empty margins;
// the tool icon's legs run below its 512 px square canvas).
const COMPANY = { viewBox: "70 110 620 300", width: 620 };
const TOOL = { viewBox: "0 0 512 620", width: 410 };

async function rasterise(svgText, { viewBox, width }) {
  const [, , vw, vh] = viewBox.split(" ").map(Number);
  const height = Math.round((width * vh) / vw);
  const svg = svgText
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<svg\b([^>]*)>/, (_m, attrs) => {
      const clean = attrs
        .replace(/\s(width|height|viewBox)="[^"]*"/g, "")
        .replace(/style="[^"]*"/, "");
      return `<svg${clean} width="${width}" height="${height}" viewBox="${viewBox}">`;
    });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(Error("Could not draw a report logo."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * 2; // drawn at twice the size so it stays sharp when printed
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      widthPx: width,
      heightPx: height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// -> { left: company logo, right: tool icon }; null for one that cannot be drawn.
export async function loadReportLogos() {
  const draw = (svg, crop) => rasterise(svg, crop).catch(() => null);
  const [left, right] = await Promise.all([draw(companySvg, COMPANY), draw(toolSvg, TOOL)]);
  return { left, right };
}
