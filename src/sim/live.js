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
// Pure, Node-importable; every call returns fresh objects.

import { Vector3 } from 'three';
import { R_EARTH, DEG } from '../shared/constants.js';
import { earthRotationAngle, eciToEcef, ecefToLatLonAlt, localFrameEci, siteVelocityEci } from '../shared/geo.js';

/** Version of the live link messages (README, "Live link"). */
export const LIVE_PROTOCOL = 1;

const FOOTPRINT_POINTS = 36;

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
    headingDeg: ((Math.atan2(de, dn) / DEG) % 360 + 360) % 360,
    pitchDeg: Math.atan2(du, Math.hypot(de, dn)) / DEG,
  };
}

/** A shell satellite's geodetic state, tagged with its id. */
function satellite(sat, t, siteAltM) {
  const s = sat.stateAt(t);
  return { id: sat.id, ...geodetic(s.r, s.v, null, t, siteAltM) };
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
    k = geodetic(s.r, s.v, kv.directionAt(t), t, siteAltM);
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
      interceptor: satellite(engagement.interceptorSat, t, siteAltM),
    },
    footprint: footprint(scenario, t),
    intercept,
  };
}

/** Scenario events with t0 < t <= t1, in time order: [{ t, id, text }]. */
export function eventsBetween(scenario, t0, t1) {
  return scenario.events.filter((e) => e.t > t0 && e.t <= t1).map(({ t, id, text }) => ({ t, id, text }));
}

/** What a host needs to know about the scenario: the site, the azimuth and the key times. */
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
    },
  };
}
