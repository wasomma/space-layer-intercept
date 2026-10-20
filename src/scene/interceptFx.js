// Intercept effects: flash sprite, shock ring and particle burst at intercept.position.
//
// createInterceptFx() -> { object3d, update(state, origin) }
//   state:  states.intercept ({ active, flash, ring, burst, shake, position })
//             flash  0..1 intensity envelope: the flash sprite grows to 0.75 km
//             ring   0..1 progress: the shock ring expands to 3.75 km across and fades
//             burst  0..1 progress: 300 particles travel up to 5 km and fade
//             shake  ignored here (main.js applies it to the camera)
//   origin: the camera's ECI position this frame (km)
//
// The sizes, levels and burst pieces come from sim/effects.js (interceptFxShape, BURST_PIECES),
// which the live link exports too. World-size effects (km) at (position - origin), so they read
// as an event in space at the intercept camera's few-km distance. The burst particles are stored
// relative to the burst centre and the Points object is placed at the centre, so nothing large
// reaches the GPU.

import * as THREE from 'three';
import { FLASH, THREAT, INTERCEPTOR } from '../shared/palette.js';
import { FLASH_MAX_KM, BURST_PIECES, BURST_PIECE_SIZE_KM, burstPieceFade, interceptFxShape } from '../sim/effects.js';
import { makeGlowSprite, getGlowTexture, isVec3, clamp01 } from './util.js';

const PARTICLES = BURST_PIECES.count;
const PARTICLE_SIZE_KM = BURST_PIECE_SIZE_KM; // attenuated point size

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

  // Particle burst: the pieces' directions with a speed factor, and their colours.
  const dirs = BURST_PIECES.dirs;
  const base = new Float32Array(PARTICLES * 3);
  const palette = [new THREE.Color(FLASH), new THREE.Color(THREAT), new THREE.Color(INTERCEPTOR)];
  for (let i = 0; i < PARTICLES; i++) {
    const c = palette[BURST_PIECES.kind[i]];
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

      const f = clamp01(state.flash);
      const r = clamp01(state.ring);
      const b = clamp01(state.burst);
      const shape = interceptFxShape({ flash: f, ring: r, burst: b });

      // Flash.
      if (f > 0.001) {
        flash.position.copy(center);
        flash.scale.setScalar(shape.flash.diameterKm);
        flash.material.opacity = shape.flash.level;
        flashCore.position.copy(center);
        flashCore.scale.setScalar(FLASH_MAX_KM * 0.35 * Math.sqrt(f));
        flashCore.material.opacity = Math.min(1, f * 1.4);
        flash.visible = flashCore.visible = true;
      } else {
        flash.visible = flashCore.visible = false;
      }

      // Ring.
      if (r > 0.001 && r < 0.999) {
        ring.position.copy(center);
        ring.scale.setScalar(Math.max(1e-6, shape.ring.diameterKm));
        ring.material.opacity = shape.ring.level;
        ring.visible = true;
      } else {
        ring.visible = false;
      }

      // Burst.
      if (b > 0.001 && b < 0.999) {
        const travel = shape.burst.spreadKm;
        for (let i = 0; i < PARTICLES; i++) {
          const k = i * 3;
          positions[k] = dirs[k] * travel;
          positions[k + 1] = dirs[k + 1] * travel;
          positions[k + 2] = dirs[k + 2] * travel;
          const fade = burstPieceFade(i, b);
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
