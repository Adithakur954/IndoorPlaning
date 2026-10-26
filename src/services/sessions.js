import { api } from "./api.js";
import { parseLogRows, parseLogsCsv } from "../utils/excelPlan.js";

export const listSessions = () => api("/sessions");

export async function loadSessions(ids, floorId, alignment) {
  const logs = [];
  for (const id of ids) {
    const response = await api(`/sessions/${encodeURIComponent(id)}`);
    const parsed =
      response.type === "csv"
        ? parseLogsCsv(response.data, null, floorId, alignment)
        : parseLogRows(
            Array.isArray(response.data)
              ? response.data
              : response.data.logs || [],
            floorId,
            alignment,
          );
    if (parsed.error) throw Error(parsed.error);
    logs.push(
      ...parsed.logs.map((log, index) => ({
        ...log,
        id: `${id}-${log.id ?? index}`,
        floorId: log.floorId || floorId,
      })),
    );
  }
  return logs;
}
