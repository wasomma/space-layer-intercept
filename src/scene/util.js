// Scene-internal helpers shared by the actor modules.
//
// Units: 1 scene unit = 1 km. Floating origin: the render camera sits at (0, 0, 0) and every
// object is placed at its ECI position minus the origin (the camera's ECI position this frame),
// subtracted in doubles before anything reaches the GPU.
//
// What lives here:
//   - procedural sprite textures (canvas gradients, no texture files)
//   - world-size glow sprites (sizeAttenuation on) and fixed-pixel sprites (sizeAttenuation off,
//     sized in CSS pixels by index.js every frame through applyPixelSizes)
//   - a fat-line trail that writes origin-relative positions in place
//   - the marker cross-fade of the 4.2 marker policy
//   - small guards (isVec3, num, orientZ) and a seeded PRNG (from shared/random.js)

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

export const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Metres to scene units (km). Actor geometry is modelled in metres under a group scaled by this. */
export const M = 0.001;

// ---------------------------------------------------------------------------
// Marker policy (4.2): geometry is always drawn; the fixed-pixel marker shows when the camera is
// farther than MARKER_DISTANCE_FACTOR times the object's length, cross-fading over
// MARKER_FADE_SECONDS. Pixel sizes are CSS pixels.

export const MARKER_DISTANCE_FACTOR = 60;
export const MARKER_FADE_SECONDS = 1;
export const PX = {
  shellMarker: 5, // dim constellation satellites (Points clouds)
  satMarker: 9, // the three highlighted satellites
  vehicleMarker: 8, // missile and kill vehicle
  haloDim: 22, // halo at highlight 0
  haloLit: 36, // halo at highlight 1
};

// ---------------------------------------------------------------------------
// Procedural textures (built once, shared)

let glowTexture = null;
let ringTexture = null;
let fadeTexture = null;
let dotTexture = null;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Soft radial gradient, white with alpha falling to 0 at the edge. */
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 128;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.32)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

/** Crisp dot with a short soft edge: the fixed-pixel marker. */
export function getDotTexture() {
  if (dotTexture) return dotTexture;
  const size = 64;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  dotTexture = new THREE.CanvasTexture(c);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

/** Thin soft-edged ring, used for the detect pulse and the intercept shock ring. */
export function getRingTexture() {
  if (ringTexture) return ringTexture;
  const size = 128;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.9, 'rgba(255,255,255,1)');
  grad.addColorStop(0.96, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  ringTexture = new THREE.CanvasTexture(c);
  ringTexture.colorSpace = THREE.SRGBColorSpace;
  return ringTexture;
}

/**
 * Vertical alpha ramp for alphaMap use: bright at uv.y = 1, dim at uv.y = 0.
 * alphaMap samples the green channel.
 */
export function getFadeTexture() {
  if (fadeTexture) return fadeTexture;
  const c = makeCanvas(4, 64);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0.0, 'rgb(20,20,20)');
  grad.addColorStop(1.0, 'rgb(255,255,255)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  fadeTexture = new THREE.CanvasTexture(c);
  return fadeTexture;
}

function textureFor(kind) {
  if (kind === 'ring') return getRingTexture();
  if (kind === 'dot') return getDotTexture();
  return getGlowTexture();
}

// ---------------------------------------------------------------------------
// Sprites

/**
 * Additive billboard sprite sized in world units (km). depthTest stays on so the globe occludes
 * it; depthWrite is off so overlapping glows add up.
 * @param {string} color palette hex
 * @param {{ ring?: boolean, opacity?: number }} [opts]
 */
export function makeGlowSprite(color, opts = {}) {
  const material = new THREE.SpriteMaterial({
    map: opts.ring ? getRingTexture() : getGlowTexture(),
    color: new THREE.Color(color),
    transparent: true,
    opacity: opts.opacity ?? 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.visible = false;
  return sprite;
}

/**
 * Fixed-pixel billboard sprite (sizeAttenuation off). Its on-screen size in CSS pixels is
 * sprite.userData.px; index.js converts that to a sprite scale every frame (applyPixelSizes),
 * so actors only ever set userData.px, opacity and visibility.
 * @param {string} color palette hex
 * @param {number} px diameter in CSS pixels
 * @param {{ texture?: 'dot'|'glow'|'ring', opacity?: number, additive?: boolean }} [opts]
 */
export function makePixelSprite(color, px, opts = {}) {
  const material = new THREE.SpriteMaterial({
    map: textureFor(opts.texture || 'dot'),
    color: new THREE.Color(color),
    transparent: true,
    opacity: opts.opacity ?? 1,
    blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.userData.px = px;
  sprite.visible = false;
  return sprite;
}

/**
 * Size every fixed-pixel sprite for this camera and viewport. With sizeAttenuation off a sprite
 * of scale s spans s * P[1][1] in NDC, i.e. s * P[1][1] * height / 2 CSS pixels, so
 * s = px * 2 / (P[1][1] * height). P[1][1] = 1 / tan(fov / 2) (times zoom).
 * @param {THREE.Sprite[]} sprites
 * @param {THREE.Camera} camera
 * @param {number} heightCss viewport height in CSS pixels
 */
export function applyPixelSizes(sprites, camera, heightCss) {
  const p11 = camera.projectionMatrix.elements[5];
  if (!(p11 > 0) || !(heightCss > 0)) return;
  const k = 2 / (p11 * heightCss);
  for (const sprite of sprites) {
    const s = Math.max(1e-9, num(sprite.userData.px, 0) * k);
    sprite.scale.set(s, s, 1);
  }
}

// ---------------------------------------------------------------------------
// Marker cross-fade

/**
 * Cross-fade value for a fixed-pixel marker: 1 when the camera is farther than
 * MARKER_DISTANCE_FACTOR * lengthKm, 0 when nearer, moving at 1 / MARKER_FADE_SECONDS per second.
 * It snaps (no fade) on the first update, after reset(), when dt is 0 or large (a seek, a paused
 * tab), and on a camera cut (the distance jumps by more than 3x in one update).
 * @param {number} lengthKm the object's length
 */
export function createMarkerFade(lengthKm) {
  const threshold = lengthKm * MARKER_DISTANCE_FACTOR;
  let value = -1;
  let lastDist = NaN;
  return {
    get value() {
      return value < 0 ? 0 : value;
    },
    /**
     * @param {number} distKm camera-to-object distance
     * @param {number} dt wall-clock seconds since the previous scene update (0 = snap)
     */
    update(distKm, dt) {
      const target = distKm > threshold ? 1 : 0;
      const cut = !(lastDist > 0) || distKm > lastDist * 3 || distKm < lastDist / 3;
      lastDist = distKm;
      if (value < 0 || cut || !(dt > 0) || dt > 0.25) {
        value = target;
      } else {
        const step = dt / MARKER_FADE_SECONDS;
        value += Math.max(-step, Math.min(step, target - value));
      }
      return value;
    },
    reset() {
      value = -1;
      lastDist = NaN;
    },
  };
}

// ---------------------------------------------------------------------------
// Fat-line trail

/**
 * A Line2 trail with a preallocated buffer. setPoints() writes origin-relative positions in place
 * (point - origin, subtracted in doubles, then stored as float32) and limits the drawn segment
 * count, so nothing is reallocated per frame. The vertex colours carry a brightness ramp from
 * tail to head. The line object itself stays at (0, 0, 0).
 *
 * @param {{ color: string, linewidth: number, capacity?: number, tailBrightness?: number, headBrightness?: number, opacity?: number }} opts
 */
export function createTrail({ color, linewidth, capacity = 256, tailBrightness = 0.3, headBrightness = 1, opacity = 0.95 }) {
  const geometry = new LineGeometry();
  geometry.setPositions(new Float32Array(capacity * 3));
  geometry.setColors(new Float32Array(capacity * 3).fill(1));

  const material = new LineMaterial({
    color: new THREE.Color(color),
    linewidth,
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
  });

  const line = new Line2(geometry, material);
  line.frustumCulled = false; // the bounding volume is stale by design
  line.visible = false;
  line.renderOrder = 2;

  const posBuffer = geometry.attributes.instanceStart.data; // xyz xyz per segment
  const colBuffer = geometry.attributes.instanceColorStart.data;
  const pos = posBuffer.array;
  const col = colBuffer.array;
  const baseOpacity = opacity;

  function point(points, n, i) {
    // Evenly subsample when more points arrive than the buffer holds; always keep the head.
    if (n <= capacity) return points[i];
    const idx = Math.round((i / (capacity - 1)) * (n - 1));
    return points[idx];
  }

  return {
    line,
    material,
    /**
     * @param {Array<{x:number,y:number,z:number}>} points ECI km, tail first
     * @param {{x:number,y:number,z:number}} origin camera ECI position this frame
     * @param {number} [fade=1] overall opacity multiplier 0..1
     */
    setPoints(points, origin, fade = 1) {
      const n = Array.isArray(points) ? points.length : 0;
      const count = Math.min(n, capacity);
      if (count < 2 || !(fade > 0.001)) {
        line.visible = false;
        return;
      }
      const ox = origin ? origin.x : 0;
      const oy = origin ? origin.y : 0;
      const oz = origin ? origin.z : 0;
      const segs = count - 1;
      let written = 0;
      for (let i = 0; i < segs; i++) {
        const a = point(points, n, i);
        const b = point(points, n, i + 1);
        if (!isVec3(a) || !isVec3(b)) continue;
        const o = written * 6;
        pos[o] = a.x - ox;
        pos[o + 1] = a.y - oy;
        pos[o + 2] = a.z - oz;
        pos[o + 3] = b.x - ox;
        pos[o + 4] = b.y - oy;
        pos[o + 5] = b.z - oz;
        const ka = tailBrightness + (headBrightness - tailBrightness) * (i / segs);
        const kb = tailBrightness + (headBrightness - tailBrightness) * ((i + 1) / segs);
        col[o] = col[o + 1] = col[o + 2] = ka;
        col[o + 3] = col[o + 4] = col[o + 5] = kb;
        written++;
      }
      if (written < 1) {
        line.visible = false;
        return;
      }
      posBuffer.needsUpdate = true;
      colBuffer.needsUpdate = true;
      geometry.instanceCount = written;
      // Opaque unless fading: adjacent segments overlap at their joints, and a transparent line
      // blends each overlap twice, which bloom turns into beads along the trail.
      material.opacity = baseOpacity * Math.min(1, fade);
      material.transparent = fade < 0.999;
      line.visible = true;
    },
    hide() {
      line.visible = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Guards and small helpers

/** True when v looks like a finite {x, y, z}. */
export function isVec3(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** True when v is a finite, non-zero {x, y, z}. */
export function isDir(v) {
  return isVec3(v) && (v.x !== 0 || v.y !== 0 || v.z !== 0);
}

/** Finite number or the fallback. */
export function num(x, fallback = 0) {
  return Number.isFinite(x) ? x : fallback;
}

/** Clamp to [0, 1]; non-finite gives 0. */
export function clamp01(x) {
  return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}

/**
 * target = v - origin, in doubles (the floating-origin subtraction). Returns target.
 * @param {THREE.Vector3} target
 * @param {{x:number,y:number,z:number}} v ECI km
 * @param {{x:number,y:number,z:number}} origin camera ECI km
 */
export function setRelative(target, v, origin) {
  return target.set(v.x - origin.x, v.y - origin.y, v.z - origin.z);
}

/** Distance from the origin (the camera) to the ECI point v, km. */
export function distanceFromOrigin(v, origin) {
  return Math.hypot(v.x - origin.x, v.y - origin.y, v.z - origin.z);
}

/** Orient obj so its local +Z points along dir (any length). No-op for a zero vector. */
export function orientZ(obj, dir) {
  if (!isVec3(dir)) return;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-12) return;
  _dir.set(dir.x / len, dir.y / len, dir.z / len);
  obj.quaternion.setFromUnitVectors(AXIS_Z, _dir);
}
const _dir = new THREE.Vector3();

/** Small seeded PRNG (mulberry32), returns floats in [0, 1); it lives in shared/random.js. */
export { rng } from '../shared/random.js';
