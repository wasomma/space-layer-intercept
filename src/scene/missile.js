// Missile: 20 m body, origin at the tail, exhaust and plume sprites, fat-line trail rebuilt
// camera-relative, fixed-pixel marker when far.
//
// createMissile() -> { object3d, update(state, origin, ctx) }
//   state:  states.missile ({ position, velocity, direction, altKm, speedKms, phase, visible,
//           plume, trail }) plus an optional trailOpacity (index.js derives it)
//   origin: the camera's ECI position this frame (km)
//   ctx:    optional { dt } wall-clock seconds since the previous update (marker cross-fade)
//
// Generic illustrative body: a 1.1 m radius cylinder with a tangent-ogive nose, modelled in metres
// under a group scaled by 0.001, origin at the tail so `position` is the tail point, +Z along
// `direction`. Hidden when phase is 'gone' or visible is false; the trail is drawn whenever it
// has two or more points, so it can linger and retract after the body is gone.
//
// Plume, scaled by `plume` 0..1: two additive exhaust cones behind the nozzle (world size),
// a world-size glow and core sprite, and a fixed-pixel glow that cross-fades in with the marker
// so a boosting missile still reads from far away.

import * as THREE from 'three';
import { THREAT, FLASH, SAT_DIM, BG } from '../shared/palette.js';
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
const LENGTH = 20;
const RADIUS = 1.1;
const NOSE_LENGTH = 4.8;
const BODY_LENGTH = LENGTH - NOSE_LENGTH;
const FLAME_LENGTH = 24; // inner flame at plume 1
const FLAME_OUTER_LENGTH = 40;

// km.
const LENGTH_KM = LENGTH * M;
const PLUME_GLOW_KM = 0.06; // world-size glow sprite at plume 1
const PLUME_CORE_KM = 0.022;
const PLUME_GLOW_OFFSET_KM = 0.009; // behind the nozzle
const PLUME_CORE_OFFSET_KM = 0.002;
const PLUME_PIXEL_PX = 22; // fixed-pixel plume glow when far

function ogiveProfile(radius, length, steps = 16) {
  const rho = (radius * radius + length * length) / (2 * radius);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const y = (length * i) / steps;
    const r = Math.max(0, Math.sqrt(rho * rho - y * y) - (rho - radius));
    pts.push(new THREE.Vector2(r, y));
  }
  return pts;
}

/** Unit flame: wide end at the origin (the nozzle), apex 1 unit behind along -Z. */
function flameGeometry(radius) {
  const g = new THREE.ConeGeometry(radius, 1, 16, 1, true);
  g.translate(0, 0.5, 0); // base at y = 0, apex at y = 1
  g.rotateX(-Math.PI / 2); // +Y -> -Z
  return g;
}

export function createMissile() {
  const root = new THREE.Group();
  root.name = 'missile';

  // ---- body (metres)
  const body = new THREE.Group();
  body.name = 'missile-body';
  body.scale.setScalar(M);
  body.visible = false;
  root.add(body);

  const skin = new THREE.MeshStandardMaterial({ color: THREAT, emissive: THREAT, emissiveIntensity: 0.35, roughness: 0.5, metalness: 0.2 });
  const bandMat = new THREE.MeshStandardMaterial({ color: BG, roughness: 0.6, metalness: 0.3 });
  const nozzleMat = new THREE.MeshStandardMaterial({ color: SAT_DIM, roughness: 0.4, metalness: 0.7 });

  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS, RADIUS, BODY_LENGTH, 24).rotateX(Math.PI / 2), skin);
  cyl.position.z = BODY_LENGTH / 2;
  body.add(cyl);
  const nose = new THREE.Mesh(new THREE.LatheGeometry(ogiveProfile(RADIUS, NOSE_LENGTH), 24).rotateX(Math.PI / 2), skin);
  nose.position.z = BODY_LENGTH;
  body.add(nose);
  for (const z of [6.5, 11.5]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 1.015, RADIUS * 1.015, 0.25, 24, 1, true).rotateX(Math.PI / 2), bandMat);
    band.position.z = z;
    body.add(band);
  }
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.8, RADIUS * 0.95, 0.7, 20, 1, true).rotateX(Math.PI / 2), nozzleMat);
  nozzle.position.z = -0.35;
  body.add(nozzle);

  // Exhaust cones (inside the scaled body, so lengths are metres).
  const flameMat = new THREE.MeshBasicMaterial({
    color: FLASH,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flame = new THREE.Mesh(flameGeometry(RADIUS * 0.85), flameMat);
  flame.position.z = -0.7;
  flame.renderOrder = 3;
  body.add(flame);
  const outerMat = flameMat.clone();
  outerMat.color.set(THREAT);
  outerMat.opacity = 0.35;
  const flameOuter = new THREE.Mesh(flameGeometry(RADIUS * 1.5), outerMat);
  flameOuter.position.z = -0.7;
  flameOuter.renderOrder = 3;
  body.add(flameOuter);

  // ---- plume sprites (km) and the far-view marker
  const plumeGlow = makeGlowSprite(THREAT);
  plumeGlow.renderOrder = 4;
  const plumeCore = makeGlowSprite(FLASH);
  plumeCore.renderOrder = 4;
  const plumePixel = makePixelSprite(THREAT, PLUME_PIXEL_PX, { texture: 'glow' });
  plumePixel.renderOrder = 4;
  const marker = makePixelSprite(THREAT, PX.vehicleMarker, { texture: 'dot' });
  marker.renderOrder = 5;
  marker.name = 'missile-marker';
  root.add(plumeGlow, plumeCore, plumePixel, marker);

  const trail = createTrail({ color: THREAT, linewidth: 2, tailBrightness: 0.3 });
  trail.line.name = 'missile-trail';
  root.add(trail.line);

  const fade = createMarkerFade(LENGTH_KM);
  const _dir = new THREE.Vector3(0, 1, 0);
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

      const show = state.visible !== false && state.phase !== 'gone' && isVec3(state.position);
      if (!show) {
        hideBody();
        wasShown = false;
        return;
      }
      if (!wasShown) fade.reset();
      wasShown = true;

      const p = state.position;
      // Tail point relative to the camera, in doubles.
      _tail.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      body.position.copy(_tail);
      if (isDir(state.direction)) _dir.set(state.direction.x, state.direction.y, state.direction.z).normalize();
      else if (isDir(state.velocity)) _dir.set(state.velocity.x, state.velocity.y, state.velocity.z).normalize();
      else _dir.set(p.x, p.y, p.z).normalize(); // straight up
      orientZ(body, _dir);
      body.visible = true;

      // Marker cross-fade by camera distance (the camera is at the origin).
      const dist = _tail.length();
      const k = fade.update(dist + LENGTH_KM * 0.5, num(ctx.dt, 0));
      marker.position.copy(_tail).addScaledVector(_dir, LENGTH_KM * 0.5);
      marker.material.opacity = k;
      marker.visible = k > 0.002;

      const plume = clamp01(state.plume);
      const lit = plume > 0.01;
      flame.visible = flameOuter.visible = lit;
      if (lit) {
        flame.scale.set(1, 1, FLAME_LENGTH * plume);
        flameMat.opacity = 0.75 * plume;
        flameOuter.scale.set(1, 1, FLAME_OUTER_LENGTH * plume);
        outerMat.opacity = 0.35 * plume;

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
