// Detect enclosed light regions in a dark-line architectural plan. The returned
// rectangles are editable estimates; the source image remains available for review.
export async function detectRooms(dataUrl, metresWide = 20) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = Math.min(650, image.naturalWidth),
    height = Math.max(
      1,
      Math.round((image.naturalHeight * width) / image.naturalWidth),
    );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return detectRegionsFromPixels(
    ctx.getImageData(0, 0, width, height).data,
    width,
    height,
    metresWide,
  );
}
export function detectRegionsFromPixels(rgba, width, height, metresWide = 20) {
  const free = new Uint8Array(width * height),
    seen = new Uint8Array(width * height);
  for (let i = 0; i < free.length; i++) {
    const n = i * 4;
    free[i] =
      rgba[n] * 0.299 + rgba[n + 1] * 0.587 + rgba[n + 2] * 0.114 > 175 &&
      rgba[n + 3] > 100
        ? 1
        : 0;
  }
  const components = [];
  const stack = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      let start = y * width + x;
      if (!free[start] || seen[start]) continue;
      seen[start] = 1;
      stack.push(start);
      let size = 0,
        minX = x,
        maxX = x,
        minY = y,
        maxY = y,
        touches = false;
      while (stack.length) {
        let i = stack.pop(),
          px = i % width,
          py = Math.floor(i / width);
        size++;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        if (px < 2 || py < 2 || px >= width - 2 || py >= height - 2)
          touches = true;
        for (const q of [i - 1, i + 1, i - width, i + width])
          if (
            q >= 0 &&
            q < free.length &&
            free[q] &&
            !seen[q] &&
            Math.abs((q % width) - px) +
              Math.abs(Math.floor(q / width) - py) ===
              1
          ) {
            seen[q] = 1;
            stack.push(q);
          }
      }
      const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
      if (!touches && size > 100 && boxArea > 250 && size / boxArea > 0.43)
        components.push({ minX, maxX, minY, maxY, size });
    }
  components.sort((a, b) => b.size - a.size);
  const scale = Number(metresWide) / width;
  return components
    .slice(0, 80)
    .filter((c) => {
      const roomWidthM = (c.maxX - c.minX) * scale;
      const roomDepthM = (c.maxY - c.minY) * scale;
      return roomWidthM >= 1 && roomDepthM >= 1 && roomWidthM * roomDepthM >= 2;
    })
    .map((c, i) => ({
      id: crypto.randomUUID(),
      name: `Detected room ${i + 1}`,
      shape: "rectangle",
      x: +(c.minX * scale).toFixed(2),
      z: +(c.minY * scale).toFixed(2),
      width: +((c.maxX - c.minX) * scale).toFixed(2),
      depth: +((c.maxY - c.minY) * scale).toFixed(2),
      height: 3,
      material: "drywall",
    }));
}
