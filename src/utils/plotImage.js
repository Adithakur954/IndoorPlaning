// PNG of the plot exactly as it is on screen: the 2D plan (the visible part,
// with the current pan and zoom, plus the legend and direction markers) or,
// when only the 3D view is open, the 3D canvas.
const WIDTH_PX = 2400;
const FOOTER_PX = 64;

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error("Could not render the plan to an image."));
    image.src = url;
  });

const svgImage = (svg) =>
  loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(svg),
    )}`,
  );

const toBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("Could not create the image."))),
      "image/png",
    ),
  );

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws `text` wrapped to `maxWidth`, starting at the top-left (x, y).
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = "";
  let top = y;
  for (const word of String(text).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      ctx.fillText(line, x, top);
      top += lineHeight;
      line = word;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, top);
}

// The legend, drawn from what is on screen (same bands, same wording).
function drawLegend(ctx, origin, scale) {
  const legend = document.querySelector(".map-legend");
  if (!legend) return;
  const box = legend.getBoundingClientRect();
  const at = (r) => ({
    x: (r.left - origin.left) * scale,
    y: (r.top - origin.top) * scale,
    w: r.width * scale,
    h: r.height * scale,
  });
  const b = at(box);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.strokeStyle = "#dce7e2";
  ctx.lineWidth = scale;
  roundRect(ctx, b.x, b.y, b.w, b.h, 8 * scale);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  const items = legend.querySelectorAll(
    ".map-legend-toggle, h4, .map-legend-row, .map-legend-note, select",
  );
  for (const el of items) {
    const r = at(el.getBoundingClientRect());
    const style = getComputedStyle(el);
    const size = (parseFloat(style.fontSize) || 11) * scale;
    ctx.font = `${style.fontWeight >= 600 ? "700" : "400"} ${size}px sans-serif`;
    ctx.fillStyle = style.color || "#35504a";
    let textX = r.x;
    let maxWidth = r.w;
    const swatch = el.querySelector("i");
    if (swatch) {
      const s = at(swatch.getBoundingClientRect());
      const sStyle = getComputedStyle(swatch);
      ctx.fillStyle =
        sStyle.backgroundColor !== "rgba(0, 0, 0, 0)" ? sStyle.backgroundColor : "#1f3f3a";
      if (swatch.classList.contains("dot")) {
        ctx.beginPath();
        ctx.arc(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(s.x, s.y, s.w, Math.max(s.h, 2 * scale));
      textX = s.x + s.w + 6 * scale;
      maxWidth = r.x + r.w - textX;
      ctx.fillStyle = style.color || "#35504a";
    }
    const text =
      el.tagName === "SELECT"
        ? el.options[el.selectedIndex]?.text || ""
        : (el.innerText || "").replace(/\s+/g, " ").trim();
    if (el.tagName === "SELECT") {
      ctx.strokeStyle = "#c9d8d2";
      ctx.lineWidth = scale;
      roundRect(ctx, r.x, r.y, r.w, r.h, 6 * scale);
      ctx.stroke();
      ctx.fillStyle = style.color || "#35504a";
      ctx.fillText(text, r.x + 10 * scale, r.y + (r.h - size) / 2);
      continue;
    }
    if (text) wrapText(ctx, text, textX, r.y, maxWidth, size * 1.3);
  }
  ctx.restore();
}

// North/south/east/west markers and the compass box.
async function drawDirections(ctx, origin, scale) {
  ctx.save();
  for (const el of document.querySelectorAll(".plan2d .edge-label")) {
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.width / 2 - origin.left) * scale,
      cy = (r.top + r.height / 2 - origin.top) * scale;
    ctx.fillStyle = "#1f3f3a";
    ctx.beginPath();
    ctx.arc(cx, cy, (r.width / 2) * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${10 * scale}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(el.textContent.trim(), cx, cy);
  }
  const compass = document.querySelector(".plan2d .plan-compass");
  if (!compass) {
    ctx.restore();
    return;
  }
  const r = compass.getBoundingClientRect();
  const x = (r.left - origin.left) * scale,
    y = (r.top - origin.top) * scale;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.strokeStyle = "#d5e0dc";
  ctx.lineWidth = scale;
  roundRect(ctx, x, y, r.width * scale, r.height * scale, 8 * scale);
  ctx.fill();
  ctx.stroke();
  const arrow = compass.querySelector("svg");
  if (arrow) {
    const clone = arrow.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const a = arrow.getBoundingClientRect();
    ctx.drawImage(
      await svgImage(clone),
      (a.left - origin.left) * scale,
      (a.top - origin.top) * scale,
      a.width * scale,
      a.height * scale,
    );
  }
  const label = compass.querySelector("small");
  if (label) {
    const l = label.getBoundingClientRect();
    ctx.fillStyle = "#3b5650";
    ctx.font = `400 ${10 * scale}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(
      label.textContent.trim(),
      (l.left + l.width / 2 - origin.left) * scale,
      (l.top - origin.top) * scale,
    );
  }
  ctx.restore();
}

export async function plotImageBlob({ title = "" } = {}) {
  const svg = document.querySelector(".plan2d > svg.plan-svg");
  const gl = document.querySelector(".plan3d canvas");
  let source, width, height;
  let origin = null;
  let scale = 1;
  if (svg) {
    // the part of the plan that is visible on screen right now (pan, zoom and
    // the extra room the browser leaves around the drawing)
    origin = svg.getBoundingClientRect();
    const inverse = svg.getScreenCTM().inverse();
    const corner = (x, y) => {
      const p = svg.createSVGPoint();
      p.x = x;
      p.y = y;
      return p.matrixTransform(inverse);
    };
    const topLeft = corner(origin.left, origin.top),
      bottomRight = corner(origin.right, origin.bottom);
    width = WIDTH_PX;
    height = Math.round((WIDTH_PX * origin.height) / origin.width);
    scale = width / origin.width;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("font-family", "Inter, Segoe UI, Arial, sans-serif");
    clone.setAttribute(
      "viewBox",
      `${topLeft.x} ${topLeft.y} ${bottomRight.x - topLeft.x} ${bottomRight.y - topLeft.y}`,
    );
    clone.setAttribute("width", width);
    clone.setAttribute("height", height);
    source = await svgImage(clone);
  } else if (gl) {
    width = gl.width;
    height = gl.height;
    source = gl;
  } else {
    throw Error("Open the 2D or 3D view to download the plot.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height + (title ? FOOTER_PX : 0);
  const ctx = canvas.getContext("2d");
  const host = svg?.parentElement;
  ctx.fillStyle = (host && getComputedStyle(host).backgroundColor) || "#ffffff";
  if (ctx.fillStyle === "rgba(0, 0, 0, 0)") ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, width, height);
  if (origin) {
    await drawDirections(ctx, origin, scale);
    drawLegend(ctx, origin, scale);
  }
  if (title) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, height, canvas.width, FOOTER_PX);
    ctx.fillStyle = "#1f3f3a";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, 24, height + FOOTER_PX / 2);
  }
  return toBlob(canvas);
}

export const plotFileName = (projectName, floorName) =>
  `${[projectName, floorName]
    .filter(Boolean)
    .join("-")
    .replace(/[^\w.-]+/g, "_") || "plot"}.png`;
