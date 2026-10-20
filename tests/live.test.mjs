import { test } from 'node:test';
import assert from 'node:assert/strict';
import { R_EARTH, DEG } from '../src/shared/constants.js';
import { smoothstep } from '../src/shared/easing.js';
import { latLonToEcef, ecefToEci, eciToEcef, earthRotationAngle, localFrame } from '../src/shared/geo.js';
import { Vector3 } from 'three';
import { buildScenario, DEFAULT_PARAMS } from '../src/sim/scenario.js';
import { buildTimeline } from '../src/sim/timeline.js';
import { createStateComputer } from '../src/sim/states.js';
import { interceptFxShape } from '../src/sim/effects.js';
import { exportLiveState, eventsBetween, liveScenarioSummary } from '../src/sim/live.js';

const scenario = buildScenario();
const { tRelease, tIntercept } = scenario.engagement;
const SITE_ALT_M = 1800;

/** ECEF position (km) of a geodetic actor exported with siteAltM. */
function ecefOf(a, siteAltM = SITE_ALT_M) {
  return latLonToEcef(a.lat, a.lon, (a.altM - siteAltM) / 1000);
}

/** ECI unit vector of heading and pitch (degrees) at the geodetic actor a, time t. */
function eciAxis(headingDeg, pitchDeg, a, t) {
  const { east, north, up } = localFrame(a.lat, a.lon);
  const h = headingDeg * DEG;
  const p = pitchDeg * DEG;
  const d = new Vector3()
    .addScaledVector(east, Math.cos(p) * Math.sin(h))
    .addScaledVector(north, Math.cos(p) * Math.cos(h))
    .addScaledVector(up, Math.sin(p));
  return ecefToEci(d, earthRotationAngle(t));
}

/** East, north and up components of the ECI vector v at the geodetic actor a, time t. */
function enuOf(v, a, t) {
  const { east, north, up } = localFrame(a.lat, a.lon);
  const d = eciToEcef(v, earthRotationAngle(t));
  return [d.dot(east), d.dot(north), d.dot(up)];
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The visualization's own states, for checking that the export carries the numbers it draws.
const timeline = buildTimeline(scenario);
const computeStates = createStateComputer(scenario, timeline);
const filmAt = (t) => computeStates(timeline.simToAnim(t));

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

// ---------------------------------------------------------------------------
// Space segment: the interceptor satellite's slew and thrusters, the kill vehicle's plume and
// the intercept effects.

const E = scenario.engagement;
const tOrient = E.tOrient;
const slewSpan = tRelease - tOrient;
const accelShare = DEFAULT_PARAMS.engagement.slewAccelFraction;
const tSpunUp = tOrient + accelShare * slewSpan; // thrusters stop spinning the slew up
const tBrake = tRelease - accelShare * slewSpan; // and start braking it
const tKvBurnEnd = tRelease + E.kv.burnDuration;

test('the scenario summary adds the slew start, the kill vehicle burnout and the end of the intercept effects', () => {
  const k = liveScenarioSummary(scenario).keyTimes;
  assert.equal(k.orient, tOrient);
  assert.equal(k.kvBurnout, E.tKvBurnout);
  assert.equal(k.interceptFxEnd, tIntercept + 3);
  assert.ok(k.orient < k.release && k.release < k.kvBurnout && k.kvBurnout < k.intercept && k.intercept < k.interceptFxEnd);
});

test('the interceptor satellite pointing axis is the slew axis, separate from its velocity heading', () => {
  for (const t of [tOrient - 30, tOrient, tOrient + 20, (tSpunUp + tBrake) / 2, tRelease - 10, tRelease, tRelease + 200]) {
    const sat = exportLiveState(scenario, t).satellites.interceptor;
    const axis = eciAxis(sat.pointing.headingDeg, sat.pointing.pitchDeg, sat, t);
    const err = axis.distanceTo(E.facingAt(t));
    assert.ok(err < 1e-9, `pointing at ${t} is ${err} off the slew axis`);
    // headingDeg and pitchDeg stay those of the velocity.
    const [ve, vn, vu] = sat.velEnuMs;
    const velHeading = ((Math.atan2(ve, vn) / DEG) % 360 + 360) % 360;
    assert.ok(Math.abs(sat.headingDeg - velHeading) < 1e-9, `velocity heading at ${t}`);
    assert.ok(Math.abs(sat.pitchDeg - Math.atan2(vu, Math.hypot(ve, vn)) / DEG) < 1e-9, `velocity pitch at ${t}`);
  }
  const mid = exportLiveState(scenario, (tSpunUp + tBrake) / 2).satellites.interceptor;
  assert.ok(Math.abs(mid.pointing.headingDeg - mid.headingDeg) > 1, 'the pointing heading is not the velocity heading');
});

test('the pointing axis is nadir before the slew, with a steady heading that runs on into the slew', () => {
  for (const t of [-60, 0, tOrient - 1, tOrient]) {
    const p = exportLiveState(scenario, t).satellites.interceptor.pointing;
    assert.ok(Math.abs(p.pitchDeg + 90) < 1e-9, `nadir at ${t}: pitch ${p.pitchDeg}`);
  }
  const before = exportLiveState(scenario, tOrient - 0.01).satellites.interceptor.pointing;
  const after = exportLiveState(scenario, tOrient + 0.01).satellites.interceptor.pointing;
  assert.ok(Math.abs(before.headingDeg - after.headingDeg) < 0.01, `heading ${before.headingDeg} -> ${after.headingDeg}`);
  assert.ok(after.pitchDeg > -90 && after.pitchDeg < -89.99, `the slew has just begun: pitch ${after.pitchDeg}`);
});

test('the slew turns the pointing axis 124.5 degrees and ends on the firing direction at release', () => {
  const start = exportLiveState(scenario, tOrient).satellites.interceptor;
  const end = exportLiveState(scenario, tRelease);
  const sat = end.satellites.interceptor;
  const a0 = eciAxis(start.pointing.headingDeg, start.pointing.pitchDeg, start, tOrient);
  const a1 = eciAxis(sat.pointing.headingDeg, sat.pointing.pitchDeg, sat, tRelease);
  assert.ok(Math.abs(a0.angleTo(a1) / DEG - E.slewAngleDeg) < 1e-6, `slew ${a0.angleTo(a1) / DEG} deg`);
  assert.ok(Math.abs(E.slewAngleDeg - 124.5) < 0.1, `slew angle ${E.slewAngleDeg}`);
  assert.ok(a1.distanceTo(E.departDir) < 1e-9, 'on the firing direction at release');
  // The kill vehicle leaves along the same axis (3 m out of the tube, so its local frame is a
  // few hundred-thousandths of a degree away).
  assert.ok(Math.abs(sat.pointing.headingDeg - end.killVehicle.headingDeg) < 1e-4, 'heading matches the kill vehicle');
  assert.ok(Math.abs(sat.pointing.pitchDeg - end.killVehicle.pitchDeg) < 1e-4, 'pitch matches the kill vehicle');
  // And it holds the firing direction after the release.
  const later = exportLiveState(scenario, tRelease + 300).satellites.interceptor;
  assert.ok(eciAxis(later.pointing.headingDeg, later.pointing.pitchDeg, later, tRelease + 300).distanceTo(E.departDir) < 1e-9);
});

test('the thrusters fire while the slew spins up and while it brakes, pushing toward and then against the turn', () => {
  const at = (t) => {
    const sat = exportLiveState(scenario, t).satellites.interceptor;
    const axis = enuOf(E.facingAt(t), sat, t);
    return { ...sat.thrusters, axis, firing: enuOf(E.departDir, sat, t) };
  };
  for (const t of [-60, tOrient - 1, tOrient, (tSpunUp + tBrake) / 2, tRelease, tRelease + 1, tIntercept]) {
    assert.deepEqual(exportLiveState(scenario, t).satellites.interceptor.thrusters, { level: 0, dirEnu: null }, `off at ${t}`);
  }
  for (const [t, sign] of [
    [tOrient + 0.5, 1],
    [(tOrient + tSpunUp) / 2, 1],
    [tSpunUp - 0.5, 1],
    [tBrake + 0.5, -1],
    [(tBrake + tRelease) / 2, -1],
    [tRelease - 0.5, -1],
  ]) {
    const s = at(t);
    assert.equal(s.level, 1, `firing at ${t}`);
    assert.ok(Math.abs(Math.hypot(...s.dirEnu) - 1) < 1e-9, `unit push at ${t}`);
    assert.ok(Math.abs(dot3(s.dirEnu, s.axis)) < 1e-9, `push perpendicular to the axis at ${t}`);
    assert.ok(sign * dot3(s.dirEnu, s.firing) > 0, `push ${sign > 0 ? 'toward' : 'against'} the firing direction at ${t}`);
    // The scene's thruster puffs read the same level (states.js passes rcsAt through).
    assert.equal(filmAt(t).interceptorSat.rcs, s.level, `film level at ${t}`);
  }
  for (let t = tOrient - 5; t <= tRelease + 5; t += 0.5) {
    const { level, dirEnu } = exportLiveState(scenario, t).satellites.interceptor.thrusters;
    assert.ok(level >= 0 && level <= 1, `level ${level} at ${t}`);
    assert.equal(dirEnu === null, level === 0, `dirEnu present only while firing, at ${t}`);
  }
});

test('the kill vehicle plume is on through its kick burn after release and off after', () => {
  assert.equal(exportLiveState(scenario, tRelease - 0.01).killVehicle, null);
  for (const t of [tRelease, tRelease + 0.01, tRelease + 0.5, tRelease + 1, tKvBurnEnd - 0.01]) {
    assert.equal(exportLiveState(scenario, t).killVehicle.plume, 1, `burning at ${t}`);
    // The film's own plume (at the release itself its time mapping rounds to just before it).
    if (t > tRelease) assert.equal(filmAt(t).kv.plume, 1, `film burning at ${t}`);
  }
  for (const t of [tKvBurnEnd, tKvBurnEnd + 0.5, tRelease + 60, tIntercept - 1]) {
    assert.equal(exportLiveState(scenario, t).killVehicle.plume, 0, `out at ${t}`);
  }
  assert.equal(E.kv.burnDuration, 2);
  for (let t = tRelease; t < tRelease + 10; t += 0.1) {
    const plume = exportLiveState(scenario, t).killVehicle.plume;
    assert.ok(plume >= 0 && plume <= 1, `plume ${plume} at ${t}`);
  }
});

test('the intercept effects are null before the intercept and after their envelope', () => {
  for (const t of [-60, tRelease, tIntercept - 0.001, tIntercept + 3, tIntercept + 10]) {
    assert.equal(exportLiveState(scenario, t).interceptFx, null, `no effects at ${t}`);
  }
  const fx = exportLiveState(scenario, tIntercept).interceptFx;
  assert.deepEqual(fx, {
    flash: { level: 0, diameterKm: 0 },
    ring: { level: 0.9, diameterKm: 0 },
    burst: { level: 1, count: 300, spreadKm: 0, pieceSizeKm: 0.12 },
  });
  const peak = exportLiveState(scenario, tIntercept + 0.3).interceptFx;
  assert.ok(Math.abs(peak.flash.level - 1) < 1e-9 && Math.abs(peak.flash.diameterKm - 0.75) < 1e-9, 'flash peaks at 0.3 s');
  const late = exportLiveState(scenario, tIntercept + 1.5).interceptFx;
  assert.equal(late.flash, null, 'the flash is over at 1.5 s');
  assert.equal(late.ring, null, 'the ring is over at 1.5 s');
  assert.equal(late.burst.count, 300);
  assert.equal(exportLiveState(scenario, tIntercept + 2).interceptFx.burst.spreadKm, 5);
});

test('the intercept effects carry the levels and sizes the visualization draws', () => {
  let prev = null;
  for (let t = tIntercept + 0.025; t < tIntercept + 3; t += 0.05) {
    const fx = exportLiveState(scenario, t).interceptFx;
    const film = filmAt(t).intercept;
    assert.ok(fx && film.active, `active at ${t}`);
    const drawn = interceptFxShape(film);
    for (const key of ['flash', 'ring', 'burst']) {
      if (!fx[key]) continue;
      for (const [field, v] of Object.entries(drawn[key])) {
        assert.ok(Math.abs(fx[key][field] - v) < 1e-9, `${key}.${field} at ${t}: ${fx[key][field]} vs ${v}`);
      }
      assert.ok(fx[key].level >= 0 && fx[key].level <= 1, `${key} level at ${t}`);
    }
    if (fx.flash) assert.ok(fx.flash.diameterKm >= 0 && fx.flash.diameterKm <= 0.75);
    if (fx.ring) assert.ok(fx.ring.diameterKm >= 0 && fx.ring.diameterKm <= 3.75);
    assert.ok(fx.burst.spreadKm >= 0 && fx.burst.spreadKm <= 5);
    if (prev) {
      assert.ok(fx.burst.level <= prev.burst.level, `burst fades at ${t}`);
      assert.ok(fx.burst.spreadKm >= prev.burst.spreadKm, `burst spreads at ${t}`);
      if (fx.ring && prev.ring) assert.ok(fx.ring.diameterKm >= prev.ring.diameterKm && fx.ring.level <= prev.ring.level, `ring at ${t}`);
    }
    prev = fx;
  }
  assert.ok(prev.burst.level < 1e-3, `the burst has faded by the end: ${prev.burst.level}`);
});

test('the new fields are fresh objects on every call', () => {
  const t = tOrient + 10;
  const a = exportLiveState(scenario, t);
  a.satellites.interceptor.pointing.headingDeg = -1;
  a.satellites.interceptor.thrusters.dirEnu[0] = 99;
  const b = exportLiveState(scenario, t);
  assert.notEqual(b.satellites.interceptor.pointing.headingDeg, -1);
  assert.notEqual(b.satellites.interceptor.thrusters.dirEnu[0], 99);
  const f = exportLiveState(scenario, tIntercept + 0.5);
  f.interceptFx.flash.level = 99;
  f.interceptFx.burst.count = 0;
  const g = exportLiveState(scenario, tIntercept + 0.5);
  assert.notEqual(g.interceptFx.flash.level, 99);
  assert.equal(g.interceptFx.burst.count, 300);
});
