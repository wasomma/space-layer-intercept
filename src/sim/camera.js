// Scripted camera.
//
// createCamera(scenario, timeline) returns cameraState(animT) -> { position, target, anchor, up,
// fov, shake }, all ECI km, fresh objects every call. One shot per beat with a hard cut at each beat
// start (main.js snaps its smoothing on beat change). Within a beat the pose either blends
// between two poses with smoothstep on beat-local time or follows an actor. R = R_EARTH;
// `outward(p)` is the unit vector from the Earth's centre through p; east, north, up are the
// local frame at the point named. camera.up is the local vertical below 50 km altitude and
// world Y above (with a fallback when the view direction is parallel to it). Every offset is a
// framing choice (starting values of 5.7, to be tuned by eye in Phase 2).
//
// Also exports interceptFxAt, the intercept effect envelopes shared with states.js (the shake
// of the Intercept shot comes from it).

import { Vector3 } from 'three';
import { R_EARTH, DEG } from '../shared/constants.js';
import { localFrameEci, siteVelocityEci } from '../shared/geo.js';
import { clamp, smoothstep, easeOutQuad } from '../shared/easing.js';
import { slerpUnit } from './scenario.js';

export const FOV_DEFAULT = 50;
export const FOV_LAUNCH = 55;
// Beats that open by continuing the previous beat's shot rather than with a hard cut: Handoff
// (the acquisition view drifts into it), Intercept (the course view carries through) and
// Resolution (pulls back from the intercept framing).
const CONTINUOUS_BEATS = new Set(['handoff', 'intercept', 'resolution']);
const RELEASE_LOOK = 1.0; // release: animation seconds the camera holds on the satellite, easing its aim
const RELEASE_LOOK_SHARE = 0.4; // toward the departing kill vehicle by this share
const RELEASE_SETTLE = 0.3; // the chase into the follow shot settles this long after burnout
/** Course view: begins this many animation seconds after the kill vehicle's burnout (also the
 *  moment the projected paths fade in, states.js). */
export const COURSE_DELAY = 0.9;
const COURSE_PULL = 2.5; // pull-out from the follow shot to the course view (animation s)
const COURSE_TILT_DEG = 30; // course view: off the plane's normal, to the side
const COURSE_FIT_DEG = 16; // course view: the three points fit within this half-angle (portrait sees 20)
const COURSE_MIN_KM = 25; // course view: closest distance as the two converge (held through the intercept)
const UP_SWITCH_ALT_KM = 50; // camera.up: local vertical below, world Y above
const BOOST_MAX_CLIMB_DEG = 30; // boost shot: "behind" never points more than this below the horizontal
const LAUNCH_AIM_LOW_KM = 0.02; // launch shot: aim point up the launch axis before the follow
const LAUNCH_FOLLOW_FROM_KM = 0.04; // launch shot: missile tail height where the follow starts
const LAUNCH_FOLLOW_FULL_KM = 0.3; // launch shot: and where it is fully on the missile
const ACQ_FOLLOW_SECONDS = 1.5; // boost shot: follow the missile this long (animation s)
const ACQ_PULL_SECONDS = 2.5; // then pull back over this long, settling before the track (anim 28)
const ACQ_DISTANCE_KM = 17000; // wide acquisition view: distance across the sensor beam
const ACQ_AIM = 0.42; // aim point from the missile (0) to the sensor (1), clear of the HUD
const ACQ_DRIFT_FROM = 5.5; // boost shot: the wide view starts drifting into the Handoff framing (beat seconds)

// Intercept effect envelopes, animation seconds after the intercept (v1 pacing).
const FX_WINDOW = 3;
const FLASH_RISE = 0.3;
const FLASH_END = 1.5;
const RING_DURATION = 1.5;
const BURST_DURATION = 3;
const SHAKE_DURATION = 1;

/**
 * Intercept effects at animation time animT for an intercept at animation time animI:
 * progress values, all 0 outside [animI, animI + 3).
 * @returns {{ active: boolean, flash: number, ring: number, burst: number, shake: number }}
 */
export function interceptFxAt(animT, animI) {
  const local = animT - animI;
  if (!(local >= 0 && local < FX_WINDOW)) return { active: false, flash: 0, ring: 0, burst: 0, shake: 0 };
  const flash = local < FLASH_RISE ? smoothstep(local, 0, FLASH_RISE) : 1 - smoothstep(local, FLASH_RISE, FLASH_END);
  return {
    active: true,
    flash,
    ring: clamp(local / RING_DURATION),
    burst: clamp(local / BURST_DURATION),
    shake: local < SHAKE_DURATION ? easeOutQuad(1 - local / SHAKE_DURATION) : 0,
  };
}

const WORLD_Y = new Vector3(0, 1, 0);
const WORLD_Z = new Vector3(0, 0, 1);

/** p + a * ka + b * kb (+ c * kc), fresh vector. */
function offset(p, a, ka, b, kb, c, kc) {
  const v = p.clone().addScaledVector(a, ka).addScaledVector(b, kb);
  return c ? v.addScaledVector(c, kc) : v;
}

/** camera.up for a camera at position looking at target (5.7), never parallel to the view. */
function cameraUp(position, target) {
  const view = target.clone().sub(position);
  const len = view.length();
  if (len > 0) view.divideScalar(len);
  const alt = position.length() - R_EARTH;
  const local = position.clone().normalize();
  const candidates = alt < UP_SWITCH_ALT_KM ? [local, WORLD_Y, WORLD_Z] : [WORLD_Y, local, WORLD_Z];
  for (const c of candidates) if (Math.abs(c.dot(view)) < 0.998) return c.clone();
  return WORLD_Z.clone();
}

/**
 * Blend two camera poses by e (0..1): the target linearly, the camera's offset from it by
 * direction (slerp) and log length, and the up vector by slerp, so a long move eases evenly.
 */
function blendPose(a, b, e) {
  const offA = a.position.clone().sub(a.target);
  const offB = b.position.clone().sub(b.target);
  const la = offA.length();
  const lb = offB.length();
  const len = Math.exp(Math.log(la) + (Math.log(lb) - Math.log(la)) * e);
  // The aim moves in step with the zoom (its share of the distance change), so a pull-out keeps
  // the near subject in frame until the camera is far enough to see the far one, and a zoom-in
  // keeps the wide subject until it is close; for similar distances it moves with e.
  const wt = Math.abs(lb - la) > 0.05 * Math.max(la, lb) ? (len - la) / (lb - la) : e;
  const target = a.target.clone().lerp(b.target, wt);
  const dir = slerpUnit(offA.divideScalar(la), offB.divideScalar(lb), e);
  const up = slerpUnit(a.up.clone().normalize(), b.up.clone().normalize(), e);
  return { position: target.clone().addScaledVector(dir, len), target, up };
}

/** A shot's own up vector when it gives one and it is not along the view, else cameraUp. */
function shotUp(shot) {
  if (shot.up) {
    const view = shot.target.clone().sub(shot.position).normalize();
    if (Math.abs(shot.up.dot(view)) < 0.998) return shot.up.clone();
  }
  return cameraUp(shot.position, shot.target);
}

/**
 * @param {object} scenario from buildScenario
 * @param {object} timeline from buildTimeline
 * @returns {(animT: number) => { position: Vector3, target: Vector3, up: Vector3, fov: number, shake: number }}
 */
export function createCamera(scenario, timeline) {
  const R = R_EARTH;
  const { site, missile, sensorSat, engagement: E } = scenario;
  const relaySat = scenario.handoff.relaySat;
  const iSat = E.interceptorSat;
  const ip = E.interceptPoint.clone();
  const animRelease = timeline.simToAnim(E.tRelease);
  const animKvBurnout = timeline.simToAnim(E.tKvBurnout);
  const animCourse = animKvBurnout + COURSE_DELAY;
  const animI = timeline.simToAnim(E.tIntercept);
  const az = scenario.params.launchAzimuthDeg * DEG;
  const maxClimb = BOOST_MAX_CLIMB_DEG * DEG;

  const missileR = (simT) => {
    const s = missile.stateAt(Math.max(0, Math.min(simT, missile.tImpact)));
    return s.r;
  };

  // 1. Constellation: a slow push in toward the Earth from above the site.
  function establishing(animT, simT, beat) {
    const s = smoothstep(animT, beat.start, beat.end);
    const st = site.stateAt(simT);
    const dir = st.up;
    const from = offset(new Vector3(), dir, 4.0 * R, st.north, 0.8 * R);
    const to = offset(new Vector3(), dir, 3.3 * R, st.north, 0.6 * R);
    return { position: from.lerp(to, s), target: new Vector3(), anchor: new Vector3(), fov: FOV_DEFAULT };
  }

  // 2. Launch: 30 m up, 120 m east of the launcher. The aim holds 20 m up the launch axis, so the
  // TEL, the canister and the first metres of the climb share the frame, and blends onto the
  // missile as it climbs from 40 m to 300 m (Phase 2 framing; continuous at ignition).
  function launch(animT, simT) {
    const st = site.stateAt(simT);
    const position = offset(st.r, st.up, 0.03, st.east, 0.12, st.north, -0.05);
    const low = st.r.clone().addScaledVector(st.up, LAUNCH_AIM_LOW_KM);
    if (simT < 0) return { position, target: low, anchor: st.r.clone(), fov: FOV_LAUNCH };
    const tail = missileR(simT);
    const climb = tail.clone().sub(st.r).dot(st.up);
    const w = smoothstep(climb, LAUNCH_FOLLOW_FROM_KM, LAUNCH_FOLLOW_FULL_KM);
    return { position, target: low.lerp(tail.addScaledVector(st.up, 0.01), w), anchor: st.r.clone(), fov: FOV_LAUNCH };
  }

  // 3. Boost and acquisition: follow shot 4 km behind along the (Earth-relative) velocity and
  // 1.5 km above. While the climb is steeper than 30 degrees the "behind" vector is held at 30
  // degrees below the horizontal along the launch azimuth, so the camera stays above the ground.
  // 3. Boost and acquisition (Phase 2 follow-up). A short follow shot of the climbing missile,
  // then a pull-back (log-distance zoom) to a wide view across the sensor beam: the sensor sat
  // at the top, its cone and footprint spot on the threat at the bottom, so the track line that
  // appears at tTrack has its context. Screen-up is the site's local vertical throughout, so the
  // pull never rolls the view.
  function boost(animT, simT, beat) {
    const follow = boostFollow(simT);
    const up = site.stateAt(simT).up;
    const aPull = beat.start + ACQ_FOLLOW_SECONDS;
    if (animT <= aPull) return { ...follow, up };
    const m = follow.target;
    const s = sensorSat.stateAt(simT).r;
    const side = m.clone().cross(s).normalize();
    const wideTarget = m.clone().lerp(s, ACQ_AIM);
    const widePos = m.clone().lerp(s, 0.5).addScaledVector(side, ACQ_DISTANCE_KM);
    if (animT >= aPull + ACQ_PULL_SECONDS) {
      // After the lock-on the wide view drifts into the Handoff framing, arriving exactly on it
      // at the beat boundary, so acquisition flows into handoff with no hold and no cut.
      const aDrift = beat.start + ACQ_DRIFT_FROM;
      if (animT <= aDrift) return { position: widePos, target: wideTarget, up, fov: FOV_DEFAULT };
      const h = handoff(animT, simT);
      const hUp = cameraUp(h.position, h.target);
      const e = smoothstep(animT, aDrift, beat.end);
      return { ...blendPose({ position: widePos, target: wideTarget, up }, { ...h, up: hUp }, e), fov: FOV_DEFAULT };
    }
    const e = smoothstep(animT, aPull, aPull + ACQ_PULL_SECONDS);
    const wideOffset = widePos.clone().sub(wideTarget);
    const d0 = follow.position.distanceTo(m);
    const d1 = wideOffset.length();
    const dist = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e);
    const w = (dist - d0) / (d1 - d0);
    const target = m.clone().lerp(wideTarget, w);
    const dir = slerpUnit(follow.position.clone().sub(m).normalize(), wideOffset.divideScalar(d1), e);
    return { position: target.clone().addScaledVector(dir, dist), target, up, fov: FOV_DEFAULT };
  }

  function boostFollow(simT) {
    const t = Math.max(0, Math.min(simT, missile.tImpact));
    const s = missile.stateAt(t);
    const { up, east, north } = localFrameEci(s.r);
    const vRel = s.v.clone().sub(siteVelocityEci(s.r));
    const speed = vRel.length();
    let climb = speed > 1e-9 ? Math.asin(clamp(vRel.dot(up) / speed, -1, 1)) : Math.PI / 2;
    let behind;
    if (climb > maxClimb || speed < 1e-9) {
      climb = maxClimb;
      const fwd = north.clone().multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az));
      behind = fwd.multiplyScalar(Math.cos(climb)).addScaledVector(up, Math.sin(climb));
    } else {
      behind = vRel.divideScalar(speed);
    }
    const position = s.r.clone().addScaledVector(behind, -4).addScaledVector(up, 1.5);
    return { position, target: s.r.clone(), fov: FOV_DEFAULT };
  }

  // 4. Handoff: wide follow shot above the sensor-interceptor midpoint. Phase 2 framing: the
  // camera sits 2.0 R east (5.7 said 0.4 R) and aims 0.45 of the way from the relay to the
  // sensor, so the sensor, relay, interceptor satellite and missile stay between 16 degrees below
  // and 18 above the axis, clear of the HUD
  // (with the 5.7 aim on the relay the sensor sat 40 degrees off axis, out of frame).
  function handoff(animT, simT) {
    const sensor = sensorSat.stateAt(simT).r;
    const mid = sensor.clone().add(iSat.stateAt(simT).r).multiplyScalar(0.5);
    const { up, east } = localFrameEci(mid);
    const target = relaySat.stateAt(simT).r.lerp(sensor, 0.45);
    return { position: offset(mid, up, 1.2 * R, east, 2.0 * R), target, anchor: mid.clone(), fov: FOV_DEFAULT };
  }

  // 5. Engage (Phase 2 follow-up). The interceptor satellite close up, seen from behind and
  // above its final aim (departDir), so the slew turns the tube away from the camera. The
  // release plays in slow motion (timeline.js): the camera holds on the satellite while the
  // kill vehicle leaves the tube and accelerates away on its burn, easing its aim toward it,
  // then chases it into the follow shot 60 m behind and 20 m above, settling just after burnout.
  const depart = E.departDir.clone();
  function engageViewpoint(sat) {
    const { up } = localFrameEci(sat);
    const lift = up.clone().addScaledVector(depart, -up.dot(depart)).normalize();
    const side = depart.clone().cross(lift);
    return sat.clone().addScaledVector(depart, -0.035).addScaledVector(lift, 0.022).addScaledVector(side, 0.012);
  }
  function kvFollow(t) {
    const kv = E.kv.stateAt(t).r;
    const dir = E.kv.directionAt(t);
    return { kv, position: offset(kv, dir, -0.06, kv.clone().normalize(), 0.02) };
  }
  function engage(animT, simT) {
    const sat = iSat.stateAt(simT).r;
    const hold = engageViewpoint(sat);
    if (animT < animRelease || simT < E.tRelease) return { position: hold, target: sat, anchor: sat.clone(), fov: FOV_DEFAULT };
    const t = Math.min(simT, E.tIntercept);
    const { kv, position: follow } = kvFollow(t);
    const look = smoothstep(animT, animRelease, animRelease + RELEASE_LOOK);
    const chase = smoothstep(animT, animRelease + RELEASE_LOOK, animKvBurnout + RELEASE_SETTLE);
    if (chase >= 1) {
      // Course view (Phase 2 follow-up): after the launch the camera pulls out to watch the
      // kill vehicle and the threat close on the intercept point along their arcs.
      const e = smoothstep(animT, animCourse, animCourse + COURSE_PULL);
      if (e <= 0) return { position: follow, target: kv, fov: FOV_DEFAULT };
      const near = { position: follow, target: kv, up: cameraUp(follow, kv) };
      return { ...blendPose(near, coursePose(simT), e), fov: FOV_DEFAULT };
    }
    const holdTarget = sat.clone().lerp(kv, RELEASE_LOOK_SHARE * look);
    const target = holdTarget.lerp(kv, chase);
    const position = hold.lerp(follow, chase);
    // Anchored on the aim point throughout (the default), so the smoothing never re-references.
    return { position, target, fov: FOV_DEFAULT };
  }

  // 6. Intercept (Phase 2 follow-up, Wes): the course view of the Engage beat carries straight
  // through. It keeps tightening as the kill vehicle and the threat close on the intercept point,
  // down to COURSE_MIN_KM, and holds that final framing for the flash and the debris, with shake.
  function intercept(animT, simT) {
    return { ...coursePose(simT), fov: FOV_DEFAULT, shake: interceptFxAt(animT, animI).shake };
  }

  // Course view: looking down across the plane of the two velocities, tilted COURSE_TILT_DEG
  // to the side, with the motion running across the screen; framed on the kill vehicle, the
  // threat and the intercept point so it tightens as they converge.
  function coursePose(simT) {
    const t = Math.max(E.tRelease, Math.min(simT, E.tIntercept - 1e-6));
    const k = E.kv.stateAt(t);
    const m = missile.stateAt(t);
    const target = k.r.clone().add(m.r).add(ip).multiplyScalar(1 / 3);
    const ext = Math.max(k.r.distanceTo(target), m.r.distanceTo(target), ip.distanceTo(target));
    // A smooth floor (cube-root of the sum of cubes), so the zoom settles onto COURSE_MIN_KM
    // instead of stopping on it.
    const dist = Math.cbrt((ext / Math.tan(COURSE_FIT_DEG * DEG)) ** 3 + COURSE_MIN_KM ** 3);
    const n = k.v.clone().cross(m.v).normalize();
    if (n.dot(target) < 0) n.negate();
    const motion = k.v.clone().add(m.v);
    motion.addScaledVector(n, -motion.dot(n)).normalize();
    const side = motion.clone().cross(n);
    const tilt = COURSE_TILT_DEG * DEG;
    const eyeDir = n.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(side, Math.sin(tilt));
    const up = eyeDir.clone().cross(motion).normalize();
    return { position: target.clone().addScaledVector(eyeDir, dist), target, up };
  }

  // 7. Resolution: pull back from the course view's final framing of the intercept point (no
  // cut, Phase 2 follow-up) to the wide view over the site.
  function resolution(animT, simT, beat) {
    const s = smoothstep(animT, beat.start, beat.end);
    const st = site.stateAt(simT);
    const to = offset(new Vector3(), st.up, 3.5 * R, st.north, 0.7 * R);
    const wide = { position: to, target: new Vector3(), up: cameraUp(to, new Vector3()) };
    return { ...blendPose(coursePose(simT), wide, s), anchor: new Vector3(), fov: FOV_DEFAULT };
  }

  const SHOTS = { establishing, launch, boost, handoff, engage, intercept, resolution };

  return function cameraState(animT) {
    const beat = timeline.getBeat(animT);
    const simT = timeline.animToSim(animT);
    const shot = (SHOTS[beat.id] || establishing)(animT, simT, beat);
    return {
      position: shot.position,
      target: shot.target,
      // The point the camera position is rigidly attached to in this shot; main.js smooths the
      // camera's offset from it (the target for follow shots, the site for the launch shot, the
      // Earth's centre for fixed shots), so smoothing never makes a shot lag what it tracks.
      anchor: shot.anchor || shot.target.clone(),
      // Changes when a shot switches what it is anchored to, so main.js can re-reference its
      // smoothing without a jump.
      anchorKey: shot.anchorKey || (shot.anchor ? 'anchor' : 'target'),
      // False for beats whose first frame continues the previous beat's shot (main.js keeps its
      // smoothing across that join instead of snapping, as it does at a hard cut).
      cutIn: !CONTINUOUS_BEATS.has(beat.id),
      up: shotUp(shot),
      fov: shot.fov,
      shake: shot.shake || 0,
    };
  };
}
