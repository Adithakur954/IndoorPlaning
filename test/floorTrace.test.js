import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTrace,
  traceFloorImage,
} from "../server/services/floorTrace.js";

test("AI trace coordinates become bounded, editable plan objects", () => {
  const trace = normalizeTrace(
    {
      rooms: [
        { name: "Meeting room", x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      ],
      walls: [{ x1: 0, y1: 0, x2: 1.1, y2: 0 }],
      furniture: [
        { name: "Desk group", x: 0.8, y: 0.7, width: 0.4, height: 0.4 },
      ],
    },
    40,
    20,
    "floor-1",
  );
  assert.deepEqual(
    [
      trace.rooms[0].x,
      trace.rooms[0].z,
      trace.rooms[0].width,
      trace.rooms[0].depth,
    ],
    [4, 4, 12, 8],
  );
  assert.deepEqual(
    [
      trace.furniture[0].x,
      trace.furniture[0].z,
      trace.furniture[0].width,
      trace.furniture[0].depth,
    ],
    [32, 14, 8, 6],
  );
  assert.equal(trace.walls[0].x2, 40);
  assert.equal(trace.rooms[0].floorId, "floor-1");
});

test("vision request sends the image to Responses and reads structured geometry", async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  try {
    const traced = await traceFloorImage(
      {
        imageUrl: "data:image/png;base64,AAAA",
        widthM: 20,
        heightM: 10,
        floorId: "level-1",
      },
      async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.input[0].content[1].type, "input_image");
        assert.equal(request.text.format.type, "json_schema");
        assert.equal(request.store, false);
        return {
          ok: true,
          json: async () => ({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      rooms: [
                        {
                          name: "Office",
                          x: 0.2,
                          y: 0.2,
                          width: 0.4,
                          height: 0.4,
                        },
                      ],
                      walls: [],
                      furniture: [],
                    }),
                  },
                ],
              },
            ],
          }),
        };
      },
    );
    assert.equal(traced.rooms[0].width, 8);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});
