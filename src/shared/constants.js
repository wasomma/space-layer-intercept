// Physical constants and units.
//
// Units everywhere in the simulation and the scene: kilometres, km/s, seconds.
// 1 scene unit = 1 km. Textbook two-body values for a spherical, rotating Earth;
// no J2, no drag.

/** Earth radius, km (spherical). */
export const R_EARTH = 6371;

/** Earth gravitational parameter, km^3/s^2. */
export const MU = 398600.4418;

/** Earth sidereal rotation rate, rad/s. */
export const OMEGA_EARTH = 7.2921159e-5;

/** Degrees to radians. */
export const DEG = Math.PI / 180;

/** Standard gravity, km/s^2 (9.80665 m/s^2). */
export const G0 = 9.80665e-3;
