// Kill vehicle: 1.5 m body, origin at the tail, plume sprites, 1.5 px trail, fixed-pixel marker
// when far.
//
// createKv() -> { object3d, update(state, origin, ctx) }
//   state:  states.kv ({ position, velocity, direction, altKm, speedKms, phase, visible, plume,
//           trail }) plus an optional trailOpacity (index.js derives it)
//   origin: the camera's ECI position this frame (km)
//   ctx:    optional { dt } wall-clock seconds since the previous update (marker cross-fade)
//
// Generic illustrative body in INTERCEPTOR: a short cylinder with a blunt cone nose, a dark seeker
// window and four small side thruster pods, modelled in metres under a group scaled by 0.001,
// origin at the tail, +Z along `direction`. Hidden while 'stowed' (it sits in the interceptor
// satellite's tube), when 'gone', or when visible is false. The marker shows beyond
// 60 x 1.5 m = 90 m, cross-fading over 1 s.

import * as THREE from 'three';
import { INTERCEPTOR, FLASH, BG, SAT_DIM } from '../shared/palette.js';
import {
  createTrail,
  makeGlowSprite,
  makePixelSprite,
  createMarkerFade,
  isVec3,
  isDir,
  num,
  clamp01,
  orientZ,
  M,
  PX,
} from './util.js';

// Metres.
const LENGTH = 1.5;
const RADIUS = 0.28;
const BODY_LENGTH = 0.95;
const FLAME_LENGTH = 3.0;

// km.
const LENGTH_KM = LENGTH * M;
const PLUME_GLOW_KM = 0.008;
const PLUME_CORE_KM = 0.0028;
const PLUME_GLOW_OFFSET_KM = 0.0012;
const PLUME_CORE_OFFSET_KM = 0.0003;
const PLUME_PIXEL_PX = 14;

export function createKv() {
  const root = new THREE.Group();
  root.name = 'kv';

  const body = new THREE.Group();
  body.name = 'kv-body';
  body.scale.setScalar(M);
  body.visible = false;
  root.add(body);

  const skin = new THREE.MeshStandardMaterial({ color: INTERCEPTOR, emissive: INTERCEPTOR, emissiveIntensity: 0.45, roughness: 0.4, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: BG, roughness: 0.2, metalness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: SAT_DIM, roughness: 0.4, metalness: 0.7 });

  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS, RADIUS, BODY_LENGTH, 16).rotateX(Math.PI / 2), skin);
  cyl.position.z = BODY_LENGTH / 2;
  body.add(cyl);
  const noseLen = LENGTH - BODY_LENGTH;
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.35, RADIUS, noseLen, 16).rotateX(Math.PI / 2), skin);
  nose.position.z = BODY_LENGTH + noseLen / 2;
  body.add(nose);
  const seeker = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), dark);
  seeker.position.z = LENGTH;
  body.add(seeker);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.22), metal);
    pod.position.set(Math.cos(a) * (RADIUS + 0.05), Math.sin(a) * (RADIUS + 0.05), BODY_LENGTH * 0.55);
    body.add(pod);
  }
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.55, RADIUS * 0.75, 0.18, 12, 1, true).rotateX(Math.PI / 2), metal);
  nozzle.position.z = -0.09;
  body.add(nozzle);

  const flameGeom = new THREE.ConeGeometry(RADIUS * 0.7, 1, 12, 1, true);
  flameGeom.translate(0, 0.5, 0);
  flameGeom.rotateX(-Math.PI / 2); // apex 1 unit behind along -Z
  const flameMat = new THREE.MeshBasicMaterial({
    color: FLASH,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flame = new THREE.Mesh(flameGeom, flameMat);
  flame.position.z = -0.18;
  flame.renderOrder = 3;
  body.add(flame);

  const plumeGlow = makeGlowSprite(INTERCEPTOR);
  plumeGlow.renderOrder = 4;
  const plumeCore = makeGlowSprite(FLASH);
  plumeCore.renderOrder = 4;
  const plumePixel = makePixelSprite(INTERCEPTOR, PLUME_PIXEL_PX, { texture: 'glow' });
  plumePixel.renderOrder = 4;
  const marker = makePixelSprite(INTERCEPTOR, PX.vehicleMarker, { texture: 'dot' });
  marker.renderOrder = 5;
  marker.name = 'kv-marker';
  root.add(plumeGlow, plumeCore, plumePixel, marker);

  // Head brightness 0.7 keeps the trail under the bloom threshold (INTERCEPTOR is bright enough to
  // bloom, and a thin blooming line aliases into beads in the bloom pass's low mips).
  const trail = createTrail({ color: INTERCEPTOR, linewidth: 1.5, tailBrightness: 0.25, headBrightness: 0.7 });
  trail.line.name = 'kv-trail';
  root.add(trail.line);

  const fade = createMarkerFade(LENGTH_KM);
  const _dir = new THREE.Vector3(0, 0, 1);
  const _tail = new THREE.Vector3();
  let wasShown = false;

  function hideBody() {
    body.visible = plumeGlow.visible = plumeCore.visible = plumePixel.visible = marker.visible = false;
  }

  return {
    object3d: root,
    update(state, origin, ctx = {}) {
      if (!state || !isVec3(origin)) {
        hideBody();
        trail.hide();
        wasShown = false;
        return;
      }

      trail.setPoints(state.trail, origin, num(state.trailOpacity, 1));

      const show = state.visible !== false && state.phase !== 'gone' && state.phase !== 'stowed' && isVec3(state.position);
      if (!show) {
        hideBody();
        wasShown = false;
        return;
      }
      if (!wasShown) fade.reset();
      wasShown = true;

      const p = state.position;
      _tail.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      body.position.copy(_tail);
      if (isDir(state.direction)) _dir.set(state.direction.x, state.direction.y, state.direction.z).normalize();
      else if (isDir(state.velocity)) _dir.set(state.velocity.x, state.velocity.y, state.velocity.z).normalize();
      orientZ(body, _dir);
      body.visible = true;

      const dist = _tail.length();
      const k = fade.update(dist + LENGTH_KM * 0.5, num(ctx.dt, 0));
      marker.position.copy(_tail).addScaledVector(_dir, LENGTH_KM * 0.5);
      marker.material.opacity = k;
      marker.visible = k > 0.002;

      const plume = clamp01(state.plume);
      const lit = plume > 0.01;
      flame.visible = lit;
      if (lit) {
        flame.scale.set(1, 1, FLAME_LENGTH * plume);
        flameMat.opacity = 0.8 * plume;
        plumeGlow.position.copy(_tail).addScaledVector(_dir, -PLUME_GLOW_OFFSET_KM);
        plumeGlow.scale.setScalar(PLUME_GLOW_KM * plume);
        plumeGlow.material.opacity = 0.9 * plume;
        plumeCore.position.copy(_tail).addScaledVector(_dir, -PLUME_CORE_OFFSET_KM);
        plumeCore.scale.setScalar(PLUME_CORE_KM * plume);
        plumeCore.material.opacity = plume;
        plumePixel.position.copy(_tail);
        plumePixel.material.opacity = 0.85 * plume * k;
        plumeGlow.visible = plumeCore.visible = true;
        plumePixel.visible = plumePixel.material.opacity > 0.002;
      } else {
        plumeGlow.visible = plumeCore.visible = plumePixel.visible = false;
      }
    },
  };
}
