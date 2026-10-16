// Links: the v1 beams and travelling pulses, rebuilt origin-relative.
//
// createLinks() -> { object3d, update(state, origin, ctx) }
//   state:  states.links ({ beams: [{ id, from, to, opacity, pulse, color, dashed }] })
//             color  palette hex string, LINK when absent
//             dashed true for the sensor track line
//             pulse  0..1 position of the bright pulse along the beam, or null for none
//   origin: the camera's ECI position this frame (km)
//   ctx:    optional { animT } animation seconds, used only to march the dashes
//
// A fixed pool of beams is created up front and shown or hidden as the beam count changes. Each
// beam is a one-segment fat line (1.5 px) whose two vertices are rewritten every frame as
// (from - origin) and (to - origin), subtracted in doubles; the dash distances are rewritten with
// it. Dash and gap lengths are a fixed fraction of the beam length, so every beam shows about the
// same number of dashes whatever its length (beams run from a few km to over 10000 km). Pulses
// are fixed-pixel sprites so they read at every scale.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LINK, FLASH } from '../shared/palette.js';
import { makePixelSprite, isVec3, num, clamp01 } from './util.js';

const POOL_SIZE = 6;
const LINE_WIDTH = 1.5;
const DASHES_PER_BEAM = 60; // dash + gap periods along a beam
const DASH_FRACTION = 0.6; // of each period
const DASH_RATE = 0.6; // periods per animation second, marching from source to target
const NEAR_DASH_FACTOR = 0.15; // dash period cap as a fraction of the camera-to-beam distance
const PULSE_PX = 18;
const PULSE_CORE_PX = 6;

function createBeam(index) {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 0, 0, 1]);
  const material = new LineMaterial({
    color: new THREE.Color(LINK),
    linewidth: LINE_WIDTH,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    dashed: false,
    dashSize: 1,
    gapSize: 1,
    dashScale: 1,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances(); // creates the distance attributes once; rewritten in place below
  line.name = 'link-beam-' + index;
  line.visible = false;
  line.frustumCulled = false;
  line.renderOrder = 2;

  const pulse = makePixelSprite(LINK, PULSE_PX, { texture: 'glow' });
  pulse.name = 'link-pulse-' + index;
  pulse.renderOrder = 3;
  const core = makePixelSprite(FLASH, PULSE_CORE_PX, { texture: 'dot' });
  core.renderOrder = 3;

  const posBuffer = geometry.attributes.instanceStart.data;
  const distBuffer = geometry.attributes.instanceDistanceStart.data;
  return { line, material, pulse, core, colorHex: LINK, posBuffer, distBuffer };
}

export function createLinks() {
  const root = new THREE.Group();
  root.name = 'links';

  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const beam = createBeam(i);
    pool.push(beam);
    root.add(beam.line, beam.pulse, beam.core);
  }

  function hide(beam) {
    beam.line.visible = false;
    beam.pulse.visible = false;
    beam.core.visible = false;
  }

  return {
    object3d: root,
    update(state, origin, ctx = {}) {
      const beams = state && Array.isArray(state.beams) ? state.beams : [];
      const t = num(ctx.animT, 0);
      for (let i = 0; i < POOL_SIZE; i++) {
        const beam = pool[i];
        const b = beams[i];
        if (!b || !isVec3(b.from) || !isVec3(b.to) || !isVec3(origin)) {
          hide(beam);
          continue;
        }
        const opacity = clamp01(num(b.opacity, 1));
        // Origin-relative endpoints, in doubles.
        const fx = b.from.x - origin.x;
        const fy = b.from.y - origin.y;
        const fz = b.from.z - origin.z;
        const tx = b.to.x - origin.x;
        const ty = b.to.y - origin.y;
        const tz = b.to.z - origin.z;
        const length = Math.hypot(tx - fx, ty - fy, tz - fz);
        if (length < 1e-6 || opacity <= 0.001) {
          hide(beam);
          continue;
        }

        const pos = beam.posBuffer.array;
        pos[0] = fx;
        pos[1] = fy;
        pos[2] = fz;
        pos[3] = tx;
        pos[4] = ty;
        pos[5] = tz;
        beam.posBuffer.needsUpdate = true;
        const dist = beam.distBuffer.array;
        dist[0] = 0;
        dist[1] = length;
        beam.distBuffer.needsUpdate = true;

        // Colour (only touch the materials when it changes).
        const hex = typeof b.color === 'string' && b.color ? b.color : LINK;
        if (hex !== beam.colorHex) {
          beam.colorHex = hex;
          beam.material.color.set(hex);
          beam.pulse.material.color.set(hex);
        }

        // Dashing.
        const dashed = b.dashed === true;
        if (beam.material.dashed !== dashed) {
          beam.material.dashed = dashed;
          beam.material.needsUpdate = true;
        }
        if (dashed) {
          // Dash period: a fixed fraction of the beam, but never longer than a fraction of the
          // camera's distance to the beam. Seen from a few km off a 10000 km beam, beam-relative
          // dashes would be 100 km long and the gap at the near end could fill the frame.
          const dx = tx - fx;
          const dy = ty - fy;
          const dz = tz - fz;
          const u = clamp01(-(fx * dx + fy * dy + fz * dz) / (length * length));
          const near = Math.hypot(fx + dx * u, fy + dy * u, fz + dz * u);
          const period = Math.min(length / DASHES_PER_BEAM, Math.max(1e-4, near * NEAR_DASH_FACTOR));
          beam.material.dashSize = period * DASH_FRACTION;
          beam.material.gapSize = period * (1 - DASH_FRACTION);
          beam.material.dashOffset = -((t * DASH_RATE) % 1) * period;
        }
        beam.material.opacity = opacity;
        beam.line.visible = true;

        // Pulse.
        const pulse = b.pulse;
        if (pulse !== null && pulse !== undefined && Number.isFinite(pulse) && pulse >= 0 && pulse <= 1) {
          beam.pulse.position.set(fx + (tx - fx) * pulse, fy + (ty - fy) * pulse, fz + (tz - fz) * pulse);
          beam.pulse.material.opacity = 1;
          beam.pulse.visible = true;
          beam.core.position.copy(beam.pulse.position);
          beam.core.material.opacity = 0.9;
          beam.core.visible = true;
        } else {
          beam.pulse.visible = false;
          beam.core.visible = false;
        }
      }
    },
  };
}
