// Scene dev harness. Serves at /dev/scene.html?t=30 under the Vite dev server.
//
// Hand-authored sample states in km (the shapes computeStates returns) for any animation time t, fed to the
// real scene with a renderer configured as in 4.4 (logarithmic depth, camera at the origin, the
// floating origin applied each frame) and the 5.7 camera for that beat. Nothing here is the
// simulation: the missile follows a smooth illustrative arc pinned to the brief's sample points
// (300 km up at t = 30, 1200 km at t = 60, intercept 1100 km up at t = 80), the kill vehicle a
// smooth arc from the interceptor satellite to the intercept point; the shells are real circular
// orbits (circularOrbitState) at 1000 and 10000 km advancing at their real mean motion.
//
// Query parameters:
//   t=<seconds>   animation time to show (check times 5 16 30 45 60 78 87; any value works)
//   orbit=1       free orbit (OrbitControls on a proxy camera about the beat's camera target,
//                 floating origin = pivot + proxy offset, as main.js does for free cam)
//   anim=1        advance t in real time from the given value (loops at 90)
//
// window.__sceneDev exposes { t, states, scene, camera, origin, setT(t) } for inspection.
// All parameters are generic and illustrative.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createScene } from '../src/scene/index.js';
import { circularOrbitState } from '../src/sim/kepler.js';
import { R_EARTH, MU, OMEGA_EARTH, DEG, G0 } from '../src/shared/constants.js';
import { latLonToEcef, localFrameEci, ecefToEci } from '../src/shared/geo.js';
import { remap, smoothstep, clamp, easeInOutCubic } from '../src/shared/easing.js';
import { BG, SENSOR, LINK, cssVars } from '../src/shared/palette.js';

export const CHECK_TIMES = [5, 16, 30, 45, 55, 60, 78, 80.4, 87];
const DURATION = 90;

// ---------------------------------------------------------------------------
// Harness anchors in simulation seconds (illustrative stand-ins for the scenario's values).

const K = {
  detect: 25,
  track: 40,
  link1: 60,
  link2: 80,
  assign: 100,
  burnout: 180,
  orient: 240,
  release: 300,
  intercept: 900,
};

// Beats of 5.6: fixed animation boundaries, simulation anchors from K.
const BEATS = [
  { id: 'establishing', label: 'Constellation', start: 0, end: 10, simStart: -60, simEnd: -4 },
  { id: 'launch', label: 'Launch', start: 10, end: 24, simStart: -4, simEnd: 10 },
  { id: 'boost', label: 'Boost and acquisition', start: 24, end: 38, simStart: 10, simEnd: K.track + 20 },
  { id: 'handoff', label: 'Handoff', start: 38, end: 50, simStart: K.track + 20, simEnd: K.assign + 10 },
  { id: 'engage', label: 'Engage', start: 50, end: 72, simStart: K.assign + 10, simEnd: K.intercept - 8 },
  { id: 'intercept', label: 'Intercept', start: 72, end: 84, simStart: K.intercept - 8, simEnd: K.intercept + 4 },
  { id: 'resolution', label: 'Resolution', start: 84, end: 90, simStart: K.intercept + 4, simEnd: K.intercept + 900 },
].map((b) => ({ ...b, warp: (b.simEnd - b.simStart) / (b.end - b.start) }));

function getBeat(t) {
  for (const b of BEATS) if (t >= b.start && t < b.end) return b;
  return t < 0 ? BEATS[0] : BEATS[BEATS.length - 1];
}
function animToSim(t) {
  const b = getBeat(t);
  return b.simStart + (t - b.start) * b.warp;
}
function simToAnim(s) {
  for (const b of BEATS) if (s >= b.simStart && s < b.simEnd) return b.start + (s - b.simStart) / b.warp;
  return s < BEATS[0].simStart ? 0 : DURATION;
}
const A = Object.fromEntries(Object.entries(K).map(([k, s]) => [k, simToAnim(s)]));
A.ignition = simToAnim(0);

// ---------------------------------------------------------------------------
// Geometry

const SITE = { lat: 50, lon: 90 };
const SITE_ECEF = latLonToEcef(SITE.lat, SITE.lon, 0);
const LAUNCH_AZIMUTH_DEG = 55; // illustrative
const APOGEE_KM = 1300; // illustrative arc for the harness
const RANGE_KM = 8400; // illustrative
const GROUND_LIFT_KM = 0.002; // the woodland tile is raised 2 m (terrain.js)

const theta = (s) => OMEGA_EARTH * s;
const siteEci = (s) => ecefToEci(SITE_ECEF, theta(s));

// Missile arc in ECI from the site at ignition: downrange angle phi = sigma * range, altitude
// 4 H sigma (1 - sigma). sigma(t) is pinned to the brief's sample points.
const SITE0 = siteEci(0);
const F0 = localFrameEci(SITE0);
const AZ_DIR = F0.north.clone().multiplyScalar(Math.cos(LAUNCH_AZIMUTH_DEG * DEG)).addScaledVector(F0.east, Math.sin(LAUNCH_AZIMUTH_DEG * DEG));
const U0 = SITE0.clone().normalize();
const SIGMA_KEYS = [
  [24, 0.0002],
  [30, 0.0612], // 300 km up
  [45, 0.222],
  [60, 0.361], // 1200 km up
  [72, 0.6868],
  [80, 0.693], // intercept, 1100 km up (descending)
  [90, 0.6998],
];
function sigmaAt(t) {
  if (t <= SIGMA_KEYS[0][0]) return SIGMA_KEYS[0][1];
  for (let i = 0; i + 1 < SIGMA_KEYS.length; i++) {
    const [t0, s0] = SIGMA_KEYS[i];
    const [t1, s1] = SIGMA_KEYS[i + 1];
    if (t <= t1) return s0 + ((s1 - s0) * (t - t0)) / (t1 - t0);
  }
  return SIGMA_KEYS[SIGMA_KEYS.length - 1][1];
}
function arcPoint(sigma) {
  const phi = (sigma * RANGE_KM) / R_EARTH;
  const alt = 4 * APOGEE_KM * sigma * (1 - sigma);
  return U0.clone().multiplyScalar(Math.cos(phi)).addScaledVector(AZ_DIR, Math.sin(phi)).normalize().multiplyScalar(R_EARTH + alt);
}
/** Missile tail position (ECI km) at animation time t >= ignition. */
function missileAt(t) {
  if (t < BEATS[2].start) {
    // Launch beat at real time: straight up out of the canister on the rotating site.
    const s = Math.max(0, animToSim(t));
    const site = siteEci(s);
    const up = site.clone().normalize();
    return site.addScaledVector(up, 0.5 * (0.03 - G0) * s * s); // illustrative net acceleration
  }
  return arcPoint(sigmaAt(t));
}
const INTERCEPT_POINT = arcPoint(sigmaAt(A.intercept));

// Shells (5.2): circular orbits at their real mean motion.
const SHELL_I = { planes: 6, perPlane: 12, altKm: 1000, incDeg: 55, phaseDeg: 0 };
const SHELL_S = { planes: 2, perPlane: 4, altKm: 10000, incDeg: 60 };
const meanMotionDeg = (altKm) => Math.sqrt(MU / Math.pow(R_EARTH + altKm, 3)) / DEG;

const shellI = [];
for (let p = 0; p < SHELL_I.planes; p++) {
  for (let s = 0; s < SHELL_I.perPlane; s++) {
    shellI.push({ id: `i-${p}-${s}`, raanDeg: 30 * p, argLat0Deg: 30 * s + 5 * p + SHELL_I.phaseDeg });
  }
}
// Sensor-shell phase searched so one satellite's nadir is nearest the site at ignition (5.4).
function buildSensorShell(phase) {
  const out = [];
  for (let p = 0; p < SHELL_S.planes; p++) {
    for (let s = 0; s < SHELL_S.perPlane; s++) out.push({ id: `s-${p}-${s}`, raanDeg: 90 * p, argLat0Deg: 90 * s + phase });
  }
  return out;
}
const shellPos = (sat, altKm, incDeg, simT) =>
  circularOrbitState(altKm, incDeg, sat.raanDeg, sat.argLat0Deg + meanMotionDeg(altKm) * simT).r;
const posI = (sat, s) => shellPos(sat, SHELL_I.altKm, SHELL_I.incDeg, s);
const posS = (sat, s) => shellPos(sat, SHELL_S.altKm, SHELL_S.incDeg, s);

let shellS = buildSensorShell(0);
let sensorPick = shellS[0];
{
  let best = Infinity;
  const site = U0;
  for (let phase = 0; phase < 360; phase++) {
    const shell = buildSensorShell(phase);
    for (const sat of shell) {
      const d = Math.acos(clamp(posS(sat, 0).normalize().dot(site), -1, 1)) * R_EARTH;
      if (d < best) {
        best = d;
        shellS = shell;
        sensorPick = sat;
      }
    }
  }
  sensorPick = shellS.find((s) => s.id === sensorPick.id);
}

function segmentClearsSphere(a, b, radius) {
  const d = b.clone().sub(a);
  const len2 = d.lengthSq();
  const s = len2 > 0 ? clamp(-a.dot(d) / len2, 0, 1) : 0;
  return a.clone().addScaledVector(d, s).length() > radius;
}

// Interceptor satellite: the shell member nearest the intercept point at release.
let interceptorPick = shellI[0];
{
  let best = Infinity;
  for (const sat of shellI) {
    const d = posI(sat, K.release).distanceTo(INTERCEPT_POINT);
    if (d < best) {
      best = d;
      interceptorPick = sat;
    }
  }
}
// Relay: line of sight to both ends at both link times, minimum summed distance (5.5).
let relayPick = null;
{
  let best = Infinity;
  for (const sat of shellI) {
    if (sat === interceptorPick) continue;
    let ok = true;
    let sum = 0;
    for (const s of [K.link1, K.link2]) {
      const r = posI(sat, s);
      const a = posS(sensorPick, s);
      const b = posI(interceptorPick, s);
      if (!segmentClearsSphere(r, a, R_EARTH) || !segmentClearsSphere(r, b, R_EARTH)) ok = false;
      sum += r.distanceTo(a) + r.distanceTo(b);
    }
    if (ok && sum < best) {
      best = sum;
      relayPick = sat;
    }
  }
  if (!relayPick) relayPick = shellI.find((s) => s !== interceptorPick);
}

// Kill vehicle: quadratic arc from the tube mouth at release to the intercept point, bulging
// outward; parameter linear in simulation time.
const REL_SAT = posI(interceptorPick, K.release);
const KV_CTRL = (() => {
  const mid = REL_SAT.clone().add(INTERCEPT_POINT).multiplyScalar(0.5);
  return mid.addScaledVector(mid.clone().normalize(), 0.15 * REL_SAT.distanceTo(INTERCEPT_POINT));
})();
const DEPART_DIR = KV_CTRL.clone().sub(REL_SAT).normalize();
const KV_START = REL_SAT.clone().addScaledVector(DEPART_DIR, 0.003);
const kvCurve = new THREE.QuadraticBezierCurve3(KV_START, KV_CTRL, INTERCEPT_POINT.clone());
const kvParam = (s) => clamp((s - K.release) / (K.intercept - K.release), 0, 1);
const kvAt = (t) => kvCurve.getPoint(kvParam(animToSim(t)));

// ---------------------------------------------------------------------------
// Helpers

function sampleTrail(at, t0, t1, maxPoints = 256) {
  if (!(t1 > t0)) return [];
  const n = clamp(Math.ceil((t1 - t0) / 0.1) + 1, 2, maxPoints);
  const out = [];
  for (let i = 0; i < n; i++) out.push(at(t0 + ((t1 - t0) * i) / (n - 1)));
  return out;
}

/** Trail from the actor's start to now, retracting to empty over 3 s after the intercept. */
function trailFor(at, tStart, t) {
  if (t < tStart) return [];
  if (t < A.intercept) return sampleTrail(at, tStart, t);
  const k = (t - A.intercept) / 3;
  if (k >= 1) return [];
  return sampleTrail(at, tStart + (A.intercept - tStart) * k, A.intercept);
}

/** Unit direction of travel by finite difference in animation time. */
function travelDir(at, t, fallback) {
  const a = at(t - 0.02);
  const b = at(t + 0.02);
  const d = b.sub(a);
  return d.lengthSq() > 1e-18 ? d.normalize() : fallback.clone();
}

const fmt = (x) => x.toFixed(2);

// ---------------------------------------------------------------------------
// Sample states for animation time t.

export function sampleStates(t) {
  const beat = getBeat(t);
  const simT = animToSim(t);
  const site = siteEci(simT);
  const frame = localFrameEci(site);

  // Launcher (rotates with the Earth).
  const launcher = {
    position: site.clone(),
    up: frame.up.clone(),
    east: frame.east.clone(),
    north: frame.north.clone(),
    erectAngleDeg: 90 * easeInOutCubic(remap(simT, -45, -10)),
    lidOpen: remap(simT, -0.5, 0),
    outriggers: remap(simT, -60, -45),
    visible: true,
  };

  // Missile.
  const ignited = t >= A.ignition;
  const mGone = t >= A.intercept;
  const mPos = ignited ? missileAt(Math.min(t, A.intercept)) : site.clone();
  const mDir = ignited ? travelDir(missileAt, Math.max(t, A.ignition + 0.03), frame.up) : frame.up.clone();
  const warp = beat.warp;
  const mVel = ignited ? travelDir(missileAt, Math.max(t, A.ignition + 0.03), frame.up) : new THREE.Vector3();
  const mSpeed = ignited ? missileAt(t + 0.01).distanceTo(missileAt(t - 0.01)) / (0.02 * warp) : 0;
  mVel.multiplyScalar(mSpeed);
  const missile = {
    position: mPos,
    velocity: mVel,
    direction: mDir,
    altKm: mPos.length() - R_EARTH,
    speedKms: mSpeed,
    phase: !ignited ? 'seated' : mGone ? 'gone' : simT < K.burnout ? 'boost' : 'coast',
    visible: ignited && !mGone,
    plume: ignited && !mGone ? 1 - remap(simT, K.burnout - 2, K.burnout) : 0,
    trail: trailFor(missileAt, A.ignition, t),
  };

  // Sensor satellite and its cone.
  const sPos = posS(sensorPick, simT);
  const nadirAim = (s) => {
    const p = posS(sensorPick, s);
    const sub = p.clone().normalize().multiplyScalar(R_EARTH);
    const aim = sub.addScaledVector(localFrameEci(sub).east, 150).sub(p);
    const yaw = 10 * Math.sin((2 * Math.PI * s) / 8) * DEG;
    return p.clone().add(aim.applyAxisAngle(p.clone().negate().normalize(), yaw));
  };
  let coneTarget;
  if (t < A.detect) coneTarget = nadirAim(simT);
  else coneTarget = nadirAim(K.detect).lerp(mPos, smoothstep(remap(simT, K.detect, K.detect + 0.5)));
  let coneOpacity = 0;
  if (t >= 10 && t < A.intercept) {
    coneOpacity = 0.15;
    if (t >= A.detect) coneOpacity += 0.35 * (1 - remap(t, A.detect, A.detect + 1));
  }
  const sensorSat = {
    position: sPos,
    velocity: new THREE.Vector3(),
    coneTarget,
    coneOpacity,
    detectPulse: t >= A.detect && t <= A.detect + 1 ? remap(t, A.detect, A.detect + 1) : 0,
    tracking: t >= A.track && t < A.intercept,
    visible: true,
  };

  // Relay.
  const rPos = posI(relayPick, simT);
  const settle = 1 - remap(t, BEATS[6].start, BEATS[6].start + 2);
  const relaySat = {
    position: rPos,
    velocity: new THREE.Vector3(),
    highlight: 0.3 + 0.7 * smoothstep(remap(t, A.link1 + 3, A.link1 + 3.6)) * settle,
    visible: true,
  };

  // Interceptor satellite: facing slews from nadir to the departure direction.
  const iPos = posI(interceptorPick, simT);
  const nadir = iPos.clone().negate().normalize();
  const facing = nadir.clone().lerp(DEPART_DIR, smoothstep(remap(simT, K.orient, K.release))).normalize();
  const interceptorSat = {
    position: iPos,
    velocity: new THREE.Vector3(),
    facing,
    highlight: 0.3 + 0.7 * smoothstep(remap(t, A.assign, A.assign + 0.6)) * settle,
    visible: true,
  };

  // Kill vehicle.
  const released = t >= A.release;
  const kGone = t >= A.intercept;
  const kPos = released ? kvAt(Math.min(t, A.intercept)) : KV_START.clone();
  const kDir = released ? kvCurve.getTangent(clamp(kvParam(simT), 1e-4, 1)) : DEPART_DIR.clone();
  const kv = {
    position: kPos,
    velocity: kDir.clone(),
    direction: kDir,
    altKm: kPos.length() - R_EARTH,
    speedKms: 0,
    phase: !released ? 'stowed' : kGone ? 'gone' : simT < K.release + 2 ? 'burn' : 'coast',
    visible: released && !kGone,
    plume: released && !kGone && simT < K.release + 2 ? 1 : 0,
    trail: trailFor(kvAt, A.release, t),
  };

  // Links (5.5): track line, then the two handoff beams with a 3 s pulse and a 0.25 linger.
  const beams = [];
  if (t >= A.track && t < A.intercept) {
    beams.push({ id: 'track', from: sPos.clone(), to: mPos.clone(), opacity: 0.6, pulse: null, color: SENSOR, dashed: true });
  }
  const hop = (id, start, from, to) => {
    if (t < start || t >= BEATS[6].start) return;
    const p = (t - start) / 3;
    beams.push({ id, from: from.clone(), to: to.clone(), opacity: p < 1 ? 0.85 : 0.25, pulse: p < 1 ? p : null, color: LINK, dashed: false });
  };
  hop('link1', A.link1, sPos, rPos);
  hop('link2', A.link2, rPos, iPos);

  // Intercept effects (the Intercept beat runs at real time).
  const dt = t - A.intercept;
  const intercept = {
    active: dt >= 0 && dt < 5,
    flash: dt < 0 ? 0 : dt < 0.3 ? dt / 0.3 : 1 - remap(dt, 0.3, 1.5),
    ring: dt < 0 ? 0 : remap(dt, 0, 1.5),
    burst: dt < 0 ? 0 : remap(dt, 0, 3),
    shake: dt < 0 ? 0 : 1 - remap(dt, 0, 1),
    position: INTERCEPT_POINT.clone(),
  };

  // Constellation.
  const constellation = {
    interceptor: shellI.map((s) => posI(s, simT)),
    sensor: shellS.map((s) => posS(s, simT)),
    orbits: {
      interceptor: Array.from({ length: SHELL_I.planes }, (_, p) => ({ raanDeg: 30 * p, incDeg: SHELL_I.incDeg, altKm: SHELL_I.altKm })),
      sensor: Array.from({ length: SHELL_S.planes }, (_, p) => ({ raanDeg: 90 * p, incDeg: SHELL_S.incDeg, altKm: SHELL_S.altKm })),
    },
  };

  // Labels (5.11). The launcher label sits on the cab (22.5 m forward, 3.5 m up, on the raised tile).
  const cab = site.clone().addScaledVector(frame.north, 0.0225).addScaledVector(frame.up, 0.0035 + GROUND_LIFT_KM);
  const labels = [
    { id: 'sensorSat', text: 'SENSOR SAT', position: sPos.clone(), visible: true },
    { id: 'interceptorSat', text: 'INTERCEPTOR SAT', position: iPos.clone(), visible: true },
    { id: 'relay', text: 'RELAY', position: rPos.clone(), visible: t >= 4 },
    { id: 'launcher', text: 'MOBILE LAUNCHER', position: cab, visible: beat.id === 'launch' },
    { id: 'threat', text: 'THREAT', position: mPos.clone(), visible: t >= A.ignition + 1 && t < A.intercept },
    { id: 'track', text: 'TRACK', position: mPos.clone(), visible: t >= A.track && t < A.intercept },
    { id: 'assigned', text: 'TARGET ASSIGNED', position: iPos.clone(), visible: t >= A.assign && t < A.assign + 3 },
    { id: 'kv', text: 'INTERCEPTOR', position: kPos.clone(), visible: kv.visible },
    { id: 'intercept', text: 'INTERCEPT', position: INTERCEPT_POINT.clone(), visible: dt >= 0 && dt < 4 },
  ];

  const readouts = [
    { id: 'alt', label: 'THREAT ALT', value: `${Math.round(missile.altKm).toLocaleString('en-US')} km` },
    { id: 'spd', label: 'THREAT SPD', value: `${fmt(mSpeed)} km/s` },
  ];

  const states = {
    animT: t,
    simT,
    warp,
    beat,
    earth: { theta: theta(simT) },
    launcher,
    missile,
    kv,
    sensorSat,
    relaySat,
    interceptorSat,
    constellation,
    links: { beams },
    intercept,
    labels,
    readouts,
    camera: null,
  };
  states.camera = cameraFor(t, states);
  return states;
}

// ---------------------------------------------------------------------------
// The 5.7 camera for each beat (no smoothing; main.js smooths, the harness hard-sets).

function cameraFor(t, s) {
  const R = R_EARTH;
  const beat = s.beat;
  const site = s.launcher.position;
  const siteFrame = localFrameEci(site);
  const siteDir = siteFrame.up;
  const local = smoothstep(remap(t, beat.start, beat.end));
  const position = new THREE.Vector3();
  const target = new THREE.Vector3();
  let fov = 50;
  let shake = 0;
  switch (beat.id) {
    case 'establishing': {
      const p0 = siteDir.clone().multiplyScalar(4.0 * R).addScaledVector(siteFrame.north, 0.8 * R);
      const p1 = siteDir.clone().multiplyScalar(3.3 * R).addScaledVector(siteFrame.north, 0.6 * R);
      position.lerpVectors(p0, p1, local);
      break;
    }
    case 'launch': {
      fov = 55;
      position.copy(site).addScaledVector(siteFrame.up, 0.03).addScaledVector(siteFrame.east, 0.12).addScaledVector(siteFrame.north, -0.05);
      if (t < A.ignition) target.copy(site).addScaledVector(siteFrame.up, 0.01);
      else target.copy(s.missile.position).addScaledVector(siteFrame.up, 0.01);
      break;
    }
    case 'boost': {
      const m = s.missile.position;
      const up = localFrameEci(m).up;
      position.copy(m).addScaledVector(s.missile.direction, -4).addScaledVector(up, 1.5);
      target.copy(m);
      break;
    }
    case 'handoff': {
      const mid = s.sensorSat.position.clone().add(s.interceptorSat.position).multiplyScalar(0.5);
      const f = localFrameEci(mid);
      position.copy(mid).addScaledVector(f.up, 1.2 * R).addScaledVector(f.east, 0.4 * R);
      target.copy(s.relaySat.position);
      break;
    }
    case 'engage': {
      const sat = s.interceptorSat.position;
      const fs = localFrameEci(sat);
      const pre = sat.clone().addScaledVector(fs.up, 0.03).addScaledVector(fs.east, 0.03).addScaledVector(s.interceptorSat.facing, -0.02);
      if (t < A.release) {
        position.copy(pre);
        target.copy(sat);
      } else {
        const k = s.kv.position;
        const fk = localFrameEci(k);
        const post = k.clone().addScaledVector(s.kv.direction, -0.06).addScaledVector(fk.up, 0.02);
        const b = smoothstep(remap(t, A.release, A.release + 0.4));
        position.lerpVectors(pre, post, b);
        target.lerpVectors(sat, k, b);
      }
      break;
    }
    case 'intercept': {
      const f = localFrameEci(INTERCEPT_POINT);
      position.copy(INTERCEPT_POINT).addScaledVector(f.up, 2).addScaledVector(f.east, 3).addScaledVector(f.north, 1);
      target.copy(INTERCEPT_POINT);
      shake = s.intercept.shake;
      break;
    }
    default: {
      const p0 = INTERCEPT_POINT.clone().addScaledVector(INTERCEPT_POINT.clone().normalize(), 200);
      const p1 = siteDir.clone().multiplyScalar(3.5 * R).addScaledVector(siteFrame.north, 0.7 * R);
      position.lerpVectors(p0, p1, local);
      target.lerpVectors(INTERCEPT_POINT, new THREE.Vector3(), local);
      break;
    }
  }
  const alt = position.length() - R;
  const up = alt < 50 ? position.clone().normalize() : new THREE.Vector3(0, 1, 0);
  return { position, target, up, fov, shake };
}

// ---------------------------------------------------------------------------
// Boot (browser only).

function boot() {
  for (const [k, v] of Object.entries(cssVars())) document.documentElement.style.setProperty(k, v);

  const params = new URLSearchParams(location.search);
  let t = Number.parseFloat(params.get('t'));
  if (!Number.isFinite(t)) t = 5;
  t = clamp(t, 0, DURATION - 1e-3);
  const orbit = params.get('orbit') === '1';
  const anim = params.get('anim') === '1';

  const canvas = document.getElementById('gl');
  const labelContainer = document.getElementById('labels');
  // Renderer as in src/main.js.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(BG, 1);

  const scene = createScene({ renderer, labelContainer, width: window.innerWidth, height: window.innerHeight });
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 300000);
  camera.position.set(0, 0, 0); // never moves: floating origin

  const origin = new THREE.Vector3();
  const lookDir = new THREE.Vector3();
  const shakeOffset = new THREE.Vector3();
  let states = sampleStates(t);

  // Free orbit about a pivot fixed in ECI (the beat's camera target), as main.js does.
  let controls = null;
  const pivot = new THREE.Vector3();
  const proxy = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 300000);
  function startOrbit() {
    pivot.copy(states.camera.target);
    proxy.up.copy(states.camera.up);
    proxy.position.copy(states.camera.position).sub(pivot);
    if (proxy.position.lengthSq() < 1e-12) proxy.position.set(0, 0, 1);
    proxy.lookAt(0, 0, 0);
    proxy.fov = states.camera.fov;
    proxy.updateProjectionMatrix();
    controls = new OrbitControls(proxy, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.002;
    controls.maxDistance = 150000;
    controls.update();
  }
  if (orbit) startOrbit();

  function setT(next) {
    t = clamp(next, 0, DURATION - 1e-3);
    states = sampleStates(t);
    renderNav();
  }

  function renderNav() {
    const nav = document.getElementById('harness');
    if (!nav) return;
    const links = CHECK_TIMES.map((c) => {
      const q = new URLSearchParams(params);
      q.set('t', String(c));
      const on = Math.abs(c - t) < 1e-6 ? ' class="on"' : '';
      return `<a href="?${q.toString()}"${on}>t=${c}</a>`;
    }).join('');
    const s = states;
    nav.innerHTML =
      `<div class="title">scene harness  t=${t.toFixed(2)}  ${s.beat.label}  sim T${s.simT < 0 ? '-' : '+'}${Math.abs(s.simT).toFixed(1)} s  x${s.warp.toFixed(1)}</div>` +
      `<div>${links}</div>` +
      `<div>missile alt ${s.missile.altKm.toFixed(1)} km  camera alt ${(s.camera.position.length() - R_EARTH).toFixed(3)} km</div>` +
      `<div>&amp;orbit=1 free orbit, &amp;anim=1 play from t</div>`;
  }

  function aimScripted(cam) {
    const shake = Number.isFinite(cam.shake) ? cam.shake : 0;
    if (shake > 0) {
      const k = t * 60;
      const amp = shake * 0.008 * cam.position.distanceTo(cam.target);
      shakeOffset.set(Math.sin(k * 1.7) * Math.cos(k * 0.9), Math.sin(k * 2.3 + 1.3), Math.cos(k * 1.1 + 0.4) * Math.sin(k * 0.7)).multiplyScalar(amp);
    } else {
      shakeOffset.set(0, 0, 0);
    }
    origin.copy(cam.position).add(shakeOffset);
    camera.up.copy(cam.up);
    lookDir.copy(cam.target).sub(origin);
    if (lookDir.lengthSq() > 1e-18) camera.lookAt(lookDir);
    if (Number.isFinite(cam.fov) && camera.fov !== cam.fov) {
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
    }
  }

  renderNav();

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (anim) {
      let next = t + dt;
      if (next >= DURATION) next = 0;
      setT(next);
    }
    if (controls) {
      controls.update();
      origin.copy(pivot).add(proxy.position);
      camera.quaternion.copy(proxy.quaternion);
      camera.up.copy(proxy.up);
      if (camera.fov !== proxy.fov) {
        camera.fov = proxy.fov;
        camera.updateProjectionMatrix();
      }
    } else {
      aimScripted(states.camera);
    }
    // The scene sees the origin actually used this frame (as in main.js).
    const frameStates = { ...states, camera: { ...states.camera, position: origin.clone() } };
    scene.update(frameStates);
    scene.render(camera);
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    proxy.aspect = w / h;
    proxy.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    scene.resize(w, h);
  });

  window.__sceneDev = {
    get t() {
      return t;
    },
    get states() {
      return states;
    },
    scene,
    camera,
    origin: () => origin.clone(),
    setT,
    anchors: { K, A },
    picks: { sensor: sensorPick.id, relay: relayPick.id, interceptor: interceptorPick.id },
  };
}

if (typeof document !== 'undefined' && document.getElementById && document.getElementById('gl')) boot();
