import { test } from 'node:test';
import assert from 'node:assert/strict';
import { R_EARTH, DEG } from '../src/shared/constants.js';
import { smoothstep } from '../src/shared/easing.js';
import { latLonToEcef, ecefToEci, eciToEcef, earthRotationAngle, localFrame } from '../src/shared/geo.js';
import { buildScenario, DEFAULT_PARAMS } from '../src/sim/scenario.js';
import { exportLiveState, eventsBetween, liveScenarioSummary } from '../src/sim/live.js';

const scenario = buildScenario();
const { tRelease, tIntercept } = scenario.engagement;
const SITE_ALT_M = 1800;

/** ECEF position (km) of a geodetic actor exported with siteAltM. */
function ecefOf(a, siteAltM = SITE_ALT_M) {
  return latLonToEcef(a.lat, a.lon, (a.altM - siteAltM) / 1000);
}

test('the missile starts on the site at the host ground altitude, at rest on the Earth', () => {
  const s = exportLiveState(scenario, 0, { siteAltM: SITE_ALT_M });
  assert.ok(Math.abs(s.missile.lat - DEFAULT_PARAMS.site.lat) < 1e-9);
  assert.ok(Math.abs(s.missile.lon - DEFAULT_PARAMS.site.lon) < 1e-9);
  assert.ok(Math.abs(s.missile.altM - SITE_ALT_M) < 1e-6, `altM ${s.missile.altM}`);
  assert.ok(Math.hypot(...s.missile.velEnuMs) < 1e-6, 'Earth-relative speed at ignition');
  assert.equal(s.phase, 'boost');
});

test('before ignition there is no missile or kill vehicle, and the satellites are there', () => {
  const s = exportLiveState(scenario, -5);
  assert.equal(s.missile, null);
  assert.equal(s.killVehicle, null);
  assert.equal(s.phase, 'prelaunch');
  assert.equal(s.intercept, null);
  for (const key of ['sensor', 'relay', 'interceptor']) {
    assert.ok(Number.isFinite(s.satellites[key].lat), key);
    assert.equal(typeof s.satellites[key].id, 'string');
  }
});

test('the boost attitude is the pitch program along the launch azimuth', () => {
  const { verticalUntil, rampEnd, finalDeg } = DEFAULT_PARAMS.pitch;
  for (const t of [60, 100, 140]) {
    const m = exportLiveState(scenario, t).missile;
    const pitch = 90 - (90 - finalDeg) * smoothstep(t, verticalUntil, rampEnd);
    assert.ok(Math.abs(m.headingDeg - DEFAULT_PARAMS.launchAzimuthDeg) < 1e-6, `heading at ${t}: ${m.headingDeg}`);
    assert.ok(Math.abs(m.pitchDeg - pitch) < 1e-6, `pitch at ${t}: ${m.pitchDeg} vs ${pitch}`);
  }
});

test('geodetic positions round-trip to the scenario ECI positions', () => {
  for (const t of [10, 180, 600, tRelease + 1, tIntercept - 1]) {
    const s = exportLiveState(scenario, t, { siteAltM: SITE_ALT_M });
    const theta = earthRotationAngle(t);
    const m = ecefToEci(ecefOf(s.missile), theta);
    assert.ok(m.distanceTo(scenario.missile.stateAt(t).r) < 1e-6, `missile at ${t}`);
    const sen = ecefToEci(ecefOf(s.satellites.sensor), theta);
    assert.ok(sen.distanceTo(scenario.sensorSat.stateAt(t).r) < 1e-6, `sensor at ${t}`);
    if (s.killVehicle) {
      const k = ecefToEci(ecefOf(s.killVehicle), theta);
      assert.ok(k.distanceTo(scenario.engagement.kv.stateAt(t).r) < 1e-6, `kill vehicle at ${t}`);
    }
  }
});

test('velocities are Earth-relative east, north, up (finite difference of the geodetic track)', () => {
  const h = 0.01;
  for (const [name, pick] of [
    ['missile', (s) => s.missile],
    ['interceptor sat', (s) => s.satellites.interceptor],
  ]) {
    const t = 600;
    const a = pick(exportLiveState(scenario, t - h / 2));
    const b = pick(exportLiveState(scenario, t + h / 2));
    const mid = pick(exportLiveState(scenario, t));
    const d = ecefOf(b, 0).sub(ecefOf(a, 0)).divideScalar(h); // km/s, ECEF
    const { east, north, up } = localFrame(mid.lat, mid.lon);
    const fd = [d.dot(east) * 1000, d.dot(north) * 1000, d.dot(up) * 1000];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(fd[i] - mid.velEnuMs[i]) < 0.05, `${name} component ${i}: ${fd[i]} vs ${mid.velEnuMs[i]}`);
    }
  }
});

test('the kill vehicle exists from release to the intercept and meets the missile', () => {
  assert.equal(exportLiveState(scenario, tRelease - 0.01).killVehicle, null);
  assert.ok(exportLiveState(scenario, tRelease).killVehicle);
  const s = exportLiveState(scenario, tIntercept - 0.001);
  const gapKm = ecefOf(s.missile, 0).distanceTo(ecefOf(s.killVehicle, 0));
  assert.ok(gapKm < 0.01, `gap ${gapKm * 1000} m`);
});

test('from the intercept on, the missile and kill vehicle are gone and the intercept point is given', () => {
  const s = exportLiveState(scenario, tIntercept + 5, { siteAltM: SITE_ALT_M });
  assert.equal(s.missile, null);
  assert.equal(s.killVehicle, null);
  assert.equal(s.phase, 'intercepted');
  assert.ok(s.status.intercepted);
  const p = eciToEcef(scenario.engagement.interceptPoint, earthRotationAngle(tIntercept));
  assert.ok(ecefOf(s.intercept).distanceTo(p) < 1e-6);
  assert.equal(s.intercept.t, tIntercept);
});

test('the footprint ring lies on the Earth and on the sensor cone', () => {
  const t = 30;
  const s = exportLiveState(scenario, t);
  const theta = earthRotationAngle(t);
  const apex = eciToEcef(scenario.sensorSat.stateAt(t).r, theta);
  const centre = latLonToEcef(s.footprint.center[0], s.footprint.center[1]);
  const axis = centre.clone().sub(apex).normalize();
  assert.equal(s.footprint.ring.length, 36);
  for (const [lat, lon] of s.footprint.ring) {
    const p = latLonToEcef(lat, lon);
    assert.ok(Math.abs(p.length() - R_EARTH) < 1e-6);
    const angle = Math.acos(p.clone().sub(apex).normalize().dot(axis)) / DEG;
    assert.ok(Math.abs(angle - scenario.sensorSat.coneHalfAngleDeg) < 1e-6, `ring angle ${angle}`);
  }
});

test('status flags and phases follow the key times', () => {
  const { tDetect, tTrack } = scenario.detection;
  assert.equal(exportLiveState(scenario, tDetect - 0.01).status.detected, false);
  assert.equal(exportLiveState(scenario, tDetect).status.detected, true);
  assert.equal(exportLiveState(scenario, tTrack).status.tracking, true);
  assert.equal(exportLiveState(scenario, scenario.missile.burnout.t).phase, 'coast');
});

test('every numeric field is finite from T-60 s to 60 s after the intercept', () => {
  const walk = (v, path, bad) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad.push(path);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, bad);
    }
  };
  const bad = [];
  for (let t = -60; t <= tIntercept + 60; t += 1) walk(exportLiveState(scenario, t, { siteAltM: SITE_ALT_M }), `t=${t}`, bad);
  assert.deepEqual(bad.slice(0, 5), []);
});

test('events carry unique ids and eventsBetween is (t0, t1]', () => {
  const all = eventsBetween(scenario, -Infinity, Infinity);
  assert.equal(all.length, scenario.events.length);
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
  const early = eventsBetween(scenario, 0, scenario.detection.tDetect).map((e) => e.id);
  assert.ok(early.includes('DETECT') && !early.includes('IGNITION'));
});

test('the scenario summary gives the site, the azimuth and ordered key times', () => {
  const s = liveScenarioSummary(scenario);
  assert.equal(s.protocol, 1);
  assert.deepEqual(s.site, { lat: DEFAULT_PARAMS.site.lat, lon: DEFAULT_PARAMS.site.lon });
  assert.equal(s.azimuthDeg, DEFAULT_PARAMS.launchAzimuthDeg);
  const k = s.keyTimes;
  assert.ok(k.detect < k.track && k.track < k.assign && k.assign < k.release && k.release < k.intercept && k.intercept < k.impact);
});
