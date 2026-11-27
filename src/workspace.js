// Wi-Fi and Cellular are separate workspaces. Every project belongs to one of
// them; the license decides which workspaces exist on this computer. With
// one licensed module the app opens straight into it; with both it asks once
// per app session (switchable from the projects page header).
import { useEffect, useState } from "react";
import { licensedFeatures } from "./services/cellular.js";

export const WORKSPACES = {
  wifi: { id: "wifi", label: "Wi-Fi", hint: "Access points, Wi-Fi coverage, capacity and cabling" },
  cellular: { id: "cellular", label: "Cellular", hint: "IBS / DAS antennas, carriers and RSRP / SINR" },
};
const ORDER = ["wifi", "cellular"];
const STORAGE_KEY = "indoorPlanner.workspace";

// The workspace of a project: the type saved when it was created, else (older
// projects) cellular only when it has cellular antennas and no Wi-Fi AP.
// Works on a full plan or on a project-list row (which carries the counts).
export function workspaceOf(item) {
  const type = item?.projectType;
  if (type === "wifi" || type === "cellular") return type;
  const sources = item?.sources;
  const wifi = sources ? sources.filter((s) => s.kind !== "cellular" && s.kind !== "das").length : item?.wifiCount || 0;
  const cellular = sources ? sources.filter((s) => s.kind === "cellular").length : item?.cellularCount || 0;
  return cellular > 0 && wifi === 0 ? "cellular" : "wifi";
}

function stored() {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// { ready, licensed: ["wifi", ...], workspace: "wifi" | "cellular" | null, choose }
// workspace is null only while both are licensed and none is chosen yet.
export function useWorkspace() {
  const [licensed, setLicensed] = useState(null);
  const [chosen, setChosen] = useState(stored);
  useEffect(() => {
    let off = false;
    licensedFeatures().then((features) => {
      if (off) return;
      const list = ORDER.filter((id) => features.includes(id));
      // no readable feature list (e.g. status unreachable): Wi-Fi, as an old license
      setLicensed(list.length ? list : ["wifi"]);
    });
    return () => {
      off = true;
    };
  }, []);
  const choose = (id) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      // private mode: the choice lasts until the page reloads
    }
    setChosen(id);
  };
  const workspace = !licensed
    ? null
    : licensed.length === 1
      ? licensed[0]
      : licensed.includes(chosen)
        ? chosen
        : null;
  return { ready: Boolean(licensed), licensed: licensed || [], workspace, choose };
}
