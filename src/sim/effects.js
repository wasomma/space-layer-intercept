// Intercept effects: the flash, the shock ring and the debris burst at the intercept point.
//
// interceptFxAt(animT, animI) gives their envelopes after the intercept (progress values, v1
// pacing); interceptFxShape(fx) turns those into what is drawn: each effect's level and size.
// BURST_PIECES is the burst's piece table, from a fixed seed. scene/interceptFx.js draws exactly
// these numbers and the live link exports them (live.js). The Intercept beat plays in real time
// (timeline.js), so the animation seconds after the intercept are simulation seconds there.
// Pure, Node-importable.

import { clamp, smoothstep, easeOutQuad } from '../shared/easing.js';
import { rng } from '../shared/random.js';

// Envelopes, animation seconds after the intercept (v1 pacing).
export const FX_WINDOW = 3;
const FLASH_RISE = 0.3;
export const FLASH_END = 1.5;
export const RING_DURATION = 1.5;
export const BURST_DURATION = 3;
const SHAKE_DURATION = 1;

// Sizes, km. Phase 2: 2.5x the 4.2 starting sizes (0.3, 1.5, 2 km), which were set for a camera
// about 4 km away; the Intercept shot now watches from about 13 km.
export const FLASH_MAX_KM = 0.75; // flash sprite width at full intensity
const RING_MAX_KM = 3.75; // shock ring sprite width at the end of its expansion
const RING_OPACITY = 0.9; // shock ring opacity as it starts
const BURST_TRAVEL_KM = 5.0; // distance a piece at full speed travels
const BURST_SPEEDUP = 1.6; // the pieces stop travelling at 1 / 1.6 of the burst
export const BURST_PIECE_SIZE_KM = 0.12; // attenuated point size of a piece
const BURST_COUNT = 300;
const BURST_SEED = 6012;

/**
 * Intercept effects at animation time animT for an intercept at animation time animI:
 * progress values, all 0 outside [animI, animI + 3).
 * @returns {{ active: boolean, flash: number, ring: number, burst: number, shake: number }}
 */
export function interceptFxAt(animT, animI) {
  const local = animT - animI;
  if (!(local >= 0 && local < FX_WINDOW)) return { active: false, flash: 0, ring: 0, burst: 0, shake: 0 };
  const flash = local < FLASH_RISE ? smoothstep(local, 0, FLASH_RISE) : 1 - smoothstep(local, FLASH_RISE, FLASH_END);
  return {
    active: true,
    flash,
    ring: clamp(local / RING_DURATION),
    burst: clamp(local / BURST_DURATION),
    shake: local < SHAKE_DURATION ? easeOutQuad(1 - local / SHAKE_DURATION) : 0,
  };
}

/**
 * The burst's pieces: for piece i, dirs[3i..3i+2] is a random direction scaled by the piece's
 * speed (0.35 to 1), life[i] the share of the burst it stays visible (0.45 to 1), kind[i] its
 * colour (0 flash, 1 threat, 2 interceptor). Read-only.
 */
export const BURST_PIECES = makeBurstPieces(BURST_COUNT, BURST_SEED);

function makeBurstPieces(count, seed) {
  const random = rng(seed);
  const dirs = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const kind = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const speed = 0.35 + 0.65 * Math.pow(random(), 0.6);
    dirs[i * 3] = s * Math.cos(phi) * speed;
    dirs[i * 3 + 1] = u * speed;
    dirs[i * 3 + 2] = s * Math.sin(phi) * speed;
    life[i] = 0.45 + 0.55 * random();
    const pick = random();
    kind[i] = pick < 0.5 ? 0 : pick < 0.85 ? 1 : 2;
  }
  return { count, dirs, life, kind };
}

/** Brightness of burst piece i at burst progress b: it fades out over its life. */
export function burstPieceFade(i, b) {
  const a = Math.max(0, 1 - b / BURST_PIECES.life[i]);
  return a * a;
}

/**
 * What is drawn for the envelopes fx (interceptFxAt): the flash and the shock ring as a level
 * (opacity, 0..1) and a diameter (the sprite's width, km; the ring texture's bright crest is at
 * 90 % of its radius), the burst as a level (the mean brightness of its pieces, 0..1) and a spread
 * (how far a piece at full speed has travelled from the intercept point, km; the slowest have
 * gone 35 % of that). Fresh objects.
 */
export function interceptFxShape(fx) {
  const f = clamp(fx.flash);
  const r = clamp(fx.ring);
  const b = clamp(fx.burst);
  let sum = 0;
  for (let i = 0; i < BURST_PIECES.count; i++) sum += burstPieceFade(i, b);
  return {
    flash: { level: f, diameterKm: FLASH_MAX_KM * Math.sqrt(f) },
    ring: { level: RING_OPACITY * Math.pow(1 - r, 1.2), diameterKm: RING_MAX_KM * easeOutQuad(r) },
    burst: { level: sum / BURST_PIECES.count, spreadKm: BURST_TRAVEL_KM * easeOutQuad(Math.min(1, b * BURST_SPEEDUP)) },
  };
}
