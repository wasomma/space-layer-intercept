// Sensor beam: the field-of-view cone projected onto the Earth. Owned by the scene (Phase 2
// follow-up; replaces the unit cone of 4.2 that ended in a flat disc at the target's distance
// and cut through the globe).
//
// createSensorBeam(color) -> { object3d, update(state, origin) }
//   state:  { apex, target, halfAngleDeg, opacity }  apex: the sensor satellite (ECI km);
//           target: the point the beam is centred on (the cone axis runs from apex through it);
//           opacity: the beam level from the simulation (0..1)
//   origin: the camera's ECI position this frame (km)
//
// Every edge ray of the cone is intersected with the sphere R_EARTH + FOOT_ALT_KM, so the
// walls end on the Earth's surface and the footprint is the patch of the sphere inside the
// cone: a polar mesh laid on the curved surface (exact sphere points, not a flat disc) with a
// soft radial glow, outlined by a ring traced on the ground. Rays that would miss the Earth
// (a beam past the limb) stop at their closest approach to it. All points are computed in ECI
// doubles and written origin-relative every frame (floating origin). When the camera is inside
// the cone (the launch and boost close-ups) the whole beam fades out.

import * as THREE from 'three';
import { R_EARTH } from '../shared/constants.js';
import { smoothstep } from '../shared/easing.js';
import { getFadeTexture, getGlowTexture, isVec3, num } from './util.js';

const DEG = Math.PI / 180;
const SEGMENTS = 96; // around the cone
const RINGS = 8; // footprint rings from the centre to the edge
const FOOT_ALT_KM = 3; // footprint height above the sphere (above the land outlines at ~1.9 km)
const SPOT_UV_SPAN = 0.8; // footprint edge at this fraction of the glow texture's radius

// The beam is additive and bloomed: the simulation's level is scaled per part.
const WALL_GAIN = 0.3;
const RING_GAIN = 1.4;
const SPOT_GAIN = 0.45;

export function createSensorBeam(color) {
  const group = new THREE.Group();
  group.name = 'sensor-beam';
  group.visible = false;

  // ---- walls: a fan from the apex (vertex 0) to the rim on the ground
  const wallPos = new Float32Array((1 + SEGMENTS) * 3);
  const wallUv = new Float32Array((1 + SEGMENTS) * 2);
  wallUv[0] = 0.5;
  wallUv[1] = 1; // the fade alpha map is brightest at uv.y = 1, the apex
  for (let i = 0; i < SEGMENTS; i++) {
    wallUv[2 + i * 2] = i / SEGMENTS;
    wallUv[3 + i * 2] = 0;
  }
  const wallIndex = [];
  for (let i = 0; i < SEGMENTS; i++) wallIndex.push(0, 1 + i, 1 + ((i + 1) % SEGMENTS));
  const wallGeom = new THREE.BufferGeometry();
  const wallAttr = new THREE.BufferAttribute(wallPos, 3).setUsage(THREE.DynamicDrawUsage);
  wallGeom.setAttribute('position', wallAttr);
  wallGeom.setAttribute('uv', new THREE.BufferAttribute(wallUv, 2));
  wallGeom.setIndex(wallIndex);
  const wallMat = new THREE.MeshBasicMaterial({
    color,
    alphaMap: getFadeTexture(),
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const walls = new THREE.Mesh(wallGeom, wallMat);
  walls.name = 'sensor-beam-walls';
  walls.frustumCulled = false;
  walls.renderOrder = 4;
  group.add(walls);

  // ---- footprint: polar mesh on the sphere, centre vertex 0, then RINGS rings of SEGMENTS
  const footCount = 1 + RINGS * SEGMENTS;
  const footPos = new Float32Array(footCount * 3);
  const footUv = new Float32Array(footCount * 2);
  footUv[0] = 0.5;
  footUv[1] = 0.5;
  for (let k = 1; k <= RINGS; k++) {
    const rho = (SPOT_UV_SPAN * k) / RINGS;
    for (let i = 0; i < SEGMENTS; i++) {
      const phi = (i / SEGMENTS) * Math.PI * 2;
      const v = 1 + (k - 1) * SEGMENTS + i;
      footUv[v * 2] = 0.5 + 0.5 * rho * Math.cos(phi);
      footUv[v * 2 + 1] = 0.5 + 0.5 * rho * Math.sin(phi);
    }
  }
  const footIndex = [];
  for (let i = 0; i < SEGMENTS; i++) footIndex.push(0, 1 + i, 1 + ((i + 1) % SEGMENTS));
  for (let k = 1; k < RINGS; k++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a = 1 + (k - 1) * SEGMENTS + i;
      const b = 1 + (k - 1) * SEGMENTS + ((i + 1) % SEGMENTS);
      const c = 1 + k * SEGMENTS + i;
      const d = 1 + k * SEGMENTS + ((i + 1) % SEGMENTS);
      footIndex.push(a, c, b, b, c, d);
    }
  }
  const footGeom = new THREE.BufferGeometry();
  const footAttr = new THREE.BufferAttribute(footPos, 3).setUsage(THREE.DynamicDrawUsage);
  footGeom.setAttribute('position', footAttr);
  footGeom.setAttribute('uv', new THREE.BufferAttribute(footUv, 2));
  footGeom.setIndex(footIndex);
  const spotMat = new THREE.MeshBasicMaterial({
    color,
    map: getGlowTexture(),
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const spot = new THREE.Mesh(footGeom, spotMat);
  spot.name = 'sensor-beam-footprint';
  spot.frustumCulled = false;
  spot.renderOrder = 4;
  group.add(spot);

  // ---- outline traced on the ground
  const ringPos = new Float32Array(SEGMENTS * 3);
  const ringGeom = new THREE.BufferGeometry();
  const ringAttr = new THREE.BufferAttribute(ringPos, 3).setUsage(THREE.DynamicDrawUsage);
  ringGeom.setAttribute('position', ringAttr);
  const ringMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const ring = new THREE.LineLoop(ringGeom, ringMat);
  ring.name = 'sensor-beam-outline';
  ring.frustumCulled = false;
  ring.renderOrder = 4;
  group.add(ring);

  // Scratch (doubles).
  const apex = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const hit = new THREE.Vector3();

  /** Distance along unit ray u from apex to the sphere of radius rf (closest approach on a miss). */
  function rayToSphere(u, rf) {
    const b = apex.dot(u);
    const disc = b * b - (apex.lengthSq() - rf * rf);
    if (disc < 0) return Math.max(0, -b);
    return Math.max(0, -b - Math.sqrt(disc));
  }

  /** Direction at angle alpha off the axis, azimuth phi around it, into `dir`. */
  function coneDir(alpha, phi) {
    const s = Math.sin(alpha);
    return dir
      .copy(axis)
      .multiplyScalar(Math.cos(alpha))
      .addScaledVector(e1, s * Math.cos(phi))
      .addScaledVector(e2, s * Math.sin(phi));
  }

  function write(arr, i, p, origin) {
    arr[i * 3] = p.x - origin.x;
    arr[i * 3 + 1] = p.y - origin.y;
    arr[i * 3 + 2] = p.z - origin.z;
  }

  return {
    object3d: group,
    update(state, origin) {
      const opacity = state ? num(state.opacity, 0) : 0;
      const half = (state ? num(state.halfAngleDeg, 8) : 8) * DEG;
      if (!(opacity > 0.001) || !isVec3(state.apex) || !isVec3(state.target) || !isVec3(origin) || !(half > 0)) {
        group.visible = false;
        return;
      }
      apex.set(state.apex.x, state.apex.y, state.apex.z);
      axis.set(state.target.x - apex.x, state.target.y - apex.y, state.target.z - apex.z);
      if (axis.lengthSq() < 1e-12) {
        group.visible = false;
        return;
      }
      axis.normalize();
      e1.set(0, 1, 0);
      if (Math.abs(axis.dot(e1)) > 0.9) e1.set(1, 0, 0);
      e1.addScaledVector(axis, -e1.dot(axis)).normalize();
      e2.crossVectors(axis, e1);

      const rf = R_EARTH + FOOT_ALT_KM;
      const tAxis = rayToSphere(axis, rf);

      // Camera inside the cone, between the apex and the ground: fade the beam out.
      rel.set(origin.x - apex.x, origin.y - apex.y, origin.z - apex.z);
      const along = rel.dot(axis);
      let inside = 1;
      if (along > 0 && along < tAxis * 1.05) {
        const off = Math.acos(Math.min(1, Math.max(-1, along / Math.max(1e-9, rel.length())))) / DEG;
        inside = smoothstep(off, (half / DEG) * 1.05, (half / DEG) * 1.6);
      }
      const level = opacity * inside;
      if (!(level > 0.001)) {
        group.visible = false;
        return;
      }

      // Walls and outline: the rim where each edge ray meets the ground.
      write(wallPos, 0, apex, origin);
      for (let i = 0; i < SEGMENTS; i++) {
        coneDir(half, (i / SEGMENTS) * Math.PI * 2);
        hit.copy(apex).addScaledVector(dir, rayToSphere(dir, rf));
        write(wallPos, 1 + i, hit, origin);
        write(ringPos, i, hit, origin);
        write(footPos, 1 + (RINGS - 1) * SEGMENTS + i, hit, origin);
      }
      // Footprint: centre and inner rings, each point on the sphere.
      hit.copy(apex).addScaledVector(axis, tAxis);
      write(footPos, 0, hit, origin);
      for (let k = 1; k < RINGS; k++) {
        const alpha = (half * k) / RINGS;
        for (let i = 0; i < SEGMENTS; i++) {
          coneDir(alpha, (i / SEGMENTS) * Math.PI * 2);
          hit.copy(apex).addScaledVector(dir, rayToSphere(dir, rf));
          write(footPos, 1 + (k - 1) * SEGMENTS + i, hit, origin);
        }
      }
      wallAttr.needsUpdate = true;
      footAttr.needsUpdate = true;
      ringAttr.needsUpdate = true;

      wallMat.opacity = Math.min(1, opacity * WALL_GAIN) * inside;
      spotMat.opacity = Math.min(1, opacity * SPOT_GAIN) * inside;
      ringMat.opacity = Math.min(1, opacity * RING_GAIN) * inside;
      group.visible = true;
    },
  };
}
