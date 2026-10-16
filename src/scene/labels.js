// Labels: the v1 CSS2D labels with per-id modifier classes, positioned origin-relative and
// occluded against the Earth sphere.
//
// createLabels() -> { object3d, update(state, origin), occlude(camera, origin), dispose() }
//   state:  states.labels ([{ id, text, position, visible }]), positions ECI km
//   origin: the camera's ECI position this frame (km)
//
// One CSS2DObject (class `viz-label`, plus a `viz-label--<modifier>` colour class by id, and a
// data-label-id attribute that hud.css uses to hang TRACK and TARGET ASSIGNED below their anchors)
// per id, created on first sight and reused; ids missing from a frame are hidden. Each object is
// placed at (position - origin). occlude() hides labels whose line of sight from the camera passes
// through the Earth sphere of radius R_EARTH * 0.999, tested in ECI doubles (camera at `origin`,
// Earth at the ECI origin); scene/index.js calls it just before the CSS2D render. Styling lives in
// src/hud/hud.css.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { R_EARTH } from '../shared/constants.js';
import { isVec3 } from './util.js';

const OCCLUDER_RADIUS = R_EARTH * 0.999; // slightly inside the globe so surface labels are not self-occluded

// Per-actor colour: a `viz-label--<modifier>` class from src/hud/hud.css, keyed by label id (5.11
// ids first, then the v1 spellings). Ids without an entry (launcher, intercept) stay in the
// default text colour.
const MODIFIER_BY_ID = {
  sensorSat: 'sensor',
  track: 'sensor',
  relay: 'relay',
  interceptorSat: 'interceptor-sat',
  assigned: 'interceptor-sat',
  threat: 'threat',
  kv: 'interceptor',
  // v1 and harness spellings
  sensor: 'sensor',
  relaySat: 'relay',
  'interceptor-sat': 'interceptor-sat',
  interceptor: 'interceptor',
};

export function createLabels() {
  const root = new THREE.Group();
  root.name = 'labels';

  /** @type {Map<string, { object: CSS2DObject, wanted: boolean, text: string, eci: THREE.Vector3 }>} */
  const entries = new Map();
  const _cam = new THREE.Vector3();
  const _d = new THREE.Vector3();

  function getEntry(id) {
    let entry = entries.get(id);
    if (entry) return entry;
    const el = document.createElement('div');
    const modifier = MODIFIER_BY_ID[id];
    el.className = modifier ? `viz-label viz-label--${modifier}` : 'viz-label';
    el.dataset.labelId = id;
    const object = new CSS2DObject(el);
    // hud.css gives the element a zero-size box, so its top-left corner sits on the anchor
    // whatever the center; (0, 1) keeps the v1 placement up and to the right of the actor.
    object.center.set(0, 1);
    object.visible = false;
    object.name = 'label-' + id;
    root.add(object);
    entry = { object, wanted: false, text: '', eci: new THREE.Vector3() };
    entries.set(id, entry);
    return entry;
  }

  /** True when the segment from the camera (ECI _cam) to p (ECI) passes through the Earth. */
  function blocked(p) {
    _d.subVectors(p, _cam);
    const len = _d.length();
    if (len < 1e-9) return false;
    _d.divideScalar(len);
    const b = _cam.dot(_d);
    const c = _cam.lengthSq() - OCCLUDER_RADIUS * OCCLUDER_RADIUS;
    const disc = b * b - c;
    if (disc <= 0) return false;
    const sq = Math.sqrt(disc);
    const s0 = -b - sq; // entry
    const s1 = -b + sq; // exit
    if (s1 <= 0) return false; // sphere behind the camera
    if (s0 < 0) return true; // camera inside the occluder
    return s0 < len;
  }

  return {
    object3d: root,
    update(state, origin) {
      for (const entry of entries.values()) entry.wanted = false;
      const list = Array.isArray(state) ? state : [];
      const o = isVec3(origin) ? origin : null;
      for (const item of list) {
        if (!item || item.id === undefined || item.id === null) continue;
        const entry = getEntry(String(item.id));
        const text = item.text === undefined || item.text === null ? '' : String(item.text);
        if (text !== entry.text) {
          entry.text = text;
          entry.object.element.textContent = text;
        }
        const ok = isVec3(item.position) && o !== null;
        if (ok) {
          const p = item.position;
          entry.eci.set(p.x, p.y, p.z);
          entry.object.position.set(p.x - o.x, p.y - o.y, p.z - o.z);
        }
        entry.wanted = item.visible !== false && ok && text !== '';
      }
      for (const entry of entries.values()) entry.object.visible = entry.wanted;
    },
    /** Hide labels behind the Earth for this frame's camera (at ECI `origin`). */
    occlude(camera, origin) {
      if (isVec3(origin)) _cam.set(origin.x, origin.y, origin.z);
      else if (camera) {
        camera.updateMatrixWorld();
        _cam.setFromMatrixPosition(camera.matrixWorld);
      } else return;
      for (const entry of entries.values()) {
        entry.object.visible = entry.wanted && !blocked(entry.eci);
      }
    },
    dispose() {
      for (const entry of entries.values()) {
        entry.object.element.remove();
        root.remove(entry.object);
      }
      entries.clear();
    },
  };
}
