import {
  parseBuildingWorkbook,
  parseLogsWorkbook,
  parseLogsCsv,
  createReviewedDetectedWorkbook,
  downloadWorkbook,
} from "../utils/excelPlan.js";
import { parseIndoorLogZip } from "../utils/indoorZip.js";
import { detectRooms } from "../utils/imageDetection.js";
import { createStoryBuildingTemplateWorkbook } from "../templates/buildingTemplate.js";

const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());

export async function readBuilding(file) {
  const parsed = await parseBuildingWorkbook(await fileBytes(file));
  if (parsed.error) throw Error(parsed.error);
  const floors = [
    ...new Map(
      parsed.rooms.map((room) => [
        room.floorId,
        {
          id: room.floorId,
          name: room.floorName || room.floorId,
          elevation: 0,
        },
      ]),
    ).values(),
  ];
  return { ...parsed, floors };
}

export async function readLogs(file, floorId, alignment) {
  const extension = file.name.split(".").pop().toLowerCase();
  const parsed =
    extension === "zip"
      ? await parseIndoorLogZip(await fileBytes(file), floorId, alignment)
      : extension === "csv"
        ? parseLogsCsv(await file.text(), null, floorId, alignment)
        : await parseLogsWorkbook(
            await fileBytes(file),
            null,
            floorId,
            alignment,
          );
  if (parsed.error) throw Error(parsed.error);
  return parsed;
}

export async function readFloorImage(file, widthM, floorId) {
  if (file.size > 8 * 1024 * 1024) throw Error("Image must be under 8 MB");
  const rawUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = rawUrl;
  await image.decode();
  const pixelsWide = Math.min(1600, image.naturalWidth);
  const pixelsHigh = Math.round(
    (image.naturalHeight * pixelsWide) / image.naturalWidth,
  );
  const canvas = document.createElement("canvas");
  canvas.width = pixelsWide;
  canvas.height = pixelsHigh;
  canvas.getContext("2d").drawImage(image, 0, 0, pixelsWide, pixelsHigh);
  const url = canvas.toDataURL("image/webp", 0.84);
  const imageData = {
    url,
    widthM,
    heightM: (widthM * image.naturalHeight) / image.naturalWidth,
    fileName: file.name,
  };
  const rooms = (await detectRooms(url, widthM)).map((room) => ({
    ...room,
    floorId,
  }));
  return { imageData, rooms };
}

export async function downloadReviewedRooms(
  rooms,
  projectName,
  wallThickness,
  floor,
  interiorWalls = [],
  furniture = [],
) {
  const workbook = await createReviewedDetectedWorkbook(
    { rooms, interiorWalls, furniture, siteName: projectName, wallThickness },
    floor,
  );
  await downloadWorkbook(workbook, "reviewed_floor_plan.xlsx");
}

export async function downloadBuildingTemplate() {
  await downloadWorkbook(
    await createStoryBuildingTemplateWorkbook(3),
    "building_template.xlsx",
  );
}
