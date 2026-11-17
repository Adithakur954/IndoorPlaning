import React, { useMemo } from "react";
import * as THREE from "three";
import { heatmapCanvas } from "../../utils/heatmapImage.js";

const OPACITY = 0.7;

function useHeatmap(cells, rooms, ranges) {
  return useMemo(
    () =>
      cells.length && ranges?.length
        ? heatmapCanvas(cells, rooms, ranges)
        : null,
    [cells, rooms, ranges],
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

export function Heatmap3D({ cells, rooms, ranges, y = 0.015, opacity = OPACITY }) {
  const heat = useHeatmap(cells, rooms, ranges);
  const texture = useMemo(() => {
    if (!heat) return null;
    const t = new THREE.CanvasTexture(heat.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [heat]);
  if (!heat) return null;
  return (
    <mesh
      position={[heat.x + heat.widthM / 2, y, heat.z + heat.heightM / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[heat.widthM, heat.heightM]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
      />
    </mesh>
  );
}
