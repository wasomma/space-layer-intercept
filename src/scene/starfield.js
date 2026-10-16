// Starfield: 3000 points on a sphere of radius 100000 km, STAR, size attenuation off.
// The camera sits at the origin, so the starfield stays at the origin and is
// never shifted by the floating origin. Deterministic (seeded) so every run shows the same sky.

import * as THREE from 'three';
import { STAR } from '../shared/palette.js';

const COUNT = 3000;
const BRIGHT_COUNT = 300; // drawn slightly larger, out of the 3000
const RADIUS = 100000; // km

/** Small seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPoints(count, random, minBright, maxBright, size, opacity) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere.
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = RADIUS * s * Math.cos(phi);
    positions[i * 3 + 1] = RADIUS * u;
    positions[i * 3 + 2] = RADIUS * s * Math.sin(phi);
    const k = minBright + (maxBright - minBright) * Math.pow(random(), 2.2);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    color: STAR,
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

export function createStarfield() {
  const group = new THREE.Group();
  group.name = 'starfield';
  const random = rng(20261015);
  group.add(buildPoints(COUNT - BRIGHT_COUNT, random, 0.25, 0.85, 1.4, 0.9));
  group.add(buildPoints(BRIGHT_COUNT, random, 0.7, 1.0, 2.2, 1.0));
  group.renderOrder = -1;
  return {
    object3d: group,
    update() {},
  };
}
