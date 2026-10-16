// Scenario builder.
//
// buildScenario(params) runs once at load and returns the whole engagement as data plus pure
// state functions:
//   1. the missile boost, integrated with RK4 under thrust and point-mass gravity with a
//      programmed pitch-over (5.3), then a Kepler coast to impact;
//   2. the two shells as circular Kepler orbits at their real mean motion (5.2);
//   3. the sensor satellite (PHASE_S search) and the detection time from cone and line-of-sight
//      geometry (5.4);
//   4. the handoff latencies, the minimum delta-v Lambert engagement over every interceptor-shell
//      satellite, release time and intercept time (PHASE_I search), and the relay (5.5);
//   5. the event log (5.9).
//
// Pure and Node-importable: no DOM, no JSON imports, three.js math only. Positions ECI km,
// velocities km/s, times seconds from ignition. Every state function returns fresh vectors.
//
// Fidelity: textbook two-body physics about a spherical rotating Earth.
// Every vehicle, sensor and constellation number below is a generic round value chosen for the
// picture (illustrative) and corresponds to no real system.

import { Vector3 } from 'three';
import { R_EARTH, MU, DEG } from '../shared/constants.js';
import {
  latLonToEcef,
  localFrameEci,
  ecefToEci,
  eciToEcef,
  earthRotationAngle,
  siteVelocityEci,
  greatCircleDistance,
} from '../shared/geo.js';
import { smoothstep, clamp } from '../shared/easing.js';
import { propagateKepler, circularOrbitState, apsides } from './kepler.js';
import { lambert } from './lambert.js';
import { rk4Step, gravityAccel } from './integrate.js';
import { segmentClearsSphere, inCone } from './los.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Model parameters. All illustrative: generic round numbers chosen for
 * the picture. The thrust accelerations and PITCH_FINAL are the tuned values of 5.3 (starting
 * values 0.030, 0.040, 0.055 km/s^2 and 25 degrees); see the decisions log.
 */
export const DEFAULT_PARAMS = deepFreeze({
  site: { lat: 50, lon: 90 }, // illustrative generic interior point (5.1)
  launchAzimuthDeg: 55, // illustrative, degrees east of north (5.3)
  thrustPhases: [
    { duration: 60, accel: 0.035 }, // illustrative, km/s^2 (tuned from 0.030)
    { duration: 60, accel: 0.045 }, // illustrative, km/s^2 (tuned from 0.040)
    { duration: 60, accel: 0.065 }, // illustrative, km/s^2 (tuned from 0.055)
  ],
  pitch: { verticalUntil: 10, rampEnd: 150, finalDeg: 0 }, // illustrative; finalDeg is PITCH_FINAL (tuned from 25)
  integrator: { dt: 0.05, sampleEvery: 0.5 }, // RK4 step and boost sample spacing, s
  coast: { scanStep: 10, bisectTol: 0.01, pathStep: 2 }, // s
  interceptorShell: {
    planes: 6, // illustrative
    perPlane: 12, // illustrative
    altKm: 1000, // illustrative
    incDeg: 55, // illustrative
    raanStepDeg: 30, // illustrative
    slotStepDeg: 30, // 360 / perPlane
    interPlanePhaseDeg: 5, // illustrative
  },
  sensorShell: {
    raansDeg: [0, 90], // illustrative
    perPlane: 4, // illustrative
    altKm: 10000, // illustrative
    incDeg: 60, // illustrative
    slotStepDeg: 90, // 360 / perPlane
  },
  phaseIDeg: null, // PHASE_I; null = searched (5.5)
  phaseSDeg: null, // PHASE_S; null = searched (5.4)
  phaseSearch: { sStepDeg: 1, iStepDeg: 2, sensorNadirMaxKm: 800 },
  sensor: {
    coneHalfAngleDeg: 8, // illustrative
    widenStepDeg: 2,
    maxConeHalfAngleDeg: 30,
    nadirOffsetKm: 150, // illustrative: the aim point, east of the sub-satellite point
    detectFrom: 3, // s, first sample time considered
    trackDelay: 15, // s, illustrative (tTrack = tDetect + 15)
  },
  latencies: { link1: 20, link2: 20, assign: 20 }, // s, illustrative
  // Engagement search window and kill-vehicle release (5.5), all illustrative.
  engagement: {
    releaseMin: 60, // s after tAssign
    releaseMax: 400,
    releaseStep: 10,
    tofMin: 120, // s
    tofMax: 700,
    tofStep: 10,
    impactMargin: 300, // s before impact
    minArcAltKm: 150, // transfer arc floor above R_EARTH
    arcSampleStep: 10, // s
    deltaVCapKms: 3, // illustrative
    deltaVCapFallbackKms: 4, // illustrative, used only if no solution under the cap exists
    orientLead: 240, // s, illustrative: tOrient = tRelease - 240 (5.5 said 60; slowed in Phase 2 follow-up)
    slewAccelFraction: 0.2, // illustrative: thrusters spin the slew up over the first 20 % and brake over the last 20 %
    tubeOffsetKm: 0.003, // kill vehicle starts 3 m out along the tube axis
    burnDuration: 2, // s, plume on after release
  },
});

// Pruning factor of the engagement search: a transfer with delta-v |dV| over a time of flight
// T ends at most K |dV| T from where the satellite itself would have drifted (two-body, T from
// 120 to 700 s from a 1000 km orbit, random directions: measured maximum 1.18 for |dV| up to
// 3 km/s and 1.22 up to 4 km/s). Candidates whose distance-over-time already exceeds K times
// the best delta-v found so far cannot beat it and are skipped unsolved.
const PRUNE_K = 1.4;
const KV_BURN_DT = 0.01; // s, RK4 step and table spacing of the kill-vehicle kick burn

const _tmp = new Vector3();

// ---------------------------------------------------------------------------
// Shells

/** A circular-orbit shell satellite (5.2) with stateAt(t) at its real mean motion. */
function makeShellSat(id, plane, slot, altKm, incDeg, raanDeg, argLat0Deg) {
  const a = R_EARTH + altKm;
  const meanMotionDegS = Math.sqrt(MU / (a * a * a)) / DEG;
  return {
    id,
    plane,
    slot,
    altKm,
    incDeg,
    raanDeg,
    argLat0Deg,
    meanMotionDegS,
    stateAt: (t) => circularOrbitState(altKm, incDeg, raanDeg, argLat0Deg + meanMotionDegS * t),
  };
}

function buildInterceptorShell(shell, phaseI) {
  const sats = [];
  for (let p = 0; p < shell.planes; p++) {
    for (let s = 0; s < shell.perPlane; s++) {
      const argLat0 = shell.slotStepDeg * s + shell.interPlanePhaseDeg * p + phaseI;
      const id = `INT-${p + 1}-${String(s + 1).padStart(2, '0')}`;
      sats.push(makeShellSat(id, p, s, shell.altKm, shell.incDeg, shell.raanStepDeg * p, argLat0));
    }
  }
  return sats;
}

function buildSensorShell(shell, phaseS) {
  const sats = [];
  shell.raansDeg.forEach((raan, p) => {
    for (let s = 0; s < shell.perPlane; s++) {
      const id = `SEN-${p + 1}-${s + 1}`;
      sats.push(makeShellSat(id, p, s, shell.altKm, shell.incDeg, raan, shell.slotStepDeg * s + phaseS));
    }
  });
  return sats;
}

/** Plane basis of the v1 ring convention (kepler.js circularOrbitState). */
function planeBasis(incDeg, raanDeg) {
  const inc = incDeg * DEG;
  const raan = raanDeg * DEG;
  return {
    nx: Math.sin(raan),
    nz: Math.cos(raan),
    mx: Math.cos(inc) * Math.cos(raan),
    my: Math.sin(inc),
    mz: -Math.cos(inc) * Math.sin(raan),
  };
}

// ---------------------------------------------------------------------------
// Missile: boost (RK4) and coast (Kepler)

function thrustMagnitude(phases, t) {
  let start = 0;
  for (const ph of phases) {
    if (t < start + ph.duration) return t >= start ? ph.accel : 0;
    start += ph.duration;
  }
  return 0;
}

/**
 * Thrust direction at ECI position r and time t (5.3): local up for the first verticalUntil
 * seconds, then rotating in the vertical plane of the launch azimuth from 90 degrees above the
 * local horizontal to PITCH_FINAL by smoothstep between verticalUntil and rampEnd, then held.
 * The local frame is evaluated at the current position.
 */
function makeThrustDirection(params) {
  const az = params.launchAzimuthDeg * DEG;
  const cAz = Math.cos(az);
  const sAz = Math.sin(az);
  const { verticalUntil, rampEnd, finalDeg } = params.pitch;
  return function thrustDirection(r, t) {
    const { up, east, north } = localFrameEci(r);
    const pitch = (90 - (90 - finalDeg) * smoothstep(t, verticalUntil, rampEnd)) * DEG;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    return new Vector3()
      .addScaledVector(north, cAz * cp)
      .addScaledVector(east, sAz * cp)
      .addScaledVector(up, sp);
  };
}

function buildMissile(params, rEcef) {
  const { dt, sampleEvery } = params.integrator;
  const phases = params.thrustPhases;
  const tBurnout = phases.reduce((s, ph) => s + ph.duration, 0);
  const thrustDirection = makeThrustDirection(params);

  // One RK4 step from (r, v) at t; the thrust magnitude is taken at the step midpoint so a
  // step never straddles a phase change (the phase boundaries fall on step boundaries).
  const step = (r, v, t, h) => {
    const mag = thrustMagnitude(phases, t + h / 2);
    return rk4Step(r, v, t, h, (rr, vv, tt) => gravityAccel(rr).addScaledVector(thrustDirection(rr, tt), mag));
  };

  // Initial state: the site's ECI position and velocity (theta = 0 at ignition, so the
  // site's ECEF and ECI positions coincide; the Earth's rotation is inherited).
  const r0 = rEcef.clone();
  const v0 = siteVelocityEci(r0);
  const steps = Math.round(tBurnout / dt);
  const every = Math.max(1, Math.round(sampleEvery / dt));
  const boost = [{ t: 0, r: r0.clone(), v: v0.clone() }];
  let r = r0;
  let v = v0;
  for (let i = 0; i < steps; i++) {
    const s = step(r, v, i * dt, dt);
    r = s.r;
    v = s.v;
    if ((i + 1) % every === 0) boost.push({ t: ((i + 1) / every) * sampleEvery, r: r.clone(), v: v.clone() });
    else if (i + 1 === steps) boost.push({ t: tBurnout, r: r.clone(), v: v.clone() });
  }
  const burnout = { t: tBurnout, r: r.clone(), v: v.clone() };

  const boostState = (t) => {
    let k = Math.min(boost.length - 1, Math.max(0, Math.floor(t / sampleEvery + 1e-9)));
    while (k > 0 && boost[k].t > t) k--;
    let { r: rr, v: vv, t: tt } = boost[k];
    rr = rr.clone();
    vv = vv.clone();
    while (t - tt > 1e-9) {
      const h = Math.min(dt, t - tt);
      const s = step(rr, vv, tt, h);
      rr = s.r;
      vv = s.v;
      tt += h;
    }
    return { r: rr, v: vv };
  };
  const coastState = (t) => propagateKepler(burnout.r, burnout.v, t - tBurnout);

  // Apogee (radial velocity changes sign) and impact (first |r| < R_EARTH), scanned on the
  // coast then bisected to the tolerance.
  const { scanStep, bisectTol, pathStep } = params.coast;
  const radialRate = (t) => {
    const s = coastState(t);
    return s.r.dot(s.v);
  };
  let tApogee = tBurnout;
  if (radialRate(tBurnout) > 0) {
    let a = tBurnout;
    while (radialRate(a + scanStep) > 0 && a < tBurnout + 20000) a += scanStep;
    let b = a + scanStep;
    while (b - a > bisectTol) {
      const m = 0.5 * (a + b);
      if (radialRate(m) > 0) a = m;
      else b = m;
    }
    tApogee = 0.5 * (a + b);
  }
  let lo = tApogee;
  while (coastState(lo + scanStep).r.length() >= R_EARTH && lo < tBurnout + 40000) lo += scanStep;
  let hi = lo + scanStep;
  while (hi - lo > bisectTol) {
    const m = 0.5 * (lo + hi);
    if (coastState(m).r.length() < R_EARTH) hi = m;
    else lo = m;
  }
  const tImpact = hi;

  const rApogee = coastState(tApogee).r;
  const rImpact = coastState(tImpact).r;
  const impactEcef = eciToEcef(rImpact, earthRotationAngle(tImpact));
  const rangeKm = greatCircleDistance(rEcef, impactEcef);

  function stateAt(t) {
    if (!(t >= 0 && t <= tImpact)) return null;
    return t < tBurnout ? boostState(t) : coastState(t);
  }

  /** Thrust direction of the pitch program at time t and ECI position r (fresh unit vector). */
  function thrustDirectionAt(t, r) {
    return thrustDirection(r, t);
  }

  // Body axis: the thrust direction during boost; on the coast it turns from the burnout thrust
  // direction to the velocity direction over BODY_TURN seconds, then follows the velocity.
  const BODY_TURN = 20; // s, visual
  const burnoutAxis = thrustDirection(burnout.r, tBurnout);
  function directionAt(t) {
    const tc = Math.max(0, Math.min(t, tImpact));
    const s = tc < tBurnout ? boostState(tc) : coastState(tc);
    if (tc < tBurnout) return thrustDirection(s.r, tc);
    const vHat = s.v.clone().normalize();
    const w = smoothstep(tc, tBurnout, tBurnout + BODY_TURN);
    return w >= 1 ? vHat : slerpUnit(burnoutAxis, vHat, w);
  }

  // Path table for trails: the boost samples, then the coast every pathStep seconds.
  const pathT = boost.map((s) => s.t);
  const pathR = boost.map((s) => s.r.clone());
  for (let t = tBurnout + pathStep; t < tImpact; t += pathStep) {
    pathT.push(t);
    pathR.push(coastState(t).r);
  }

  return {
    boost,
    burnout,
    tApogee,
    tImpact,
    rangeKm,
    apogeeAltKm: rApogee.length() - R_EARTH,
    burnoutSpeedKms: burnout.v.length(),
    burnoutAltKm: burnout.r.length() - R_EARTH,
    impactEcef,
    stateAt,
    thrustDirectionAt,
    directionAt,
    path: { t: pathT, r: pathR },
  };
}

// ---------------------------------------------------------------------------
// Sensor: PHASE_S search, sweep, detection

/** Sub-satellite-point distance (km) from the site for the nearest sensor sat at t = 0. */
function nearestSensor(sats, rSite) {
  let best = null;
  for (const sat of sats) {
    const d = greatCircleDistance(sat.stateAt(0).r, rSite);
    if (!best || d < best.distanceKm) best = { sat, distanceKm: d };
  }
  return best;
}

/**
 * Sensor aim point (Phase 2 follow-up, replacing the 5.4 nadir sweep, whose yaw read as a wobble
 * at the Constellation beat's warp): the field of view is locked to the satellite, a fixed
 * nadirOffsetKm east of its sub-satellite point, so the footprint travels across the Earth with
 * the satellite's ground track and never swings.
 */
function makeAimPoint(sensorParams) {
  return function aimPoint(rSat) {
    const ssp = rSat.clone().setLength(R_EARTH);
    const { east } = localFrameEci(ssp);
    return ssp.addScaledVector(east, sensorParams.nadirOffsetKm);
  };
}

function findDetection(missile, sensorSat, sweepTarget, sensorParams, log) {
  let half = sensorParams.coneHalfAngleDeg;
  for (;;) {
    for (const s of missile.boost) {
      if (s.t < sensorParams.detectFrom || s.t >= missile.burnout.t) continue;
      const rSat = sensorSat.stateAt(s.t).r;
      const axis = sweepTarget(rSat, s.t).sub(rSat).normalize();
      if (inCone(rSat, axis, half * DEG, s.r) && segmentClearsSphere(rSat, s.r, R_EARTH)) {
        return { tDetect: s.t, coneHalfAngleDeg: half };
      }
    }
    if (half + sensorParams.widenStepDeg > sensorParams.maxConeHalfAngleDeg) {
      throw new Error(`buildScenario: no detection before burnout with cones up to ${half} degrees`);
    }
    half += sensorParams.widenStepDeg;
    log.push(`sensor cone widened to ${half} degrees: no detection before burnout at ${half - sensorParams.widenStepDeg}`);
  }
}

// ---------------------------------------------------------------------------
// Engagement search (5.5)

/**
 * Exact minimum radius of the conic arc from (r1, v1) over the transfer that ends at r2:
 * the periapsis radius if periapsis is passed inside the arc, else the smaller endpoint radius.
 */
export function transferArcMinRadius(r1, v1, r2) {
  const r1m = r1.length();
  const r2m = r2.length();
  const ends = Math.min(r1m, r2m);
  const { rp, e } = apsides(r1, v1);
  if (rp >= ends || e < 1e-9) return ends;
  const h = new Vector3().crossVectors(r1, v1);
  const hHat = h.clone().normalize();
  const v2 = v1.lengthSq();
  const eVec = r1
    .clone()
    .multiplyScalar(v2 - MU / r1m)
    .addScaledVector(v1, -r1.dot(v1))
    .divideScalar(MU);
  const eHat = eVec.normalize();
  const pHat = new Vector3().crossVectors(hHat, eHat);
  const r1Hat = r1.clone().divideScalar(r1m);
  const r2Hat = r2.clone().divideScalar(r2m);
  const twoPi = 2 * Math.PI;
  let theta1 = Math.atan2(pHat.dot(r1Hat), eHat.dot(r1Hat));
  if (theta1 < 0) theta1 += twoPi;
  let dTheta = Math.atan2(hHat.dot(_tmp.crossVectors(r1Hat, r2Hat)), r1Hat.dot(r2Hat));
  if (dTheta < 0) dTheta += twoPi;
  return theta1 + dTheta >= twoPi ? rp : ends;
}

/** Arc sampled every step seconds (5.5); returns the minimum radius seen, endpoints included. */
function sampledArcMinRadius(r1, v1, tof, step) {
  let min = r1.length();
  for (let t = step; t < tof; t += step) min = Math.min(min, propagateKepler(r1, v1, t).r.length());
  return Math.min(min, propagateKepler(r1, v1, tof).r.length());
}

function searchEngagement(params, missile, tAssign, capKms, phases) {
  const E = params.engagement;
  const shell = params.interceptorShell;
  const minArcR = R_EARTH + E.minArcAltKm;

  // Release and intercept grids. Intercept times are tRelease + tof on the shared grid.
  const relTimes = [];
  for (let k = E.releaseMin; k <= E.releaseMax + 1e-9; k += E.releaseStep) relTimes.push(tAssign + k);
  const tIMax = Math.min(relTimes[relTimes.length - 1] + E.tofMax, missile.tImpact - E.impactMargin);
  const tIndex = new Map();
  const iTimes = [];
  for (const tR of relTimes) {
    for (let tof = E.tofMin; tof <= E.tofMax + 1e-9; tof += E.tofStep) {
      const tI = tR + tof;
      if (tI > tIMax + 1e-9) break;
      const key = Math.round(tI * 1000);
      if (!tIndex.has(key)) {
        tIndex.set(key, iTimes.length);
        iTimes.push(tI);
      }
    }
  }
  const nI = iTimes.length;
  const nR = relTimes.length;
  const mR = new Float64Array(nI * 3);
  iTimes.forEach((tI, m) => {
    const s = missile.stateAt(tI);
    mR[3 * m] = s.r.x;
    mR[3 * m + 1] = s.r.y;
    mR[3 * m + 2] = s.r.z;
  });

  // Distinct satellite tracks. Slots are slotStepDeg apart, so PHASE_I and PHASE_I + slotStep
  // give the same constellation with relabelled slots: the per-phase search repeats exactly
  // every slotStep degrees, and each distinct track is searched once.
  const tracks = [];
  for (const phi of phases) {
    for (let p = 0; p < shell.planes; p++) {
      for (let s = 0; s < shell.perPlane; s++) {
        tracks.push({ p, s, phi, u0: shell.slotStepDeg * s + shell.interPlanePhaseDeg * p + phi });
      }
    }
  }
  const nT = tracks.length;
  const a = R_EARTH + shell.altKm;
  const speed = Math.sqrt(MU / a);
  const nDeg = Math.sqrt(MU / (a * a * a)) / DEG;
  const bases = [];
  for (let p = 0; p < shell.planes; p++) bases.push(planeBasis(shell.incDeg, shell.raanStepDeg * p));

  const satAt = (track, t, out, o, withV) => {
    const B = bases[track.p];
    const u = (track.u0 + nDeg * t) * DEG;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    out[o] = a * (cu * B.nx + su * B.mx);
    out[o + 1] = a * su * B.my;
    out[o + 2] = a * (cu * B.nz + su * B.mz);
    if (withV) {
      out[o + 3] = speed * (-su * B.nx + cu * B.mx);
      out[o + 4] = speed * cu * B.my;
      out[o + 5] = speed * (-su * B.nz + cu * B.mz);
    }
  };
  const satRel = new Float64Array(nT * nR * 6);
  const satInt = new Float64Array(nT * nI * 3);
  for (let k = 0; k < nT; k++) {
    for (let j = 0; j < nR; j++) satAt(tracks[k], relTimes[j], satRel, (k * nR + j) * 6, true);
    for (let m = 0; m < nI; m++) satAt(tracks[k], iTimes[m], satInt, (k * nI + m) * 3, false);
  }

  // Candidates with their pruning key q = |rMissile(tI) - rSat(tI)| / tof (km/s).
  const cTrack = [];
  const cRel = [];
  const cInt = [];
  const cQ = [];
  const qMax = PRUNE_K * capKms;
  for (let k = 0; k < nT; k++) {
    for (let j = 0; j < nR; j++) {
      const tR = relTimes[j];
      for (let tof = E.tofMin; tof <= E.tofMax + 1e-9; tof += E.tofStep) {
        const tI = tR + tof;
        if (tI > tIMax + 1e-9) break;
        const m = tIndex.get(Math.round(tI * 1000));
        const o = (k * nI + m) * 3;
        const dx = mR[3 * m] - satInt[o];
        const dy = mR[3 * m + 1] - satInt[o + 1];
        const dz = mR[3 * m + 2] - satInt[o + 2];
        const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / tof;
        if (q < qMax) {
          cTrack.push(k);
          cRel.push(j);
          cInt.push(m);
          cQ.push(q);
        }
      }
    }
  }
  // Sort by q (quantized to 1e-6 km/s, ties by index: deterministic) with a packed numeric key.
  const nC = cQ.length;
  const keys = new Float64Array(nC);
  for (let i = 0; i < nC; i++) keys[i] = Math.floor(cQ[i] * 1e6) * 8388608 + i;
  keys.sort();

  let best = null;
  let bestDv = capKms;
  let evaluated = 0;
  let solved = 0;
  const r1 = new Vector3();
  const vSat = new Vector3();
  const r2 = new Vector3();
  for (let n = 0; n < nC; n++) {
    const i = keys[n] % 8388608;
    if (cQ[i] >= PRUNE_K * bestDv) break;
    const k = cTrack[i];
    const j = cRel[i];
    const m = cInt[i];
    const o = (k * nR + j) * 6;
    r1.set(satRel[o], satRel[o + 1], satRel[o + 2]);
    vSat.set(satRel[o + 3], satRel[o + 4], satRel[o + 5]);
    r2.set(mR[3 * m], mR[3 * m + 1], mR[3 * m + 2]);
    const tof = iTimes[m] - relTimes[j];
    evaluated++;
    const sol = lambert(r1, r2, tof, { prograde: true });
    if (!sol) continue;
    solved++;
    const dv = sol.v1.distanceTo(vSat);
    if (dv >= bestDv) continue;
    // Transfer arc floor: the 10 s sampling of 5.5 plus the exact periapsis check, so a dip
    // between samples is caught too.
    if (transferArcMinRadius(r1, sol.v1, r2) < minArcR) continue;
    if (sampledArcMinRadius(r1, sol.v1, tof, E.arcSampleStep) < minArcR) continue;
    bestDv = dv;
    best = { track: tracks[k], tRelease: relTimes[j], tIntercept: iTimes[m], deltaVKms: dv };
  }
  return { best, stats: { tracks: nT, candidates: nC, evaluated, solved } };
}

// ---------------------------------------------------------------------------
// Formatting for the event log

function fmtClock(t) {
  const sign = t < 0 ? '-' : '+';
  const s = Math.round(Math.abs(t));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `T${sign}${mm}:${ss}`;
}

// ---------------------------------------------------------------------------

/**
 * Build the scenario once at load.
 * @param {object} [params=DEFAULT_PARAMS]
 * @returns {object}
 */
export function buildScenario(params = DEFAULT_PARAMS) {
  const log = [];

  // Site (5.1).
  const rEcef = latLonToEcef(params.site.lat, params.site.lon, 0);
  const frameEcef = localFrameEci(rEcef);
  const site = {
    lat: params.site.lat,
    lon: params.site.lon,
    rEcef,
    frameEcef,
    /** ECI position, velocity and local frame of the site at t (the frame rides the Earth). */
    stateAt(t) {
      const theta = earthRotationAngle(t);
      const r = ecefToEci(rEcef, theta);
      return {
        r,
        v: siteVelocityEci(r),
        up: ecefToEci(frameEcef.up, theta),
        east: ecefToEci(frameEcef.east, theta),
        north: ecefToEci(frameEcef.north, theta),
      };
    },
  };

  // Missile (5.3).
  const missile = buildMissile(params, rEcef);
  const tBurnout = missile.burnout.t;

  // Sensor shell and PHASE_S (5.4).
  const SS = params.sensorShell;
  let phaseS = params.phaseSDeg;
  let sensorNadirKm;
  if (phaseS === null || phaseS === undefined) {
    let bestPhase = 0;
    let bestD = Infinity;
    for (let phi = 0; phi < 360; phi += params.phaseSearch.sStepDeg) {
      const near = nearestSensor(buildSensorShell(SS, phi), rEcef);
      if (near.distanceKm < bestD - 1e-9) {
        bestD = near.distanceKm;
        bestPhase = phi;
      }
    }
    phaseS = bestPhase;
    if (bestD >= params.phaseSearch.sensorNadirMaxKm) {
      log.push(
        `PHASE_S: no phase brings a sensor nadir point within ${params.phaseSearch.sensorNadirMaxKm} km of the site ` +
          `(the nearest plane passes ${bestD.toFixed(0)} km away); the minimum-distance phase ${phaseS} is used`
      );
    }
  }
  const sensorShell = buildSensorShell(SS, phaseS);
  const nearSensor = nearestSensor(sensorShell, rEcef);
  sensorNadirKm = nearSensor.distanceKm;
  const sweepTarget = makeAimPoint(params.sensor);

  // Detection (5.4).
  const det = findDetection(missile, nearSensor.sat, sweepTarget, params.sensor, log);
  const tDetect = det.tDetect;
  const tTrack = tDetect + params.sensor.trackDelay;
  const sensorSat = {
    ...nearSensor.sat,
    coneHalfAngleDeg: det.coneHalfAngleDeg,
    nadirDistanceKm: sensorNadirKm,
    /** Cone aim point at t: locked to the satellite, offset from its nadir (fresh vector). */
    sweepTargetAt: (t) => sweepTarget(nearSensor.sat.stateAt(t).r, t),
  };

  // Handoff latencies (5.5).
  const L = params.latencies;
  const tLink1 = tTrack + L.link1;
  const tLink2 = tLink1 + L.link2;
  const tAssign = tLink2 + L.assign;

  // Engagement and PHASE_I (5.5).
  const IS = params.interceptorShell;
  const iStep = params.phaseSearch.iStepDeg;
  let phases;
  if (params.phaseIDeg !== null && params.phaseIDeg !== undefined) phases = [params.phaseIDeg];
  else if (IS.slotStepDeg % iStep === 0) {
    phases = [];
    for (let phi = 0; phi < IS.slotStepDeg; phi += iStep) phases.push(phi);
  } else {
    phases = [];
    for (let phi = 0; phi < 360; phi += iStep) phases.push(phi);
  }
  let capKms = params.engagement.deltaVCapKms;
  let search = searchEngagement(params, missile, tAssign, capKms, phases);
  if (!search.best) {
    log.push(`engagement: no solution under ${capKms} km/s; cap raised to ${params.engagement.deltaVCapFallbackKms} km/s`);
    capKms = params.engagement.deltaVCapFallbackKms;
    search = searchEngagement(params, missile, tAssign, capKms, phases);
  }
  if (!search.best) throw new Error(`buildScenario: no engagement solution under ${capKms} km/s`);
  const { track, tRelease, tIntercept } = search.best;
  const phaseI = track.phi;
  const interceptorShell = buildInterceptorShell(IS, phaseI);
  const iSat = interceptorShell.find((s) => s.plane === track.p && s.slot === track.s);

  // Kill vehicle: it leaves the tube tubeOffsetKm out along the departure direction, so the
  // Lambert arc is re-solved from that point (two passes converge to well under a millimetre).
  const E = params.engagement;
  const tof = tIntercept - tRelease;
  const satRel = iSat.stateAt(tRelease);
  const rMissileI = missile.stateAt(tIntercept).r;
  let sol = lambert(satRel.r, rMissileI, tof, { prograde: true });
  let departDir = sol.v1.clone().sub(satRel.v).normalize();
  let rRelease = satRel.r.clone();
  for (let pass = 0; pass < 2; pass++) {
    rRelease = satRel.r.clone().addScaledVector(departDir, E.tubeOffsetKm);
    const s2 = lambert(rRelease, rMissileI, tof, { prograde: true });
    if (!s2) break;
    sol = s2;
    if (pass === 0) departDir = sol.v1.clone().sub(satRel.v).normalize();
  }
  // Finite kick burn (Phase 2 follow-up; 5.5 had an impulse at release). The kill vehicle
  // leaves the tube co-moving with the satellite, and its motor accelerates it along the
  // departure direction of the impulsive solution at |dV| / burnDuration for burnDuration
  // seconds, integrated with RK4 under gravity and thrust. At burnout the arc to the intercept
  // point is re-solved (Lambert) and the small remaining difference is applied as a trim; from
  // burnout it coasts by Kepler.
  const impulse = sol.v1.clone().sub(satRel.v);
  const burnT = E.burnDuration;
  const burnAccel = impulse.length() / burnT; // km/s^2
  const thrust = (r) => gravityAccel(r).addScaledVector(departDir, burnAccel);
  const burnSteps = Math.round(burnT / KV_BURN_DT);
  const burnR = [rRelease.clone()];
  const burnV = [satRel.v.clone()];
  {
    let r = rRelease.clone();
    let v = satRel.v.clone();
    for (let k = 0; k < burnSteps; k++) {
      ({ r, v } = rk4Step(r, v, tRelease + k * KV_BURN_DT, KV_BURN_DT, thrust));
      burnR.push(r.clone());
      burnV.push(v.clone());
    }
  }
  const tKvBurnout = tRelease + burnSteps * KV_BURN_DT;
  const rKvBurnout = burnR[burnSteps];
  const vKvBurnout = burnV[burnSteps];
  const solB = lambert(rKvBurnout, rMissileI, tIntercept - tKvBurnout, { prograde: true });
  if (!solB) throw new Error('buildScenario: no arc from the kill vehicle burnout to the intercept point');
  const v1 = solB.v1.clone();
  const trim = v1.clone().sub(vKvBurnout);
  const deltaV = impulse.clone().add(trim); // the burn plus the burnout trim (what the kill vehicle spends)
  const kvStateAt = (t) => {
    if (!(t >= tRelease && t <= tIntercept)) return null;
    if (t < tKvBurnout) {
      const x = (t - tRelease) / KV_BURN_DT;
      const k = Math.min(burnSteps - 1, Math.floor(x));
      const f = x - k;
      return { r: burnR[k].clone().lerp(burnR[k + 1], f), v: burnV[k].clone().lerp(burnV[k + 1], f) };
    }
    return propagateKepler(rKvBurnout, v1, t - tKvBurnout);
  };
  const kvAtI = kvStateAt(tIntercept);
  const mAtI = missile.stateAt(tIntercept);
  const closingSpeedKms = kvAtI.v.distanceTo(mAtI.v);
  const tOrient = tRelease - E.orientLead;

  // Interceptor satellite facing (5.5): nadir, slewing to the departure direction between
  // tOrient and tRelease, held after. The slew follows a reaction-control profile: thrusters
  // spin it up at constant angular acceleration, it coasts at constant rate, and opposing
  // thrusters brake it to rest on the departure direction.
  const ta = E.slewAccelFraction;
  const slewProgress = (t) => {
    const u = clamp((t - tOrient) / (tRelease - tOrient), 0, 1);
    const rate = 1 / (1 - ta); // peak rate in progress per unit u
    if (u < ta) return (0.5 * rate * u * u) / ta;
    if (u <= 1 - ta) return 0.5 * rate * ta + rate * (u - ta);
    const r = 1 - u;
    return 1 - (0.5 * rate * r * r) / ta;
  };
  const nadirAt = (t) => iSat.stateAt(t).r.negate().normalize();
  const facingAt = (t) => {
    const s = slewProgress(t);
    if (s <= 0) return nadirAt(t);
    if (s >= 1) return departDir.clone();
    return slerpUnit(nadirAt(t), departDir, s);
  };
  // Reaction-control firing: level 1 while spinning up or braking, 0 while coasting or at rest;
  // dir is the direction the thrusters push the satellite's pointing axis (toward the departure
  // direction while spinning up, away from it while braking), perpendicular to the axis.
  const rcsAt = (t) => {
    const u = (t - tOrient) / (tRelease - tOrient);
    const f = facingAt(t);
    const w = departDir.clone().sub(nadirAt(t));
    const dir = w.addScaledVector(f, -w.dot(f));
    if (dir.lengthSq() > 1e-12) dir.normalize();
    if (!(u > 0 && u < 1)) return { level: 0, dir };
    if (u < ta) return { level: 1, dir };
    if (u > 1 - ta) return { level: 1, dir: dir.negate() };
    return { level: 0, dir };
  };

  // Kill vehicle body axis: along the tube (the departure direction) through the burn, then
  // turning over KV_TURN seconds onto the line of sight to the missile, which it holds (on a
  // collision course the line of sight converges to the relative-velocity direction, used for
  // the last kilometre where the line of sight is ill-defined).
  const KV_TURN = 40; // s, visual
  const losAt = (t) => {
    const k = kvStateAt(t);
    const m = missile.stateAt(t);
    const rel = m.r.clone().sub(k.r);
    const dist = rel.length();
    const relV = k.v.clone().sub(m.v).normalize();
    if (dist < 1e-6) return relV;
    const los = rel.divideScalar(dist);
    const w = smoothstep(dist, 0.2, 1.0);
    return w >= 1 ? los : slerpUnit(relV, los, w);
  };
  const kvDirectionAt = (t) => {
    const tc = Math.max(tRelease, Math.min(t, tIntercept));
    const tTurn = tRelease + E.burnDuration;
    if (tc <= tTurn) return departDir.clone();
    const w = smoothstep(tc, tTurn, tTurn + KV_TURN);
    const los = losAt(tc);
    return w >= 1 ? los : slerpUnit(departDir, los, w);
  };

  // Relay (5.5): another interceptor-shell satellite with line of sight to both ends at
  // tLink1 and tLink2, minimizing the sum of the two distances.
  let relay = null;
  let relayCost = Infinity;
  const sen1 = sensorSat.stateAt(tLink1).r;
  const sen2 = sensorSat.stateAt(tLink2).r;
  const int1 = iSat.stateAt(tLink1).r;
  const int2 = iSat.stateAt(tLink2).r;
  for (const sat of interceptorShell) {
    if (sat === iSat) continue;
    const a1 = sat.stateAt(tLink1).r;
    const a2 = sat.stateAt(tLink2).r;
    if (!segmentClearsSphere(a1, sen1, R_EARTH) || !segmentClearsSphere(a1, int1, R_EARTH)) continue;
    if (!segmentClearsSphere(a2, sen2, R_EARTH) || !segmentClearsSphere(a2, int2, R_EARTH)) continue;
    const cost = a1.distanceTo(sen1) + a2.distanceTo(int2);
    if (cost < relayCost) {
      relayCost = cost;
      relay = sat;
    }
  }
  if (!relay) throw new Error('buildScenario: no relay with line of sight to both ends');

  // Events (5.9), simulation time, in time order.
  const events = [
    { t: -60, text: 'Constellation nominal' },
    { t: -10, text: 'Launcher erected' },
    { t: -0.5, text: 'Canister open' },
    { t: 0, text: 'Ignition' },
    { t: tDetect, text: 'Sensor sat: launch detected' },
    { t: tTrack, text: 'Track established' },
    { t: tLink1, text: 'Handoff to relay' },
    { t: tLink2, text: 'Handoff to interceptor sat' },
    { t: tAssign, text: `Solution: dV ${(impulse.length() + trim.length()).toFixed(2)} km/s, intercept ${fmtClock(tIntercept)}` },
    { t: tBurnout, text: 'Burnout' },
    { t: tRelease, text: 'Interceptor released' },
    { t: tIntercept, text: 'Intercept' },
    { t: tIntercept + 4, text: 'Engagement complete' },
  ]
    .map((e, i) => ({ ...e, i }))
    .sort((p, q) => p.t - q.t || p.i - q.i)
    .map(({ t, text }) => ({ t, text }));

  return {
    params,
    site,
    missile,
    shells: { interceptor: interceptorShell, sensor: sensorShell },
    sensorSat,
    detection: { tDetect, tTrack },
    handoff: { tLink1, tLink2, tAssign, relaySat: relay },
    engagement: {
      interceptorSat: iSat,
      tOrient,
      tRelease,
      tIntercept,
      deltaV,
      // What the kill vehicle spends: the burn (its thrust integral) plus the burnout trim.
      deltaVKms: impulse.length() + trim.length(),
      burnAccelKms2: burnAccel,
      trimKms: trim.length(),
      tKvBurnout,
      deltaVCapKms: capKms,
      closingSpeedKms,
      interceptPoint: mAtI.r.clone(),
      departDir: departDir.clone(),
      facingAt,
      rcsAt,
      slewAngleDeg: (Math.acos(clamp(nadirAt(tOrient).dot(departDir), -1, 1)) * 180) / Math.PI,
      kv: { v1, r0: rRelease.clone(), stateAt: kvStateAt, directionAt: kvDirectionAt, burnDuration: E.burnDuration },
    },
    phases: { phaseIDeg: phaseI, phaseSDeg: phaseS },
    search: { ...search.stats },
    events,
    log,
    rEarth: R_EARTH,
  };
}

/** Spherical interpolation between unit vectors a and b by s (fresh vector). */
export function slerpUnit(a, b, s) {
  const dot = Math.max(-1, Math.min(1, a.dot(b)));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return b.clone();
  if (Math.PI - omega < 1e-6) {
    // Opposite: rotate through any perpendicular.
    const perp = Math.abs(a.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    perp.addScaledVector(a, -perp.dot(a)).normalize();
    return a
      .clone()
      .multiplyScalar(Math.cos(Math.PI * s))
      .addScaledVector(perp, Math.sin(Math.PI * s));
  }
  const so = Math.sin(omega);
  return a
    .clone()
    .multiplyScalar(Math.sin((1 - s) * omega) / so)
    .addScaledVector(b, Math.sin(s * omega) / so)
    .normalize();
}
