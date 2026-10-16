// Wiring.
// Renderer with a logarithmic depth buffer, the simulation, the master clock, the scene with a
// floating origin, the scripted camera with a free-orbit toggle, the HUD, and the frame loop.
//
// Floating origin: the render camera never moves from (0, 0, 0). Each frame the ECI position
// the camera should occupy (the "origin", km, in doubles) is decided here and handed to the
// scene as states.camera.position; every actor is drawn at its ECI position minus that origin,
// so nothing near the camera is ever far from the GPU's origin.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSimulation, createClock, TOTAL_DURATION } from './sim/index.js';
import { createScene } from './scene/index.js';
import { createHud } from './hud/index.js';
import { BG } from './shared/palette.js';

const canvas = document.getElementById('gl');
const labelContainer = document.getElementById('labels');
const hudRoot = document.getElementById('hud');

// Renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(BG, 1);

// Simulation and clock
const sim = createSimulation();
const { scenario, timeline, computeStates } = sim;
const clock = createClock({ duration: TOTAL_DURATION, loop: true });
clock.play();

// Scene and camera (the camera stays at the origin; only its orientation and fov change)
const scene = createScene({
  renderer,
  labelContainer,
  width: window.innerWidth,
  height: window.innerHeight,
  coneHalfAngleDeg: scenario.sensorSat.coneHalfAngleDeg,
});
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 300000);
camera.position.set(0, 0, 0);

// HUD
const hud = createHud({ root: hudRoot, beats: timeline.beats, duration: TOTAL_DURATION, events: timeline.events });

// Scripted camera state. The smoothing acts on the camera's offset from the shot's anchor
// (states.camera.anchor: the point the camera is rigidly attached to, i.e. the target in follow
// shots, the site in the launch shot, the Earth's centre in fixed shots), not on its absolute
// position: the follow shots track targets moving hundreds of km per animation second, and
// smoothing the absolute position would leave the camera trailing by speed / 6.
// snapCamera forces the smoothed offset onto the scripted one on the next frame: after a seek,
// at every beat change (the script hard-cuts at beat starts) and on leaving free cam.
let snapCamera = true;
let lastBeatId = null;
let lastAnchorKey = null;
const smoothedOffset = new THREE.Vector3();
const scriptedOffset = new THREE.Vector3();
const smoothedOrigin = new THREE.Vector3();
const origin = new THREE.Vector3();
const shakeOffset = new THREE.Vector3();
const lookDir = new THREE.Vector3();
// Shake amplitude as a fraction of the camera-to-target distance, at states.camera.shake = 1.
const SHAKE_FRACTION = 0.008;

// Free cam: OrbitControls drives a proxy camera positioned relative to a pivot fixed in ECI at
// toggle time. The controls orbit the proxy about (0, 0, 0), i.e. about the pivot. OrbitControls
// caches the camera's up vector at construction, so a fresh instance is made per toggle.
let freeCam = false;
let controls = null;
const pivot = new THREE.Vector3();
const proxy = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 300000);

let lastStates = null;

function seek(t) {
  clock.seek(t);
  snapCamera = true;
}

function setFreeCam(on) {
  const enable = Boolean(on);
  if (enable === freeCam) return;
  freeCam = enable;
  if (enable) {
    const target = lastStates ? lastStates.camera.target : new THREE.Vector3();
    pivot.copy(target);
    proxy.up.copy(camera.up);
    proxy.position.copy(origin).sub(pivot);
    if (proxy.position.lengthSq() < 1e-12) proxy.position.set(0, 0, 1);
    proxy.lookAt(0, 0, 0);
    controls = new OrbitControls(proxy, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.002;
    controls.maxDistance = 150000;
    controls.update();
  } else {
    if (controls) controls.dispose();
    controls = null;
    snapCamera = true;
  }
}

function jumpBeat(id) {
  const beat = timeline.beats.find((b) => b.id === id);
  if (beat) seek(beat.start);
}

hud.on('play', () => clock.play());
hud.on('pause', () => clock.pause());
hud.on('seek', (t) => seek(t));
hud.on('speed', (s) => clock.setSpeed(s));
hud.on('jumpBeat', (id) => jumpBeat(id));
hud.on('toggleFreeCam', () => setFreeCam(!freeCam));
hud.on('replay', () => {
  seek(0);
  clock.play();
});

// The camera script sets a vertical fov framed for landscape. In portrait (a phone held upright)
// the horizontal view would shrink to a sliver, so the vertical fov opens until the horizontal
// fov is at least PORTRAIT_MIN_H times the scripted one.
const PORTRAIT_MIN_H = 0.8;
let scriptedFov = 50;

function applyFov() {
  const half = (scriptedFov * Math.PI) / 360;
  const minHalfH = half * PORTRAIT_MIN_H;
  let fov = scriptedFov;
  if (Math.atan(Math.tan(half) * camera.aspect) < minHalfH) {
    fov = (Math.atan(Math.tan(minHalfH) / camera.aspect) * 360) / Math.PI;
  }
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

/** Scripted camera: smooth the offset from the shot's anchor, add shake, aim. */
function applyScriptedCamera(states, dt) {
  const cam = states.camera;
  const anchor = cam.anchor || cam.target;
  const beatId = states.beat ? states.beat.id : null;
  if (beatId !== lastBeatId) {
    // Snap at a hard cut; keep smoothing where the new beat continues the shot (cam.cutIn false).
    if (cam.cutIn !== false) snapCamera = true;
    lastBeatId = beatId;
  }

  scriptedOffset.copy(cam.position).sub(anchor);
  const anchorKey = cam.anchorKey || null;
  // A shot that switches what it is anchored to (within a beat) snaps onto its scripted pose:
  // the shots keep their pose continuous across such a switch, while the old smoothing state
  // means nothing relative to the new anchor (anchors can move tens of metres per frame).
  if (snapCamera || anchorKey !== lastAnchorKey) {
    smoothedOffset.copy(scriptedOffset);
    snapCamera = false;
  } else {
    smoothedOffset.lerp(scriptedOffset, 1 - Math.exp(-6 * dt));
  }
  lastAnchorKey = anchorKey;
  smoothedOrigin.copy(anchor).add(smoothedOffset);

  const shake = Number.isFinite(cam.shake) ? cam.shake : 0;
  if (shake > 0) {
    const s = clock.t * 60;
    const amp = shake * SHAKE_FRACTION * smoothedOrigin.distanceTo(cam.target);
    shakeOffset
      .set(Math.sin(s * 1.7) * Math.cos(s * 0.9), Math.sin(s * 2.3 + 1.3), Math.cos(s * 1.1 + 0.4) * Math.sin(s * 0.7))
      .multiplyScalar(amp);
  } else {
    shakeOffset.set(0, 0, 0);
  }
  origin.copy(smoothedOrigin).add(shakeOffset);

  if (cam.up) camera.up.copy(cam.up);
  lookDir.copy(cam.target).sub(origin);
  if (lookDir.lengthSq() > 1e-18) camera.lookAt(lookDir);

  if (Number.isFinite(cam.fov)) scriptedFov = cam.fov;
  applyFov();
}

/** Free cam: the origin is the pivot plus the proxy's offset; the camera takes its orientation. */
function applyFreeCamera() {
  controls.update();
  origin.copy(pivot).add(proxy.position);
  camera.quaternion.copy(proxy.quaternion);
  camera.up.copy(proxy.up);
}

// Frame loop
let lastNow = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  advance(dt);
}

/** One frame of wall time dt: tick, compute, place the camera, update, render, HUD. */
function advance(dt) {
  clock.tick(dt);
  const states = computeStates(clock.t);

  if (freeCam) applyFreeCamera();
  else applyScriptedCamera(states, dt);

  // The scene sees the origin actually used this frame.
  states.camera.position = origin.clone();
  lastStates = states;

  scene.update(states);
  scene.render(camera);

  hud.update({
    t: clock.t,
    simT: states.simT,
    warp: states.warp,
    beatId: states.beat ? states.beat.id : null,
    playing: clock.playing,
    speed: clock.speed,
    freeCam,
    readouts: states.readouts,
  });
}

requestAnimationFrame(frame);

// Resize
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyFov();
  proxy.aspect = w / h;
  proxy.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  scene.resize(w, h);
}
window.addEventListener('resize', onResize);

// Console and verification hooks
window.__viz = {
  seek,
  play: () => clock.play(),
  pause: () => clock.pause(),
  setSpeed: (s) => clock.setSpeed(s),
  freeCam: (on) => setFreeCam(on),
  jumpBeat,
  t: () => clock.t,
  simT: () => timeline.animToSim(clock.t),
  // Run n frames of dt seconds synchronously (verification when requestAnimationFrame is paused).
  step: (dt = 1 / 60, n = 1) => {
    for (let i = 0; i < n; i++) advance(dt);
    return clock.t;
  },
  states: () => lastStates || computeStates(clock.t),
  origin: () => origin.clone(),
  scenario,
  timeline,
  // Debug handles for inspection from the console.
  scene: scene.scene,
  camera,
};
