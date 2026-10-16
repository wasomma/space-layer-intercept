import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { R_EARTH, DEG } from '../src/shared/constants.js';
import { segmentClearsSphere, inCone, nadirDirection } from '../src/sim/los.js';

test('segmentClearsSphere on hand-checked geometries', () => {
  const R = R_EARTH;
  // Two points on opposite sides at 1000 km altitude: the chord passes through the centre.
  assert.equal(segmentClearsSphere(new Vector3(R + 1000, 0, 0), new Vector3(-(R + 1000), 0, 0), R), false);
  // Two points 90 degrees apart at 1000 km altitude: closest approach is (R+1000)/sqrt2 = 5212 < R.
  assert.equal(segmentClearsSphere(new Vector3(R + 1000, 0, 0), new Vector3(0, 0, R + 1000), R), false);
  // Two points 90 degrees apart at 10000 km altitude: closest approach is 11576 > R.
  assert.equal(segmentClearsSphere(new Vector3(R + 10000, 0, 0), new Vector3(0, 0, R + 10000), R), true);
  // A short segment entirely above the surface.
  assert.equal(segmentClearsSphere(new Vector3(R + 500, 0, 0), new Vector3(R + 500, 100, 0), R), true);
  // One endpoint on the surface is not clear (tangent counts as blocked).
  assert.equal(segmentClearsSphere(new Vector3(R, 0, 0), new Vector3(R + 500, 0, 0), R), false);
  // One endpoint inside.
  assert.equal(segmentClearsSphere(new Vector3(R - 1, 0, 0), new Vector3(R + 500, 0, 0), R), false);
  // Closest point lies beyond an endpoint, not at the foot of the perpendicular.
  assert.equal(segmentClearsSphere(new Vector3(R + 10, 5000, 0), new Vector3(R + 10, 8000, 0), R), true);
  // Degenerate zero-length segment: clear iff the point is outside.
  assert.equal(segmentClearsSphere(new Vector3(R + 1, 0, 0), new Vector3(R + 1, 0, 0), R), true);
});

test('inCone on hand-checked geometries', () => {
  const apex = new Vector3(0, 0, 10000);
  const axis = new Vector3(0, 0, -1);
  const half = 8 * DEG;
  assert.equal(inCone(apex, axis, half, new Vector3(0, 0, 0)), true, 'on axis');
  assert.equal(inCone(apex, axis, half, apex.clone()), true, 'apex itself');
  // 10000 * tan(8 deg) = 1405 km: inside at 1300, outside at 1500.
  assert.equal(inCone(apex, axis, half, new Vector3(1300, 0, 0)), true);
  assert.equal(inCone(apex, axis, half, new Vector3(0, 1500, 0)), false);
  assert.equal(inCone(apex, axis, half, new Vector3(0, 0, 20000)), false, 'behind the apex');
});

test('nadirDirection is the unit vector toward the centre', () => {
  const n = nadirDirection(new Vector3(0, 3000, 4000));
  assert.ok(n.distanceTo(new Vector3(0, -0.6, -0.8)) < 1e-15);
});
