import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { R_EARTH, MU } from '../src/shared/constants.js';
import { propagateKepler, circularOrbitState, period } from '../src/sim/kepler.js';
import { lambert } from '../src/sim/lambert.js';

function checkCoast(fraction, opts) {
  const alt = 1000;
  const { r, v } = circularOrbitState(alt, 55, 30, 40);
  const v0 = opts && opts.prograde === false ? v.clone().negate() : v;
  const tof = fraction * period(R_EARTH + alt);
  const q = propagateKepler(r, v0, tof);
  const sol = lambert(r, q.r, tof, opts);
  assert.ok(sol, 'solution exists');
  assert.ok(sol.v1.distanceTo(v0) < 1e-7, `v1 error ${sol.v1.distanceTo(v0)}`);
  assert.ok(sol.v2.distanceTo(q.v) < 1e-7, `v2 error ${sol.v2.distanceTo(q.v)}`);
}

test('circular orbit, r(0) to r(T/4) in T/4, reproduces v(0)', () => checkCoast(0.25));
test('long way (transfer angle above pi) reproduces a 3/4-orbit coast', () => checkCoast(0.75));
test('retrograde option reproduces a retrograde coast', () => checkCoast(1 / 3, { prograde: false }));

test('Hohmann transfer R_EARTH + 500 to R_EARTH + 2000 (antipodal) matches the closed form', () => {
  const r1m = R_EARTH + 500;
  const r2m = R_EARTH + 2000;
  const aT = (r1m + r2m) / 2;
  const tof = Math.PI * Math.sqrt((aT * aT * aT) / MU);
  const r1 = new Vector3(r1m, 0, 0);
  const r2 = new Vector3(-r2m, 0, 0);
  const sol = lambert(r1, r2, tof);
  assert.ok(sol, 'solution exists');
  const vDep = Math.sqrt(MU * (2 / r1m - 1 / aT));
  const vArr = Math.sqrt(MU * (2 / r2m - 1 / aT));
  assert.ok(Math.abs(sol.v1.length() - vDep) < 1e-6, `departure speed ${sol.v1.length()} vs ${vDep}`);
  assert.ok(Math.abs(sol.v2.length() - vArr) < 1e-6, `arrival speed ${sol.v2.length()} vs ${vArr}`);
  assert.ok(Math.abs(sol.v1.dot(r1)) < 1e-6 * r1m, 'departure is tangential');
  const end = propagateKepler(r1, sol.v1, tof);
  assert.ok(end.r.distanceTo(r2) < 1e-5, `propagated arrival error ${end.r.distanceTo(r2)}`);
  assert.ok(end.v.distanceTo(sol.v2) < 1e-7, `arrival velocity error`);
  assert.ok(new Vector3().crossVectors(r1, sol.v1).y > 0, 'prograde plane');
});

test('a transfer between two generic points lands on r2 when propagated', () => {
  const a = circularOrbitState(1000, 55, 60, 200);
  const b = new Vector3(2000, 5500, 4800).setLength(R_EARTH + 1100);
  const tof = 900;
  const sol = lambert(a.r, b, tof);
  assert.ok(sol, 'solution exists');
  const end = propagateKepler(a.r, sol.v1, tof);
  assert.ok(end.r.distanceTo(b) < 1e-5, `arrival error ${end.r.distanceTo(b)}`);
  assert.ok(end.v.distanceTo(sol.v2) < 1e-7);
});

test('a short, fast (hyperbolic) transfer lands on r2 when propagated', () => {
  const r1 = new Vector3(R_EARTH + 500, 0, 0);
  const r2 = new Vector3(0, 0, R_EARTH + 3000);
  const sol = lambert(r1, r2, 400);
  assert.ok(sol, 'solution exists');
  const end = propagateKepler(r1, sol.v1, 400);
  assert.ok(end.r.distanceTo(r2) < 1e-5, `arrival error ${end.r.distanceTo(r2)}`);
  assert.ok(sol.v1.lengthSq() / 2 - MU / r1.length() > 0, 'hyperbolic energy');
});

test('returns null for bad inputs', () => {
  const r1 = new Vector3(R_EARTH + 500, 0, 0);
  assert.equal(lambert(r1, new Vector3(0, 0, R_EARTH + 500), 0), null);
  assert.equal(lambert(r1, new Vector3(0, 0, R_EARTH + 500), -10), null);
  assert.equal(lambert(r1, r1.clone().multiplyScalar(1.5), 600), null, 'rectilinear');
});
