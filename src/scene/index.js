// Scene root.
//
// createScene({ renderer, labelContainer, width, height })
//   -> { update(states), render(camera), resize(width, height), dispose() }
//
// Owns the THREE.Scene, an EffectComposer (RenderPass, UnrealBloomPass, OutputPass) and a
// CSS2DRenderer whose element is appended to labelContainer. main.js owns renderer.setSize.
//
// Floating origin: update(states) takes origin = states.camera.position (ECI km, the origin
// main.js actually used this frame) and passes it to every actor; each actor places its objects at
// state.position - origin, computed in doubles before upload. Trails, beams, rings and cones are
// rebuilt or re-aimed origin-relative every frame. The Earth group sits at -origin, rotated by
// states.earth.theta, and carries the terrain tile as a child. The starfield stays at the origin.
// render(camera) receives a camera at (0, 0, 0).
//
// Fixed-pixel sprites (markers, halos, pulses, far plume glows) declare their size in CSS pixels
// (sprite.userData.px); render() converts that to a sprite scale for the camera's fov and the
// viewport height every frame, so they hold their pixel size at every distance and fov.
//
// Actor update calls take an optional third `ctx` argument beyond the 4.2 contract:
// { dt, animT, exclude } (wall-clock seconds since the previous update for the marker
// cross-fades, animation time for dash marching, and the highlighted satellites' positions so
// the constellation does not draw a second body and marker on them).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLonToVector3 } from '../shared/geo.js';
import { BG, FLASH, SENSOR, RELAY, INTERCEPTOR_SAT } from '../shared/palette.js';
import { createEarth } from './earth.js';
import { createStarfield } from './starfield.js';
import { createConstellation } from './constellation.js';
import { createTerrain } from './terrain.js';
import { createLauncher } from './launcher.js';
import { createMissile } from './missile.js';
import { createSatellite } from './satellite.js';
import { createKv } from './kv.js';
import { createLinks } from './links.js';
import { createCourse } from './course.js';
import { createInterceptFx } from './interceptFx.js';
import { createLabels } from './labels.js';
import { isVec3, num, applyPixelSizes } from './util.js';

const BLOOM = { strength: 0.8, radius: 0.4, threshold: 0.6 };
const AMBIENT = 0.45;
const SUN_INTENSITY = 2.2;
// Fixed sun direction in ECI (directional light: only the direction matters, and the floating
// origin does not change directions). High over the launch site's south-west at ignition.
const SUN_DIR = latLonToVector3(28, 62, 1).normalize();
// Generic sensor field-of-view half-angle (5.4), used when the caller does not pass one.
const DEFAULT_CONE_HALF_ANGLE_DEG = 8; // illustrative
// A frame gap longer than this snaps the marker cross-fades instead of fading (a paused or
// hidden tab, a seek).
const MAX_FADE_DT = 0.25;

export function createScene({ renderer, labelContainer, width, height, coneHalfAngleDeg = DEFAULT_CONE_HALF_ANGLE_DEG }) {
  let w = Math.max(1, Math.floor(width || 1));
  let h = Math.max(1, Math.floor(height || 1));

  const scene = new THREE.Scene();
  scene.name = 'viz-scene';
  scene.background = new THREE.Color(BG);

  // Lights: a dim ambient fill plus one sun. Everything glowing uses unlit or emissive materials.
  scene.add(new THREE.AmbientLight(FLASH, AMBIENT)); // FLASH is the palette's white
  const sun = new THREE.DirectionalLight(FLASH, SUN_INTENSITY);
  sun.position.copy(SUN_DIR); // target stays at (0, 0, 0): light travels along -SUN_DIR
  scene.add(sun);

  // Actors.
  const earth = createEarth();
  const starfield = createStarfield();
  const constellation = createConstellation();
  const terrain = createTerrain();
  const launcher = createLauncher();
  const missile = createMissile();
  const sensorSat = createSatellite(SENSOR, { sensor: true, name: 'sensor-sat', coneHalfAngleDeg });
  const relaySat = createSatellite(RELAY, { name: 'relay-sat' });
  const interceptorSat = createSatellite(INTERCEPTOR_SAT, { tube: true, name: 'interceptor-sat' });
  const kv = createKv();
  const links = createLinks();
  const course = createCourse();
  const interceptFx = createInterceptFx();
  const labels = createLabels();

  earth.object3d.add(terrain.object3d);
  for (const actor of [starfield, earth, constellation, launcher, missile, sensorSat, relaySat, interceptorSat, kv, links, course, interceptFx, labels]) {
    scene.add(actor.object3d);
  }

  // Fixed-pixel sprites, collected once (every actor builds its sprites at creation).
  const pixelSprites = [];
  scene.traverse((obj) => {
    if (obj.isSprite && obj.userData && obj.userData.px !== undefined) pixelSprites.push(obj);
  });

  // Post-processing. The renderer's own antialias does not reach the composer's render targets,
  // so they are multisampled here; without it thin lines alias into steps that bloom turns into
  // beads.
  const composerTarget = new THREE.WebGLRenderTarget(w * renderer.getPixelRatio(), h * renderer.getPixelRatio(), {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  const renderPass = new RenderPass(scene, null);
  composer.addPass(renderPass);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // CSS2D labels.
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  const labelEl = labelRenderer.domElement;
  labelEl.style.position = 'absolute';
  labelEl.style.top = '0';
  labelEl.style.left = '0';
  labelEl.style.pointerEvents = 'none';
  if (labelContainer) labelContainer.appendChild(labelEl);

  // Per-frame scratch.
  const origin = new THREE.Vector3();
  const sensorState = { pulsePosition: null };
  const missileState = { trailOpacity: 1 };
  const kvState = { trailOpacity: 1 };
  const ctx = { dt: 0, animT: 0, exclude: [] };
  let lastUpdate = NaN;

  /** Trail fade after the intercept: follows the burst (v1), unless the state carries its own. */
  function trailFade(intercept, explicit) {
    if (Number.isFinite(explicit)) return explicit;
    if (intercept && intercept.active) return Math.max(0, 1 - num(intercept.burst, 0));
    return 1;
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  return {
    scene,
    update(states) {
      if (!states) return;
      if (states.camera && isVec3(states.camera.position)) origin.copy(states.camera.position);

      const t = now();
      const dt = Number.isFinite(lastUpdate) ? (t - lastUpdate) / 1000 : 0;
      lastUpdate = t;
      ctx.dt = dt > 0 && dt <= MAX_FADE_DT ? dt : 0;
      ctx.animT = num(states.animT, 0);
      ctx.exclude.length = 0;
      for (const s of [states.sensorSat, states.relaySat, states.interceptorSat]) {
        if (s && s.visible !== false && isVec3(s.position)) ctx.exclude.push(s.position);
      }

      earth.update(states.earth, origin);
      terrain.update(states.earth, origin);
      constellation.update(states.constellation, origin, ctx);
      launcher.update(states.launcher, origin);

      const m = states.missile;
      if (m) {
        Object.assign(missileState, m);
        missileState.trailOpacity = trailFade(states.intercept, m.trailOpacity);
        missile.update(missileState, origin, ctx);
      } else {
        missile.update(null, origin, ctx);
      }

      const s = states.sensorSat;
      if (s) {
        Object.assign(sensorState, s);
        // The detect pulse grows at the missile; satellite.js falls back to the cone target.
        sensorState.pulsePosition = isVec3(s.pulsePosition) ? s.pulsePosition : m && isVec3(m.position) ? m.position : null;
        sensorSat.update(sensorState, origin, ctx);
      } else {
        sensorSat.update(null, origin, ctx);
      }
      relaySat.update(states.relaySat, origin, ctx);
      interceptorSat.update(states.interceptorSat, origin, ctx);

      const k = states.kv;
      if (k) {
        Object.assign(kvState, k);
        kvState.trailOpacity = trailFade(states.intercept, k.trailOpacity);
        kv.update(kvState, origin, ctx);
      } else {
        kv.update(null, origin, ctx);
      }

      links.update(states.links, origin, ctx);
      course.update(states.course, origin);
      interceptFx.update(states.intercept, origin);
      labels.update(states.labels, origin);
    },

    render(camera) {
      if (!camera) return;
      renderPass.camera = camera;
      applyPixelSizes(pixelSprites, camera, h);
      labels.occlude(camera, origin);
      composer.render();
      labelRenderer.render(scene, camera);
    },

    resize(width2, height2) {
      w = Math.max(1, Math.floor(width2 || 1));
      h = Math.max(1, Math.floor(height2 || 1));
      composer.setPixelRatio(renderer.getPixelRatio());
      // composer.setSize also resizes every pass, the bloom pass included, at the pixel ratio.
      composer.setSize(w, h);
      labelRenderer.setSize(w, h);
    },

    dispose() {
      labels.dispose();
      if (labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
      const textures = new Set();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.isInstancedMesh) obj.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        for (const mat of mats) {
          for (const key of ['map', 'alphaMap', 'emissiveMap']) if (mat[key]) textures.add(mat[key]);
          mat.dispose();
        }
      });
      for (const tex of textures) tex.dispose();
      bloomPass.dispose();
      composer.dispose();
    },
  };
}
