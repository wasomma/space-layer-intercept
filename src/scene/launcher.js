// Launcher: a generic heavy 8-axle transporter-erector-launcher at metre scale in km units.
//
// createLauncher() -> { object3d, update(state, origin) }
//   state:  states.launcher ({ position, up, east, north, erectAngleDeg, lidOpen, outriggers, visible })
//   origin: the camera's ECI position this frame (km)
//
// Modelled in metres under a group scaled by 0.001. Local frame: X = forward (north), Y = up,
// Z = east (north x up = east, right-handed), built from the state's up / north, which the sim
// supplies already rotated by theta. 22 m long, 3.5 m wide, VEHICLE colour: 8 axles with 16 wheels
// (radius 0.8 m), a forward cab with dark glass, a canister (inner radius 1.3 x the missile's
// 1.1 m, open top, lid that swings open with lidOpen 0..1) on an erector cradle hinged at the
// vehicle rear, two telescopic hydraulic rams whose length follows erectAngleDeg, and four
// outriggers that slide out and jack down with outriggers 0..1.
//
// Geometry of the erection: the hinge pivot is at the vehicle rear, PIVOT_HEIGHT above the
// ground; the canister axis runs AXIS_OFFSET above the pivot when stowed, and the canister base
// overhangs the pivot by PIVOT_HEIGHT. Rotating the cradle 90 degrees therefore stands the
// canister with its base on the ground and its axis exactly AXIS_OFFSET behind the pivot; the
// pivot is placed at x = AXIS_OFFSET, so the erect axis is the vertical line through `position`
// and the missile (tail at `position`) rises straight out of it.
//
// The whole vehicle is lifted by the terrain's ground offset (the woodland tile is raised 2 m
// above the sphere, terrain.js) so the wheels stand on the visible ground.

import * as THREE from 'three';
import { VEHICLE, BG, GLOBE, SAT_DIM } from '../shared/palette.js';
import { isVec3, isDir, num, clamp01, M, distanceFromOrigin } from './util.js';
import { GROUND_LIFT_M } from './terrain.js';

const DEG = Math.PI / 180;

// Metres.
const MISSILE_RADIUS = 1.1;
const CANISTER_INNER = 1.3 * MISSILE_RADIUS;
const CANISTER_OUTER = CANISTER_INNER + 0.19;
const CANISTER_LENGTH = 21.0; // 20 m missile plus clearance
const PIVOT_HEIGHT = 1.6;
const AXIS_OFFSET = 1.85; // pivot to canister axis, > outer radius so the erect canister clears the rear
const PIVOT_X = AXIS_OFFSET; // erect axis lands on x = 0
const BASE_OVERHANG = PIVOT_HEIGHT; // erect canister base on the ground
const REAR_X = PIVOT_X - 0.15;
const LENGTH = 22;
const FRONT_X = REAR_X + LENGTH;
const HALF_WIDTH = 1.75;
const WHEEL_RADIUS = 0.8;
const WHEEL_WIDTH = 0.55;
const AXLES = [3.2, 4.9, 8.4, 10.1, 13.6, 15.3, 18.8, 20.5];
const CAB_REAR_X = 21.4;
const DECK_BOTTOM = 1.4;
const DECK_TOP = 1.62;
const LID_MAX_DEG = 115;

// Rams: base on the chassis, attach point on the cradle (hinge-local, before rotation).
const RAM_BASE = { x: PIVOT_X + 9.0, y: 1.2 };
const RAM_ATTACH = { x: 6.0, y: -0.1 };
const RAM_Z = 0.85;
const RAM_RADII = [0.2, 0.17, 0.14, 0.11, 0.085];

// Outriggers: x stations, beam travel, jack travel.
const OUTRIGGER_X = [2.05, 17.05];
const OUTRIGGER_BEAM = { length: 1.6, size: 0.3, y: 1.05, travel: 1.4 };
const OUTRIGGER_FOOT = { retracted: 0.6, deployed: 0.04 };

const SHOW_WITHIN_KM = 150;

function box(w, h, d, mat, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Box spanning [x0, x1] x [y0, y1] x [z0, z1] (either order per axis). */
function span(mat, x0, x1, y0, y1, z0, z1) {
  return box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** 0..1 from a number or a boolean. */
function unit(v) {
  return v === true ? 1 : clamp01(v);
}

export function createLauncher() {
  const root = new THREE.Group();
  root.name = 'launcher';
  root.visible = false;

  // Everything is in metres under `body`.
  const body = new THREE.Group();
  body.name = 'launcher-body';
  body.scale.setScalar(M);
  root.add(body);

  const paint = new THREE.MeshStandardMaterial({ color: VEHICLE, roughness: 0.75, metalness: 0.25 });
  const darkPaint = new THREE.MeshStandardMaterial({ color: VEHICLE, roughness: 0.9, metalness: 0.1 });
  darkPaint.color.multiplyScalar(0.6);
  const rubber = new THREE.MeshStandardMaterial({ color: BG, roughness: 0.95, metalness: 0 });
  const glass = new THREE.MeshStandardMaterial({ color: GLOBE, roughness: 0.12, metalness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: SAT_DIM, roughness: 0.35, metalness: 0.8 });
  const interior = new THREE.MeshStandardMaterial({ color: BG, roughness: 1, metalness: 0, side: THREE.BackSide });

  // ---- chassis, deck, cab
  body.add(span(darkPaint, REAR_X, FRONT_X - 0.3, 0.75, DECK_BOTTOM, -1.0, 1.0)); // frame
  body.add(span(paint, REAR_X, CAB_REAR_X - 0.1, DECK_BOTTOM, DECK_TOP, -HALF_WIDTH, HALF_WIDTH)); // deck over the wheels
  // Side skirts between the wheel groups.
  for (const side of [-1, 1]) {
    for (const [x0, x1] of [
      [5.8, 7.5],
      [11.0, 12.7],
      [16.2, 17.9],
    ]) {
      body.add(span(darkPaint, x0, x1, 0.6, DECK_BOTTOM, side * (HALF_WIDTH - 0.06), side * HALF_WIDTH));
    }
  }
  // Cab: boxy cab-over with a vertical windshield and side windows.
  const cabTop = 3.3;
  body.add(span(paint, CAB_REAR_X, FRONT_X, 0.9, cabTop, -HALF_WIDTH, HALF_WIDTH));
  body.add(span(darkPaint, CAB_REAR_X + 0.1, FRONT_X - 0.15, cabTop, cabTop + 0.12, -HALF_WIDTH + 0.15, HALF_WIDTH - 0.15)); // roof cap
  body.add(span(glass, FRONT_X, FRONT_X + 0.02, 2.35, 3.1, -1.55, 1.55)); // windshield
  for (const side of [-1, 1]) {
    body.add(span(glass, 22.0, 23.2, 2.4, 3.1, side * HALF_WIDTH, side * (HALF_WIDTH + 0.02)));
  }
  body.add(span(darkPaint, FRONT_X - 0.1, FRONT_X + 0.18, 0.65, 1.15, -HALF_WIDTH + 0.05, HALF_WIDTH - 0.05)); // bumper
  body.add(span(darkPaint, FRONT_X, FRONT_X + 0.03, 1.35, 2.15, -1.1, 1.1)); // grille
  // Hinge brackets at the rear.
  for (const side of [-1, 1]) body.add(span(darkPaint, PIVOT_X - 0.3, PIVOT_X + 0.3, DECK_TOP - 0.1, PIVOT_HEIGHT + 0.25, side * 1.25 - 0.15, side * 1.25 + 0.15));

  // ---- wheels (instanced: tyres and hubs)
  const tyreGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 22).rotateX(Math.PI / 2);
  const hubGeom = new THREE.CylinderGeometry(0.36, 0.36, WHEEL_WIDTH + 0.04, 12).rotateX(Math.PI / 2);
  const tyres = new THREE.InstancedMesh(tyreGeom, rubber, AXLES.length * 2);
  const hubs = new THREE.InstancedMesh(hubGeom, steel, AXLES.length * 2);
  tyres.name = 'launcher-tyres';
  hubs.name = 'launcher-hubs';
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const x of AXLES) {
      for (const side of [-1, 1]) {
        m.makeTranslation(x, WHEEL_RADIUS, side * (HALF_WIDTH - WHEEL_WIDTH / 2 - 0.02));
        tyres.setMatrixAt(i, m);
        hubs.setMatrixAt(i, m);
        i++;
      }
    }
    tyres.instanceMatrix.needsUpdate = true;
    hubs.instanceMatrix.needsUpdate = true;
    tyres.computeBoundingSphere();
    hubs.computeBoundingSphere();
  }
  body.add(tyres, hubs);

  // ---- erector: hinge group at the pivot; rotation.z = erect angle lifts +X toward +Y
  const hinge = new THREE.Group();
  hinge.name = 'launcher-hinge';
  hinge.position.set(PIVOT_X, PIVOT_HEIGHT, 0);
  body.add(hinge);

  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.8, 12).rotateX(Math.PI / 2), steel);
  hinge.add(pin);
  // Cradle beams and saddles.
  for (const side of [-1, 1]) hinge.add(span(darkPaint, -0.3, 17.0, -0.15, 0.18, side * 0.85 - 0.15, side * 0.85 + 0.15));
  for (const x of [1.5, 6.5, 11.5, 16.4]) hinge.add(span(darkPaint, x - 0.25, x + 0.25, 0.0, 0.42, -1.25, 1.25));

  // Canister: built along its own +Y (base at 0), turned so +Y runs along the cradle (+X).
  const canister = new THREE.Group();
  canister.name = 'launcher-canister';
  canister.rotation.z = -Math.PI / 2; // local +Y -> hinge +X, local -X -> hinge +Y
  canister.position.set(-BASE_OVERHANG, AXIS_OFFSET, 0);
  hinge.add(canister);
  const L = CANISTER_LENGTH;
  canister.add(new THREE.Mesh(new THREE.CylinderGeometry(CANISTER_OUTER, CANISTER_OUTER, L, 48, 1, true).translate(0, L / 2, 0), paint));
  canister.add(new THREE.Mesh(new THREE.CylinderGeometry(CANISTER_INNER, CANISTER_INNER, L, 48, 1, true).translate(0, L / 2, 0), interior));
  canister.add(new THREE.Mesh(new THREE.RingGeometry(CANISTER_INNER, CANISTER_OUTER, 48).rotateX(-Math.PI / 2).translate(0, L, 0), paint)); // open top rim
  canister.add(new THREE.Mesh(new THREE.CircleGeometry(CANISTER_OUTER, 48).rotateX(Math.PI / 2), darkPaint)); // closed base
  canister.add(new THREE.Mesh(new THREE.CircleGeometry(CANISTER_INNER, 48).rotateX(-Math.PI / 2).translate(0, 0.05, 0), rubber)); // floor
  for (const y of [1.2, 6.0, 11.0, 16.0, L - 0.6]) {
    canister.add(new THREE.Mesh(new THREE.CylinderGeometry(CANISTER_OUTER + 0.05, CANISTER_OUTER + 0.05, 0.35, 48, 1, true).translate(0, y, 0), darkPaint));
  }
  // Lid: hinged on the canister's local -X rim (the rear side when erect), opening away from the cab.
  const lidPivot = new THREE.Group();
  lidPivot.name = 'launcher-lid';
  lidPivot.position.set(-CANISTER_OUTER, L, 0);
  canister.add(lidPivot);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(CANISTER_OUTER + 0.04, CANISTER_OUTER + 0.04, 0.18, 48), paint);
  lid.position.set(CANISTER_OUTER, 0.09, 0);
  lidPivot.add(lid);
  lidPivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 10).rotateX(Math.PI / 2), steel)); // knuckle

  // ---- rams: telescopic, stages nested at the stowed length
  const rams = [];
  const stageGeoms = RAM_RADII.map((r) => new THREE.CylinderGeometry(r, r, 1, 12).translate(0, 0.5, 0));
  for (const side of [-1, 1]) {
    const stages = stageGeoms.map((g) => {
      const mesh = new THREE.Mesh(g, steel);
      body.add(mesh);
      return mesh;
    });
    const baseMount = span(darkPaint, RAM_BASE.x - 0.3, RAM_BASE.x + 0.3, RAM_BASE.y - 0.3, DECK_TOP + 0.02, side * RAM_Z - 0.22, side * RAM_Z + 0.22);
    body.add(baseMount);
    rams.push({ side, stages });
  }
  const _attach = new THREE.Vector3();
  const _base = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  function ramAttachPoint(angleRad, z, target) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return target.set(PIVOT_X + RAM_ATTACH.x * c - RAM_ATTACH.y * s, PIVOT_HEIGHT + RAM_ATTACH.x * s + RAM_ATTACH.y * c, z);
  }
  const stowedLength = ramAttachPoint(0, 0, new THREE.Vector3()).distanceTo(new THREE.Vector3(RAM_BASE.x, RAM_BASE.y, 0));
  function updateRams(angleRad) {
    const n = RAM_RADII.length;
    for (const ram of rams) {
      const z = ram.side * RAM_Z;
      _base.set(RAM_BASE.x, RAM_BASE.y, z);
      ramAttachPoint(angleRad, z, _attach);
      _dir.subVectors(_attach, _base);
      const len = _dir.length();
      _dir.divideScalar(len || 1);
      const stage = Math.min(stowedLength, len);
      const step = n > 1 ? Math.max(0, len - stage) / (n - 1) : 0;
      ram.stages.forEach((mesh, i) => {
        mesh.position.copy(_base).addScaledVector(_dir, i * step);
        mesh.quaternion.setFromUnitVectors(_yAxis, _dir);
        mesh.scale.set(1, stage, 1);
      });
    }
  }

  // ---- outriggers
  const outriggers = [];
  const jackGeom = new THREE.CylinderGeometry(0.12, 0.12, 1, 10).translate(0, -0.5, 0); // hangs down from y = 0
  const footGeom = new THREE.CylinderGeometry(0.35, 0.4, 0.08, 16);
  for (const x of OUTRIGGER_X) {
    for (const side of [-1, 1]) {
      const beam = box(OUTRIGGER_BEAM.size, OUTRIGGER_BEAM.size, OUTRIGGER_BEAM.length, darkPaint, x, OUTRIGGER_BEAM.y, 0);
      const housing = box(0.42, 0.5, 0.42, paint, 0, 0, 0);
      const jack = new THREE.Mesh(jackGeom, steel);
      const foot = new THREE.Mesh(footGeom, darkPaint);
      body.add(beam, housing, jack, foot);
      outriggers.push({ x, side, beam, housing, jack, foot });
    }
  }
  function updateOutriggers(k) {
    const slide = clamp01(k / 0.6);
    const drop = clamp01((k - 0.6) / 0.4);
    const half = OUTRIGGER_BEAM.length / 2;
    for (const o of outriggers) {
      const zc = o.side * (HALF_WIDTH - half + slide * OUTRIGGER_BEAM.travel);
      o.beam.position.z = zc;
      const zEnd = zc + o.side * (half - 0.21);
      const footY = OUTRIGGER_FOOT.retracted + (OUTRIGGER_FOOT.deployed - OUTRIGGER_FOOT.retracted) * drop;
      o.housing.position.set(o.x, OUTRIGGER_BEAM.y + 0.05, zEnd);
      o.jack.position.set(o.x, OUTRIGGER_BEAM.y, zEnd);
      o.jack.scale.set(1, Math.max(0.01, OUTRIGGER_BEAM.y - footY), 1);
      o.foot.position.set(o.x, footY, zEnd);
    }
  }

  updateRams(0);
  updateOutriggers(0);

  // Orientation scratch.
  const basis = new THREE.Matrix4();
  const fwd = new THREE.Vector3();
  const upV = new THREE.Vector3();
  const eastV = new THREE.Vector3();
  let lastAngle = NaN;
  let lastOut = NaN;

  return {
    object3d: root,
    update(state, origin) {
      if (!state || state.visible === false || !isVec3(state.position) || !isVec3(origin)) {
        root.visible = false;
        return;
      }
      const p = state.position;
      if (distanceFromOrigin(p, origin) > SHOW_WITHIN_KM) {
        root.visible = false;
        return;
      }
      root.visible = true;

      if (isDir(state.up) && isDir(state.north)) {
        upV.set(state.up.x, state.up.y, state.up.z).normalize();
        fwd.set(state.north.x, state.north.y, state.north.z);
        fwd.addScaledVector(upV, -fwd.dot(upV)).normalize();
      } else {
        upV.set(p.x, p.y, p.z).normalize();
        fwd.set(0, 1, 0).addScaledVector(upV, -upV.y);
        if (fwd.lengthSq() < 1e-12) fwd.set(1, 0, 0);
        fwd.normalize();
      }
      eastV.crossVectors(fwd, upV).normalize(); // north x up = east
      basis.makeBasis(fwd, upV, eastV);
      root.quaternion.setFromRotationMatrix(basis);
      // Origin-relative position in doubles, lifted onto the raised ground.
      const lift = GROUND_LIFT_M * M;
      root.position.set(p.x - origin.x + upV.x * lift, p.y - origin.y + upV.y * lift, p.z - origin.z + upV.z * lift);

      const angle = Math.min(90, Math.max(0, num(state.erectAngleDeg, 0))) * DEG;
      if (angle !== lastAngle) {
        hinge.rotation.z = angle;
        updateRams(angle);
        lastAngle = angle;
      }
      lidPivot.rotation.z = unit(state.lidOpen) * LID_MAX_DEG * DEG;
      const out = unit(state.outriggers);
      if (out !== lastOut) {
        updateOutriggers(out);
        lastOut = out;
      }
    },
  };
}
