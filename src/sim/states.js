// State computer: computeStates(animT) gathers every actor state for an animation time.
//
// Physics comes from the scenario (simulation time); the choreography layered on top (halo
// levels, cone opacity, beam pulses, label windows, effect envelopes, trail retraction) runs on
// animation time with the v1 pacing, so it reads the same at every warp. Every call returns
// fresh objects and fresh Vector3 instances. Pure, Node-importable.

import { Vector3 } from 'three';
import { R_EARTH, OMEGA_EARTH, G0, DEG } from '../shared/constants.js';
import { earthRotationAngle, ecefToEci, eciToEcef, localFrameEci, siteVelocityEci, greatCircleDistance } from '../shared/geo.js';
import { clamp, lerp, smoothstep, easeInOutCubic } from '../shared/easing.js';
import { LINK, SENSOR } from '../shared/palette.js';
import { createCamera, COURSE_DELAY } from './camera.js';
import { interceptFxAt } from './effects.js';
import { period } from './kepler.js';

// ---------------------------------------------------------------------------
// Pacing constants. Animation seconds unless marked (sim). Chosen for the look.

const TRAIL_MAX = 256; // points per trail, the current position included
const TRAIL_HOLD = 0.5; // trails frozen at full length after the intercept for this long
const TRAIL_CLEAR = 3; // and fully retracted by the intercept + this
const KV_PATH_STEP = 1; // sim s, kill-vehicle path table spacing
const COURSE_FADE = 1.5; // projected paths fade in over this long (animation s)
const COURSE_OUT = 0.6; // and out this long before the intercept
const COURSE_SAMPLES = 64; // points per projected path

const PLUME_FADE = 0.5; // missile plume fades over this long after burnout
const KV_PLUME_FADE = 0.6; // kill-vehicle plume fades over this long after its burn

const OUTRIGGER_START = -60; // sim: outriggers extend, then the canister erects (5.6)
const OUTRIGGER_END = -50; // sim
const ERECT_START = -50; // sim
const ERECT_END = -10; // sim
const LID_START = -0.5; // sim
const LID_END = 0; // sim

const HALO_REST = 0.3; // dim halo on the highlighted satellites
const HALO_RISE = 0.4;
const HALO_SETTLE = 2; // back to rest over this long after the engagement completes

const CONE_ON = 4; // the sensor cone fades in with the labels
const CONE_FADE_IN = 1;
const CONE_REST = 0.15;
const CONE_PEAK = 0.5;
const CONE_TRACKING = 0.3;
const CONE_PULSE_RISE = 0.1;
const CONE_PULSE_DECAY = 1;
const CONE_TRACK_RAMP = 0.3;
const CONE_FADE_OUT = 1;
const CONE_COURSE_DIM = 0.7; // the beam drops to 30 % in the course view
const DETECT_PULSE = 1;

const PULSE_TRAVEL = 3; // handoff pulse travels its beam over this long (5.5)
const BEAM_FADE_IN = 0.2;
const BEAM_ACTIVE_OPACITY = 0.7;
const BEAM_LINGER_OPACITY = 0.25; // (5.5)
const BEAM_SETTLE = 0.5;
const TRACK_LINE_OPACITY = 0.6;

const LABEL_SATS_ON = 4; // SENSOR SAT, INTERCEPTOR SAT, RELAY from animation t = 4 (5.11)
const LABEL_THREAT_DELAY = 1;
const LABEL_ASSIGNED_SECONDS = 3;
const LABEL_INTERCEPT_SECONDS = 4;
const LABEL_LAUNCHER_FORWARD = 0.0225; // km along north: the cab centre of the 22 m vehicle (launcher.js)
const LABEL_LAUNCHER_UP = 0.0054; // km: cab roof 3.4 m plus the 2 m ground lift

// Beats whose shots are at or near the launch site: the missile trail hangs in the
// atmosphere there, so it is drawn fixed to the rotating Earth. From the Handoff beat on (a
// hard cut to space views) it is drawn as the inertial path, which the kill vehicle meets.
const EARTH_FIXED_TRAIL_BEATS = new Set(['establishing', 'launch', 'boost']);

// ---------------------------------------------------------------------------
// Helpers

function within(t, start, end) {
  return t >= start && t < end;
}

function fmtThousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtAlt(km) {
  if (km < 10) return `${Math.max(0, km).toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${fmtThousands(km)} km`;
}

function fmtMmSs(seconds) {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** First index i with times[i] >= t (times ascending). */
function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Trail from a path table: the points with tFrom <= t < tTo, thinned on a power-of-two index
 * grid (so the kept points do not shimmer as the trail grows), with `tail` (the exact point at
 * tFrom, when the trail is retracting) prepended and `head` (the exact current point) appended.
 * `transform(point, t)` maps a stored point to the frame drawn; it must return a fresh vector.
 */
function trailFromPath(times, points, tFrom, tTo, head, transform, tail = null) {
  const lo = lowerBound(times, tFrom);
  const hi = lowerBound(times, tTo) - 1;
  const out = [];
  if (tail) out.push(tail);
  if (hi >= lo) {
    const count = hi - lo + 1;
    let stride = 1;
    while (Math.ceil(count / stride) + 1 > TRAIL_MAX - 1) stride *= 2;
    if (!tail) out.push(transform(points[lo], times[lo]));
    for (let i = Math.ceil((lo + 1) / stride) * stride; i <= hi; i += stride) out.push(transform(points[i], times[i]));
  }
  if (head) out.push(head);
  return out;
}

/** Halo level: rest, rising to 1 at tOn, settling back to rest after tSettle (animation time). */
function haloLevel(animT, tOn, tSettle) {
  const on = smoothstep(animT, tOn, tOn + HALO_RISE) * (1 - smoothstep(animT, tSettle, tSettle + HALO_SETTLE));
  return lerp(HALO_REST, 1, on);
}

// ---------------------------------------------------------------------------

/**
 * @param {object} scenario from buildScenario
 * @param {object} timeline from buildTimeline
 * @returns {(animT: number) => object}
 */
export function createStateComputer(scenario, timeline) {
  const cameraState = createCamera(scenario, timeline);
  const { site, missile, sensorSat, detection, handoff, engagement: E, shells } = scenario;
  const relaySat = handoff.relaySat;
  const iSat = E.interceptorSat;
  const kv = E.kv;
  const tBurnout = missile.burnout.t;
  const { tDetect, tTrack } = detection;
  const { tLink1, tLink2, tAssign } = handoff;
  const { tRelease, tIntercept } = E;
  const tComplete = tIntercept + 4;
  const ip = E.interceptPoint;
  const missileAtI = missile.stateAt(tIntercept);
  const missileDirAtI = missile.directionAt(tIntercept);
  const kvAtI = kv.stateAt(tIntercept);
  const kvDirAtI = kv.directionAt(tIntercept);

  // Animation times of the anchors the choreography keys off.
  const A = timeline.simToAnim;
  const aDetect = A(tDetect);
  const aTrack = A(tTrack);
  const aLink1 = A(tLink1);
  const aLink2 = A(tLink2);
  const aAssign = A(tAssign);
  const aBurnout = A(tBurnout);
  const aRelease = A(tRelease);
  const aKvBurnEnd = A(tRelease + kv.burnDuration);
  // Course view (camera.js): the projected paths fade in and the kill vehicle's trail eases from
  // the satellite's frame to the inertial frame as the camera pulls out.
  const aCourse = A(E.tKvBurnout) + COURSE_DELAY;
  const aIntercept = A(tIntercept);
  const aComplete = A(tComplete);
  const aIgnition = A(0);
  const launchBeat = timeline.beats.find((b) => b.id === 'launch');

  // Kill-vehicle path table (sim time, inertial).
  const kvPathT = [];
  const kvPathR = [];
  for (let t = tRelease; t < tIntercept; t += KV_PATH_STEP) {
    kvPathT.push(t);
    kvPathR.push(kv.stateAt(t).r);
  }

  // The three highlighted satellites are drawn as their own actors, so they are left out of
  // the dim shell clouds (no double geometry in close-ups).
  const special = new Set([sensorSat.id, relaySat.id, iSat.id]);
  const dimInterceptor = shells.interceptor.filter((s) => !special.has(s.id));
  const dimSensor = shells.sensor.filter((s) => !special.has(s.id));
  const planesOf = (sats) => {
    const seen = new Map();
    for (const s of sats) {
      const key = `${s.raanDeg}|${s.incDeg}|${s.altKm}`;
      if (!seen.has(key)) seen.set(key, { raanDeg: s.raanDeg, incDeg: s.incDeg, altKm: s.altKm });
    }
    return [...seen.values()];
  };
  const orbitsInterceptor = planesOf(shells.interceptor);
  const orbitsSensor = planesOf(shells.sensor);

  const inertial = (p) => p.clone();

  // -------------------------------------------------------------------------

  function launcherState(simT) {
    const st = site.stateAt(simT);
    return {
      position: st.r,
      up: st.up,
      east: st.east,
      north: st.north,
      erectAngleDeg: 90 * easeInOutCubic(clamp((simT - ERECT_START) / (ERECT_END - ERECT_START))),
      lidOpen: smoothstep(simT, LID_START, LID_END),
      outriggers: smoothstep(simT, OUTRIGGER_START, OUTRIGGER_END),
      visible: true,
    };
  }

  function missileTrail(animT, simT, beatId, head) {
    const path = missile.path;
    if (simT < 0) return [];
    const theta = earthRotationAngle(simT);
    const earthFixed = EARTH_FIXED_TRAIL_BEATS.has(beatId);
    const transform = earthFixed ? (p, t) => ecefToEci(p, theta - OMEGA_EARTH * t) : inertial;
    if (simT < tIntercept) return trailFromPath(path.t, path.r, 0, simT, head, transform);
    const tail = smoothstep(animT, aIntercept + TRAIL_HOLD, aIntercept + TRAIL_CLEAR);
    if (tail >= 1) return [];
    const tFrom = tail * tIntercept;
    const tailPoint = transform(missile.stateAt(tFrom).r, tFrom);
    return trailFromPath(path.t, path.r, tFrom, tIntercept, ip.clone(), transform, tailPoint);
  }

  function missileState(animT, simT, beatId) {
    if (simT < 0) {
      const st = site.stateAt(simT);
      return {
        position: st.r,
        velocity: st.v,
        direction: st.up,
        altKm: 0,
        speedKms: st.v.length(),
        phase: 'seated',
        visible: false,
        plume: 0,
        trail: [],
      };
    }
    if (simT >= tIntercept) {
      return {
        position: ip.clone(),
        velocity: missileAtI.v.clone(),
        direction: missileDirAtI.clone(),
        altKm: ip.length() - R_EARTH,
        speedKms: missileAtI.v.length(),
        phase: 'gone',
        visible: false,
        plume: 0,
        trail: missileTrail(animT, simT, beatId, null),
      };
    }
    const s = missile.stateAt(simT);
    const boosting = simT < tBurnout;
    return {
      position: s.r,
      velocity: s.v,
      direction: missile.directionAt(simT),
      altKm: s.r.length() - R_EARTH,
      speedKms: s.v.length(),
      phase: boosting ? 'boost' : 'coast',
      visible: true,
      plume: boosting ? 1 : 1 - smoothstep(animT, aBurnout, aBurnout + PLUME_FADE),
      trail: missileTrail(animT, simT, beatId, s.r.clone()),
    };
  }

  function kvTrail(animT, simT, head) {
    if (simT < tRelease) return [];
    if (simT < tIntercept) {
      // Around the release the trail is drawn in the interceptor satellite's co-moving frame,
      // so it runs from the tube to the kill vehicle (an inertial trail would streak kilometres
      // along the orbit in a few seconds); as the camera pulls out to the course view it eases
      // into the inertial frame, where it shows the kill vehicle's actual arc.
      let transform = inertial;
      const comoving = 1 - smoothstep(animT, aCourse, aCourse + COURSE_FADE);
      if (comoving > 0 && timeline.getBeat(animT).id === 'engage') {
        const satNow = iSat.stateAt(simT).r;
        transform = (p, t) => p.clone().addScaledVector(satNow.clone().sub(iSat.stateAt(t).r), comoving);
      }
      return trailFromPath(kvPathT, kvPathR, tRelease, simT, head, transform);
    }
    const tail = smoothstep(animT, aIntercept + TRAIL_HOLD, aIntercept + TRAIL_CLEAR);
    if (tail >= 1) return [];
    const tFrom = tRelease + tail * (tIntercept - tRelease);
    return trailFromPath(kvPathT, kvPathR, tFrom, tIntercept, kvAtI.r.clone(), inertial, kv.stateAt(tFrom).r);
  }

  function kvState(animT, simT) {
    if (simT < tRelease) {
      const s = iSat.stateAt(simT);
      return {
        position: s.r,
        velocity: s.v,
        direction: E.facingAt(simT),
        altKm: s.r.length() - R_EARTH,
        speedKms: s.v.length(),
        phase: 'stowed',
        visible: false,
        plume: 0,
        trail: [],
      };
    }
    if (simT >= tIntercept) {
      return {
        position: kvAtI.r.clone(),
        velocity: kvAtI.v.clone(),
        direction: kvDirAtI.clone(),
        altKm: kvAtI.r.length() - R_EARTH,
        speedKms: kvAtI.v.length(),
        phase: 'gone',
        visible: false,
        plume: 0,
        trail: kvTrail(animT, simT, null),
      };
    }
    const s = kv.stateAt(simT);
    const burning = simT < tRelease + kv.burnDuration;
    return {
      position: s.r,
      velocity: s.v,
      direction: kv.directionAt(simT),
      altKm: s.r.length() - R_EARTH,
      speedKms: s.v.length(),
      phase: burning ? 'burn' : 'coast',
      visible: true,
      plume: burning ? 1 : 1 - smoothstep(animT, Math.max(aKvBurnEnd, aRelease), Math.max(aKvBurnEnd, aRelease) + KV_PLUME_FADE),
      trail: kvTrail(animT, simT, s.r.clone()),
    };
  }

  function sensorSatState(animT, simT) {
    const s = sensorSat.stateAt(simT);
    // The field of view is locked to the satellite (scenario.js, makeAimPoint), so the footprint
    // travels with its ground track; detection and track show as the cone flash, the pulse rings
    // at the missile and the track line, not as a slew of the beam.
    const coneTarget = sensorSat.sweepTargetAt(simT);
    const level =
      lerp(CONE_REST, CONE_TRACKING, smoothstep(animT, aTrack, aTrack + CONE_TRACK_RAMP)) *
      smoothstep(animT, CONE_ON, CONE_ON + CONE_FADE_IN) *
      (1 - smoothstep(animT, aIntercept, aIntercept + CONE_FADE_OUT)) *
      // dimmed in the course view so the converging paths read over it
      (1 - CONE_COURSE_DIM * smoothstep(animT, aCourse, aCourse + COURSE_FADE));
    // The cone flashes and a pulse ring grows at the missile on detection and again when the
    // track is established (the second one falls in the Boost beat's wide acquisition shot).
    const conePulse = (a0) =>
      within(animT, a0, a0 + CONE_PULSE_DECAY)
        ? smoothstep(animT, a0, a0 + CONE_PULSE_RISE) * (1 - smoothstep(animT, a0 + CONE_PULSE_RISE, a0 + CONE_PULSE_DECAY))
        : 0;
    const pulse = Math.max(conePulse(aDetect), conePulse(aTrack));
    const ring = (a0) => (within(animT, a0, a0 + DETECT_PULSE) ? (animT - a0) / DETECT_PULSE : 0);
    return {
      position: s.r,
      velocity: s.v,
      coneTarget,
      coneOpacity: lerp(level, CONE_PEAK, pulse),
      coneHalfAngleDeg: sensorSat.coneHalfAngleDeg,
      detectPulse: ring(aDetect) || ring(aTrack),
      tracking: simT >= tTrack && simT < tIntercept,
      visible: true,
    };
  }

  function handoffBeam(animT, id, aStart, from, to) {
    if (!within(animT, aStart, aComplete)) return null;
    const local = animT - aStart;
    let opacity;
    let pulse;
    if (local < PULSE_TRAVEL) {
      opacity = BEAM_ACTIVE_OPACITY * smoothstep(local, 0, BEAM_FADE_IN);
      pulse = local / PULSE_TRAVEL;
    } else {
      opacity = lerp(BEAM_ACTIVE_OPACITY, BEAM_LINGER_OPACITY, smoothstep(local, PULSE_TRAVEL, PULSE_TRAVEL + BEAM_SETTLE));
      pulse = null;
    }
    return { id, from, to, opacity, pulse, color: LINK, dashed: false };
  }

  function linksState(animT, simT, sensorPos, relayPos, iSatPos, missilePos) {
    const beams = [];
    if (simT >= tTrack && simT < tIntercept) {
      beams.push({
        id: 'track',
        from: sensorPos.clone(),
        to: missilePos.clone(),
        opacity: TRACK_LINE_OPACITY,
        pulse: null,
        color: SENSOR,
        dashed: true,
      });
    }
    const b1 = handoffBeam(animT, 'link1', aLink1, sensorPos.clone(), relayPos.clone());
    if (b1) beams.push(b1);
    const b2 = handoffBeam(animT, 'link2', aLink2, relayPos.clone(), iSatPos.clone());
    if (b2) beams.push(b2);
    return { beams };
  }

  // Projected course (course.js): the kill vehicle's and the threat's own future positions from
  // now to the intercept (Kepler), shown from the course view until just before the intercept.
  function courseLevel(animT, simT) {
    if (!(simT >= E.tKvBurnout && simT < tIntercept)) return 0;
    return smoothstep(animT, aCourse, aCourse + COURSE_FADE) * (1 - smoothstep(animT, aIntercept - COURSE_OUT, aIntercept));
  }

  function courseState(animT, simT) {
    const opacity = courseLevel(animT, simT);
    const kvPath = [];
    const threatPath = [];
    if (opacity > 0) {
      for (let i = 0; i <= COURSE_SAMPLES; i++) {
        const t = simT + ((tIntercept - simT) * i) / COURSE_SAMPLES;
        kvPath.push(kv.stateAt(t).r);
        threatPath.push(missile.stateAt(t).r);
      }
    }
    return { opacity, kv: kvPath, missile: threatPath, point: ip.clone() };
  }

  function labelsState(animT, simT, pos) {
    const st = site.stateAt(simT);
    const launcherAnchor = st.r.addScaledVector(st.north, LABEL_LAUNCHER_FORWARD).addScaledVector(st.up, LABEL_LAUNCHER_UP);
    return [
      { id: 'sensorSat', text: 'SENSOR SAT', position: pos.sensor.clone(), visible: animT >= LABEL_SATS_ON },
      // Retired once the course view starts: its job is done, and at that scale it sits on the kill vehicle's label.
      { id: 'interceptorSat', text: 'INTERCEPTOR SAT', position: pos.iSat.clone(), visible: animT >= LABEL_SATS_ON && animT < aCourse },
      { id: 'relay', text: 'RELAY', position: pos.relay.clone(), visible: animT >= LABEL_SATS_ON && animT < aCourse },
      {
        id: 'launcher',
        text: 'MOBILE LAUNCHER',
        position: launcherAnchor,
        visible: within(animT, launchBeat.start, launchBeat.end),
      },
      {
        id: 'threat',
        text: 'THREAT',
        position: pos.missile.clone(),
        visible: within(animT, aIgnition + LABEL_THREAT_DELAY, aIntercept) && simT < tIntercept,
      },
      { id: 'track', text: 'TRACK', position: pos.missile.clone(), visible: simT >= tTrack && simT < tIntercept },
      {
        id: 'assigned',
        text: 'TARGET ASSIGNED',
        position: pos.iSat.clone(),
        visible: within(animT, aAssign, aAssign + LABEL_ASSIGNED_SECONDS),
      },
      { id: 'kv', text: 'INTERCEPTOR', position: pos.kv.clone(), visible: simT >= tRelease && simT < tIntercept },
      {
        id: 'intercept',
        text: 'INTERCEPT',
        position: ip.clone(),
        visible: within(animT, aIntercept, aIntercept + LABEL_INTERCEPT_SECONDS),
      },
      { id: 'predicted', text: 'INTERCEPT POINT', position: ip.clone(), visible: courseLevel(animT, simT) > 0.3 },
    ];
  }

  // Readouts (5.10, extended in the Phase 2 follow-up): each beat shows the quantities that beat
  // is about, all computed from the simulation's own state, so the numbers show the physics at
  // work (orbital speeds and periods that follow from altitude, the thrust and flight-path angle
  // of the boost, link ranges with their light-time delay, the slew rate, the kick burn's
  // acceleration, the closing speed). Values are preformatted; ids are stable across beats so a
  // row that carries over is updated in place rather than re-added.
  const C_KMS = 299792.458; // speed of light, km/s
  const sensorAlt = sensorSat.stateAt(0).r.length() - R_EARTH;
  const shellAlt = iSat.stateAt(0).r.length() - R_EARTH;
  const thrustPhases = scenario.params.thrustPhases;
  const siteLatLon = `${Math.abs(site.lat).toFixed(1)} ${site.lat >= 0 ? 'N' : 'S'}  ${Math.abs(site.lon).toFixed(1)} ${site.lon >= 0 ? 'E' : 'W'}`;

  const fmtKms = (v, digits = 2) => `${v.toFixed(digits)} km/s`;
  const fmtKm = (km) => `${fmtThousands(km)} km`;
  const fmtPeriod = (sec) => {
    const m = Math.round(sec / 60);
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
  };
  const fmtG = (kms2) => `${(kms2 / G0).toFixed(1)} g`;
  const fmtDeg = (deg) => `${deg.toFixed(1)} deg`;
  const fmtLink = (km) => `${fmtKm(km)}, ${((km / C_KMS) * 1000).toFixed(0)} ms`; // range and light time

  /** Thrust acceleration of the boost at simT (km/s^2), 0 outside the burn. */
  function thrustAt(simT) {
    let t0 = 0;
    for (const p of thrustPhases) {
      if (simT >= t0 && simT < t0 + p.duration) return p.accel;
      t0 += p.duration;
    }
    return 0;
  }

  /** Flight-path angle of the Earth-relative velocity above the local horizontal, degrees. */
  function flightPathDeg(r, v) {
    const rel = v.clone().sub(siteVelocityEci(r));
    const speed = rel.length();
    if (speed < 1e-9) return 90;
    return Math.asin(clamp(rel.dot(localFrameEci(r).up) / speed, -1, 1)) / DEG;
  }

  /** Great-circle distance from the launch site to the point under r, km (Earth-fixed). */
  function downrangeKm(r, simT) {
    return greatCircleDistance(site.rEcef, eciToEcef(r, earthRotationAngle(simT)));
  }

  /** Interceptor satellite slew rate at simT, deg/s (central difference over 1 s). */
  function slewRateDeg(simT) {
    return E.facingAt(simT + 0.5).angleTo(E.facingAt(simT - 0.5)) / DEG;
  }

  function readoutsState(simT, beatId, m, k, sensorPos, relay, isat) {
    const rows = [];
    const add = (id, label, value) => rows.push({ id, label, value });
    const flying = simT >= 0 && simT < tIntercept;
    const threat = () => {
      add('threatAlt', 'THREAT ALT', fmtAlt(m.altKm));
      add('threatSpd', 'THREAT SPD', fmtKms(m.speedKms));
    };

    if (beatId === 'establishing') {
      add('sensorAlt', 'SENSOR ALT', fmtKm(sensorAlt));
      add('sensorSpd', 'SENSOR SPD', fmtKms(sensorSat.stateAt(simT).v.length()));
      add('sensorPrd', 'SENSOR PRD', fmtPeriod(period(R_EARTH + sensorAlt)));
      add('shellAlt', 'SHELL ALT', fmtKm(shellAlt));
      add('shellSpd', 'SHELL SPD', fmtKms(isat.v.length()));
      add('shellPrd', 'SHELL PRD', fmtPeriod(period(R_EARTH + shellAlt)));
      return rows;
    }

    if (beatId === 'launch' && simT < 0) {
      add('site', 'SITE', siteLatLon);
      add('siteSpd', 'EARTH ROT', fmtKms(m.speedKms)); // the site's speed from the Earth's rotation
      return rows;
    }

    if (beatId === 'launch' || beatId === 'boost') {
      threat();
      add('thrust', 'THRUST', simT < tBurnout ? fmtG(thrustAt(simT)) : 'OFF');
      add('fpa', 'FLIGHT PATH', fmtDeg(flightPathDeg(m.position, m.velocity)));
      add('downrange', 'DOWNRANGE', fmtAlt(downrangeKm(m.position, simT)));
      if (simT >= tDetect) add('trackRng', 'SENSOR RNG', fmtKm(sensorPos.distanceTo(m.position)));
      return rows;
    }

    if (beatId === 'handoff') {
      threat();
      add('fpa', 'FLIGHT PATH', fmtDeg(flightPathDeg(m.position, m.velocity)));
      add('link1', 'LINK 1', fmtLink(sensorPos.distanceTo(relay.r)));
      add('link2', 'LINK 2', fmtLink(relay.r.distanceTo(isat.r)));
      if (simT >= tAssign) add('kvDv', 'KV dV', fmtKms(E.deltaVKms));
      return rows;
    }

    if (beatId === 'engage' || beatId === 'intercept') {
      if (flying) threat();
      if (simT < tRelease) {
        add('isatAlt', 'INT SAT ALT', fmtAlt(isat.r.length() - R_EARTH));
        add('isatSpd', 'INT SAT SPD', fmtKms(isat.v.length()));
        if (simT >= E.tOrient) add('slew', 'SLEW RATE', `${slewRateDeg(simT).toFixed(2)} deg/s`);
        add('kvDv', 'KV dV', fmtKms(E.deltaVKms));
      } else if (simT < E.tKvBurnout) {
        add('kvAccel', 'KV ACCEL', fmtG(E.burnAccelKms2));
        add('kvRel', 'KV SEP SPD', `${(k.velocity.distanceTo(isat.v) * 1000).toFixed(0)} m/s`);
        add('kvSpd', 'KV SPD', fmtKms(k.speedKms));
        add('kvDv', 'KV dV', fmtKms(E.deltaVKms));
      } else if (flying) {
        add('kvSpd', 'KV SPD', fmtKms(k.speedKms));
        add('kvTtg', 'KV TTG', fmtMmSs(tIntercept - simT));
        add('closing', 'CLOSING', fmtKms(k.velocity.distanceTo(m.velocity), 2));
        add('kvRng', 'KV RANGE', fmtAlt(k.position.distanceTo(m.position)));
      } else {
        add('icptAlt', 'INTERCEPT ALT', fmtAlt(ip.length() - R_EARTH));
        add('closing', 'CLOSING', fmtKms(E.closingSpeedKms, 2));
      }
      return rows;
    }

    // Resolution: the engagement in numbers.
    add('icptAlt', 'INTERCEPT ALT', fmtAlt(ip.length() - R_EARTH));
    add('icptTime', 'INTERCEPT AT', `T+${fmtMmSs(tIntercept)}`);
    add('kvFlight', 'KV FLIGHT', fmtMmSs(tIntercept - tRelease));
    add('kvDv', 'KV dV', fmtKms(E.deltaVKms));
    add('closing', 'CLOSING', fmtKms(E.closingSpeedKms, 2));
    return rows;
  }

  return function computeStates(animT) {
    const beat = timeline.getBeat(animT);
    const simT = timeline.animToSim(animT);

    const missileS = missileState(animT, simT, beat.id);
    const kvS = kvState(animT, simT);
    const sensorS = sensorSatState(animT, simT);
    const relay = relaySat.stateAt(simT);
    const isat = iSat.stateAt(simT);
    const rcsNow = E.rcsAt(simT);

    return {
      animT,
      simT,
      warp: timeline.warpAt(animT),
      beat: { id: beat.id, label: beat.label, start: beat.start, end: beat.end, simStart: beat.simStart, simEnd: beat.simEnd, warp: beat.warp },
      earth: { theta: earthRotationAngle(simT) },
      launcher: launcherState(simT),
      missile: missileS,
      kv: kvS,
      sensorSat: sensorS,
      relaySat: {
        position: relay.r,
        velocity: relay.v,
        highlight: haloLevel(animT, aLink1 + PULSE_TRAVEL, aComplete),
        visible: true,
      },
      interceptorSat: {
        position: isat.r,
        velocity: isat.v,
        facing: E.facingAt(simT),
        // Reaction-control firing during the slew (level 0..1, push direction of the nose).
        rcs: rcsNow.level,
        rcsDir: rcsNow.dir,
        highlight: haloLevel(animT, aAssign, aComplete),
        visible: true,
      },
      constellation: {
        interceptor: dimInterceptor.map((s) => s.stateAt(simT).r),
        sensor: dimSensor.map((s) => s.stateAt(simT).r),
        orbits: {
          interceptor: orbitsInterceptor.map((o) => ({ ...o })),
          sensor: orbitsSensor.map((o) => ({ ...o })),
        },
      },
      links: linksState(animT, simT, sensorS.position, relay.r, isat.r, missileS.position),
      course: courseState(animT, simT),
      intercept: { ...interceptFxAt(animT, aIntercept), position: ip.clone() },
      labels: labelsState(animT, simT, {
        sensor: sensorS.position,
        iSat: isat.r,
        relay: relay.r,
        missile: missileS.position,
        kv: kvS.position,
      }),
      readouts: readoutsState(simT, beat.id, missileS, kvS, sensorS.position, relay, isat),
      camera: cameraState(animT),
      rEarth: R_EARTH,
    };
  };
}
