import { api } from "./api.js";

export function traceFloorImage(image, floorId) {
  return api("/floor-image/trace", {
    method: "POST",
    body: JSON.stringify({
      imageUrl: image.url,
      widthM: image.widthM,
      heightM: image.heightM,
      floorId,
    }),
  });
}
