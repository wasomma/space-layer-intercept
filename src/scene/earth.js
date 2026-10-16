// Earth: the v1 globe at true scale, radius R_EARTH km.
//
// createEarth() -> { object3d, update(state, origin) }
//   state:  states.earth ({ theta })
//   origin: the camera's ECI position this frame (km)
//
// Dark sphere in GLOBE, land outlines at R_EARTH * 1.0003 in LAND (world-atlas land only, no
// borders, nothing labelled), graticule every 15 degrees at R_EARTH * 1.0002 in GRATICULE, and a
// fresnel atmosphere back-side shell at R_EARTH * 1.012 in ATMOS. The group is placed at -origin
// (double subtraction, then upload) and rotated by theta about +Y, which is the ECEF -> ECI
// rotation of src/shared/geo.js; the terrain tile is added as a child by index.js.
//
// The graticule, land lines and atmosphere are hidden below 30 km camera altitude (the launch
// close-up) and fade in between 30 and 45 km so they do not pop during the boost follow shot.
//
// The atmosphere is the one custom shader in the scene; it declares the logarithmic-depth chunks
// so it depth-tests correctly against the log depth buffer.

import * as THREE from 'three';
import { mesh } from 'topojson-client';
import land from 'world-atlas/land-110m.json';
import { R_EARTH } from '../shared/constants.js';
import { latLonToVector3 } from '../shared/geo.js';
import { smoothstep } from '../shared/easing.js';
import { GLOBE, LAND, GRATICULE, ATMOS } from '../shared/palette.js';
import { num, isVec3 } from './util.js';

const LAND_RADIUS = R_EARTH * 1.0003;
const GRATICULE_RADIUS = R_EARTH * 1.0002;
const ATMOS_RADIUS = R_EARTH * 1.012;
// Long outline segments are split so their chords stay above the sphere surface (a 1 degree
// chord sags about 0.24 km below its ends at this radius).
const MAX_SEGMENT_DEG = 1;
const GRATICULE_STEP_DEG = 15;
const GRATICULE_SUBDIV_DEG = 1;

// Overlay fade by camera altitude (km): hidden below HIDE_BELOW, full above SHOW_ABOVE.
const HIDE_BELOW_KM = 30;
const SHOW_ABOVE_KM = 45;

const LAND_OPACITY = 0.7;
const GRATICULE_OPACITY = 1;
const ATMOS_STRENGTH = 0.55;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Push one segment between two [lon, lat] points, subdivided as needed. */
function pushSegment(out, lonA, latA, lonB, latB, radius, maxDeg) {
  const span = Math.max(Math.abs(lonB - lonA), Math.abs(latB - latA));
  const steps = Math.max(1, Math.ceil(span / maxDeg));
  latLonToVector3(latA, lonA, radius, _a);
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    latLonToVector3(latA + (latB - latA) * s, lonA + (lonB - lonA) * s, radius, _b);
    out.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
    _a.copy(_b);
  }
}

function buildLandPositions() {
  const out = [];
  const geo = mesh(land, land.objects.land); // GeoJSON MultiLineString
  const lines = geo && geo.type === 'MultiLineString' ? geo.coordinates : [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [lonA, latA] = line[i];
      const [lonB, latB] = line[i + 1];
      // Skip antimeridian wraps and the polygon cut that runs along the pole edge.
      if (Math.abs(lonB - lonA) > 180) continue;
      if (Math.abs(lonA) === 180 && Math.abs(lonB) === 180) continue;
      if (latA < -89.9 && latB < -89.9) continue;
      pushSegment(out, lonA, latA, lonB, latB, LAND_RADIUS, MAX_SEGMENT_DEG);
    }
  }
  return new Float32Array(out);
}

function buildGraticulePositions() {
  const out = [];
  const d = GRATICULE_SUBDIV_DEG;
  // Parallels every 15 degrees from -75 to 75.
  for (let lat = -90 + GRATICULE_STEP_DEG; lat < 90; lat += GRATICULE_STEP_DEG) {
    for (let lon = -180; lon < 180; lon += d) {
      pushSegment(out, lon, lat, lon + d, lat, GRATICULE_RADIUS, d);
    }
  }
  // Meridians every 15 degrees, pole to pole.
  for (let lon = -180; lon < 180; lon += GRATICULE_STEP_DEG) {
    for (let lat = -90; lat < 90; lat += d) {
      pushSegment(out, lon, lat, lon, lat + d, GRATICULE_RADIUS, d);
    }
  }
  return new Float32Array(out);
}

/** Fresnel rim on a back-side shell. Declares the logarithmic-depth chunks. */
function createAtmosphereMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(ATMOS) },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vP = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        #include <logdepthbuf_fragment>
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.5);
        gl_FragColor = vec4(uColor, f * ${ATMOS_STRENGTH.toFixed(3)} * uOpacity);
      }
    `,
  });
}

export function createEarth() {
  const group = new THREE.Group();
  group.name = 'earth';

  // Dark body. Lit lightly so the day side reads as a sphere; emissive keeps the night side off black.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH, 128, 96),
    new THREE.MeshStandardMaterial({
      color: GLOBE,
      emissive: GLOBE,
      emissiveIntensity: 0.9,
      roughness: 0.85,
      metalness: 0.0,
    })
  );
  sphere.name = 'earth-body';
  group.add(sphere);

  // Graticule.
  const gratGeom = new THREE.BufferGeometry();
  gratGeom.setAttribute('position', new THREE.BufferAttribute(buildGraticulePositions(), 3));
  const gratMat = new THREE.LineBasicMaterial({ color: GRATICULE, transparent: true, opacity: GRATICULE_OPACITY, depthWrite: false });
  const graticule = new THREE.LineSegments(gratGeom, gratMat);
  graticule.name = 'earth-graticule';
  group.add(graticule);

  // Land outlines.
  const landGeom = new THREE.BufferGeometry();
  landGeom.setAttribute('position', new THREE.BufferAttribute(buildLandPositions(), 3));
  const landMat = new THREE.LineBasicMaterial({ color: LAND, transparent: true, opacity: LAND_OPACITY, depthWrite: false });
  const landLines = new THREE.LineSegments(landGeom, landMat);
  landLines.name = 'earth-land';
  group.add(landLines);

  // Fresnel atmosphere rim (back side, so it shows outside the globe silhouette).
  const atmosMat = createAtmosphereMaterial();
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(ATMOS_RADIUS, 96, 64), atmosMat);
  atmosphere.name = 'earth-atmosphere';
  atmosphere.renderOrder = 1;
  group.add(atmosphere);

  return {
    object3d: group,
    update(state, origin) {
      if (isVec3(origin)) group.position.set(-origin.x, -origin.y, -origin.z);
      group.rotation.y = num(state && state.theta, 0);

      // Camera altitude above the sphere (the camera sits at the origin, i.e. at ECI `origin`).
      const alt = isVec3(origin) ? Math.hypot(origin.x, origin.y, origin.z) - R_EARTH : Infinity;
      const k = smoothstep(alt, HIDE_BELOW_KM, SHOW_ABOVE_KM);
      const show = k > 0.001;
      graticule.visible = landLines.visible = atmosphere.visible = show;
      gratMat.opacity = GRATICULE_OPACITY * k;
      landMat.opacity = LAND_OPACITY * k;
      atmosMat.uniforms.uOpacity.value = k;
    },
  };
}
