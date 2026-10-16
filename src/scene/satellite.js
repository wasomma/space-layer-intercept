// Satellite: 4 m body, two 6 m panels, halo and fixed-pixel marker sprites; the sensor variant
// adds the field-of-view cone and the detect pulse; the tube variant adds the launch tube.
//
// createSatellite(color, { sensor, tube, name, coneHalfAngleDeg }) -> { object3d, update(state, origin, ctx) }
//   state:  states.sensorSat / relaySat / interceptorSat:
//           { position, velocity, visible, highlight?, facing?, rcs?, rcsDir? } (rcs: thruster
//           firing level 0..1 and push direction, tube variant) and, for the sensor,
//           { coneTarget, coneOpacity, detectPulse, tracking, pulsePosition } (pulsePosition is
//           supplied by index.js: the missile's position)
//   origin: the camera's ECI position this frame (km)
//   ctx:    optional { dt } wall-clock seconds since the previous update (marker cross-fade)
//
// Body modelled in metres under a group scaled by 0.001: a 3.2 x 3.2 x 4 m box (+Z is the
// pointing axis), two 6 m x 2.4 m panels on struts. With `facing` the body's +Z points along it
// (the interceptor satellite slews its tube onto the departure direction); otherwise +Z points
// at the Earth's centre. The tube variant carries a 3 m launch tube on +Z whose mouth is 3 m
// from the body centre, where the kill vehicle appears at release.
//
// Marker policy: a 9 px marker and a halo of 22 px (highlight 0) to 36 px (highlight 1), both
// cross-fading out when the camera is within 60 x the 16.8 m panel span. The sensor, which has no
// highlight field, brightens its halo while tracking.
//
// Sensor beam (beam.js): the field-of-view cone, half-angle coneHalfAngleDeg (given at creation,
// or on the state when the sim supplies one), aimed at coneTarget and projected onto the Earth:
// walls from the satellite to the ground, the footprint laid on the curved surface. The detect
// pulse is a fixed-pixel ring growing to PULSE_MAX_PX at the missile.

import * as THREE from 'three';
import { easeOutQuad } from '../shared/easing.js';
import { GRATICULE, SAT_DIM, BG, FLASH } from '../shared/palette.js';
import {
  makePixelSprite,
  makeGlowSprite,
  createMarkerFade,
  isVec3,
  isDir,
  num,
  clamp01,
  orientZ,
  M,
  PX,
} from './util.js';
import { createSensorBeam } from './beam.js';

// Metres.
const BODY_W = 3.2;
const BODY_L = 4.0;
const STRUT = 0.8;
const PANEL_L = 6.0;
const PANEL_W = 2.4;
const SPAN_KM = (BODY_W + 2 * (STRUT + PANEL_L)) * M; // 16.8 m
const TUBE_LENGTH = 3.0;
const TUBE_OUTER = 0.45;
const TUBE_INNER = 0.38;

const PULSE_MAX_PX = 140;

const BODY_SHADE = 0.6; // body colour as a fraction of the actor colour
const BODY_EMISSIVE = 0.12;
const HALO_BASE = 0.1; // halo opacity at highlight 0
const HALO_GAIN = 0.28; // added at highlight 1
const MARKER_OPACITY = 0.8;

// Reaction-control puffs (tube variant, the slewing interceptor satellite), metres.
const RCS_PUFFS = 3; // sprites per thruster cluster, at staggered ages
const RCS_PULSE_HZ = 3; // pulses per animation second
const RCS_TRAVEL = 3.2; // a puff drifts this far from the nozzle
const RCS_SIZE0 = 0.35;
const RCS_SIZE1 = 2.6;
const RCS_OPACITY = 0.65;

export function createSatellite(color, options = {}) {
  const sensor = Boolean(options.sensor);
  const tube = Boolean(options.tube);
  const coneHalfAngleDeg = num(options.coneHalfAngleDeg, 8);
  const root = new THREE.Group();
  root.name = options.name || (sensor ? 'sensor-sat' : 'satellite');

  // ---- body (metres)
  const body = new THREE.Group();
  body.name = root.name + '-body';
  body.scale.setScalar(M);
  body.visible = false;
  root.add(body);

  // Phase 2 follow-up: body, panel glow, halo and marker toned down (the bright green of the
  // interceptor satellite bloomed heavily in its close-up and wide shots).
  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(BODY_SHADE),
    emissive: color,
    emissiveIntensity: BODY_EMISSIVE,
    roughness: 0.55,
    metalness: 0.3,
  });
  body.add(new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_W, BODY_L), bodyMat));

  const strutMat = new THREE.MeshStandardMaterial({ color: SAT_DIM, roughness: 0.6, metalness: 0.4 });
  const panelMat = new THREE.MeshStandardMaterial({
    color: GRATICULE,
    emissive: color,
    emissiveIntensity: 0.05,
    roughness: 0.5,
    metalness: 0.5,
    side: THREE.DoubleSide,
  });
  const panelGeom = new THREE.PlaneGeometry(PANEL_L, PANEL_W);
  const panelEdges = new THREE.EdgesGeometry(panelGeom);
  const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(STRUT, 0.15, 0.15), strutMat);
    strut.position.x = side * (BODY_W / 2 + STRUT / 2);
    body.add(strut);
    // Panel plane in the body's XZ plane (normal along local Y).
    const panel = new THREE.Mesh(panelGeom, panelMat);
    panel.rotation.x = -Math.PI / 2;
    panel.position.x = side * (BODY_W / 2 + STRUT + PANEL_L / 2);
    body.add(panel);
    const edges = new THREE.LineSegments(panelEdges, edgeMat);
    edges.rotation.x = -Math.PI / 2;
    edges.position.copy(panel.position);
    body.add(edges);
  }

  if (sensor) {
    // Sensor aperture on the pointing face.
    const aperture = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 0.9, 0.7, 20).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: BG, emissive: color, emissiveIntensity: 0.2, roughness: 0.3 })
    );
    aperture.position.z = BODY_L / 2 + 0.35;
    body.add(aperture);
  }

  if (tube) {
    // Launch tube along +Z from the body centre to 3 m (protrudes 1 m beyond the +Z face).
    const tubeMat = new THREE.MeshStandardMaterial({ color: SAT_DIM, roughness: 0.4, metalness: 0.6 });
    const boreMat = new THREE.MeshStandardMaterial({ color: BG, roughness: 1, side: THREE.BackSide });
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_OUTER, TUBE_OUTER, TUBE_LENGTH, 20, 1, true).rotateX(Math.PI / 2), tubeMat);
    outer.position.z = TUBE_LENGTH / 2;
    body.add(outer);
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_INNER, TUBE_INNER, TUBE_LENGTH, 20, 1, true).rotateX(Math.PI / 2), boreMat);
    bore.position.z = TUBE_LENGTH / 2;
    body.add(bore);
    const rim = new THREE.Mesh(new THREE.RingGeometry(TUBE_INNER, TUBE_OUTER + 0.04, 20), bodyMat);
    rim.position.z = TUBE_LENGTH;
    body.add(rim);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_OUTER + 0.12, TUBE_OUTER + 0.12, 0.3, 20).rotateX(Math.PI / 2), tubeMat);
    collar.position.z = BODY_L / 2 + 0.15;
    body.add(collar);
  }

  // ---- reaction-control puffs (tube variant): a nose cluster and a tail cluster, placed on
  // the body's side each frame from the push direction, each a short stream of fading puffs.
  const rcsPuffs = [];
  if (tube) {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < RCS_PUFFS; i++) {
        const puff = makeGlowSprite(FLASH, { opacity: 0 });
        puff.renderOrder = 5;
        body.add(puff);
        rcsPuffs.push({ sprite: puff, cluster: c, slot: i });
      }
    }
  }

  // ---- halo and marker (fixed pixel)
  const halo = makePixelSprite(color, PX.haloDim, { texture: 'glow' });
  halo.name = root.name + '-halo';
  halo.renderOrder = 3;
  const marker = makePixelSprite(color, PX.satMarker, { texture: 'dot' });
  marker.name = root.name + '-marker';
  marker.renderOrder = 4;
  root.add(halo, marker);

  // ---- sensor beam (projected onto the Earth) and the detect pulse
  let beam = null;
  let pulse = null;
  if (sensor) {
    beam = createSensorBeam(color);
    beam.object3d.name = root.name + '-beam';
    root.add(beam.object3d);

    pulse = makePixelSprite(color, 0, { texture: 'ring' });
    pulse.name = root.name + '-detect-pulse';
    pulse.renderOrder = 5;
    root.add(pulse);
  }

  const fade = createMarkerFade(SPAN_KM);
  const _p = new THREE.Vector3();
  const _nadir = new THREE.Vector3();
  let wasShown = false;

  function hideAll() {
    root.visible = false;
    wasShown = false;
  }

  const _push = new THREE.Vector3();
  const _invQ = new THREE.Quaternion();
  const _nozzle = new THREE.Vector3();

  /**
   * Reaction-control puffs. state.rcs (0..1) is the firing level and state.rcsDir (world) the
   * direction the thrusters push the nose. A couple turns the body: the nose cluster, on the
   * side away from the push, exhausts against it; the tail cluster exhausts along it. Each
   * cluster shows a pulsed stream of puffs drifting out and fading (animation time).
   */
  function updateRcs(state, animT) {
    const level = clamp01(num(state.rcs, 0));
    if (!(level > 0.001) || !isDir(state.rcsDir)) {
      for (const p of rcsPuffs) p.sprite.visible = false;
      return;
    }
    // Push direction in body space, perpendicular to the pointing axis (+Z).
    _invQ.copy(body.quaternion).invert();
    _push.copy(state.rcsDir).applyQuaternion(_invQ);
    _push.z = 0;
    if (_push.lengthSq() < 1e-12) {
      for (const p of rcsPuffs) p.sprite.visible = false;
      return;
    }
    _push.normalize();
    for (const p of rcsPuffs) {
      const nose = p.cluster === 0;
      const exhaust = nose ? -1 : 1; // along -push at the nose, +push at the tail
      const age = (((animT * RCS_PULSE_HZ + p.slot / RCS_PUFFS) % 1) + 1) % 1;
      _nozzle.set(_push.x * exhaust * (BODY_W / 2), _push.y * exhaust * (BODY_W / 2), nose ? BODY_L / 2 - 0.4 : -BODY_L / 2 + 0.4);
      p.sprite.position.copy(_nozzle).addScaledVector(_push, exhaust * (0.2 + RCS_TRAVEL * age));
      p.sprite.scale.setScalar(RCS_SIZE0 + (RCS_SIZE1 - RCS_SIZE0) * age);
      p.sprite.material.opacity = RCS_OPACITY * level * Math.pow(1 - age, 1.5);
      p.sprite.visible = p.sprite.material.opacity > 0.002;
    }
  }

  return {
    object3d: root,
    update(state, origin, ctx = {}) {
      if (!state || state.visible === false || !isVec3(state.position) || !isVec3(origin)) {
        hideAll();
        return;
      }
      if (!wasShown) fade.reset();
      wasShown = true;
      root.visible = true;
      body.visible = true;

      const p = state.position;
      _p.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      body.position.copy(_p);
      if (isDir(state.facing)) {
        orientZ(body, state.facing);
      } else {
        _nadir.set(-p.x, -p.y, -p.z);
        orientZ(body, _nadir);
      }

      // Halo and marker.
      const k = fade.update(_p.length(), num(ctx.dt, 0));
      let h = state.highlight;
      if (!Number.isFinite(h)) h = sensor && state.tracking ? 0.8 : 0.3;
      h = clamp01(h);
      halo.position.copy(_p);
      halo.userData.px = PX.haloDim + (PX.haloLit - PX.haloDim) * h;
      halo.material.opacity = (HALO_BASE + HALO_GAIN * h) * k;
      halo.visible = halo.material.opacity > 0.002;
      marker.position.copy(_p);
      marker.material.opacity = MARKER_OPACITY * k;
      marker.visible = k > 0.002;

      if (tube) updateRcs(state, num(ctx.animT, 0));
      if (!sensor) return;

      // Beam. A half-angle on the state (the sim may widen the cone, 5.4) overrides the one
      // given at creation.
      beam.update(
        {
          apex: state.position,
          target: state.coneTarget,
          halfAngleDeg: num(state.coneHalfAngleDeg, coneHalfAngleDeg),
          opacity: num(state.coneOpacity, 0),
        },
        origin
      );

      // Detect pulse ring at the missile (or the cone target when no missile is supplied).
      const dp = num(state.detectPulse, 0);
      const at = isVec3(state.pulsePosition) ? state.pulsePosition : state.coneTarget;
      if (dp > 0 && dp < 1 && isVec3(at)) {
        pulse.position.set(at.x - origin.x, at.y - origin.y, at.z - origin.z);
        pulse.userData.px = Math.max(1, PULSE_MAX_PX * easeOutQuad(dp));
        pulse.material.opacity = 1 - dp;
        pulse.visible = true;
      } else {
        pulse.visible = false;
      }
    },
  };
}
