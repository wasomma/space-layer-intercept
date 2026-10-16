// Two-body Kepler propagation by universal variables.
//
// Pure functions, three.js math only, Node-importable. Units: km, km/s, s, km^3/s^2.
// Textbook formulation (Stumpff functions, Newton iteration on the universal anomaly chi,
// Lagrange f and g coefficients). Handles elliptic, parabolic and hyperbolic states.

import { Vector3 } from 'three';
import { R_EARTH, MU, DEG } from '../shared/constants.js';

const TOL = 1e-10;
const MAX_ITER = 100;
// Below this |z| the closed forms of the Stumpff functions cancel catastrophically; use series.
const SERIES_Z = 1e-3;

/** Stumpff C(z) = (1 - cos sqrt z) / z, with the parabolic limit 1/2 at z = 0. */
export function stumpffC(z) {
  if (Math.abs(z) < SERIES_Z) {
    // 1/2 - z/24 + z^2/720 - z^3/40320 + z^4/3628800
    return 0.5 - z / 24 + (z * z) / 720 - (z * z * z) / 40320 + (z * z * z * z) / 3628800;
  }
  if (z > 0) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  }
  const s = Math.sqrt(-z);
  return (Math.cosh(s) - 1) / -z;
}

/** Stumpff S(z) = (sqrt z - sin sqrt z) / sqrt(z)^3, with the parabolic limit 1/6 at z = 0. */
export function stumpffS(z) {
  if (Math.abs(z) < SERIES_Z) {
    // 1/6 - z/120 + z^2/5040 - z^3/362880 + z^4/39916800
    return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880 + (z * z * z * z) / 39916800;
  }
  if (z > 0) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  const s = Math.sqrt(-z);
  return (Math.sinh(s) - s) / (s * s * s);
}

/**
 * Solve the universal Kepler equation for the universal anomaly chi after dt seconds.
 * F(chi) = (r0 vr0 / sqrt mu) chi^2 C(z) + (1 - alpha r0) chi^3 S(z) + r0 chi - sqrt(mu) dt,
 * z = alpha chi^2, alpha = 1/a. dF/dchi = r(chi) > 0, so F is monotonic: Newton from the
 * standard initial guess, with a bracketing bisection fallback if Newton fails to settle.
 */
function solveUniversalAnomaly(r0m, vr0, alpha, dt, mu) {
  const sqrtMu = Math.sqrt(mu);
  const k1 = (r0m * vr0) / sqrtMu;
  const k2 = 1 - alpha * r0m;

  const F = (chi) => {
    const z = alpha * chi * chi;
    return k1 * chi * chi * stumpffC(z) + k2 * chi * chi * chi * stumpffS(z) + r0m * chi - sqrtMu * dt;
  };
  const dF = (chi) => {
    const z = alpha * chi * chi;
    return k1 * chi * (1 - z * stumpffS(z)) + k2 * chi * chi * stumpffC(z) + r0m;
  };

  // Initial guess: the elliptic estimate sqrt(mu) |alpha| dt; for near-parabolic or
  // hyperbolic states that is tiny, so start from the parabolic-ish scale instead.
  let chi = sqrtMu * Math.abs(alpha) * dt;
  if (Math.abs(alpha) < 1e-7 || alpha < 0) {
    // chi scales like (6 sqrt(mu) dt)^(1/3) on a parabola; a usable start for hyperbolas too.
    chi = Math.sign(dt) * Math.cbrt(6 * sqrtMu * Math.abs(dt));
  }

  let converged = false;
  for (let i = 0; i < MAX_ITER; i++) {
    const f = F(chi);
    const d = dF(chi);
    if (!(Math.abs(d) > 0) || !Number.isFinite(d)) break;
    const ratio = f / d;
    chi -= ratio;
    if (Math.abs(ratio) < TOL) {
      converged = true;
      break;
    }
  }
  if (converged && Number.isFinite(chi)) return chi;

  // Bisection fallback on a bracket found by expansion (F is monotonic increasing).
  let lo = 0;
  let hi = Math.sign(dt) || 1;
  let fl = F(lo);
  let fh = F(hi);
  let n = 0;
  while (fl * fh > 0 && n++ < 200) {
    lo = hi;
    fl = fh;
    hi *= 2;
    fh = F(hi);
    if (!Number.isFinite(fh)) throw new Error('propagateKepler: cannot bracket the universal anomaly');
  }
  if (lo > hi) [lo, hi, fl, fh] = [hi, lo, fh, fl];
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = F(mid);
    if (fm === 0 || hi - lo < TOL) return mid;
    if (fl * fm < 0) {
      hi = mid;
      fh = fm;
    } else {
      lo = mid;
      fl = fm;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Propagate a two-body state by dt seconds.
 * @param {Vector3} r0 position, km
 * @param {Vector3} v0 velocity, km/s
 * @param {number} dt seconds (may be negative)
 * @param {number} [mu=MU]
 * @returns {{ r: Vector3, v: Vector3 }} fresh vectors
 */
export function propagateKepler(r0, v0, dt, mu = MU) {
  if (!(dt !== 0)) return { r: r0.clone(), v: v0.clone() };

  const r0m = r0.length();
  const v0m = v0.length();
  const vr0 = r0.dot(v0) / r0m;
  const alpha = 2 / r0m - (v0m * v0m) / mu;
  const sqrtMu = Math.sqrt(mu);

  const chi = solveUniversalAnomaly(r0m, vr0, alpha, dt, mu);
  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);

  const f = 1 - ((chi * chi) / r0m) * C;
  const g = dt - ((chi * chi * chi) / sqrtMu) * S;

  const r = new Vector3().addScaledVector(r0, f).addScaledVector(v0, g);
  const rm = r.length();

  const fdot = (sqrtMu / (rm * r0m)) * (alpha * chi * chi * chi * S - chi);
  const gdot = 1 - ((chi * chi) / rm) * C;

  const v = new Vector3().addScaledVector(r0, fdot).addScaledVector(v0, gdot);
  return { r, v };
}

/**
 * ECI state on a circular orbit, in the v1 ring convention:
 *   node vector   n = (sin raan, 0, cos raan)
 *   in-plane      m = cos inc * (cos raan, 0, -sin raan) + sin inc * (0, 1, 0)
 *   r = a (cos u n + sin u m),  v = sqrt(mu / a) (-sin u n + cos u m)
 * @param {number} altKm altitude above R_EARTH
 * @param {number} incDeg inclination
 * @param {number} raanDeg right ascension of the ascending node
 * @param {number} argLatDeg argument of latitude u (angle from the node along the orbit)
 * @param {number} [mu=MU]
 * @returns {{ r: Vector3, v: Vector3 }}
 */
export function circularOrbitState(altKm, incDeg, raanDeg, argLatDeg, mu = MU) {
  const a = R_EARTH + altKm;
  const inc = incDeg * DEG;
  const raan = raanDeg * DEG;
  const u = argLatDeg * DEG;
  const n = new Vector3(Math.sin(raan), 0, Math.cos(raan));
  const m = new Vector3(Math.cos(inc) * Math.cos(raan), Math.sin(inc), -Math.cos(inc) * Math.sin(raan));
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const speed = Math.sqrt(mu / a);
  const r = new Vector3().addScaledVector(n, a * cu).addScaledVector(m, a * su);
  const v = new Vector3().addScaledVector(n, -speed * su).addScaledVector(m, speed * cu);
  return { r, v };
}

/**
 * Orbital period of a semi-major axis a, seconds.
 * @param {number} a km
 * @param {number} [mu=MU]
 */
export function period(a, mu = MU) {
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/**
 * Apsides of the orbit through state (r, v) from energy and angular momentum:
 * { rp, ra, a, e }. For e >= 1, ra is Infinity and a is negative (hyperbolic) or
 * Infinity (parabolic).
 * @param {Vector3} r km
 * @param {Vector3} v km/s
 * @param {number} [mu=MU]
 */
export function apsides(r, v, mu = MU) {
  const rm = r.length();
  const v2 = v.lengthSq();
  const energy = v2 / 2 - mu / rm;
  const h = new Vector3().crossVectors(r, v).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const a = energy !== 0 ? -mu / (2 * energy) : Infinity;
  const rp = (h * h) / (mu * (1 + e));
  const ra = e < 1 ? a * (1 + e) : Infinity;
  return { rp, ra, a, e };
}
