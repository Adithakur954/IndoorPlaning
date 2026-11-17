import React, { useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls, Grid } from "@react-three/drei";
import * as THREE from "three";
import { pointsOf, bbox, boundaryAreas } from "../../utils/geometry.js";
import { buildWalls } from "../../utils/wallGraph.js";
import { materialColors } from "../../config/materialColors.js";
import { Heatmap3D } from "./SmoothHeatmap.jsx";
import {
  getFloorLogs,
  getLogGridCells,
  getMetricColor,
  getMetricRanges,
} from "../../utils/logOverlay.js";

// All walls of a floor from the shared wall model: a wall between two rooms (or
// a room and the building shell) is drawn once, with its openings cut out.
function Walls3D({ plan, floorId, tool, onSelect }) {
  const walls = useMemo(
    () => buildWalls(plan, floorId),
    [
      plan.rooms,
      plan.boundaries,
      plan.doors,
      plan.windows,
      plan.wallTypes,
      floorId,
    ],
  );
  const thickness = Math.max(0.01, Number(plan.wallThickness) || 0.2);
  return (
    <group>
      {walls.flatMap((wall, wi) =>
        wall.pieces.map((piece) => {
          const mid = (piece.from + piece.to) / 2,
            ratio = mid / wall.length;
          const owner = wall.owners[0];
          return (
            <mesh
              key={`${wi}-${piece.key}`}
              position={[
                wall.a.x + (wall.b.x - wall.a.x) * ratio,
                (piece.top + piece.bottom) / 2,
                wall.a.z + (wall.b.z - wall.a.z) * ratio,
              ]}
              rotation={[
                0,
                -Math.atan2(wall.b.z - wall.a.z, wall.b.x - wall.a.x),
                0,
              ]}
              onPointerDown={(e) => {
                if (tool !== "select") return;
                e.stopPropagation();
                onSelect({ type: owner.type, id: owner.id });
              }}
            >
              <boxGeometry
                args={[
                  piece.to - piece.from,
                  piece.top - piece.bottom,
                  thickness,
                ]}
              />
              <meshStandardMaterial
                color={materialColors[wall.material] || materialColors.drywall}
                transparent
                opacity={wall.material === "glass" ? 0.35 : 0.72}
              />
            </mesh>
          );
        }),
      )}
    </group>
  );
}
function ShapeRoom({
  room,
  selected,
  onSelect,
  onMove,
  tool,
  onPlace,
  snap,
  doors,
  windows,
  wallTypes,
  showRoomNames,
  isStatic = true,
}) {
  const group = useRef(),
    drag = useRef(null),
    { raycaster, camera, gl } = useThree();
  const p = pointsOf(room),
    shape = new THREE.Shape();
  p.forEach((pt, i) =>
    i ? shape.lineTo(pt.x, pt.z) : shape.moveTo(pt.x, pt.z),
  );
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.08,
    bevelEnabled: false,
  });
  geometry.rotateX(Math.PI / 2);
  const wallHeight = Number(room.height) || 3;
  const move = (e) => {
    if (!drag.current) return;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      hit = new THREE.Vector3();
    raycaster.setFromCamera(e.pointer, camera);
    if (raycaster.ray.intersectPlane(plane, hit)) {
      const x = snap ? Math.round(hit.x * 2) / 2 : hit.x,
        z = snap ? Math.round(hit.z * 2) / 2 : hit.z,
        dx = x - drag.current.x,
        dz = z - drag.current.z;
      if (Math.abs(dx) + Math.abs(dz) > 0.05) {
        onMove("room", room.id, dx, dz);
        drag.current = { x, z };
      }
    }
  };
  return (
    <group
      ref={group}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (tool !== "select") {
          if (!["wall", "polygon", "boundary"].includes(tool))
            onPlace(tool, { x: e.point.x, z: e.point.z });
          return;
        }
        onSelect({ type: "room", id: room.id });
        if (isStatic) return;
        drag.current = {
          x: snap ? Math.round(e.point.x * 2) / 2 : e.point.x,
          z: snap ? Math.round(e.point.z * 2) / 2 : e.point.z,
        };
        gl.domElement.style.cursor = "grabbing";
        e.target.setPointerCapture(e.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        const wasDragging = Boolean(drag.current);
        drag.current = null;
        gl.domElement.style.cursor = "auto";
        if (wasDragging && e.target.hasPointerCapture(e.pointerId))
          e.target.releasePointerCapture(e.pointerId);
      }}
    >
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={selected ? "#76cdb7" : "#afdcd1"}
          side={THREE.DoubleSide}
        />
      </mesh>
      {showRoomNames && (
        <Html
          position={[
            Number(room.x) + Number(room.width) / 2,
            wallHeight + 0.3,
            Number(room.z) + Number(room.depth) / 2,
          ]}
          center
          style={{
            whiteSpace: "nowrap",
            fontSize: 11,
            color: "#183e3a",
            pointerEvents: "none",
          }}
        >
          {room.name}
        </Html>
      )}
    </group>
  );
}
function Draggable({
  type,
  item,
  onSelect,
  onMove,
  children,
  snap,
  tool,
  onPlace,
}) {
  const { raycaster, camera, gl } = useThree(),
    drag = useRef(null);
  return (
    <group
      onPointerDown={(e) => {
        e.stopPropagation();
        if (tool !== "select") {
          if (!["wall", "polygon", "boundary"].includes(tool))
            onPlace(tool, { x: e.point.x, z: e.point.z });
          return;
        }
        onSelect({ type, id: item.id });
        drag.current = {
          x: snap ? Math.round(e.point.x * 2) / 2 : e.point.x,
          z: snap ? Math.round(e.point.z * 2) / 2 : e.point.z,
        };
        gl.domElement.style.cursor = "grabbing";
        e.target.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const hit = new THREE.Vector3();
        raycaster.setFromCamera(e.pointer, camera);
        if (
          raycaster.ray.intersectPlane(
            new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
            hit,
          )
        ) {
          const x = snap ? Math.round(hit.x * 2) / 2 : hit.x,
            z = snap ? Math.round(hit.z * 2) / 2 : hit.z,
            dx = x - drag.current.x,
            dz = z - drag.current.z;
          if (Math.abs(dx) + Math.abs(dz) > 0.05) {
            onMove(type, item.id, dx, dz);
            drag.current = { x, z };
          }
        }
      }}
      onPointerUp={(e) => {
        const wasDragging = Boolean(drag.current);
        drag.current = null;
        gl.domElement.style.cursor = "auto";
        if (wasDragging && e.target.hasPointerCapture(e.pointerId))
          e.target.releasePointerCapture(e.pointerId);
      }}
    >
      {children}
    </group>
  );
}
function Opening({ item, room, type, onSelect }) {
  if (!room) return null;
  const b = bbox(room),
    off = Number(item.offset || 0),
    w = Number(item.width || 1),
    h = Number(item.height || 2);
  const side = item.wallSide || "north";
  const horizontal = side === "north" || side === "south";
  const x = horizontal
    ? b.minX + off + w / 2
    : side === "west"
      ? b.minX
      : b.maxX;
  const z = horizontal
    ? side === "north"
      ? b.minZ
      : b.maxZ
    : b.minZ + off + w / 2;
  return (
    <mesh
      position={[
        x,
        (type === "door" ? 0 : Number(item.sillHeight || 1)) + h / 2,
        z,
      ]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ type, id: item.id });
      }}
    >
      <boxGeometry args={horizontal ? [w, h, 0.12] : [0.12, h, w]} />
      <meshStandardMaterial
        color={type === "door" ? "#b77938" : "#56a9c7"}
        transparent
        opacity={type === "door" ? 0.9 : 0.45}
      />
    </mesh>
  );
}
function Scene({
  plan,
  floorId,
  selected,
  onSelect,
  onMove,
  onPlace,
  tool,
  snap,
  predictions,
  overlay,
  heatmap,
  heatmapOpacity = 0.8,
  logsVisible,
  logGrid,
  metric,
  gridSize,
  aggregation,
  showRoomNames = true,
  showFurnitureNames = true,
  showWifiNames = true,
  isStatic = true,
  hiddenLayers = [],
}) {
  const shown = (id) => !hiddenLayers.includes(id);
  const rooms = plan.rooms.filter((r) => r.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId),
    walls = plan.interiorWalls.filter((w) => w.floorId === floorId),
    furniture = plan.furniture.filter((f) => f.floorId === floorId);
  const logs = getFloorLogs(plan, floorId);
  const ranges = getMetricRanges(plan, metric);
  const metricColor = (value) => getMetricColor(value, ranges);
  const cells = logGrid
    ? getLogGridCells({ logs, rooms, gridSize, aggregation, metric, ranges })
    : [];
  return (
    <>
      <ambientLight intensity={1.5} />
      <directionalLight position={[10, 20, 10]} intensity={2} />
      {shown("grid") && (
      <Grid
        args={[200, 200]}
        cellSize={1}
        sectionSize={5}
        cellColor="#b8ccc8"
        sectionColor="#8daaa4"
        position={[0, -0.06, 0]}
        infiniteGrid
      />
      )}
      <mesh
        position={[0, -0.04, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (tool === "select") onSelect(null);
          else if (!["wall", "polygon", "boundary"].includes(tool))
            onPlace(tool, {
              x: snap ? Math.round(e.point.x * 2) / 2 : e.point.x,
              z: snap ? Math.round(e.point.z * 2) / 2 : e.point.z,
            });
        }}
      >
        <planeGeometry args={[1000, 1000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {heatmap && (
        <Heatmap3D
          cells={predictions}
          rooms={[...rooms, ...boundaryAreas(plan, floorId)]}
          opacity={heatmapOpacity}
          ranges={predictions[0]?.ranges}
        />
      )}
      {logsVisible &&
        (logGrid
          ? cells.map((c) => (
              <mesh
                key={c.id}
                position={[c.x, 0.13, c.z]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                <planeGeometry args={[c.width, c.depth]} />
                <meshBasicMaterial
                  color={c.color}
                  transparent
                  opacity={0.7}
                  depthWrite={false}
                />
              </mesh>
            ))
          : logs.map((l) => (
              <mesh key={l.id} position={[l.x, 0.2, l.z]}>
                <sphereGeometry args={[0.18, 8, 8]} />
                <meshBasicMaterial color={metricColor(l[metric])} />
              </mesh>
            )))}
      {(shown("rooms") ? rooms : []).map((r) => (
        <ShapeRoom
          key={r.id}
          room={r}
          selected={selected?.type === "room" && selected.id === r.id}
          onSelect={onSelect}
          onMove={onMove}
          tool={tool}
          onPlace={onPlace}
          snap={snap}
          doors={plan.doors}
          windows={plan.windows}
          wallTypes={plan.wallTypes}
          showRoomNames={showRoomNames}
          isStatic={isStatic}
        />
      ))}
      {plan.doors
        .filter((d) => d.floorId === floorId)
        .map((d) => (
          <Opening
            key={d.id}
            item={d}
            room={rooms.find((r) => r.id === d.roomId)}
            type="door"
            onSelect={onSelect}
          />
        ))}
      {plan.windows
        .filter((w) => w.floorId === floorId)
        .map((w) => (
          <Opening
            key={w.id}
            item={w}
            room={rooms.find((r) => r.id === w.roomId)}
            type="window"
            onSelect={onSelect}
          />
        ))}
      {walls.map((w) => {
        const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
        return (
          <mesh
            key={w.id}
            position={[(+w.x1 + +w.x2) / 2, 1.5, (+w.z1 + +w.z2) / 2]}
            rotation={[0, -Math.atan2(w.z2 - w.z1, w.x2 - w.x1), 0]}
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ type: "wall", id: w.id });
            }}
          >
            <boxGeometry args={[len, 3, 0.1]} />
            <meshStandardMaterial color="#6f8584" transparent opacity={0.65} />
          </mesh>
        );
      })}
      {shown("walls") && (
        <Walls3D plan={plan} floorId={floorId} tool={tool} onSelect={onSelect} />
      )}
      {overlay?.recommended?.map((r) => (
        <mesh key={r.candidateId} position={[r.planX, r.heightM, r.planZ]}>
          <sphereGeometry args={[0.3, 16, 16]} />
          <meshStandardMaterial
            color="#e8790a"
            emissive="#e8790a"
            emissiveIntensity={0.6}
          />
        </mesh>
      ))}
      {overlay?.candidates?.valid.map((c) => (
        <mesh key={c.id} position={[c.x, c.heightM, c.z]}>
          <sphereGeometry args={[0.08, 8, 8]} />
          <meshBasicMaterial color="#16a34a" />
        </mesh>
      ))}
      {(shown("furniture") ? furniture : []).map((f) => (
        <Draggable
          key={f.id}
          type="furniture"
          item={f}
          onSelect={onSelect}
          onMove={onMove}
          tool={tool}
          onPlace={onPlace}
          snap={snap}
        >
          <mesh
            position={[
              +f.x + f.width / 2,
              Number(f.height || 0.8) / 2,
              +f.z + f.depth / 2,
            ]}
          >
            <boxGeometry args={[f.width, Number(f.height || 0.8), f.depth]} />
            <meshStandardMaterial color="#a88964" />
          </mesh>
          {showFurnitureNames && (
            <Html
              position={[
                +f.x + f.width / 2,
                Number(f.height || 0.8) + 0.15,
                +f.z + f.depth / 2,
              ]}
              center
              style={{
                whiteSpace: "nowrap",
                fontSize: 11,
                color: "#183e3a",
                pointerEvents: "none",
              }}
            >
              {f.name}
            </Html>
          )}
        </Draggable>
      ))}
      {(shown("sources") ? sources : []).map((s) => (
        <Draggable
          key={s.id}
          type="source"
          item={s}
          onSelect={onSelect}
          onMove={onMove}
          tool={tool}
          onPlace={onPlace}
          snap={snap}
        >
          <group position={[s.x, Number(s.heightM || 2), s.z]}>
            <mesh>
              <sphereGeometry args={[0.25, 16, 16]} />
              <meshStandardMaterial
                color={s.kind === "wifi" ? "#7c3aed" : "#0891b2"}
                emissive={s.kind === "wifi" ? "#7c3aed" : "#0891b2"}
                emissiveIntensity={0.5}
              />
            </mesh>
            {(s.kind !== "wifi" || showWifiNames) && (
              <Html
                position={[0, 0.5, 0]}
                center
                style={{
                  whiteSpace: "nowrap",
                  fontSize: 11,
                  color: "#183e3a",
                  pointerEvents: "none",
                }}
              >
                {s.name}
              </Html>
            )}
          </group>
        </Draggable>
      ))}
      <OrbitControls
        makeDefault
        target={[8, 0, 7]}
        maxPolarAngle={Math.PI / 2.05}
      />
    </>
  );
}
export default function Plan3D(props) {
  return (
    <div className="plan3d">
      <Canvas
        camera={{ position: [17, 23, 28], fov: 45 }}
        gl={{ preserveDrawingBuffer: true }}
      >
        <Scene {...props} />
      </Canvas>
    </div>
  );
}
