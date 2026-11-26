import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import { heatmapCanvas } from "../../utils/heatmapImage.js";

const OPACITY = 0.7;

// Callers must pass stable `cells`, `rooms` and `ranges` (memoised), or the
// image is rebuilt on every render.
function useHeatmap(cells, rooms, ranges, pxPerM) {
  return useMemo(
    () =>
      cells.length && ranges?.length
        ? heatmapCanvas(cells, rooms, ranges, pxPerM)
        : null,
    [cells, rooms, ranges, pxPerM],
  );
}

export function Heatmap2D({ cells, rooms, ranges, opacity = OPACITY }) {
  const heat = useHeatmap(cells, rooms, ranges);
  const url = useMemo(() => heat?.canvas.toDataURL(), [heat]);
  if (!heat) return null;
  return (
    <image
      href={url}
      x={heat.x}
      y={heat.z}
      width={heat.widthM}
      height={heat.heightM}
      opacity={opacity}
      preserveAspectRatio="none"
      pointerEvents="none"
    />
  );
}

export function Heatmap3D({
  cells,
  rooms,
  ranges,
  y = 0.015,
  opacity = OPACITY,
  pxPerM,
  maxAnisotropy = 1,
}) {
  const heat = useHeatmap(cells, rooms, ranges, pxPerM);
  const texture = useMemo(() => {
    if (!heat) return null;
    const t = new THREE.CanvasTexture(heat.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAnisotropy; // keeps the map sharp at grazing angles
    return t;
  }, [heat, maxAnisotropy]);
  // Free the GPU copy when the map is replaced or removed.
  useEffect(() => () => texture?.dispose(), [texture]);
  if (!heat) return null;
  return (
    // Drawn after the floors and pulled towards the camera in the depth test (polygon offset): it lies only
    // 1.5 cm above the room floors, and on a large building seen from far away the depth buffer cannot tell 1.5 cm
    // apart, so without this the floor and the map took turns at every pixel while the view moved (flicker).
    // The offset scales with the depth precision itself, so it works at any distance; walls still hide it.
    <mesh
      position={[heat.x + heat.widthM / 2, y, heat.z + heat.heightM / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={2}
    >
      <planeGeometry args={[heat.widthM, heat.heightM]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-16}
        polygonOffsetUnits={-64}
      />
    </mesh>
  );
}
