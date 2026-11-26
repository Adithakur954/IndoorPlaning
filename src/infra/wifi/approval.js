// How far a design can be trusted, from what a person has confirmed.
//
//   preliminary         the default: something rests on an assumption
//   validated           ceiling and walls stated, no route is an estimate, drawn
//                       trays and racks confirmed, and the person has checked the
//                       plan dimensions and the pathways on site
//   construction-ready  also every route confirmed and the equipment verified
//
// This tool plans; it does not certify an installation. The last level only means
// the person has marked every check as done.
import { pathwayStated, withDefaults } from "../core/pathway.js";

export function approvalSummary({ runs = [], racks = [], pathway = {} }) {
  const p = withDefaults(pathway);
  const has = runs.length > 0;
  const checks = [
    { id: "ceiling", label: "Ceiling and wall access stated", ok: pathwayStated(pathway) },
    { id: "noEstimates", label: "No route rests on an unconfirmed assumption", ok: has && runs.every((r) => r.pathwayStatus !== "estimated") },
    { id: "trays", label: "Every drawn tray confirmed on site", ok: p.trays.every((t) => t.status === "confirmed") },
    { id: "racks", label: "Every rack confirmed (not only suggested)", ok: racks.every((r) => !r.suggested) },
    { id: "dimensions", label: "Plan dimensions verified on site", ok: p.verification.dimensions },
    { id: "pathways", label: "Cable pathways verified on site", ok: p.verification.pathways },
    { id: "routes", label: "Every route confirmed by a person", ok: has && runs.every((r) => r.pathwayStatus === "confirmed") },
    { id: "equipment", label: "Equipment and parts verified", ok: p.verification.equipment },
  ];
  const ok = Object.fromEntries(checks.map((c) => [c.id, c.ok]));
  const validated = ok.ceiling && ok.noEstimates && ok.trays && ok.racks && ok.dimensions && ok.pathways;
  const level = validated && ok.routes && ok.equipment ? "construction-ready" : validated ? "validated" : "preliminary";
  const count = (status) => runs.filter((r) => r.pathwayStatus === status).length;
  return {
    level,
    checks,
    missing: checks.filter((c) => !c.ok).map((c) => c.label),
    routes: { total: runs.length, estimated: count("estimated"), stated: count("stated"), confirmed: count("confirmed") },
  };
}

export const STATUS_TEXT = {
  preliminary: "preliminary estimate - lengths come from the plan geometry and are unverified on site",
  validated: "validated design - ceiling, routes, trays and racks are confirmed; equipment and parts are still to be verified",
  "construction-ready": "marked construction-ready by the user (every check is confirmed). This tool plans and does not certify an installation",
};
