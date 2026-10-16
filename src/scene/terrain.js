// Terrain: the woodland tile at the launch site.
//
// createTerrain(site = { lat: 50, lon: 90 }) -> { object3d, update(state, origin) }
//   state:  states.earth ({ theta }), used only to measure the camera's distance to the site
//   origin: the camera's ECI position this frame (km)
//
// Built once in the site's ECEF frame and added by index.js as a child of the Earth group, so it
// rotates with the globe. The tile group sits at the site's ECEF position with a local basis
// X = east, Y = up, Z = south, and is scaled by 0.001 so everything inside is modelled in metres
// with small local coordinates: the floating origin then keeps the close-up exact (the group's
// world translation, R(theta) * rEcef - origin, is formed in doubles on the CPU).
//
// Contents, all from a seeded scatter (the same tile every run):
//   - ground disc, radius 5 km, procedural canvas grass texture, vertices lowered by
//     d^2 / (2 R_EARTH) so it hugs the sphere, raised 2 m above it
//   - a dark apron from 5 km to 40 km, same curvature, fading from GROUND to the globe's GLOBE
//     look so the launch close-up has a level horizon (the 128 x 96 globe facets sag up to
//     0.85 km below the true sphere and would otherwise show as a drop at the tile edge)
//   - about 600 conifers (two cones on a cylinder, 15 to 25 m) and 150 broadleaf trees
//     (icosahedron canopy, 10 to 16 m) outside a 60 m clearing, densest near the clearing
//   - about 2000 grass tufts (crossed alpha-tested quads, 0.6 m) within 300 m of the clearing
//   - a 6 m dirt track from the clearing edge north to the tile edge
//   - a trampled patch over the clearing
// The TEL faces north at the clearing centre (launcher.js), so the track leads away from its cab.
// A sight-line corridor toward the 5.7 Launch camera (120 m east, 50 m south of the site) is kept
// free of trees so tree crowns never block the close-up.
//
// Everything beyond SHOW_DETAIL_KM is hidden (trees, grass, track, patch) and the whole tile is
// hidden beyond SHOW_TILE_KM: from orbit it is sub-pixel.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { R_EARTH } from '../shared/constants.js';
import { latLonToEcef, localFrameEci, ecefToEci } from '../shared/geo.js';
import { smoothstep } from '../shared/easing.js';
import { GROUND, GLOBE, FOLIAGE, FOLIAGE_DARK, TRUNK, BG } from '../shared/palette.js';
import { isVec3, num, rng, M } from './util.js';

// Tile layout, metres.
const R_M = R_EARTH * 1000; // Earth radius in metres
const TILE_RADIUS = 5000;
const APRON_RADIUS = 40000;
/** The tile is raised this many metres (0.002 km) above the sphere; launcher.js stands on it. */
export const GROUND_LIFT_M = 2.0;
const CLEARING_RADIUS = 60;
const GRASS_RADIUS = CLEARING_RADIUS + 300;
const TRACK_WIDTH = 6;
const TRACK_LIFT = 0.15; // above the ground disc (log depth needs a geometric offset, not polygonOffset)
const PATCH_LIFT = 0.1;
const ANGULAR_SEGMENTS = 128; // shared by the disc edge and the apron's inner edge so they meet exactly
const TEXTURE_TILE_M = 30; // grass texture repeat

const CONIFERS = 600;
const BROADLEAF = 150;
const GRASS_TUFTS = 2000;
const TREE_SPREAD_M = 1400; // r = clearing + spread * u^TREE_BIAS
const TREE_BIAS = 2.0;
const TREE_MIN_SPACING = 7;
const TUFT_SIZE = 0.6;

// Sight line to the 5.7 Launch camera (site + east 0.12 km - north 0.05 km), extended past it.
const SIGHTLINE = { x: 120 * 1.4, z: 50 * 1.4, halfWidth: 22 };
// TEL footprint (launcher.js: faces north, hinge 1.85 m north of the site, 22 m long).
const TEL_BOX = { xMin: -3.5, xMax: 3.5, zMin: -25.5, zMax: 3 };

const SHOW_DETAIL_KM = 40;
const SHOW_TILE_KM = 300;

const SEED = 50090;

/** Ground height (metres, local Y) at horizontal distance d from the site: hugs the sphere. */
function groundY(d) {
  return -(d * d) / (2 * R_M) + GROUND_LIFT_M;
}

/** Track centre line: x (east) as a function of distance s north of the site. */
function trackX(s) {
  return 22 * Math.sin(s / 340) * smoothstep(s, 40, 400) + 9 * Math.sin(s / 97 + 1.3) * smoothstep(s, 60, 600);
}

// ---------------------------------------------------------------------------
// Canvas textures (palette colours only)

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function grassGroundTexture(random) {
  const size = 256;
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = GROUND;
  g.fillRect(0, 0, size, size);
  const speckles = [FOLIAGE, FOLIAGE_DARK, FOLIAGE, TRUNK];
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = 0.18 + 0.4 * random();
    g.fillStyle = speckles[Math.floor(random() * speckles.length)];
    const x = random() * size;
    const y = random() * size;
    const w = 1 + random() * 2.5;
    const h = 2 + random() * 5;
    g.fillRect(x, y, w, h);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function patchTexture(random) {
  const size = 256;
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  // Radial alpha so the patch blends into the grass.
  for (let i = 0; i < 1400; i++) {
    const a = random() * Math.PI * 2;
    const d = Math.sqrt(random()) * r * 0.98;
    g.globalAlpha = (0.12 + 0.3 * random()) * (1 - Math.pow(d / r, 3));
    g.fillStyle = random() < 0.6 ? TRUNK : GROUND;
    const s = 3 + random() * 9;
    g.beginPath();
    g.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, s, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function trackTexture() {
  const w = 64;
  const h = 128;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = TRUNK;
  g.fillRect(0, 0, w, h);
  // Two ruts and a grassy crown, edges softened toward the ground colour.
  g.globalAlpha = 0.35;
  g.fillStyle = BG;
  g.fillRect(w * 0.18, 0, w * 0.14, h);
  g.fillRect(w * 0.68, 0, w * 0.14, h);
  g.globalAlpha = 0.45;
  g.fillStyle = FOLIAGE_DARK;
  g.fillRect(w * 0.42, 0, w * 0.16, h);
  g.globalAlpha = 0.6;
  g.fillStyle = GROUND;
  g.fillRect(0, 0, w * 0.08, h);
  g.fillRect(w * 0.92, 0, w * 0.08, h);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function tuftTexture(random) {
  const size = 64;
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const blades = [FOLIAGE, FOLIAGE_DARK, FOLIAGE, GROUND];
  for (let i = 0; i < 16; i++) {
    const x = size * (0.12 + 0.76 * random());
    const lean = (random() - 0.5) * size * 0.35;
    const top = size * (0.05 + 0.4 * random());
    const w = 1.5 + random() * 2.5;
    g.fillStyle = blades[Math.floor(random() * blades.length)];
    g.beginPath();
    g.moveTo(x - w, size);
    g.lineTo(x + w, size);
    g.lineTo(x + lean, top);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radial ramp for the apron's emissive map: black at the inner edge, white at the outer. */
function apronEmissiveTexture() {
  const c = canvas(64, 4);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgb(0,0,0)');
  grad.addColorStop(0.45, 'rgb(150,150,150)');
  grad.addColorStop(1, 'rgb(255,255,255)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry builders

/** Polar ground disc: a centre vertex plus rings, lowered to hug the sphere. */
function buildGroundDisc(random) {
  const rings = 56;
  const radii = [];
  for (let i = 1; i <= rings; i++) radii.push(TILE_RADIUS * Math.pow(i / rings, 1.7));
  const positions = [0, groundY(0), 0];
  const uvs = [0, 0];
  const colors = [1, 1, 1];
  // Low-frequency brightness patches from a few random sinusoids.
  const waves = [];
  for (let i = 0; i < 6; i++) {
    waves.push({ kx: (random() - 0.5) / 120, kz: (random() - 0.5) / 120, ph: random() * 6.28, a: 0.06 + 0.06 * random() });
  }
  const patch = (x, z) => {
    let v = 1;
    for (const w of waves) v += w.a * Math.sin(x * w.kx * 6.28 + z * w.kz * 6.28 + w.ph);
    return v;
  };
  for (const r of radii) {
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const a = (j / ANGULAR_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      positions.push(x, groundY(r), z);
      uvs.push(x / TEXTURE_TILE_M, z / TEXTURE_TILE_M);
      const k = patch(x, z);
      colors.push(k, k, k);
    }
  }
  const index = [];
  // Centre fan.
  for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % ANGULAR_SEGMENTS);
    index.push(0, b, a);
  }
  // Ring strips.
  for (let i = 0; i < rings - 1; i++) {
    const r0 = 1 + i * ANGULAR_SEGMENTS;
    const r1 = 1 + (i + 1) * ANGULAR_SEGMENTS;
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const j1 = (j + 1) % ANGULAR_SEGMENTS;
      index.push(r0 + j, r0 + j1, r1 + j);
      index.push(r0 + j1, r1 + j1, r1 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Annulus from the tile edge to APRON_RADIUS; uv.x is the radial fraction (emissive ramp). */
function buildApron() {
  const rings = 28;
  const positions = [];
  const uvs = [];
  const colors = [];
  const cIn = new THREE.Color(GROUND);
  const cOut = new THREE.Color(GLOBE);
  const c = new THREE.Color();
  for (let i = 0; i <= rings; i++) {
    const r = TILE_RADIUS * Math.pow(APRON_RADIUS / TILE_RADIUS, i / rings);
    const f = (r - TILE_RADIUS) / (APRON_RADIUS - TILE_RADIUS);
    c.copy(cIn).lerp(cOut, smoothstep(f, 0, 0.6));
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const a = (j / ANGULAR_SEGMENTS) * Math.PI * 2;
      positions.push(Math.cos(a) * r, groundY(r), Math.sin(a) * r);
      uvs.push(f, 0.5);
      colors.push(c.r, c.g, c.b);
    }
  }
  const index = [];
  for (let i = 0; i < rings; i++) {
    const r0 = i * ANGULAR_SEGMENTS;
    const r1 = (i + 1) * ANGULAR_SEGMENTS;
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const j1 = (j + 1) % ANGULAR_SEGMENTS;
      index.push(r0 + j, r0 + j1, r1 + j);
      index.push(r0 + j1, r1 + j1, r1 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Ribbon along the track centre line from the clearing edge to the tile edge. */
function buildTrack() {
  const positions = [];
  const uvs = [];
  const half = TRACK_WIDTH / 2;
  const sEnd = TILE_RADIUS - 30;
  const samples = [];
  for (let s = CLEARING_RADIUS - 8; s < 600; s += 4) samples.push(s);
  for (let s = 600; s < sEnd; s += 25) samples.push(s);
  samples.push(sEnd);
  for (const s of samples) {
    const x = trackX(s);
    const dx = (trackX(s + 0.5) - trackX(s - 0.5)) / 1; // d x / d s
    // Direction of travel in local XZ: (dx, -1) (north is -Z); left/right normal.
    const len = Math.hypot(dx, 1);
    const nx = 1 / len;
    const nz = dx / len;
    for (const side of [-1, 1]) {
      const px = x + side * half * nx;
      const pz = -s + side * half * nz;
      positions.push(px, groundY(Math.hypot(px, pz)) + TRACK_LIFT, pz);
      uvs.push(side < 0 ? 0 : 1, s / 12);
    }
  }
  const index = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // counter-clockwise from above: faces +Y
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Trampled patch over the clearing. */
function buildPatch() {
  const segs = 64;
  const radius = CLEARING_RADIUS + 4;
  const positions = [0, groundY(0) + PATCH_LIFT, 0];
  const uvs = [0.5, 0.5];
  for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    positions.push(x, groundY(radius) + PATCH_LIFT, z);
    uvs.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
  }
  const index = [];
  for (let j = 0; j < segs; j++) index.push(0, 1 + ((j + 1) % segs), 1 + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Unit-height conifer: trunk and a two-tier canopy, base at y = 0. */
function coniferGeometries() {
  const trunk = new THREE.CylinderGeometry(0.012, 0.018, 0.3, 5).translate(0, 0.15, 0);
  const lower = new THREE.ConeGeometry(0.21, 0.62, 7).translate(0, 0.15 + 0.31, 0);
  const upper = new THREE.ConeGeometry(0.15, 0.5, 7).translate(0, 0.5 + 0.25, 0);
  const canopy = mergeGeometries([lower, upper]);
  lower.dispose();
  upper.dispose();
  return { trunk, canopy };
}

/** Unit-height broadleaf: trunk and an icosahedron crown, base at y = 0. */
function broadleafGeometries() {
  const trunk = new THREE.CylinderGeometry(0.02, 0.03, 0.5, 5).translate(0, 0.25, 0);
  const canopy = new THREE.IcosahedronGeometry(0.32, 1).scale(1, 0.85, 1).translate(0, 0.66, 0);
  return { trunk, canopy };
}

/** Crossed quads, base at y = 0, normals straight up so the tuft lights like the ground. */
function tuftGeometry() {
  const a = new THREE.PlaneGeometry(TUFT_SIZE, TUFT_SIZE).translate(0, TUFT_SIZE / 2, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const g = mergeGeometries([a, b]);
  a.dispose();
  b.dispose();
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Scatter

/** Distance from (x, z) to the segment from (0, 0) to (sx, sz). */
function distToSegment(x, z, sx, sz) {
  const len2 = sx * sx + sz * sz;
  const t = Math.max(0, Math.min(1, (x * sx + z * sz) / len2));
  return Math.hypot(x - sx * t, z - sz * t);
}

function nearTrack(x, z, margin) {
  const s = -z;
  if (s < CLEARING_RADIUS - 10) return false;
  return Math.abs(x - trackX(s)) < TRACK_WIDTH / 2 + margin;
}

function inTelBox(x, z, pad = 0) {
  return x > TEL_BOX.xMin - pad && x < TEL_BOX.xMax + pad && z > TEL_BOX.zMin - pad && z < TEL_BOX.zMax + pad;
}

function scatterTrees(random, count) {
  const cell = TREE_MIN_SPACING;
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  const out = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 60) {
    attempts++;
    const a = random() * Math.PI * 2;
    const r = CLEARING_RADIUS + 4 + TREE_SPREAD_M * Math.pow(random(), TREE_BIAS);
    if (r > TILE_RADIUS - 20) continue;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (nearTrack(x, z, 5)) continue;
    if (distToSegment(x, z, SIGHTLINE.x, SIGHTLINE.z) < SIGHTLINE.halfWidth) continue;
    const ci = Math.floor(x / cell);
    const cj = Math.floor(z / cell);
    let clash = false;
    for (let di = -1; di <= 1 && !clash; di++) {
      for (let dj = -1; dj <= 1 && !clash; dj++) {
        const bucket = grid.get(key(ci + di, cj + dj));
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.hypot(p.x - x, p.z - z) < TREE_MIN_SPACING) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    const p = { x, z, r };
    const k = key(ci, cj);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
    out.push(p);
  }
  return out;
}

function scatterTufts(random, count) {
  const out = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 20) {
    attempts++;
    const a = random() * Math.PI * 2;
    const r = GRASS_RADIUS * Math.pow(random(), 0.75);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (inTelBox(x, z, 0.5)) continue;
    if (nearTrack(x, z, -0.5)) continue;
    out.push({ x, z, r });
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createTerrain(site = { lat: 50, lon: 90 }) {
  const lat = num(site && site.lat, 50);
  const lon = num(site && site.lon, 90);
  const random = rng(SEED);

  const root = new THREE.Group();
  root.name = 'terrain';

  // Site frame: X = east, Y = up, Z = south (east x up = -north, so the basis is right-handed).
  const rEcef = latLonToEcef(lat, lon, 0);
  const { up, east, north } = localFrameEci(rEcef);
  const south = north.clone().negate();
  root.position.copy(rEcef);
  root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
  root.scale.setScalar(M); // children in metres

  // Ground disc.
  const groundTex = grassGroundTexture(random);
  const ground = new THREE.Mesh(
    buildGroundDisc(random),
    new THREE.MeshStandardMaterial({ map: groundTex, vertexColors: true, roughness: 1, metalness: 0 })
  );
  ground.name = 'terrain-ground';
  root.add(ground);

  // Apron to the horizon, matching the globe's material at its outer edge.
  const apron = new THREE.Mesh(
    buildApron(),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      emissive: GLOBE,
      emissiveIntensity: 0.9,
      emissiveMap: apronEmissiveTexture(),
      roughness: 0.95,
      metalness: 0,
    })
  );
  apron.name = 'terrain-apron';
  root.add(apron);

  const detail = new THREE.Group();
  detail.name = 'terrain-detail';
  root.add(detail);

  // Clearing patch.
  const patch = new THREE.Mesh(
    buildPatch(),
    new THREE.MeshStandardMaterial({ map: patchTexture(random), transparent: true, depthWrite: false, roughness: 1, metalness: 0 })
  );
  patch.name = 'terrain-clearing';
  patch.renderOrder = -0.5;
  detail.add(patch);

  // Dirt track.
  const track = new THREE.Mesh(
    buildTrack(),
    new THREE.MeshStandardMaterial({ map: trackTexture(), roughness: 1, metalness: 0 })
  );
  track.name = 'terrain-track';
  detail.add(track);

  // Trees.
  const canopyA = new THREE.Color(FOLIAGE);
  const canopyB = new THREE.Color(FOLIAGE_DARK);
  const trunkC = new THREE.Color(TRUNK);
  const tmpC = new THREE.Color();
  const trunkTint = new THREE.Color();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s3 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  const spots = scatterTrees(random, CONIFERS + BROADLEAF);
  // Broadleaf trees are mixed in nearer the clearing; conifers dominate farther out.
  const broadIdx = new Set();
  const byRadius = spots.map((p, i) => ({ i, r: p.r })).sort((a, b) => a.r - b.r);
  for (const { i } of byRadius) {
    if (broadIdx.size >= BROADLEAF) break;
    if (random() < 0.45) broadIdx.add(i);
  }

  const treeMat = () => new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
  const conifer = coniferGeometries();
  const broad = broadleafGeometries();
  const nConifer = spots.length - broadIdx.size;
  const coniferTrunks = new THREE.InstancedMesh(conifer.trunk, treeMat(), Math.max(1, nConifer));
  const coniferCrowns = new THREE.InstancedMesh(conifer.canopy, treeMat(), Math.max(1, nConifer));
  const broadTrunks = new THREE.InstancedMesh(broad.trunk, treeMat(), Math.max(1, broadIdx.size));
  const broadCrowns = new THREE.InstancedMesh(broad.canopy, treeMat(), Math.max(1, broadIdx.size));
  coniferTrunks.name = 'terrain-conifer-trunks';
  coniferCrowns.name = 'terrain-conifer-crowns';
  broadTrunks.name = 'terrain-broadleaf-trunks';
  broadCrowns.name = 'terrain-broadleaf-crowns';
  let ci = 0;
  let bi = 0;
  spots.forEach((p, i) => {
    const isBroad = broadIdx.has(i);
    const h = isBroad ? 10 + 6 * random() : 15 + 10 * random();
    const w = 0.85 + 0.3 * random();
    q.setFromAxisAngle(yAxis, random() * Math.PI * 2);
    p3.set(p.x, groundY(p.r) - 0.3, p.z); // sunk slightly so no root floats on the curvature
    s3.set(h * w, h, h * w);
    m4.compose(p3, q, s3);
    tmpC.copy(canopyA).lerp(canopyB, random()).multiplyScalar(0.85 + 0.3 * random());
    trunkTint.copy(trunkC).multiplyScalar(0.8 + 0.3 * random());
    if (isBroad) {
      broadTrunks.setMatrixAt(bi, m4);
      broadCrowns.setMatrixAt(bi, m4);
      broadCrowns.setColorAt(bi, tmpC);
      broadTrunks.setColorAt(bi, trunkTint);
      bi++;
    } else {
      coniferTrunks.setMatrixAt(ci, m4);
      coniferCrowns.setMatrixAt(ci, m4);
      coniferCrowns.setColorAt(ci, tmpC);
      coniferTrunks.setColorAt(ci, trunkTint);
      ci++;
    }
  });
  coniferTrunks.count = coniferCrowns.count = ci;
  broadTrunks.count = broadCrowns.count = bi;
  for (const im of [coniferTrunks, coniferCrowns, broadTrunks, broadCrowns]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    detail.add(im);
  }

  // Grass tufts.
  const tufts = scatterTufts(random, GRASS_TUFTS);
  const tuftMesh = new THREE.InstancedMesh(
    tuftGeometry(),
    new THREE.MeshStandardMaterial({ map: tuftTexture(random), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0 }),
    Math.max(1, tufts.length)
  );
  tuftMesh.name = 'terrain-grass';
  tufts.forEach((p, i) => {
    const k = 0.7 + 0.7 * random();
    q.setFromAxisAngle(yAxis, random() * Math.PI);
    p3.set(p.x, groundY(p.r) - 0.05, p.z);
    s3.set(k, k * (0.8 + 0.4 * random()), k);
    m4.compose(p3, q, s3);
    tuftMesh.setMatrixAt(i, m4);
    tmpC.setRGB(1, 1, 1).multiplyScalar(0.8 + 0.4 * random());
    tuftMesh.setColorAt(i, tmpC);
  });
  tuftMesh.count = tufts.length;
  tuftMesh.instanceMatrix.needsUpdate = true;
  if (tuftMesh.instanceColor) tuftMesh.instanceColor.needsUpdate = true;
  tuftMesh.computeBoundingSphere();
  detail.add(tuftMesh);

  const siteEci = new THREE.Vector3();

  return {
    object3d: root,
    /** Exposed for checks and the dev harness. */
    stats: { conifers: ci, broadleaf: bi, tufts: tufts.length },
    update(state, origin) {
      if (!isVec3(origin)) return;
      const theta = num(state && state.theta, 0);
      ecefToEci(rEcef, theta, siteEci);
      const distKm = Math.hypot(siteEci.x - origin.x, siteEci.y - origin.y, siteEci.z - origin.z);
      root.visible = distKm < SHOW_TILE_KM;
      detail.visible = distKm < SHOW_DETAIL_KM;
    },
  };
}
