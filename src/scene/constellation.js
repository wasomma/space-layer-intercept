// Constellation: both shells as fixed-pixel Points markers, small instanced bodies for close
// passes, and orbit rings rebuilt camera-relative each frame.
//
// createConstellation() -> { object3d, update(state, origin, ctx) }
//   state:  states.constellation ({ interceptor: Vector3[], sensor: Vector3[],
//           orbits: { interceptor: [{ raanDeg, incDeg, altKm }], sensor: [...] } })
//   origin: the camera's ECI position this frame (km)
//   ctx:    optional { exclude: Vector3[] } ECI positions drawn by the highlighted satellite
//           actors; shell members within EXCLUDE_KM of one are not drawn here (no doubled
//           marker, no body inside a body).
//
// Markers: one Points cloud per shell, 5 px, sizeAttenuation off, additive. A marker fades out by
// distance (spatial ramp around 60x the body length) so it never sits on top of its own body at a
// close pass. Bodies: 4 m octahedra (interceptor shell) and 4 m boxes (sensor shell), +Z toward
// the Earth's centre. Rings: one LineLoop of RING_SEGMENTS per plane, built from
// circularOrbitState in ECI doubles once per plane and written as (point - origin) every frame.

import * as THREE from 'three';
import { circularOrbitState } from '../sim/kepler.js';
import { R_EARTH } from '../shared/constants.js';
import { smoothstep } from '../shared/easing.js';
import { SAT_DIM, RING } from '../shared/palette.js';
import { getDotTexture, isVec3, num, PX, MARKER_DISTANCE_FACTOR } from './util.js';

const RING_SEGMENTS = 192;
const RING_OPACITY = 0.9;
const MARKER_OPACITY = 0.8;
const BODY_SIZE_KM = 0.004; // 4 m bodies
// Marker spatial fade: 0 inside FADE_NEAR, 1 beyond FADE_FAR (centred on 60x the body length).
const FADE_NEAR_KM = BODY_SIZE_KM * MARKER_DISTANCE_FACTOR * 0.8;
const FADE_FAR_KM = BODY_SIZE_KM * MARKER_DISTANCE_FACTOR * 1.2;
const EXCLUDE_KM = 0.05;
// Rings fade out with the globe overlays in the launch close-up (camera altitude, km): seen from
// the ground they would cross the sky as stray lines.
const RING_HIDE_BELOW_KM = 30;
const RING_SHOW_ABOVE_KM = 45;

const SHELLS = [
  { key: 'interceptor', capacity: 128, body: 'octahedron' },
  { key: 'sensor', capacity: 32, body: 'box' },
];

function createShell({ key, capacity, body }) {
  const group = new THREE.Group();
  group.name = 'constellation-' + key;

  // Bodies.
  const geometry =
    body === 'box'
      ? new THREE.BoxGeometry(BODY_SIZE_KM * 0.75, BODY_SIZE_KM * 0.75, BODY_SIZE_KM)
      : new THREE.OctahedronGeometry(BODY_SIZE_KM / 2, 0);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SAT_DIM,
    emissive: SAT_DIM,
    emissiveIntensity: 0.45,
    roughness: 0.6,
    metalness: 0.2,
    flatShading: true,
  });
  const bodies = new THREE.InstancedMesh(geometry, bodyMat, capacity);
  bodies.name = group.name + '-bodies';
  bodies.count = 0;
  bodies.frustumCulled = false;
  group.add(bodies);

  // Markers.
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const markerGeom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  markerGeom.setAttribute('position', posAttr);
  markerGeom.setAttribute('color', colAttr);
  markerGeom.setDrawRange(0, 0);
  const markers = new THREE.Points(
    markerGeom,
    new THREE.PointsMaterial({
      color: SAT_DIM,
      map: getDotTexture(),
      size: PX.shellMarker,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: MARKER_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  markers.name = group.name + '-markers';
  markers.frustumCulled = false;
  markers.renderOrder = 3;
  group.add(markers);

  // Rings.
  const rings = new THREE.Group();
  rings.name = group.name + '-rings';
  group.add(rings);
  const ringMat = new THREE.LineBasicMaterial({ color: RING, transparent: true, opacity: RING_OPACITY, depthWrite: false });
  /** @type {Array<{ key: string, eci: Float64Array, attr: THREE.BufferAttribute, line: THREE.LineLoop }>} */
  const ringPool = [];

  function ringFor(i, orbit) {
    const alt = num(orbit.altKm, NaN);
    const inc = num(orbit.incDeg, NaN);
    const raan = num(orbit.raanDeg, NaN);
    if (!Number.isFinite(alt) || !Number.isFinite(inc) || !Number.isFinite(raan)) return null;
    const ringKey = `${alt}|${inc}|${raan}`;
    let entry = ringPool[i];
    if (!entry) {
      const attr = new THREE.BufferAttribute(new Float32Array(RING_SEGMENTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', attr);
      const line = new THREE.LineLoop(g, ringMat);
      line.frustumCulled = false;
      line.name = group.name + '-ring-' + i;
      rings.add(line);
      entry = { key: '', eci: new Float64Array(RING_SEGMENTS * 3), attr, line };
      ringPool[i] = entry;
    }
    if (entry.key !== ringKey) {
      // ECI points of the plane, in doubles, computed once per plane.
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const { r } = circularOrbitState(alt, inc, raan, (360 * s) / RING_SEGMENTS);
        entry.eci[s * 3] = r.x;
        entry.eci[s * 3 + 1] = r.y;
        entry.eci[s * 3 + 2] = r.z;
      }
      entry.key = ringKey;
    }
    return entry;
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const zeroScale = new THREE.Vector3(0, 0, 0);
  const p = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const lookM = new THREE.Matrix4();
  const upY = new THREE.Vector3(0, 1, 0);
  const upX = new THREE.Vector3(1, 0, 0);

  function excluded(v, exclude) {
    for (const e of exclude) {
      if (Math.abs(v.x - e.x) < EXCLUDE_KM && Math.abs(v.y - e.y) < EXCLUDE_KM && Math.abs(v.z - e.z) < EXCLUDE_KM) return true;
    }
    return false;
  }

  return {
    group,
    update(points, orbits, origin, exclude) {
      const list = Array.isArray(points) ? points : [];
      // The Earth's centre relative to the camera: bodies point their +Z at it.
      centre.set(-origin.x, -origin.y, -origin.z);
      let n = 0;
      for (let i = 0; i < list.length && n < capacity; i++) {
        const v = list[i];
        if (!isVec3(v)) continue;
        // Origin-relative position, subtracted in doubles.
        p.set(v.x - origin.x, v.y - origin.y, v.z - origin.z);
        const hide = excluded(v, exclude);
        const dist = p.length();
        const fade = hide ? 0 : Math.min(1, Math.max(0, (dist - FADE_NEAR_KM) / (FADE_FAR_KM - FADE_NEAR_KM)));

        // Matrix4.lookAt(eye, target) aims +Z from target toward eye: eye = centre gives +Z nadir.
        lookM.lookAt(centre, p, Math.abs(v.y) > 0.99 * Math.hypot(v.x, v.y, v.z) ? upX : upY);
        q.setFromRotationMatrix(lookM);
        m.compose(p, q, hide ? zeroScale : scale);
        bodies.setMatrixAt(n, m);

        positions[n * 3] = p.x;
        positions[n * 3 + 1] = p.y;
        positions[n * 3 + 2] = p.z;
        colors[n * 3] = colors[n * 3 + 1] = colors[n * 3 + 2] = fade;
        n++;
      }
      bodies.count = n;
      bodies.instanceMatrix.needsUpdate = true;
      markerGeom.setDrawRange(0, n);
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;

      const ringFade = smoothstep(Math.hypot(origin.x, origin.y, origin.z) - R_EARTH, RING_HIDE_BELOW_KM, RING_SHOW_ABOVE_KM);
      ringMat.opacity = RING_OPACITY * ringFade;
      rings.visible = ringFade > 0.001;
      // Rings, rebuilt camera-relative per vertex.
      const orbitList = Array.isArray(orbits) ? orbits : [];
      let r = 0;
      for (let i = 0; i < orbitList.length; i++) {
        const o = orbitList[i];
        if (!o) continue;
        const entry = ringFor(r, o);
        if (!entry) continue;
        const arr = entry.attr.array;
        const eci = entry.eci;
        for (let s = 0; s < RING_SEGMENTS * 3; s += 3) {
          arr[s] = eci[s] - origin.x;
          arr[s + 1] = eci[s + 1] - origin.y;
          arr[s + 2] = eci[s + 2] - origin.z;
        }
        entry.attr.needsUpdate = true;
        entry.line.visible = true;
        r++;
      }
      for (let i = r; i < ringPool.length; i++) ringPool[i].line.visible = false;
    },
  };
}

export function createConstellation() {
  const root = new THREE.Group();
  root.name = 'constellation';

  const shells = {};
  for (const spec of SHELLS) {
    shells[spec.key] = createShell(spec);
    root.add(shells[spec.key].group);
  }

  const zero = new THREE.Vector3();

  return {
    object3d: root,
    update(state, origin, ctx = {}) {
      const o = isVec3(origin) ? origin : zero;
      const exclude = Array.isArray(ctx.exclude) ? ctx.exclude.filter(isVec3) : [];
      const orbits = (state && state.orbits) || {};
      for (const spec of SHELLS) {
        shells[spec.key].update(state ? state[spec.key] : null, orbits[spec.key], o, exclude);
      }
    },
  };
}
