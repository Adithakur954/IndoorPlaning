import crypto from "node:crypto";

const boxSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "x", "y", "width", "height"],
  properties: {
    name: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
  },
};
const wallSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x1", "y1", "x2", "y2"],
  properties: Object.fromEntries(
    ["x1", "y1", "x2", "y2"].map((key) => [key, { type: "number" }]),
  ),
};
const traceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rooms", "walls", "furniture"],
  properties: {
    rooms: { type: "array", items: boxSchema },
    walls: { type: "array", items: wallSchema },
    furniture: { type: "array", items: boxSchema },
  },
};

const clamp = (value) => Math.max(0, Math.min(1, Number(value)));
const valid = (...values) => values.every((value) => Number.isFinite(value));
const rounded = (value) => Math.round(value * 100) / 100;

export function normalizeTrace(trace, widthM, heightM, floorId) {
  if (
    !trace ||
    !Array.isArray(trace.rooms) ||
    !Array.isArray(trace.walls) ||
    !Array.isArray(trace.furniture)
  )
    throw Error("Model returned an invalid plan");
  const boxes = (items, type) =>
    items.slice(0, 100).flatMap((box, index) => {
      if (!valid(box.x, box.y, box.width, box.height)) return [];
      const x0 = clamp(box.x),
        z0 = clamp(box.y);
      const x1 = clamp(Number(box.x) + Number(box.width));
      const z1 = clamp(Number(box.y) + Number(box.height));
      if (x1 - x0 < 0.003 || z1 - z0 < 0.003) return [];
      return [
        {
          id: crypto.randomUUID(),
          floorId,
          name: String(
            box.name ||
              (type === "room"
                ? `Space ${index + 1}`
                : `Desk group ${index + 1}`),
          ).slice(0, 80),
          x: rounded(x0 * widthM),
          z: rounded(z0 * heightM),
          width: rounded((x1 - x0) * widthM),
          depth: rounded((z1 - z0) * heightM),
          height: type === "room" ? 3 : 0.8,
          ...(type === "room"
            ? { shape: "rectangle", material: "drywall" }
            : {}),
        },
      ];
    });
  const walls = trace.walls.slice(0, 200).flatMap((wall) => {
    if (!valid(wall.x1, wall.y1, wall.x2, wall.y2)) return [];
    const x1 = rounded(clamp(wall.x1) * widthM),
      z1 = rounded(clamp(wall.y1) * heightM);
    const x2 = rounded(clamp(wall.x2) * widthM),
      z2 = rounded(clamp(wall.y2) * heightM);
    if (Math.hypot(x2 - x1, z2 - z1) < 0.2) return [];
    return [
      {
        id: crypto.randomUUID(),
        floorId,
        name: "Traced wall",
        x1,
        z1,
        x2,
        z2,
        material: "drywall",
      },
    ];
  });
  return {
    rooms: boxes(trace.rooms, "room"),
    walls,
    furniture: boxes(trace.furniture, "furniture"),
  };
}

export async function traceFloorImage(
  { imageUrl, widthM, heightM, floorId },
  fetcher = fetch,
) {
  if (!process.env.OPENAI_API_KEY) {
    const error = Error(
      "Set OPENAI_API_KEY in .env and restart the API to use AI tracing.",
    );
    error.status = 503;
    throw error;
  }
  if (
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
      imageUrl || "",
    ) ||
    imageUrl.length > 12_000_000 ||
    !valid(widthM, heightM) ||
    widthM <= 0 ||
    heightM <= 0 ||
    widthM > 10000 ||
    heightM > 10000 ||
    typeof floorId !== "string" ||
    !floorId ||
    floorId.length > 100
  ) {
    const error = Error("Invalid floor image or dimensions");
    error.status = 400;
    throw error;
  }
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-6-astra",
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Trace this floor-plan drawing into editable geometry. Coordinates must be fractions from 0 to 1 of the whole image (top-left is 0,0; bottom-right is 1,1). For example, x=0.25 means one quarter of the image width from the left. Examine the entire drawing, including small offices and booths along the edges. Return a separate room box for every visibly enclosed office, meeting room, phone booth, utility room, and other bounded space; do not merge neighboring rooms. An open seating area is not one room per desk: represent each visible desk or table cluster as furniture instead. Walls are visible structural or partition lines, including the outer boundary; use a small number of long segments and do not repeat edges already represented by a room rectangle. Ignore labels, dimension lines, columns, arrows, plants, and decorative marks. Keep boxes tight and do not invent obscured geometry. This is an approximate trace for human review.",
            },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "floor_trace",
          strict: true,
          schema: traceSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = Error(
      body.error?.message || `Vision request failed (${response.status})`,
    );
    error.status = 502;
    throw error;
  }
  const body = await response.json();
  const output = body.output
    ?.flatMap((item) => (item.type === "message" ? item.content || [] : []))
    .find((item) => item.type === "output_text")?.text;
  if (body.status !== "completed" || !output)
    throw Error("Model did not return a complete floor trace");
  return normalizeTrace(JSON.parse(output), widthM, heightM, floorId);
}
