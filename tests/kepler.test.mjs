import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { R_EARTH, MU } from '../src/shared/constants.js';
import { propagateKepler, circularOrbitState, period, apsides, stumpffC, stumpffS } from '../src/sim/kepler.js';

const specificEnergy = (r, v) => v.lengthSq() / 2 - MU / r.length();
const angularMomentum = (r, v) => new Vector3().crossVectors(r, v);

test('Stumpff functions match their parabolic limits and closed forms', () => {
  assert.ok(Math.abs(stumpffC(0) - 0.5) < 1e-15);
  assert.ok(Math.abs(stumpffS(0) - 1 / 6) < 1e-15);
  // Series and closed form agree across the switch-over.
  for (const z of [-2e-3, -9e-4, 9e-4, 2e-3]) {
    const C = z > 0 ? (1 - Math.cos(Math.sqrt(z))) / z : (Math.cosh(Math.sqrt(-z)) - 1) / -z;
    assert.ok(Math.abs(stumpffC(z) - C) < 1e-12, `C(${z})`);
  }
  assert.ok(Math.abs(stumpffC(4) - (1 - Math.cos(2)) / 4) < 1e-15);
  assert.ok(Math.abs(stumpffS(4) - (2 - Math.sin(2)) / 8) < 1e-15);
});

test('circular orbit returns to its start after one period and to the antipode after half', () => {
  const alt = 1000;
  const { r, v } = circularOrbitState(alt, 55, 30, 40);
  const a = R_EARTH + alt;
  assert.ok(Math.abs(r.length() - a) < 1e-9, 'radius');
  assert.ok(Math.abs(v.length() - Math.sqrt(MU / a)) < 1e-12, 'circular speed');
  assert.ok(Math.abs(r.dot(v)) < 1e-9, 'r perpendicular to v');

  const T = period(a);
  const full = propagateKepler(r, v, T);
  assert.ok(full.r.distanceTo(r) < 1e-5, `full period position error ${full.r.distanceTo(r)}`);
  assert.ok(full.v.distanceTo(v) < 1e-8, `full period velocity error ${full.v.distanceTo(v)}`);

  const half = propagateKepler(r, v, T / 2);
  assert.ok(half.r.distanceTo(r.clone().negate()) < 1e-5, `half period antipode error`);
  assert.ok(half.v.distanceTo(v.clone().negate()) < 1e-8, `half period velocity`);
});

test('circularOrbitState follows the v1 ring convention', () => {
  // raan 0, inc 0, u 0 sits on +Z (lon 0); u 90 on +X (lon 90, prograde eastward).
  const s0 = circularOrbitState(500, 0, 0, 0);
  assert.ok(s0.r.distanceTo(new Vector3(0, 0, R_EARTH + 500)) < 1e-9);
  assert.ok(s0.v.x > 0 && Math.abs(s0.v.y) < 1e-12 && Math.abs(s0.v.z) < 1e-12);
  const s90 = circularOrbitState(500, 0, 0, 90);
  assert.ok(s90.r.distanceTo(new Vector3(R_EARTH + 500, 0, 0)) < 1e-9);
  // inc 90, u 90 points to the north pole.
  const pole = circularOrbitState(500, 90, 0, 90);
  assert.ok(pole.r.distanceTo(new Vector3(0, R_EARTH + 500, 0)) < 1e-9);
  // The angular momentum of an inclined prograde orbit has a positive Y component.
  const inc = circularOrbitState(1000, 55, 120, 10);
  assert.ok(angularMomentum(inc.r, inc.v).y > 0);
});

test('energy and angular momentum of an e = 0.3 orbit are conserved over 20 steps', () => {
  const rp = R_EARTH + 400;
  const e = 0.3;
  const a = rp / (1 - e);
  const vp = Math.sqrt(MU * (2 / rp - 1 / a));
  let r = new Vector3(rp, 0, 0);
  let v = new Vector3(0, vp * Math.cos(0.4), vp * Math.sin(0.4));
  const E0 = specificEnergy(r, v);
  const H0 = angularMomentum(r, v);
  const T = period(a);
  for (let i = 0; i < 20; i++) {
    ({ r, v } = propagateKepler(r, v, T / 7.3));
    const E = specificEnergy(r, v);
    const H = angularMomentum(r, v);
    assert.ok(Math.abs((E - E0) / E0) < 1e-10, `energy drift ${Math.abs((E - E0) / E0)} at step ${i}`);
    assert.ok(H.distanceTo(H0) / H0.length() < 1e-10, `angular momentum drift at step ${i}`);
  }
  const ap = apsides(r, v);
  assert.ok(Math.abs(ap.e - e) < 1e-9, `eccentricity ${ap.e}`);
  assert.ok(Math.abs(ap.rp - rp) < 1e-6, `periapsis ${ap.rp}`);
  assert.ok(Math.abs(ap.ra - a * (1 + e)) < 1e-6, `apoapsis ${ap.ra}`);
  assert.ok(Math.abs(ap.a - a) < 1e-6, `semi-major axis ${ap.a}`);
});

test('a hyperbolic state propagates without error and conserves energy', () => {
  const r = new Vector3(R_EARTH + 300, 0, 0);
  const vEsc = Math.sqrt((2 * MU) / r.length());
  const v = new Vector3(0, 0, vEsc * 1.3);
  const E0 = specificEnergy(r, v);
  assert.ok(E0 > 0);
  const out = propagateKepler(r, v, 5000);
  for (const k of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(out.r[k]) && Number.isFinite(out.v[k]));
  }
  assert.ok(out.r.length() > r.length());
  assert.ok(Math.abs((specificEnergy(out.r, out.v) - E0) / E0) < 1e-10);
  const back = propagateKepler(out.r, out.v, -5000);
  assert.ok(back.r.distanceTo(r) < 1e-6, `round trip ${back.r.distanceTo(r)}`);
  assert.ok(apsides(r, v).e > 1);
});

test('a near-parabolic state propagates without error', () => {
  const r = new Vector3(0, R_EARTH + 500, 0);
  const vEsc = Math.sqrt((2 * MU) / r.length());
  const v = new Vector3(vEsc, 0, 0);
  const out = propagateKepler(r, v, 3000);
  assert.ok([out.r.x, out.r.y, out.r.z, out.v.x, out.v.y, out.v.z].every(Number.isFinite));
  const E0 = specificEnergy(r, v);
  assert.ok(Math.abs(specificEnergy(out.r, out.v) - E0) < 1e-10);
});

test('dt = 0 returns copies, and negative dt runs backwards', () => {
  const { r, v } = circularOrbitState(800, 30, 10, 20);
  const same = propagateKepler(r, v, 0);
  assert.ok(same.r !== r && same.r.equals(r) && same.v.equals(v));
  const fwd = propagateKepler(r, v, 1234.5);
  const back = propagateKepler(fwd.r, fwd.v, -1234.5);
  assert.ok(back.r.distanceTo(r) < 1e-6);
});
