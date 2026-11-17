import React from "react";
import Field from "../ui/Field.jsx";
import { setSideMaterial, sideSharedWith } from "../../utils/wallMerge.js";

export default RoomMaterials;

function RoomMaterials({ room, plan, mutate }) {
  if (room.shape !== "rectangle") return null;
  return (
    <div className="room-materials">
      <h4>Wall materials</h4>
      <small className="hint">
        A wall shared with another room or the boundary is one wall: changing it
        here changes it for both.
      </small>
      {["north", "east", "south", "west"].map((side) => {
        const shared = sideSharedWith(plan, room.id, side);
        return (
        <React.Fragment key={side}>
        <Field
          label={shared.length ? `${side} (shared with ${shared.join(", ")})` : side}
          value={
            plan.wallTypes[`${room.id}:${side}`] || room.material || "drywall"
          }
          options={["drywall", "wood", "glass", "brick", "concrete", "metal"]}
          onChange={(value) =>
            mutate((p) => setSideMaterial(p, room.id, side, value))
          }
        />
        </React.Fragment>
        );
      })}
    </div>
  );
}
