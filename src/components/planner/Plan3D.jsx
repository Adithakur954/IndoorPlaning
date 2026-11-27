import { looseWallPieces } from "../../utils/wallPieces.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Html,
  Line,
  OrbitControls,
  Grid,
} from "@react-three/drei";
import * as THREE from "three";
import {
  pointsOf,
  bbox,
  boundaryAreas,
  edgeMeasures,
  formatMetres,
} from "../../utils/geometry.js";
import { buildWalls } from "../../utils/wallGraph.js";
import { materialColors } from "../../config/materialColors.js";
import { Heatmap3D } from "./SmoothHeatmap.jsx";
import { CameraRig, NavControls, navKeyHandler } from "./Nav3D.jsx";
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
  // one shared material per wall material (not one per wall piece)
  const materials = useMemo(() => {
    const out = {};
    for (const wall of walls) {
      const key = materialColors[wall.material] ? wall.material : "drywall";
      out[key] ||= new THREE.MeshStandardMaterial({
        color: materialColors[key] || materialColors.drywall,
        transparent: true,
        opacity: key === "glass" ? 0.35 : 0.72,
      });
    }
    return out;
  }, [walls]);
  useEffect(
    () => () => Object.values(materials).forEach((m) => m.dispose()),
    [materials],
  );
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
              material={
                materials[
                  materialColors[wall.material] ? wall.material : "drywall"
                ]
              }
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
            </mesh>
          );
        }),
      )}
    </group>
  );
}
// Edge lengths just above the wall tops, and each room's width x depth
// under its name.
function Measurements3D({ plan, floorId, rooms, walls, shown }) {
  const labels = [];
  const add = (key, x, y, z, text, kind = "") =>
    labels.push({ key, position: [x, y, z], text, kind });
  if (shown("rooms"))
    for (const r of rooms) {
      const h = Number(r.height) || 3;
      const b = bbox(r);
      add(
        `size-${r.id}`,
        (b.minX + b.maxX) / 2,
        h + 0.05,
        (b.minZ + b.maxZ) / 2,
        r.shape === "circle"
          ? `Ø ${formatMetres(b.maxX - b.minX)}`
          : `${(b.maxX - b.minX).toFixed(2)} × ${formatMetres(b.maxZ - b.minZ)}`,
        "size",
      );
      if (r.shape === "circle") continue;
      for (const m of edgeMeasures(pointsOf(r)))
        add(
          `e-${r.id}-${m.index}`,
          m.mid.x + m.inward.x * 0.35,
          h + 0.15,
          m.mid.z + m.inward.z * 0.35,
          formatMetres(m.length),
        );
    }
  if (shown("boundary"))
    for (const b of (plan.boundaries || []).filter(
      (x) => x.floorId === floorId && x.points?.length >= 3,
    )) {
      const h = Number(b.height) || 3;
      for (const m of edgeMeasures(b.points))
        add(
          `b-${b.id}-${m.index}`,
          m.mid.x - m.inward.x * 0.5,
          h + 0.15,
          m.mid.z - m.inward.z * 0.5,
          formatMetres(m.length),
          "boundary",
        );
    }
  if (shown("walls"))
    for (const w of walls) {
      const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
      if (len > 1e-6)
        add(`w-${w.id}`, (+w.x1 + +w.x2) / 2, 3.15, (+w.z1 + +w.z2) / 2, formatMetres(len));
    }
  return (
    <group>
      {labels.map((l) => (
        <Html key={l.key} position={l.position} center zIndexRange={[20, 0]}
          className={`measure-3d ${l.kind}`} style={{ pointerEvents: "none" }}>
          {l.text}
        </Html>
      ))}
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
  layer = 0, // 0 = the largest room; rooms inside it get higher numbers and draw over it
}) {
  const group = useRef(),
    drag = useRef(null),
    { raycaster, camera, gl } = useThree();
  // build the extruded floor only when the outline changes, and free the old one
  const outline = JSON.stringify(pointsOf(room));
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    // every outline in the same direction: an outline drawn the other way round (common in imported rooms)
    // made the floor's top face point down, so it was lit grey-white instead of the room colour
    let pts = JSON.parse(outline);
    const twice = pts.reduce((t, p, i) => t + p.x * pts[(i + 1) % pts.length].z - pts[(i + 1) % pts.length].x * p.z, 0);
    if (twice < 0) pts = [...pts].reverse();
    pts.forEach((pt, i) =>
      i ? shape.lineTo(pt.x, pt.z) : shape.moveTo(pt.x, pt.z),
    );
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.08,
      bevelEnabled: false,
    });
    g.rotateX(Math.PI / 2);
    return g;
  }, [outline]);
  useEffect(() => () => geometry.dispose(), [geometry]);
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
      {/* Room floors lie on top of each other (an imported "Floor" with the rooms inside it), all at the same
          height: the depth buffer cannot decide between them and they took turns while the view moved. A room
          inside another (smaller) is pulled forward in the depth test by its layer, so it always draws over the
          room around it; the heatmap is pulled further still (SmoothHeatmap.jsx). */}
      <mesh geometry={geometry} renderOrder={1}>
        <meshStandardMaterial
          color={selected ? "#76cdb7" : "#afdcd1"}
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={2 - Math.min(layer, 20) * 0.5}
          polygonOffsetUnits={2 - Math.min(layer, 20) * 2}
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
// A door or window as a box in its wall gap. Rectangle rooms place it by side (north/east/south/west) and offset;
// rooms with corners (polygons, e.g. imported rooms) by edge number and offset along that edge, turned with
// the edge. (Placing polygon openings by the rectangle rule put them inside other walls, where the see-through
// box fought with the wall's faces and blinked as the view moved.) The box is a centimetre narrower and lower than
// the gap, so its faces never coincide with the wall pieces around it.
function Opening({ item, room, wall, type, onSelect }) {
  if (!room && !wall) return null;
  const off = Number(item.offset || 0),
    w = Number(item.width || 1),
    h = Number(item.height || 2);
  const bottom = type === "door" ? 0 : Number(item.sillHeight || 1);
  let x, z, angle;
  if (wall) {
    // on a loose wall, `offset` from its first end
    const len = Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1) || 1;
    const t = Math.min(len, off + w / 2);
    x = +wall.x1 + ((wall.x2 - wall.x1) * t) / len;
    z = +wall.z1 + ((wall.z2 - wall.z1) * t) / len;
    angle = -Math.atan2(wall.z2 - wall.z1, wall.x2 - wall.x1);
  } else if (room.shape !== "rectangle" && Number.isInteger(item.edgeIndex)) {
    const pts = pointsOf(room);
    const a = pts[item.edgeIndex % pts.length],
      b = pts[(item.edgeIndex + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const t = Math.min(len, off + w / 2);
    x = a.x + ((b.x - a.x) * t) / len;
    z = a.z + ((b.z - a.z) * t) / len;
    angle = -Math.atan2(b.z - a.z, b.x - a.x);
  } else {
    const bb = bbox(room);
    const side = item.wallSide || "north";
    const horizontal = side === "north" || side === "south";
    x = horizontal ? bb.minX + off + w / 2 : side === "west" ? bb.minX : bb.maxX;
    z = horizontal ? (side === "north" ? bb.minZ : bb.maxZ) : bb.minZ + off + w / 2;
    angle = horizontal ? 0 : Math.PI / 2;
  }
  return (
    <mesh
      position={[x, bottom + h / 2, z]}
      rotation={[0, angle, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ type, id: item.id });
      }}
    >
      <boxGeometry args={[Math.max(0.05, w - 0.02), Math.max(0.05, h - 0.02), 0.12]} />
      <meshStandardMaterial
        color={type === "door" ? "#b77938" : "#56a9c7"}
        transparent
        opacity={type === "door" ? 0.9 : 0.45}
        depthWrite={false}
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
  showMeasurements = false,
  cables = null,
  racks = null,
  isStatic = true,
  hiddenLayers = [],
  quality = "high",
  maxAnisotropy = 1,
  navApi,
  compassRef,
}) {
  const shown = (id) => !hiddenLayers.includes(id);
  const rooms = plan.rooms.filter((r) => r.floorId === floorId),
    sources = plan.sources.filter((s) => s.floorId === floorId && s.kind !== "das"),
    walls = plan.interiorWalls.filter((w) => w.floorId === floorId),
    furniture = plan.furniture.filter((f) => f.floorId === floorId);
  // drawing layer of each room floor: largest first (0), smaller ones over it
  const roomLayer = useMemo(() => {
    const areaOfRoom = (r) => {
      const pts = pointsOf(r);
      return Math.abs(pts.reduce((t, q, i) => t + q.x * pts[(i + 1) % pts.length].z - pts[(i + 1) % pts.length].x * q.z, 0)) / 2;
    };
    return new Map([...rooms].sort((x, y) => areaOfRoom(y) - areaOfRoom(x)).map((r, i) => [r.id, i]));
  }, [plan.rooms, floorId]); // eslint-disable-line react-hooks/exhaustive-deps
  const logs = getFloorLogs(plan, floorId);
  const ranges = getMetricRanges(plan, metric);
  const metricColor = (value) => getMetricColor(value, ranges);
  const cells = logGrid
    ? getLogGridCells({ logs, rooms, gridSize, aggregation, metric, ranges })
    : [];
  // Stable inputs for the heatmap: a fresh array would rebuild the whole image
  // (and upload a new GPU texture) on every render.
  const heatAreas = useMemo(
    () => [
      ...plan.rooms.filter((r) => r.floorId === floorId),
      ...boundaryAreas(plan, floorId),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.rooms, plan.boundaries, floorId],
  );
  // Floor extent, for "fit to view".
  const fitBox = useMemo(() => {
    let box = null;
    for (const area of heatAreas) {
      const b = bbox(area);
      if (![b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite)) continue;
      box = box
        ? {
            minX: Math.min(box.minX, b.minX),
            maxX: Math.max(box.maxX, b.maxX),
            minZ: Math.min(box.minZ, b.minZ),
            maxZ: Math.max(box.maxZ, b.maxZ),
          }
        : { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
    }
    return box;
  }, [heatAreas]);
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
          rooms={heatAreas}
          opacity={heatmapOpacity}
          ranges={predictions[0]?.ranges}
          pxPerM={quality === "low" ? 10 : undefined}
          maxAnisotropy={maxAnisotropy}
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
          layer={roomLayer.get(r.id) || 0}
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
            wall={d.wallId ? walls.find((w) => w.id === d.wallId) : null}
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
            wall={w.wallId ? walls.find((x) => x.id === w.wallId) : null}
            type="window"
            onSelect={onSelect}
          />
        ))}
      {walls.map((w) => {
        // solid pieces around the wall's own doors and windows
        const { length: len, pieces } = looseWallPieces(w, plan.doors, plan.windows);
        const ux = len ? (w.x2 - w.x1) / len : 0,
          uz = len ? (w.z2 - w.z1) / len : 0;
        return (
          <group
            key={w.id}
            rotation={[0, 0, 0]}
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ type: "wall", id: w.id });
            }}
          >
            {pieces.map((piece) => {
              const mid = (piece.from + piece.to) / 2;
              return (
                <mesh
                  key={piece.key}
                  position={[+w.x1 + ux * mid, (piece.bottom + piece.top) / 2, +w.z1 + uz * mid]}
                  rotation={[0, -Math.atan2(w.z2 - w.z1, w.x2 - w.x1), 0]}
                >
                  <boxGeometry args={[piece.to - piece.from, piece.top - piece.bottom, 0.1]} />
                  <meshStandardMaterial color="#6f8584" transparent opacity={0.65} />
                </mesh>
              );
            })}
          </group>
        );
      })}
      {shown("walls") && (
        <Walls3D plan={plan} floorId={floorId} tool={tool} onSelect={onSelect} />
      )}
      {showMeasurements && (
        <Measurements3D plan={plan} floorId={floorId} rooms={rooms} walls={walls} shown={shown} />
      )}
      {cables && (
        <group>
          {cables.runs.flatMap((run) =>
            run.paths
              .filter((p) => p.floorId === floorId && p.points.length > 1)
              .map((p, i) => {
                const apSource = sources.find((s) => s.id === run.apId);
                const top = 2.7;
                const a = p.points[0];
                const b = p.points[p.points.length - 1];
                const pts = [
                  ...(apSource ? [[a.x, Number(apSource.heightM || 2.5), a.z]] : []),
                  ...p.points.map((q) => [q.x, top, q.z]),
                  [b.x, 2, b.z],
                ];
                const colour = run.check === "ok" ? "#1f8a4c" : run.check === "near limit" ? "#d98200" : "#c0392b";
                return (
                  <Line key={`c3-${run.apId}-${i}`} points={pts} color={colour} lineWidth={2}
                    dashed={run.pathwayStatus === "estimated"} dashSize={0.3} gapSize={0.15} />
                );
              }),
          )}
          {(racks || []).filter((r) => r.floorId === floorId).map((r) => (
            <mesh key={`r3-${r.id}`} position={[r.x, 1, r.z]}>
              <boxGeometry args={[0.6, 2, 0.6]} />
              <meshStandardMaterial color="#1d4ed8" />
            </mesh>
          ))}
        </group>
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
      {/* no "regress": lowering the resolution while the view moves resized the drawing surface, which the
          browser clears, so the picture blinked white / low-resolution during every rotation */}
      <OrbitControls
        makeDefault
        minDistance={1}
        maxDistance={2000}
        maxPolarAngle={Math.PI / 2.05}
      />
      <CameraRig
        apiRef={navApi}
        compassRef={compassRef}
        box={fitBox}
        fitKey={`${floorId}|${fitBox ? 1 : 0}`}
      />
    </>
  );
}
// Renderer names that mean WebGL is running on the CPU (no usable GPU).
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render|software/i;

class WebGLBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="plan3d-fallback">
        The 3D view could not start because WebGL is turned off on this device
        or browser. Use the 2D view, or turn on hardware acceleration in the
        browser settings.
      </div>
    ) : (
      this.props.children
    );
  }
}

export default function Plan3D(props) {
  const navApi = useRef(null),
    compassRef = useRef(null);
  // "high" on a GPU; "low" when WebGL falls back to software (CPU) rendering
  const [quality, setQuality] = useState("high");
  const [maxAnisotropy, setMaxAnisotropy] = useState(1);
  const onKeyDown = useMemo(() => navKeyHandler(navApi), []);
  return (
    <div
      className="plan3d"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="3D view. Arrow keys pan, Shift+arrows rotate and tilt, + and - zoom, N faces north, F fits the floor."
    >
      <WebGLBoundary>
        <Canvas
          frameloop="demand"
          // one fixed resolution: it never changes while the view moves (no blinking)
          dpr={quality === "low" ? 1 : Math.min(1.75, Math.max(1, window.devicePixelRatio || 1))}
          camera={{ position: [17, 23, 28], fov: 45, near: 0.1, far: 5000 }}
          gl={{
            // ask for the discrete GPU; the browser falls back to software
            // (CPU) WebGL by itself when there is none
            powerPreference: "high-performance",
            antialias: quality !== "low",
            // kept so the plot export can read the canvas
            preserveDrawingBuffer: true,
          }}
          onCreated={({ gl }) => {
            const ctx = gl.getContext();
            const info = ctx.getExtension("WEBGL_debug_renderer_info");
            const name = info
              ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL)
              : ctx.getParameter(ctx.RENDERER);
            if (SOFTWARE_RENDERER.test(String(name))) setQuality("low");
            else
              setMaxAnisotropy(Math.min(8, gl.capabilities.getMaxAnisotropy()));
          }}
        >
          <Scene
            {...props}
            quality={quality}
            maxAnisotropy={maxAnisotropy}
            navApi={navApi}
            compassRef={compassRef}
          />
        </Canvas>
        <NavControls apiRef={navApi} compassRef={compassRef} />
        {quality === "low" && (
          <div
            className="plan3d-badge"
            title="No GPU is available to the browser, so the 3D view runs on the CPU at reduced quality."
          >
            CPU rendering
          </div>
        )}
      </WebGLBoundary>
    </div>
  );
}
