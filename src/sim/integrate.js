// Numerical integration of a point mass.
// Pure, three.js math only, Node-importable. Units: km, km/s, s.

import { Vector3 } from 'three';
import { MU } from '../shared/constants.js';

/**
 * One classical fourth-order Runge-Kutta step of r' = v, v' = accel(r, v, t).
 * @param {Vector3} r km
 * @param {Vector3} v km/s
 * @param {number} t seconds
 * @param {number} dt seconds
 * @param {(r: Vector3, v: Vector3, t: number) => Vector3} accel km/s^2; must return a
 *   fresh or otherwise unaliased Vector3 (it is read before the next call)
 * @returns {{ r: Vector3, v: Vector3 }} fresh vectors
 */
export function rk4Step(r, v, t, dt, accel) {
  const h = dt;
  const k1r = v.clone();
  const k1v = accel(r, v, t);

  const r2 = r.clone().addScaledVector(k1r, h / 2);
  const v2 = v.clone().addScaledVector(k1v, h / 2);
  const k2r = v2.clone();
  const k2v = accel(r2, v2, t + h / 2);

  const r3 = r.clone().addScaledVector(k2r, h / 2);
  const v3 = v.clone().addScaledVector(k2v, h / 2);
  const k3r = v3.clone();
  const k3v = accel(r3, v3, t + h / 2);

  const r4 = r.clone().addScaledVector(k3r, h);
  const v4 = v.clone().addScaledVector(k3v, h);
  const k4r = v4.clone();
  const k4v = accel(r4, v4, t + h);

  const rOut = r
    .clone()
    .addScaledVector(k1r, h / 6)
    .addScaledVector(k2r, h / 3)
    .addScaledVector(k3r, h / 3)
    .addScaledVector(k4r, h / 6);
  const vOut = v
    .clone()
    .addScaledVector(k1v, h / 6)
    .addScaledVector(k2v, h / 3)
    .addScaledVector(k3v, h / 3)
    .addScaledVector(k4v, h / 6);
  return { r: rOut, v: vOut };
}

/**
 * Point-mass gravitational acceleration -mu r / |r|^3, km/s^2. Fresh vector.
 * @param {Vector3} r km
 * @param {number} [mu=MU]
 * @returns {Vector3}
 */
export function gravityAccel(r, mu = MU) {
  const d = r.length();
  return r.clone().multiplyScalar(-mu / (d * d * d));
}
