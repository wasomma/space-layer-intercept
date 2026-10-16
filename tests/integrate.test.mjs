import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { R_EARTH, MU } from '../src/shared/constants.js';
import { propagateKepler, circularOrbitState, period } from '../src/sim/kepler.js';
import { rk4Step, gravityAccel } from '../src/sim/integrate.js';

test('gravityAccel points to the centre with magnitude mu / r^2', () => {
  const r = new Vector3(0, R_EARTH, 0);
  const a = gravityAccel(r);
  assert.ok(Math.abs(a.length() - MU / (R_EARTH * R_EARTH)) < 1e-15);
  assert.ok(a.y < 0 && a.x === 0 && a.z === 0);
  assert.ok(Math.abs(a.length() - 9.82e-3) < 2e-5, 'about 9.8 m/s^2 at the surface');
});

test('RK4 of a circular orbit at dt = 1 s stays within 0.1 km of Kepler over one period', () => {
  const alt = 500;
  const start = circularOrbitState(alt, 45, 20, 0);
  const T = period(R_EARTH + alt);
  const steps = Math.ceil(T);
  const dt = T / steps;
  let r = start.r.clone();
  let v = start.v.clone();
  let t = 0;
  let maxErr = 0;
  const accel = (rr) => gravityAccel(rr);
  for (let i = 0; i < steps; i++) {
    ({ r, v } = rk4Step(r, v, t, dt, accel));
    t += dt;
    if (i % 100 === 0) {
      const ref = propagateKepler(start.r, start.v, t);
      maxErr = Math.max(maxErr, ref.r.distanceTo(r));
    }
  }
  const ref = propagateKepler(start.r, start.v, t);
  maxErr = Math.max(maxErr, ref.r.distanceTo(r));
  assert.ok(maxErr < 0.1, `max position error ${maxErr} km`);
  assert.ok(r.distanceTo(start.r) < 0.1, `return error ${r.distanceTo(start.r)} km`);
});

test('rk4Step integrates constant acceleration exactly and returns fresh vectors', () => {
  const r0 = new Vector3(1, 2, 3);
  const v0 = new Vector3(0.1, 0, 0);
  const g = new Vector3(0, -0.01, 0);
  const out = rk4Step(r0, v0, 0, 2, () => g.clone());
  assert.ok(out.r !== r0 && out.v !== v0);
  assert.ok(out.r.distanceTo(new Vector3(1.2, 2 - 0.02, 3)) < 1e-12);
  assert.ok(out.v.distanceTo(new Vector3(0.1, -0.02, 0)) < 1e-12);
  assert.ok(r0.equals(new Vector3(1, 2, 3)) && v0.equals(new Vector3(0.1, 0, 0)), 'inputs untouched');
});

test('rk4Step passes the time argument through', () => {
  const seen = [];
  rk4Step(new Vector3(), new Vector3(), 10, 4, (r, v, t) => {
    seen.push(t);
    return new Vector3();
  });
  assert.deepEqual(seen, [10, 12, 12, 14]);
});
