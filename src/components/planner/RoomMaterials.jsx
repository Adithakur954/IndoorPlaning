import React from "react";
import Field from "../ui/Field.jsx";

export default RoomMaterials;

function RoomMaterials({ room, plan, mutate }) {
  if (room.shape !== "rectangle") return null;
  return (
    <div className="room-materials">
      <h4>Exterior wall materials</h4>
      {["north", "east", "south", "west"].map((side) => (
        <Field
          key={side}
          label={side}
          value={
            plan.wallTypes[`${room.id}:${side}`] || room.material || "drywall"
          }
          options={["drywall", "wood", "glass", "brick", "concrete", "metal"]}
          onChange={(value) =>
            mutate((p) => ({
              ...p,
              wallTypes: { ...p.wallTypes, [`${room.id}:${side}`]: value },
            }))
          }
        />
      ))}
    </div>
  );
}
