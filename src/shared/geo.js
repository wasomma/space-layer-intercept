// Geographic and frame helpers.
//
// Convention (Y up), used for both ECI and ECEF:
//   x = r * cos(lat) * sin(lon)
//   y = r * sin(lat)
//   z = r * cos(lat) * cos(lon)
// so lon 0 is on +Z, lon 90 on +X, and the north pole on +Y. Latitude and longitude are in
// degrees. Units are kilometres (1 scene unit = 1 km).
//
// ECI is the inertial frame. ECEF is ECI rotated about +Y by theta(t) = OMEGA_EARTH * t, with
// theta = 0 at ignition (t = 0), so the two frames coincide at ignition. A point fixed on the
// Earth moves eastward in ECI: ecefToEci applies the rotation, eciToEcef undoes it.

import { Vector3 } from 'three';
import { R_EARTH, OMEGA_EARTH, DEG } from './constants.js';

export { DEG };

/**
 * Convert a lat/lon (degrees) at the given radius to a Vector3.
 * @param {number} lat  latitude in degrees, -90..90
 * @param {number} lon  longitude in degrees
 * @param {number} [radius=R_EARTH] km
 * @param {Vector3} [target] optional vector to write into
 * @returns {Vector3}
 */
export function latLonToVector3(lat, lon, radius = R_EARTH, target = new Vector3()) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return target.set(radius * c * Math.sin(lo), radius * Math.sin(la), radius * c * Math.cos(lo));
}

/**
 * Inverse of latLonToVector3. Returns { lat, lon, radius } in degrees / km.
 * @param {Vector3} v
 */
export function vector3ToLatLon(v) {
  const radius = v.length();
  if (radius === 0) return { lat: 0, lon: 0, radius: 0 };
  const lat = Math.asin(Math.min(1, Math.max(-1, v.y / radius))) / DEG;
  const lon = Math.atan2(v.x, v.z) / DEG;
  return { lat, lon, radius };
}

/**
 * ECEF position of a surface point at the given altitude: radius R_EARTH + altKm.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} [altKm=0]
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function latLonToEcef(lat, lon, altKm = 0, target = new Vector3()) {
  return latLonToVector3(lat, lon, R_EARTH + altKm, target);
}

/**
 * Inverse of latLonToEcef: { lat, lon } in degrees and altKm above the sphere R_EARTH.
 * @param {Vector3} v ECEF, km
 * @returns {{ lat: number, lon: number, altKm: number }}
 */
export function ecefToLatLonAlt(v) {
  const { lat, lon, radius } = vector3ToLatLon(v);
  return { lat, lon, altKm: radius - R_EARTH };
}

/**
 * Earth rotation angle theta(t) = OMEGA_EARTH * t, radians, zero at ignition.
 * @param {number} t seconds from ignition
 */
export function earthRotationAngle(t) {
  return OMEGA_EARTH * t;
}

/**
 * Rotate an ECEF vector into ECI: rotation about +Y by theta.
 *   x' = x cos(theta) + z sin(theta)
 *   z' = -x sin(theta) + z cos(theta)
 * @param {Vector3} v ECEF
 * @param {number} theta radians
 * @param {Vector3} [target]
 * @returns {Vector3} ECI
 */
export function ecefToEci(v, theta, target = new Vector3()) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const x = v.x;
  const z = v.z;
  return target.set(x * c + z * s, v.y, -x * s + z * c);
}

/**
 * Rotate an ECI vector into ECEF: the inverse of ecefToEci (rotation about +Y by -theta).
 * @param {Vector3} v ECI
 * @param {number} theta radians
 * @param {Vector3} [target]
 * @returns {Vector3} ECEF
 */
export function eciToEcef(v, theta, target = new Vector3()) {
  return ecefToEci(v, -theta, target);
}

/**
 * ECI velocity of a point fixed to the rotating Earth at ECI position rEci:
 * omega x r with omega = (0, OMEGA_EARTH, 0), i.e. OMEGA_EARTH * (r.z, 0, -r.x). km/s.
 * @param {Vector3} rEci
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function siteVelocityEci(rEci, target = new Vector3()) {
  return target.set(OMEGA_EARTH * rEci.z, 0, -OMEGA_EARTH * rEci.x);
}

/**
 * Local tangent frame at an ECI (or ECEF) position: unit vectors { up, east, north } with
 * up = r / |r|, east = normalize(r.z, 0, -r.x), north = up x east. Right-handed:
 * east x north = up. At the poles east is undefined; +X is used.
 * @param {Vector3} rEci
 * @returns {{ up: Vector3, east: Vector3, north: Vector3 }}
 */
export function localFrameEci(rEci) {
  const up = rEci.clone().normalize();
  const east = new Vector3(rEci.z, 0, -rEci.x);
  if (east.lengthSq() < 1e-18) east.set(1, 0, 0);
  else east.normalize();
  const north = new Vector3().crossVectors(up, east);
  return { up, east, north };
}

/**
 * Local tangent frame at a lat/lon: unit vectors { up, east, north }.
 * Right-handed: east x north = up. Same frame as localFrameEci at that point.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @returns {{ up: Vector3, east: Vector3, north: Vector3 }}
 */
export function localFrame(lat, lon) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const up = new Vector3(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
  const east = new Vector3(Math.cos(lo), 0, -Math.sin(lo));
  const north = new Vector3(-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo));
  return { up, east, north };
}

/**
 * Unit vector from the origin through p (the "outward" direction used by the camera script).
 * @param {Vector3} p
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function outward(p, target = new Vector3()) {
  return target.copy(p).normalize();
}

/**
 * Great-circle interpolation between two { lat, lon } points at the given radius.
 * s = 0 returns a, s = 1 returns b. s is not clamped.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @param {number} s
 * @param {number} [radius=R_EARTH] km
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function slerpLatLon(a, b, s, radius = R_EARTH, target = new Vector3()) {
  const va = latLonToVector3(a.lat, a.lon, 1);
  const vb = latLonToVector3(b.lat, b.lon, 1);
  const dot = Math.min(1, Math.max(-1, va.dot(vb)));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return target.copy(va).multiplyScalar(radius);
  const so = Math.sin(omega);
  const wa = Math.sin((1 - s) * omega) / so;
  const wb = Math.sin(s * omega) / so;
  return target
    .set(va.x * wa + vb.x * wb, va.y * wa + vb.y * wb, va.z * wa + vb.z * wb)
    .normalize()
    .multiplyScalar(radius);
}

/**
 * Great-circle (surface) distance between two position vectors, km, on a sphere of radius
 * R_EARTH. The vectors need not have the same length; only their directions matter.
 * @param {Vector3} a
 * @param {Vector3} b
 * @param {number} [radius=R_EARTH]
 */
export function greatCircleDistance(a, b, radius = R_EARTH) {
  const la = a.length();
  const lb = b.length();
  if (la === 0 || lb === 0) return 0;
  const dot = Math.min(1, Math.max(-1, a.dot(b) / (la * lb)));
  return radius * Math.acos(dot);
}
