// Palette: neutral dark ops-centre.
// Every colour is a CSS hex string. three.js accepts these directly
// (new Color('#3FA9F5'), material { color: LAND }), and the HUD uses them as CSS.
// The v1 palette plus five launch-site colours.

export const BG = '#05080F';
export const GLOBE = '#0A1020';
export const LAND = '#3FA9F5';
export const GRATICULE = '#16233A';
export const ATMOS = '#2F7FE0';
export const STAR = '#9FB3C8';
export const RING = '#1F2D40';
export const SAT_DIM = '#5B6B80';
export const SENSOR = '#FFC857';
export const RELAY = '#8BD3FF';
export const INTERCEPTOR_SAT = '#4ADE80';
export const THREAT = '#FF4D4D';
export const INTERCEPTOR = '#7CFFB2';
export const LINK = '#CDEBFF';
export const FLASH = '#FFFFFF';
export const TEXT = '#D6E2F0';
export const TEXT_DIM = '#7D8CA3';
// Launch site (5.8).
export const GROUND = '#1C2A1F';
export const FOLIAGE = '#2F5A3A';
export const FOLIAGE_DARK = '#1E3D28';
export const TRUNK = '#4A3A2A';
export const VEHICLE = '#3C4A3E';

/** The whole palette as a { NAME: hex } map, in spec order. */
export const PALETTE = Object.freeze({
  BG,
  GLOBE,
  LAND,
  GRATICULE,
  ATMOS,
  STAR,
  RING,
  SAT_DIM,
  SENSOR,
  RELAY,
  INTERCEPTOR_SAT,
  THREAT,
  INTERCEPTOR,
  LINK,
  FLASH,
  TEXT,
  TEXT_DIM,
  GROUND,
  FOLIAGE,
  FOLIAGE_DARK,
  TRUNK,
  VEHICLE,
});

/**
 * CSS custom properties for the palette: { '--c-bg': '#05080F', '--c-sat-dim': ..., ... }.
 * Names are the constant names lower-cased with underscores turned into hyphens.
 * Apply with: for (const [k, v] of Object.entries(cssVars())) root.style.setProperty(k, v)
 */
export function cssVars() {
  const vars = {};
  for (const [name, hex] of Object.entries(PALETTE)) {
    vars['--c-' + name.toLowerCase().replace(/_/g, '-')] = hex;
  }
  return vars;
}
