import React, { useState } from "react";
import {
  AlignmentEditor,
  BuildingAlignmentSetup,
} from "./AlignmentControls.jsx";
import { geographicToLocal } from "../../utils/geographicAlignment.js";

export default function AlignmentPanel({
  plan,
  floorId,
  applyAlignment,
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const rooms = plan.rooms.filter((room) => room.floorId === floorId);
  if (setupOpen)
    return (
      <BuildingAlignmentSetup
        alignment={plan.alignment}
        rooms={rooms}
        onSave={(draft) => {
          applyAlignment(draft);
          setSetupOpen(false);
        }}
        onBack={() => setSetupOpen(false)}
      />
    );
  return (
    <div className="panel-grid">
      <section className="panel">
        <h2>Place the building on Earth</h2>
        <p>
          Choose a local plan anchor and its latitude/longitude, then set the
          rotation. Local +X points east and +Z points north at zero rotation.
          Use Google Maps to find coordinates.
        </p>
        <AlignmentEditor
          alignment={plan.alignment}
          onSave={applyAlignment}
          onOpenSetup={() => setSetupOpen(true)}
        />
        <div className="stat-row">
          <div>
            <strong>
              {plan.logs.filter((l) => l.lat !== undefined).length}
            </strong>
            <small>GPS logs</small>
          </div>
          <div>
            <strong>
              {
                plan.logs.filter(
                  (l) =>
                    l.lat !== undefined && geographicToLocal(l, plan.alignment),
                ).length
              }
            </strong>
            <small>Projected</small>
          </div>
        </div>
      </section>
      <section className="panel">
        <h2>Geographic preview</h2>
        {plan.alignment ? (
          <>
            <div className="geo-preview">
              <iframe
                title="Google Maps building position"
                src={`https://maps.google.com/maps?q=${plan.alignment.lat},${plan.alignment.lng}&z=18&output=embed`}
                referrerPolicy="no-referrer-when-downgrade"
                loading="lazy"
              />
            </div>
            <p>
              Google Maps imagery is provided by Google. The plan projection
              uses local coordinates and the saved anchor and rotation.
            </p>
          </>
        ) : (
          <div className="empty small">
            Save an alignment to preview the location.
          </div>
        )}
      </section>
    </div>
  );
}
