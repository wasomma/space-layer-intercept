// Wiring.
// Renderer with a logarithmic depth buffer, the simulation, the master clock, the scene with a
// floating origin, the scripted camera with a free-orbit toggle, the HUD, and the frame loop.
//
// Live mode (?live, README "Live link"): an external host's clock drives the time instead of the
// looping 90 s film. The page waits on the opening beat until a launch arrives, then shows the
// host's simulation time through the timeline's simToAnim; the playback controls are hidden.
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
import { createLiveClock } from './live/clock.js';
import { connectLive, liveUrlFromLocation } from './live/link.js';
import { BG } from './shared/palette.js';

const canvas = document.getElementById('gl');
const labelContainer = document.getElementById('labels');
const hudRoot = document.getElementById('hud');

// Live mode: the WebSocket URL from ?live, or null for the film.
const liveUrl = liveUrlFromLocation(window.location);

// Renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(BG, 1);

// Simulation and clock
const sim = createSimulation();
const { scenario, timeline, computeStates } = sim;
const clock = createClock({ duration: TOTAL_DURATION, loop: !liveUrl });
if (!liveUrl) clock.play();

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
const hud = createHud({
  root: hudRoot,
  beats: timeline.beats,
  duration: TOTAL_DURATION,
  events: timeline.events,
  live: Boolean(liveUrl),
});

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

// In live mode the host owns the time: only the free camera stays under the viewer's control.
if (!liveUrl) {
  hud.on('play', () => clock.play());
  hud.on('pause', () => clock.pause());
  hud.on('seek', (t) => seek(t));
  hud.on('speed', (s) => clock.setSpeed(s));
  hud.on('jumpBeat', (id) => jumpBeat(id));
  hud.on('replay', () => {
    seek(0);
    clock.play();
  });
}
hud.on('toggleFreeCam', () => setFreeCam(!freeCam));

// ---------------------------------------------------------------------------
// Live mode

// A launch whose site or azimuth differs from this page's scenario by more than these still
// plays (this page renders its own scenario), flagged SITE MISMATCH.
const SITE_TOLERANCE_DEG = 0.01;
const AZIMUTH_TOLERANCE_DEG = 0.1;
// A jump in animation time larger than this between frames (a reset, a host restart, a tab
// waking up) snaps the camera like a seek.
const LIVE_JUMP = 0.5;

const LIVE_LABELS = {
  waiting: ['LIVE: WAITING FOR HOST', 'wait'],
  standby: ['LIVE: STANDBY', 'wait'],
  countdown: ['LIVE: COUNTDOWN', 'ok'],
  live: ['LIVE', 'ok'],
  paused: ['LIVE: PAUSED', 'wait'],
  lost: ['LIVE: HOST CLOCK LOST', 'warn'],
};

function matchesScenario(launch) {
  const p = scenario.params;
  const s = launch.site;
  const siteOk =
    !s ||
    !(Number.isFinite(s.lat) && Number.isFinite(s.lon)) ||
    (Math.abs(s.lat - p.site.lat) < SITE_TOLERANCE_DEG && Math.abs(s.lon - p.site.lon) < SITE_TOLERANCE_DEG);
  const az = launch.azimuthDeg;
  const azimuthOk = !Number.isFinite(az) || Math.abs(az - p.launchAzimuthDeg) < AZIMUTH_TOLERANCE_DEG;
  return siteOk && azimuthOk;
}

function startLive(url) {
  const state = { url, clock: createLiveClock(), connected: false, everConnected: false, mismatch: false };
  connectLive(url, {
    onStatus(connected) {
      state.connected = connected;
      if (connected) state.everConnected = true;
    },
    onMessage(msg) {
      state.clock.receive(msg, performance.now() / 1000);
      if (msg.type === 'launch') state.mismatch = !matchesScenario(msg);
      else if (msg.type === 'reset') state.mismatch = false;
    },
  });
  return state;
}

/** The HUD's live badge: the link first, then the host clock, then a site mismatch. */
function liveBadge(now) {
  if (!live.connected) {
    return live.everConnected ? { text: 'LIVE: LINK LOST', level: 'warn' } : { text: 'LIVE: CONNECTING', level: 'wait' };
  }
  const [text, level] = LIVE_LABELS[live.clock.status(now)] || LIVE_LABELS.waiting;
  return live.mismatch ? { text: `${text} / SITE MISMATCH`, level: 'warn' } : { text, level };
}

const live = liveUrl ? startLive(liveUrl) : null;

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

/** One frame of wall time dt: tick (or follow the host), compute, place the camera, update, render, HUD. */
function advance(dt) {
  const now = performance.now() / 1000;
  let liveSimT = null;
  if (live) {
    // Before a launch the page holds the opening beat; after the film's end it holds the end.
    liveSimT = live.clock.simT(now);
    const animT = liveSimT === null ? 0 : timeline.simToAnim(liveSimT);
    if (Math.abs(animT - clock.t) > LIVE_JUMP) snapCamera = true;
    clock.seek(animT);
  } else {
    clock.tick(dt);
  }
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
    // Live: the host's own simulation time (null, shown T+--:--, until a launch) and its rate.
    simT: live ? liveSimT : states.simT,
    warp: live ? live.clock.rate(now) : states.warp,
    beatId: states.beat ? states.beat.id : null,
    playing: clock.playing,
    speed: clock.speed,
    freeCam,
    readouts: states.readouts,
    live: live ? liveBadge(now) : undefined,
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
  // Live mode: { url, connected, status, simT, mismatch }, or null for the film.
  live: () => {
    if (!live) return null;
    const now = performance.now() / 1000;
    return { url: live.url, connected: live.connected, status: live.clock.status(now), simT: live.clock.simT(now), mismatch: live.mismatch };
  },
  scenario,
  timeline,
  // Debug handles for inspection from the console.
  scene: scene.scene,
  camera,
};
