// Lambert's problem by universal variables.
//
// Textbook formulation: the y(z) and F(z) functions of the universal-variable method with
// Stumpff C and S, a bracketing search then safeguarded Newton on z. Single revolution.
// Pure, three.js math only, Node-importable. Units: km, km/s, s.
//
// Velocities are assembled from radial and transverse components in the transfer plane,
//   v = vr r_hat + (h / r) t_hat,   t_hat = n_hat x r_hat,
// which is algebraically identical to the Lagrange f, g form but stays finite when the two
// position vectors are (nearly) collinear, where g -> 0.

import { Vector3 } from 'three';
import { MU } from '../shared/constants.js';
import { stumpffC, stumpffS } from './kepler.js';

const TOL_Z = 1e-8;
const MAX_ITER = 200;
const Z_MAX = 4 * Math.PI * Math.PI; // one full revolution; tof -> infinity there
const Z_MIN = -1e5; // beyond this cosh overflows; no transfer of interest is that fast

const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/**
 * Solve Lambert's problem: the velocities at r1 and r2 of the conic that goes from r1 to r2
 * in tof seconds.
 * @param {Vector3} r1 km
 * @param {Vector3} r2 km
 * @param {number} tof seconds, > 0
 * @param {{ mu?: number, prograde?: boolean }} [opts] prograde: motion with a +Y (north)
 *   angular momentum component, i.e. c = r1 x r2 with c.y >= 0 is the short way, c.y < 0
 *   the long way; retrograde is the opposite.
 * @returns {{ v1: Vector3, v2: Vector3 } | null} null when no solution (y < 0 at the
 *   solution, non-convergence, degenerate geometry or tof <= 0)
 */
export function lambert(r1, r2, tof, { mu = MU, prograde = true } = {}) {
  if (!(tof > 0) || !Number.isFinite(tof)) return null;
  const r1m = r1.length();
  const r2m = r2.length();
  if (!(r1m > 0) || !(r2m > 0)) return null;

  const r1Hat = r1.clone().divideScalar(r1m);
  const r2Hat = r2.clone().divideScalar(r2m);
  const cosT = Math.max(-1, Math.min(1, r1Hat.dot(r2Hat)));
  const c = new Vector3().crossVectors(r1Hat, r2Hat);
  const sinAbs = c.length();

  // Transfer-plane normal in the direction of motion. Short way when the normal is +c.
  const nHat = new Vector3();
  let shortWay;
  if (sinAbs > 1e-12) {
    const cUp = c.y >= 0;
    shortWay = cUp === prograde;
    nHat.copy(c).divideScalar(sinAbs);
    if (!shortWay) nHat.negate();
  } else {
    // r1 and r2 collinear: the plane is free. Take the most northerly (prograde) or
    // southerly (retrograde) plane containing r1. theta = pi for opposite vectors; a
    // rectilinear transfer (theta = 0) has no solution here.
    if (cosT > 0) return null;
    shortWay = true;
    nHat.copy(prograde ? Y_AXIS : Y_AXIS.clone().negate());
    nHat.addScaledVector(r1Hat, -nHat.dot(r1Hat));
    if (nHat.lengthSq() < 1e-12) nHat.copy(X_AXIS).addScaledVector(r1Hat, -X_AXIS.dot(r1Hat));
    nHat.normalize();
  }
  const sinT = shortWay ? sinAbs : -sinAbs; // sin(theta), theta in (0, 2 pi)

  // 1 - cos and 1 + cos without cancellation.
  const sin2 = sinAbs * sinAbs;
  const oneMinusCos = cosT > 0 ? sin2 / (1 + cosT) : 1 - cosT;
  const onePlusCos = cosT < 0 ? sin2 / (1 - cosT) : 1 + cosT;
  if (!(oneMinusCos > 0)) return null;

  const A = sinT * Math.sqrt((r1m * r2m) / oneMinusCos);
  const sqrtMu = Math.sqrt(mu);

  const yOf = (z) => {
    const C = stumpffC(z);
    const S = stumpffS(z);
    return r1m + r2m + (A * (z * S - 1)) / Math.sqrt(C);
  };
  const FOf = (z) => {
    const C = stumpffC(z);
    const S = stumpffS(z);
    const y = r1m + r2m + (A * (z * S - 1)) / Math.sqrt(C);
    if (!(y > 0)) return NaN;
    return Math.pow(y / C, 1.5) * S + A * Math.sqrt(y) - sqrtMu * tof;
  };
  const dFOf = (z) => {
    const C = stumpffC(z);
    const S = stumpffS(z);
    const y = r1m + r2m + (A * (z * S - 1)) / Math.sqrt(C);
    if (Math.abs(z) < 1e-6) {
      return (Math.sqrt(2) / 40) * Math.pow(y, 1.5) + (A / 8) * (Math.sqrt(y) + A * Math.sqrt(1 / (2 * y)));
    }
    return (
      Math.pow(y / C, 1.5) * ((1 / (2 * z)) * (C - (3 * S) / (2 * C)) + (3 * S * S) / (4 * C)) +
      (A / 8) * (((3 * S) / C) * Math.sqrt(y) + A * Math.sqrt(C / y))
    );
  };

  // Bracket the root. F is monotonic increasing in z wherever y > 0; F(0) is always defined
  // because y(0) = r1 + r2 - A sqrt 2 >= 0. Going up, F -> +inf at Z_MAX. Going down, y can
  // reach 0 (A > 0) where F -> -sqrt(mu) tof < 0, so the root lies above that boundary.
  const F0 = FOf(0);
  if (!Number.isFinite(F0)) return null;
  if (F0 === 0) return assemble(0);

  let zA = 0;
  let fA = F0;
  let zB;
  let fB;
  const dir = F0 < 0 ? 1 : -1;
  let step = 1;
  let found = false;
  for (let i = 0; i < 400; i++) {
    zB = zA + dir * step;
    if (zB >= Z_MAX) zB = Z_MAX - 1e-9;
    if (zB <= Z_MIN) return null;
    fB = FOf(zB);
    if (!Number.isFinite(fB)) {
      // Stepped past the y > 0 boundary: shrink toward zA.
      step *= 0.5;
      if (step < 1e-12) return null;
      continue;
    }
    if (fA * fB <= 0) {
      found = true;
      break;
    }
    if (zB === Z_MAX - 1e-9) return null;
    zA = zB;
    fA = fB;
    step *= 2;
  }
  if (!found) return null;

  let lo = Math.min(zA, zB);
  let hi = Math.max(zA, zB);
  let flo = lo === zA ? fA : fB;

  // Bisection to a tight bracket, then safeguarded Newton.
  for (let i = 0; i < 60 && hi - lo > 1e-3; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = FOf(mid);
    if (!Number.isFinite(fm) || flo * fm > 0) {
      lo = mid;
      if (Number.isFinite(fm)) flo = fm;
    } else {
      hi = mid;
    }
  }
  let z = 0.5 * (lo + hi);
  let converged = false;
  for (let i = 0; i < MAX_ITER; i++) {
    const f = FOf(z);
    const d = dFOf(z);
    let zn = Number.isFinite(f) && Number.isFinite(d) && d !== 0 ? z - f / d : NaN;
    if (!(zn > lo && zn < hi)) zn = 0.5 * (lo + hi); // Newton left the bracket: bisect
    const fn = FOf(zn);
    if (Number.isFinite(fn)) {
      if (flo * fn > 0) {
        lo = zn;
        flo = fn;
      } else hi = zn;
    } else {
      lo = zn;
    }
    const dz = Math.abs(zn - z);
    z = zn;
    if (dz < TOL_Z || hi - lo < TOL_Z) {
      converged = true;
      break;
    }
  }
  if (!converged) return null;
  return assemble(z);

  function assemble(zSol) {
    const C = stumpffC(zSol);
    const S = stumpffS(zSol);
    const y = yOf(zSol);
    if (!(y > 0) || !Number.isFinite(y)) return null;
    // Specific angular momentum of the transfer and the shared radial-velocity term.
    const h = Math.sqrt((mu * r1m * r2m * oneMinusCos) / y);
    const k = (zSol * S - 1) / Math.sqrt(C);
    const sgn = sinT >= 0 ? 1 : -1;
    const base = Math.sqrt(mu / y);
    const vr1 = base * (sgn * Math.sqrt(r2m / r1m) * Math.sqrt(onePlusCos) + k);
    const vr2 = -base * (sgn * Math.sqrt(r1m / r2m) * Math.sqrt(onePlusCos) + k);
    const t1 = new Vector3().crossVectors(nHat, r1Hat);
    const t2 = new Vector3().crossVectors(nHat, r2Hat);
    const v1 = new Vector3().addScaledVector(r1Hat, vr1).addScaledVector(t1, h / r1m);
    const v2 = new Vector3().addScaledVector(r2Hat, vr2).addScaledVector(t2, h / r2m);
    if (![v1.x, v1.y, v1.z, v2.x, v2.y, v2.z].every(Number.isFinite)) return null;
    return { v1, v2 };
  }
}
