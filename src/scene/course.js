// Projected course: where the kill vehicle and the threat are headed, from now to the intercept,
// drawn as dashed paths ending on a marker at the intercept point. Owned by the scene (Phase 2
// follow-up, for the Engage beat's wide course view).
//
// createCourse() -> { object3d, update(state, origin) }
//   state:  states.course ({ opacity, kv: Vector3[], missile: Vector3[], point })  ECI km; the
//           paths are the simulation's own future positions (Kepler), sampled to the intercept
//   origin: the camera's ECI position this frame (km)
//
// Fat dashed lines, 1.5 px, written origin-relative in preallocated buffers every frame. The dash
// period is a fraction of the path length but never more than a fraction of the camera's
// distance to the path, so dashes read at every zoom (as for the handoff beams in links.js). The
// colours are the actors' own, dimmed to stay under the bloom threshold (a thin blooming line
// aliases into beads in the bloom pass).

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { THREAT, INTERCEPTOR, FLASH } from '../shared/palette.js';
import { makePixelSprite, isVec3, num, clamp01 } from './util.js';

const CAPACITY = 96; // points per path
const LINE_WIDTH = 1.5;
const DIM = 0.65; // colour scale, under the bloom threshold
const DASHES_PER_PATH = 48;
const NEAR_DASH_FACTOR = 0.15; // dash period cap as a fraction of the camera-to-path distance
const DASH_FRACTION = 0.55;
const MARKER_PX = 18;

function createPath(color) {
  const geometry = new LineGeometry();
  geometry.setPositions(new Float32Array(CAPACITY * 3));
  const material = new LineMaterial({
    color: new THREE.Color(color).multiplyScalar(DIM),
    linewidth: LINE_WIDTH,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    dashed: true,
    dashSize: 1,
    gapSize: 1,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances(); // creates the distance attributes, rewritten in place below
  line.frustumCulled = false;
  line.visible = false;
  line.renderOrder = 2;
  const pos = geometry.attributes.instanceStart.data;
  const dist = geometry.attributes.instanceDistanceStart.data;

  return {
    line,
    /** Write the points (ECI) origin-relative; returns false when there is nothing to draw. */
    set(points, origin, opacity) {
      const n = Array.isArray(points) ? Math.min(points.length, CAPACITY) : 0;
      if (n < 2 || !(opacity > 0.001)) {
        line.visible = false;
        return;
      }
      const p = pos.array;
      const d = dist.array;
      let total = 0;
      let near = Infinity;
      let segs = 0;
      for (let i = 0; i + 1 < n; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (!isVec3(a) || !isVec3(b)) continue;
        const ax = a.x - origin.x;
        const ay = a.y - origin.y;
        const az = a.z - origin.z;
        const bx = b.x - origin.x;
        const by = b.y - origin.y;
        const bz = b.z - origin.z;
        const o = segs * 6;
        p[o] = ax;
        p[o + 1] = ay;
        p[o + 2] = az;
        p[o + 3] = bx;
        p[o + 4] = by;
        p[o + 5] = bz;
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        d[segs * 2] = total;
        total += len;
        d[segs * 2 + 1] = total;
        near = Math.min(near, Math.hypot(ax, ay, az));
        segs++;
      }
      if (segs < 1 || !(total > 1e-6)) {
        line.visible = false;
        return;
      }
      pos.needsUpdate = true;
      dist.needsUpdate = true;
      line.geometry.instanceCount = segs;
      const period = Math.min(total / DASHES_PER_PATH, Math.max(1e-4, near * NEAR_DASH_FACTOR));
      material.dashSize = period * DASH_FRACTION;
      material.gapSize = period * (1 - DASH_FRACTION);
      material.opacity = opacity;
      line.visible = true;
    },
  };
}

export function createCourse() {
  const root = new THREE.Group();
  root.name = 'course';
  const kvPath = createPath(INTERCEPTOR);
  const threatPath = createPath(THREAT);
  const marker = makePixelSprite(FLASH, MARKER_PX, { texture: 'ring' });
  marker.name = 'course-intercept-point';
  marker.renderOrder = 3;
  root.add(kvPath.line, threatPath.line, marker);

  return {
    object3d: root,
    update(state, origin) {
      const opacity = state ? clamp01(num(state.opacity, 0)) : 0;
      if (!(opacity > 0.001) || !isVec3(origin)) {
        kvPath.line.visible = threatPath.line.visible = marker.visible = false;
        return;
      }
      kvPath.set(state.kv, origin, opacity);
      threatPath.set(state.missile, origin, opacity);
      if (isVec3(state.point)) {
        marker.position.set(state.point.x - origin.x, state.point.y - origin.y, state.point.z - origin.z);
        marker.material.opacity = 0.85 * opacity;
        marker.visible = true;
      } else {
        marker.visible = false;
      }
    },
  };
}
