// Live link export: the engagement as Earth-fixed geodetic data for an external host.
//
// exportLiveState(scenario, t, { siteAltM }) returns the physical state at simulation time t
// (seconds from ignition) with no choreography:
//   - latitude and longitude in degrees on this model's sphere (a host may use them as WGS84);
//   - altM: metres above the sphere plus siteAltM, the launcher's ground altitude on the host's
//     terrain, so the missile starts on the host's ground;
//   - velEnuMs: velocity in metres per second east, north and up, relative to the rotating Earth;
//   - headingDeg (clockwise from north) and pitchDeg (above the local horizontal) of the body axis
//     for the missile and the kill vehicle, of the velocity for the satellites.
// The missile is null before ignition and from the intercept on; the kill vehicle exists from
// release to the intercept; the three engaged satellites always. eventsBetween() and
// liveScenarioSummary() give a host the event stream and the key times.
//
// The space segment's picture, in simulation time: the interceptor satellite's pointing axis
// (the axis its slew turns onto the firing direction) and its reaction-control thrusters, the
// kill vehicle's plume through its kick burn, and the intercept effects (flash, shock ring,
// debris burst) with the levels and sizes the visualization draws (effects.js).
//
// Pure, Node-importable; every call returns fresh objects.

import { Vector3 } from 'three';
import { R_EARTH, DEG } from '../shared/constants.js';
import { earthRotationAngle, eciToEcef, ecefToLatLonAlt, localFrameEci, siteVelocityEci } from '../shared/geo.js';
import {
  interceptFxAt,
  interceptFxShape,
  FX_WINDOW,
  FLASH_END,
  RING_DURATION,
  BURST_DURATION,
  BURST_PIECES,
  BURST_PIECE_SIZE_KM,
} from './effects.js';

/** Version of the live link messages (README, "Live link"). */
export const LIVE_PROTOCOL = 1;

const FOOTPRINT_POINTS = 36;
const NADIR_EPS = 1e-9; // horizontal part of a unit axis below which it points straight down

/** Heading of the horizontal direction (east, north), degrees clockwise from north in [0, 360). */
function headingOf(e, n) {
  return ((Math.atan2(e, n) / DEG) % 360 + 360) % 360;
}

/** Pitch of the direction (east, north, up) above the local horizontal, degrees. */
function pitchOf(e, n, u) {
  return Math.atan2(u, Math.hypot(e, n)) / DEG;
}

/** East, north and up components of the ECI vector d in the local frame at ECI position r, time t. */
function enuAt(d, r, t) {
  const theta = earthRotationAngle(t);
  const { up, east, north } = localFrameEci(eciToEcef(r, theta));
  const dE = eciToEcef(d, theta);
  return [dE.dot(east), dE.dot(north), dE.dot(up)];
}

/**
 * Earth-fixed geodetic state of an ECI position r and velocity v (km, km/s) at time t. The
 * attitude follows axis (an ECI unit vector) when given, otherwise the Earth-relative velocity.
 */
function geodetic(r, v, axis, t, siteAltM) {
  const theta = earthRotationAngle(t);
  const rE = eciToEcef(r, theta);
  const vE = eciToEcef(v.clone().sub(siteVelocityEci(r)), theta);
  const { up, east, north } = localFrameEci(rE);
  const { lat, lon, altKm } = ecefToLatLonAlt(rE);
  const dir = axis ? eciToEcef(axis, theta) : vE;
  const de = dir.dot(east);
  const dn = dir.dot(north);
  const du = dir.dot(up);
  return {
    lat,
    lon,
    altM: altKm * 1000 + siteAltM,
    velEnuMs: [vE.dot(east) * 1000, vE.dot(north) * 1000, vE.dot(up) * 1000],
    headingDeg: headingOf(de, dn),
    pitchDeg: pitchOf(de, dn, du),
  };
}

/** A shell satellite's geodetic state, tagged with its id. */
function satellite(sat, t, siteAltM) {
  const s = sat.stateAt(t);
  return { id: sat.id, ...geodetic(s.r, s.v, null, t, siteAltM) };
}

/**
 * The interceptor satellite: its geodetic state (heading and pitch of the velocity, as for every
 * satellite), plus
 *   - pointing: heading and pitch of the axis its slew turns (scenario.js, facingAt): the launch
 *     tube's axis, nadir until the slew starts, on the firing direction from the release on;
 *   - thrusters: the reaction-control firing (scenario.js, rcsAt), level 1 while they spin the
 *     slew up and while they brake it, with dirEnu the unit vector (east, north, up) along which
 *     they push the pointing axis (toward the firing direction, then against the turn); level 0
 *     and dirEnu null otherwise.
 */
function interceptorSatellite(E, t, siteAltM) {
  const sat = E.interceptorSat;
  const r = sat.stateAt(t).r;
  const [e, n, u] = enuAt(E.facingAt(t), r, t);
  // Nadir has no horizontal part, so there the heading is taken from the firing direction: it
  // does not flicker with rounding, and it runs on into the slew, whose horizontal part is the
  // firing direction's.
  let [he, hn] = [e, n];
  if (Math.hypot(e, n) < NADIR_EPS) [he, hn] = enuAt(E.departDir, r, t);
  const rcs = E.rcsAt(t);
  return {
    ...satellite(sat, t, siteAltM),
    pointing: { headingDeg: headingOf(he, hn), pitchDeg: pitchOf(e, n, u) },
    thrusters: rcs.level > 0 ? { level: rcs.level, dirEnu: enuAt(rcs.dir, r, t) } : { level: 0, dirEnu: null },
  };
}

/**
 * The intercept effects at t as the visualization draws them (effects.js): null before the
 * intercept and from the end of the envelopes on, and each effect null after its own envelope.
 * flash and ring: { level, diameterKm }; burst: { level, count, spreadKm, pieceSizeKm }. The film
 * plays the Intercept beat in real time, so its seconds after the intercept are simulation seconds.
 */
function interceptEffects(tIntercept, t) {
  const since = t - tIntercept;
  if (!(since >= 0 && since < FX_WINDOW)) return null;
  const { flash, ring, burst } = interceptFxShape(interceptFxAt(t, tIntercept));
  return {
    flash: since < FLASH_END ? flash : null,
    ring: since < RING_DURATION ? ring : null,
    burst:
      since < BURST_DURATION
        ? { level: burst.level, count: BURST_PIECES.count, spreadKm: burst.spreadKm, pieceSizeKm: BURST_PIECE_SIZE_KM }
        : null,
  };
}

/** Distance along unit ray u from apex to the sphere of radius rf (closest approach on a miss). */
function rayToSphere(apex, u, rf) {
  const b = apex.dot(u);
  const disc = b * b - (apex.lengthSq() - rf * rf);
  if (disc < 0) return Math.max(0, -b);
  return Math.max(0, -b - Math.sqrt(disc));
}

/**
 * The sensor's field of view on the ground at t: the centre where the cone axis meets the sphere
 * and a ring of FOOTPRINT_POINTS where its edge rays do, as [lat, lon] pairs (the same
 * construction as the scene's beam).
 */
function footprint(scenario, t) {
  const { sensorSat } = scenario;
  const theta = earthRotationAngle(t);
  const apex = sensorSat.stateAt(t).r;
  const axis = sensorSat.sweepTargetAt(t).sub(apex).normalize();
  const e1 = new Vector3(0, 1, 0);
  if (Math.abs(axis.dot(e1)) > 0.9) e1.set(1, 0, 0);
  e1.addScaledVector(axis, -e1.dot(axis)).normalize();
  const e2 = new Vector3().crossVectors(axis, e1);
  const half = sensorSat.coneHalfAngleDeg * DEG;
  const onGround = (u) => {
    const p = eciToEcef(apex.clone().addScaledVector(u, rayToSphere(apex, u, R_EARTH)), theta);
    const { lat, lon } = ecefToLatLonAlt(p);
    return [lat, lon];
  };
  const ring = [];
  for (let i = 0; i < FOOTPRINT_POINTS; i++) {
    const phi = (i / FOOTPRINT_POINTS) * Math.PI * 2;
    const u = axis
      .clone()
      .multiplyScalar(Math.cos(half))
      .addScaledVector(e1, Math.sin(half) * Math.cos(phi))
      .addScaledVector(e2, Math.sin(half) * Math.sin(phi));
    ring.push(onGround(u));
  }
  return { center: onGround(axis), ring, halfAngleDeg: sensorSat.coneHalfAngleDeg };
}

/**
 * Physical state of the engagement at simulation time t for a live-link host.
 * @param {object} scenario from buildScenario
 * @param {number} t seconds from ignition
 * @param {{ siteAltM?: number }} [options] siteAltM: the launcher's ground altitude, metres
 */
export function exportLiveState(scenario, t, { siteAltM = 0 } = {}) {
  const { missile, detection, handoff, engagement } = scenario;
  const { tRelease, tIntercept, kv } = engagement;

  let m = null;
  if (t >= 0 && t < tIntercept) {
    const s = missile.stateAt(t);
    m = geodetic(s.r, s.v, missile.directionAt(t), t, siteAltM);
  }
  let k = null;
  if (t >= tRelease && t < tIntercept) {
    const s = kv.stateAt(t);
    // plume: 1 through the kick burn, 0 after (the film's short fade after the burn is paced in
    // animation time, so it is left out here).
    k = { ...geodetic(s.r, s.v, kv.directionAt(t), t, siteAltM), plume: t < tRelease + kv.burnDuration ? 1 : 0 };
  }
  let intercept = null;
  if (t >= tIntercept) {
    const p = ecefToLatLonAlt(eciToEcef(engagement.interceptPoint, earthRotationAngle(tIntercept)));
    intercept = { t: tIntercept, lat: p.lat, lon: p.lon, altM: p.altKm * 1000 + siteAltM };
  }

  let phase = 'prelaunch';
  if (t >= tIntercept) phase = 'intercepted';
  else if (t >= missile.burnout.t) phase = 'coast';
  else if (t >= 0) phase = 'boost';

  return {
    t,
    phase,
    status: {
      detected: t >= detection.tDetect,
      tracking: t >= detection.tTrack,
      assigned: t >= handoff.tAssign,
      released: t >= tRelease,
      intercepted: t >= tIntercept,
    },
    missile: m,
    killVehicle: k,
    satellites: {
      sensor: satellite(scenario.sensorSat, t, siteAltM),
      relay: satellite(handoff.relaySat, t, siteAltM),
      interceptor: interceptorSatellite(engagement, t, siteAltM),
    },
    footprint: footprint(scenario, t),
    intercept,
    interceptFx: interceptEffects(tIntercept, t),
  };
}

/** Scenario events with t0 < t <= t1, in time order: [{ t, id, text }]. */
export function eventsBetween(scenario, t0, t1) {
  return scenario.events.filter((e) => e.t > t0 && e.t <= t1).map(({ t, id, text }) => ({ t, id, text }));
}

/**
 * What a host needs to know about the scenario: the site, the azimuth and the key times (orient:
 * the interceptor satellite's slew starts, ending at release; kvBurnout: the kill vehicle's kick
 * burn ends; interceptFxEnd: the intercept effects end).
 */
export function liveScenarioSummary(scenario) {
  const { params, missile, detection, handoff, engagement } = scenario;
  return {
    protocol: LIVE_PROTOCOL,
    site: { lat: params.site.lat, lon: params.site.lon },
    azimuthDeg: params.launchAzimuthDeg,
    keyTimes: {
      detect: detection.tDetect,
      track: detection.tTrack,
      assign: handoff.tAssign,
      burnout: missile.burnout.t,
      release: engagement.tRelease,
      intercept: engagement.tIntercept,
      impact: missile.tImpact,
      orient: engagement.tOrient,
      kvBurnout: engagement.tKvBurnout,
      interceptFxEnd: engagement.tIntercept + FX_WINDOW,
    },
  };
}
