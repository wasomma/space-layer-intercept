// Intercept effects: flash sprite, shock ring and particle burst at intercept.position.
//
// createInterceptFx() -> { object3d, update(state, origin) }
//   state:  states.intercept ({ active, flash, ring, burst, shake, position })
//             flash  0..1 intensity envelope: the flash sprite grows to FLASH_MAX_KM
//             ring   0..1 progress: the shock ring expands to RING_MAX_KM across and fades
//             burst  0..1 progress: 300 particles travel up to BURST_TRAVEL_KM and fade
//             shake  ignored here (main.js applies it to the camera)
//   origin: the camera's ECI position this frame (km)
//
// World-size effects (km) at (position - origin), so they read as an event in space at the
// intercept camera's few-km distance. The burst particles are stored relative to the burst centre
// and the Points object is placed at the centre, so nothing large reaches the GPU.

import * as THREE from 'three';
import { easeOutQuad } from '../shared/easing.js';
import { FLASH, THREAT, INTERCEPTOR } from '../shared/palette.js';
import { makeGlowSprite, getGlowTexture, isVec3, clamp01, rng } from './util.js';

// Phase 2: 2.5x the 4.2 starting sizes (0.3, 1.5, 2 km), which were set for a camera about 4 km
// away; the Intercept shot now watches from about 13 km.
const FLASH_MAX_KM = 0.75;
const RING_MAX_KM = 3.75;
const BURST_TRAVEL_KM = 5.0;
const PARTICLES = 300;
const PARTICLE_SIZE_KM = 0.12; // attenuated point size

export function createInterceptFx() {
  const root = new THREE.Group();
  root.name = 'intercept-fx';
  root.visible = false;

  // Flash: a big soft white glow plus a tighter core.
  const flash = makeGlowSprite(FLASH);
  flash.renderOrder = 6;
  const flashCore = makeGlowSprite(FLASH);
  flashCore.renderOrder = 6;
  root.add(flash, flashCore);

  // Shock ring.
  const ring = makeGlowSprite(FLASH, { ring: true });
  ring.renderOrder = 6;
  root.add(ring);

  // Particle burst: directions with a speed factor, a per-particle life and colour.
  const random = rng(6012);
  const dirs = new Float32Array(PARTICLES * 3);
  const life = new Float32Array(PARTICLES);
  const base = new Float32Array(PARTICLES * 3);
  const palette = [new THREE.Color(FLASH), new THREE.Color(THREAT), new THREE.Color(INTERCEPTOR)];
  for (let i = 0; i < PARTICLES; i++) {
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const speed = 0.35 + 0.65 * Math.pow(random(), 0.6);
    dirs[i * 3] = s * Math.cos(phi) * speed;
    dirs[i * 3 + 1] = u * speed;
    dirs[i * 3 + 2] = s * Math.sin(phi) * speed;
    life[i] = 0.45 + 0.55 * random();
    const pick = random();
    const c = pick < 0.5 ? palette[0] : pick < 0.85 ? palette[1] : palette[2];
    base[i * 3] = c.r;
    base[i * 3 + 1] = c.g;
    base[i * 3 + 2] = c.b;
  }
  const positions = new Float32Array(PARTICLES * 3);
  const colors = new Float32Array(PARTICLES * 3);
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: PARTICLE_SIZE_KM,
      sizeAttenuation: true,
      map: getGlowTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  points.frustumCulled = false;
  points.renderOrder = 6;
  points.name = 'intercept-burst';
  root.add(points);

  const center = new THREE.Vector3();

  return {
    object3d: root,
    update(state, origin) {
      if (!state || !state.active || !isVec3(state.position) || !isVec3(origin)) {
        root.visible = false;
        return;
      }
      root.visible = true;
      const p = state.position;
      center.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);

      // Flash.
      const f = clamp01(state.flash);
      if (f > 0.001) {
        flash.position.copy(center);
        flash.scale.setScalar(FLASH_MAX_KM * Math.sqrt(f));
        flash.material.opacity = f;
        flashCore.position.copy(center);
        flashCore.scale.setScalar(FLASH_MAX_KM * 0.35 * Math.sqrt(f));
        flashCore.material.opacity = Math.min(1, f * 1.4);
        flash.visible = flashCore.visible = true;
      } else {
        flash.visible = flashCore.visible = false;
      }

      // Ring.
      const r = clamp01(state.ring);
      if (r > 0.001 && r < 0.999) {
        ring.position.copy(center);
        ring.scale.setScalar(Math.max(1e-6, RING_MAX_KM * easeOutQuad(r)));
        ring.material.opacity = 0.9 * Math.pow(1 - r, 1.2);
        ring.visible = true;
      } else {
        ring.visible = false;
      }

      // Burst.
      const b = clamp01(state.burst);
      if (b > 0.001 && b < 0.999) {
        const travel = BURST_TRAVEL_KM * easeOutQuad(Math.min(1, b * 1.6));
        for (let i = 0; i < PARTICLES; i++) {
          const k = i * 3;
          positions[k] = dirs[k] * travel;
          positions[k + 1] = dirs[k + 1] * travel;
          positions[k + 2] = dirs[k + 2] * travel;
          const a = Math.max(0, 1 - b / life[i]);
          const fade = a * a;
          colors[k] = base[k] * fade;
          colors[k + 1] = base[k + 1] * fade;
          colors[k + 2] = base[k + 2] * fade;
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        points.position.copy(center);
        points.visible = true;
      } else {
        points.visible = false;
      }
    },
  };
}
