// Line-of-sight and cone geometry.
// Pure, three.js math only, Node-importable. Units: km, radians.

import { Vector3 } from 'three';

const _d = new Vector3();
const _p = new Vector3();

/**
 * True when the straight segment from a to b misses the sphere of the given radius centred
 * at the origin (neither endpoint inside, no crossing). Equality (tangent) counts as blocked.
 * @param {Vector3} a km
 * @param {Vector3} b km
 * @param {number} radius km
 */
export function segmentClearsSphere(a, b, radius) {
  _d.subVectors(b, a);
  const len2 = _d.lengthSq();
  let s = 0;
  if (len2 > 0) s = Math.max(0, Math.min(1, -a.dot(_d) / len2));
  _p.copy(a).addScaledVector(_d, s);
  return _p.length() > radius;
}

/**
 * True when point p lies inside the cone with the given apex, unit axis and half-angle.
 * The apex itself is inside.
 * @param {Vector3} apex km
 * @param {Vector3} axisUnit unit vector along the cone axis
 * @param {number} halfAngleRad radians
 * @param {Vector3} p km
 */
export function inCone(apex, axisUnit, halfAngleRad, p) {
  _d.subVectors(p, apex);
  const len = _d.length();
  if (len === 0) return true;
  const cosA = _d.dot(axisUnit) / len;
  return cosA >= Math.cos(halfAngleRad);
}

/**
 * Unit vector from position r toward the Earth's centre (-r / |r|). Fresh vector.
 * @param {Vector3} r km
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function nadirDirection(r, target = new Vector3()) {
  return target.copy(r).negate().normalize();
}
