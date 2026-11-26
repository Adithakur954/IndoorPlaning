import React, { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// Map-style navigation for the 3D view: a camera rig that lives inside the
// <Canvas> and exposes smooth zoom / rotate / tilt / pan / fit moves, and a
// "move" control (bottom-left, like a web map) that drives it from the DOM.
//
// Plan north is -Z (the "north" wall side is minZ). Orbit angles follow
// THREE.Spherical: theta = azimuth around +Y (0 = camera south of the target
// looking north), phi = angle from straight down (0 = top view).

const TOP_PHI = 0.0001; // straight down, but not degenerate
const DEFAULT_PHI = 0.85; // ~49 deg from vertical: the usual oblique view
const DURATION = 380; // ms per animated move
const ease = (t) => 1 - Math.pow(1 - t, 3);
const TWO_PI = Math.PI * 2;
// shortest signed angle from a to b
const angleDelta = (a, b) => {
  const d = (((b - a) % TWO_PI) + TWO_PI) % TWO_PI;
  return d > Math.PI ? d - TWO_PI : d;
};

function readPose(camera, controls) {
  const target = controls.target.clone();
  const s = new THREE.Spherical().setFromVector3(
    camera.position.clone().sub(target),
  );
  return { target, radius: s.radius, theta: s.theta, phi: s.phi };
}

export function CameraRig({ apiRef, compassRef, box, fitKey }) {
  const { camera, controls, invalidate, size } = useThree();
  const anim = useRef(null);

  const apply = (pose) => {
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(pose.radius, pose.phi, pose.theta),
    );
    controls.target.copy(pose.target);
    camera.position.copy(pose.target).add(offset);
    camera.lookAt(pose.target);
    controls.update();
  };

  // Start an animated move to `goal` (any subset of the pose).
  const go = (goal, duration = DURATION) => {
    if (!controls) return;
    const from = readPose(camera, controls);
    const to = {
      target: goal.target ? goal.target.clone() : from.target.clone(),
      radius: THREE.MathUtils.clamp(
        goal.radius ?? from.radius,
        controls.minDistance || 0.5,
        controls.maxDistance === Infinity ? 5000 : controls.maxDistance,
      ),
      // keep theta continuous so we rotate the short way round
      theta:
        goal.theta == null
          ? from.theta
          : from.theta + angleDelta(from.theta, goal.theta),
      phi: THREE.MathUtils.clamp(
        goal.phi ?? from.phi,
        TOP_PHI,
        controls.maxPolarAngle,
      ),
    };
    if (duration <= 0) {
      if (anim.current) controls.enableDamping = anim.current.damping;
      anim.current = null;
      apply(to);
      invalidate();
      return;
    }
    // damping would keep nudging the camera after our move; pause it
    if (anim.current == null) anim.current = { damping: controls.enableDamping };
    controls.enableDamping = false;
    anim.current = { ...anim.current, from, to, t0: performance.now(), duration };
    invalidate();
  };

  useFrame(() => {
    const a = anim.current;
    if (!a?.to || !controls) return;
    const k = ease(Math.min(1, (performance.now() - a.t0) / a.duration));
    apply({
      target: a.from.target.clone().lerp(a.to.target, k),
      radius: a.from.radius + (a.to.radius - a.from.radius) * k,
      theta: a.from.theta + (a.to.theta - a.from.theta) * k,
      phi: a.from.phi + (a.to.phi - a.from.phi) * k,
    });
    if (k < 1) invalidate();
    else {
      controls.enableDamping = a.damping;
      anim.current = null;
    }
  });

  const fitPose = () => {
    if (!box) return null;
    const w = Math.max(1, box.maxX - box.minX),
      d = Math.max(1, box.maxZ - box.minZ);
    const vfov = THREE.MathUtils.degToRad(camera.fov || 45);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (size.width / Math.max(1, size.height)));
    const radius =
      1.15 *
      Math.max(w / 2 / Math.tan(hfov / 2), d / 2 / Math.tan(vfov / 2)) +
      3;
    return {
      target: new THREE.Vector3((box.minX + box.maxX) / 2, 0, (box.minZ + box.maxZ) / 2),
      radius,
      theta: 0,
      phi: DEFAULT_PHI,
    };
  };

  // Frame the floor when the view opens or the floor changes.
  useEffect(() => {
    if (!controls) return;
    const pose = fitPose();
    if (pose) go(pose, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, fitKey]);

  // Keep the compass (heading + tilt) in sync with the camera, without
  // re-rendering React.
  useEffect(() => {
    if (!controls || !compassRef) return;
    const sync = () => {
      const el = compassRef.current;
      if (!el) return;
      const { theta, phi } = readPose(camera, controls);
      const heading = Math.round(((-THREE.MathUtils.radToDeg(theta) % 360) + 360) % 360);
      const tilt = Math.round(THREE.MathUtils.radToDeg(phi));
      el.querySelector("svg").style.transform = `rotate(${theta}rad)`;
      el.title = `Facing ${heading}° from north, tilted ${tilt}° from top view. Click to face north.`;
    };
    sync();
    controls.addEventListener("change", sync);
    return () => controls.removeEventListener("change", sync);
  }, [controls, camera, compassRef]);

  // The API the DOM controls call.
  useEffect(() => {
    if (!controls) return;
    apiRef.current = {
      zoom: (factor) => go({ radius: readPose(camera, controls).radius * factor }),
      rotate: (deg) =>
        go({ theta: readPose(camera, controls).theta + THREE.MathUtils.degToRad(deg) }),
      tilt: (deg) =>
        go({ phi: readPose(camera, controls).phi + THREE.MathUtils.degToRad(deg) }),
      north: () => go({ theta: 0 }),
      fit: () => {
        const pose = fitPose();
        if (pose) go(pose);
      },
      // pan relative to the screen: dx right, dy up, in fractions of the view
      pan: (dx, dy) => {
        const { target, radius, theta } = readPose(camera, controls);
        const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
        const forward = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));
        const step = radius * 0.6;
        go({
          target: target
            .add(right.multiplyScalar(dx * step))
            .add(forward.multiplyScalar(dy * step)),
        }, 220);
      },
    };
    return () => {
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, camera, box, size.width, size.height]);

  return null;
}

const Icon = ({ d, size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICONS = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
  // four-way "move" arrows
  rotL: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  rotR: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  // double chevrons: change the viewing angle (tilt)
  tiltUp: "M7 13l5-5 5 5M7 18l5-5 5 5",
  tiltDown: "M7 6l5 5 5-5M7 11l5 5 5-5",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
};

// Bottom-left "move" control, like a web map: one button that opens pan
// arrows and zoom, plus rotate / tilt around a compass. `apiRef` is filled by <CameraRig>.
export function NavControls({ apiRef, compassRef }) {
  const [open, setOpen] = useState(false);
  const call = (name, ...args) => apiRef.current?.[name]?.(...args);
  // hold to keep moving
  const timer = useRef(null);
  const stop = () => {
    clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const hold = (name, ...args) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      call(name, ...args);
      stop();
      timer.current = setInterval(() => call(name, ...args), 230);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        call(name, ...args);
      }
    },
  });
  const btn = (cls, label, icon, handlers) => (
    <button className={`nav3d-btn ${cls}`} title={label} aria-label={label}
      tabIndex={open ? 0 : -1} {...handlers}>
      <Icon d={icon} />
    </button>
  );
  return (
    <div className={`nav3d${open ? " open" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}>
      <button className="nav3d-btn nav3d-toggle" aria-expanded={open}
        title={open ? "Hide move controls" : "Move the view"}
        aria-label={open ? "Hide move controls" : "Show move controls"}
        onClick={() => setOpen((v) => !v)}>
        <Icon d={ICONS.move} size={20} />
      </button>
      {btn("zin", "Zoom in", ICONS.plus, hold("zoom", 0.8))}
      {btn("left", "Move left", ICONS.left, hold("pan", -0.2, 0))}
      {btn("zout", "Zoom out", ICONS.minus, hold("zoom", 1.25))}
      {btn("up", "Move up", ICONS.up, hold("pan", 0, 0.2))}
      {btn("down", "Move down", ICONS.down, hold("pan", 0, -0.2))}
      {btn("right", "Move right", ICONS.right, hold("pan", 0.2, 0))}
      {btn("rotl", "Rotate left", ICONS.rotL, hold("rotate", -15))}
      {btn("tiltup", "Tilt towards top view", ICONS.tiltUp, hold("tilt", -8))}
      <button ref={compassRef} className="nav3d-btn nav3d-compass"
        aria-label="Face north" tabIndex={open ? 0 : -1}
        onClick={() => call("north")}>
        <svg viewBox="-20 -20 40 40" width="30" height="30" aria-hidden="true">
          <path d="M0 -15 L5 0 L-5 0 Z" fill="#dc2626" />
          <path d="M0 15 L5 0 L-5 0 Z" fill="#9aa0a6" />
          <text y="-16.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="#dc2626">N</text>
        </svg>
      </button>
      {btn("tiltdown", "Tilt towards side view", ICONS.tiltDown, hold("tilt", 8))}
      {btn("rotr", "Rotate right", ICONS.rotR, hold("rotate", 15))}
      {btn("fit", "Fit the floor in view", ICONS.fit, { onClick: () => call("fit") })}
    </div>
  );
}

// Keyboard shortcuts while the 3D view has focus.
export function navKeyHandler(apiRef) {
  return (e) => {
    const api = apiRef.current;
    if (!api || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const k = e.key;
    let handled = true;
    if (k === "+" || k === "=") api.zoom(0.8);
    else if (k === "-" || k === "_") api.zoom(1.25);
    else if (k === "n" || k === "N") api.north();
    else if (k === "f" || k === "F") api.fit();
    else if (k.startsWith("Arrow") && e.shiftKey) {
      if (k === "ArrowLeft") api.rotate(-15);
      else if (k === "ArrowRight") api.rotate(15);
      else if (k === "ArrowUp") api.tilt(-10);
      else api.tilt(10);
    } else if (k === "ArrowLeft") api.pan(-0.25, 0);
    else if (k === "ArrowRight") api.pan(0.25, 0);
    else if (k === "ArrowUp") api.pan(0, 0.25);
    else if (k === "ArrowDown") api.pan(0, -0.25);
    else handled = false;
    if (handled) e.preventDefault();
  };
}
