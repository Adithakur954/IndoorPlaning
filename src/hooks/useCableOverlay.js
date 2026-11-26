import { useEffect, useMemo, useState } from "react";
import { requestDesign } from "../infra/wifi/designClient.js";
import { mergeCatalogue } from "../infra/wifi/catalogueEdit.js";

// The cabling design for drawing on the editor plan. It only runs while
// "Cables" is switched on, and the result is never saved into the plan.
export default function useCableOverlay(plan, enabled) {
  const [design, setDesign] = useState(null);
  const cabling = plan.cabling;
  const catalogue = useMemo(() => mergeCatalogue(cabling?.catalogue), [cabling?.catalogue]);
  const designPlan = useMemo(
    () => ({
      floors: plan.floors, rooms: plan.rooms, doors: plan.doors, windows: plan.windows,
      interiorWalls: plan.interiorWalls, boundaries: plan.boundaries, furniture: plan.furniture,
      sources: plan.sources, wallTypes: plan.wallTypes,
    }),
    [plan.floors, plan.rooms, plan.doors, plan.windows, plan.interiorWalls, plan.boundaries, plan.furniture, plan.sources, plan.wallTypes],
  );
  useEffect(() => {
    if (!enabled || !cabling?.racks?.length) {
      setDesign(null);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      requestDesign({
        plan: designPlan,
        racks: cabling.racks,
        risers: cabling.risers || [],
        pathway: cabling.pathway,
        rules: cabling.rules,
        catalogue,
      })
        .then((r) => alive && r.design && setDesign(r.design))
        .catch(() => alive && setDesign(null));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, designPlan, cabling]); // eslint-disable-line react-hooks/exhaustive-deps
  return enabled ? design : null;
}
