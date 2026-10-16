// Scalar easing helpers.
// All easing functions take x in 0..1 and return 0..1; inputs are clamped.

/** Clamp x to [lo, hi]. Defaults to [0, 1]. */
export function clamp(x, lo = 0, hi = 1) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear interpolation from a to b by s (not clamped). */
export function lerp(a, b, s) {
  return a + (b - a) * s;
}

/**
 * Map x from [inLo, inHi] to [outLo, outHi], clamped to the output range.
 * remap(t, 10, 12) gives a 0..1 progress value across the window t = 10..12.
 */
export function remap(x, inLo, inHi, outLo = 0, outHi = 1) {
  if (inHi === inLo) return x < inLo ? outLo : outHi;
  const s = clamp((x - inLo) / (inHi - inLo));
  return lerp(outLo, outHi, s);
}

/**
 * Hermite smoothstep. Single-argument form smoothstep(x) eases x in 0..1.
 * Three-argument form smoothstep(x, edge0, edge1) eases x across [edge0, edge1].
 * Note the argument order: x first, unlike GLSL.
 */
export function smoothstep(x, edge0 = 0, edge1 = 1) {
  const s = edge1 === edge0 ? (x < edge0 ? 0 : 1) : clamp((x - edge0) / (edge1 - edge0));
  return s * s * (3 - 2 * s);
}

/** Cubic ease in-out on 0..1. */
export function easeInOutCubic(x) {
  const s = clamp(x);
  return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
}

/** Quadratic ease out on 0..1. */
export function easeOutQuad(x) {
  const s = clamp(x);
  return 1 - (1 - s) * (1 - s);
}
