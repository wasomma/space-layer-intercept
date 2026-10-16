import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { R_EARTH, OMEGA_EARTH, DEG } from '../src/shared/constants.js';
import {
  latLonToEcef,
  latLonToVector3,
  vector3ToLatLon,
  ecefToLatLonAlt,
  earthRotationAngle,
  ecefToEci,
  eciToEcef,
  siteVelocityEci,
  localFrameEci,
  localFrame,
  greatCircleDistance,
} from '../src/shared/geo.js';

test('latLonToEcef uses radius R_EARTH + alt and the Y-up convention', () => {
  const p = latLonToEcef(0, 0);
  assert.ok(p.distanceTo(new Vector3(0, 0, R_EARTH)) < 1e-9, 'lon 0 on +Z');
  assert.ok(latLonToEcef(0, 90).distanceTo(new Vector3(R_EARTH, 0, 0)) < 1e-9, 'lon 90 on +X');
  assert.ok(latLonToEcef(90, 0).distanceTo(new Vector3(0, R_EARTH, 0)) < 1e-9, 'north pole on +Y');
  assert.ok(Math.abs(latLonToEcef(50, 90, 1000).length() - (R_EARTH + 1000)) < 1e-9);
  const site = latLonToVector3(50, 90, R_EARTH);
  const back = vector3ToLatLon(site);
  assert.ok(Math.abs(back.lat - 50) < 1e-9 && Math.abs(back.lon - 90) < 1e-9);
});

test('ecefToLatLonAlt inverts latLonToEcef', () => {
  for (const [lat, lon, alt] of [
    [50, 90, 0],
    [-33.5, -70.25, 1196],
    [0, 179.5, 10000],
    [89.9, -45, 0.0018],
  ]) {
    const back = ecefToLatLonAlt(latLonToEcef(lat, lon, alt));
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat ${back.lat}`);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon ${back.lon}`);
    assert.ok(Math.abs(back.altKm - alt) < 1e-9, `alt ${back.altKm}`);
  }
});

test('ecefToEci then eciToEcef is the identity, and rotation is eastward', () => {
  const theta = earthRotationAngle(3600);
  assert.ok(Math.abs(theta - OMEGA_EARTH * 3600) < 1e-18);
  const p = latLonToEcef(50, 90, 12);
  const eci = ecefToEci(p, theta);
  const back = eciToEcef(eci, theta);
  assert.ok(back.distanceTo(p) < 1e-9, `round trip ${back.distanceTo(p)}`);
  assert.ok(Math.abs(eci.length() - p.length()) < 1e-9, 'rotation preserves length');
  assert.ok(Math.abs(eci.y - p.y) < 1e-12, 'rotation about Y keeps y');
  // A point at lon 0 (+Z) moves toward +X (east) with time.
  const e0 = ecefToEci(latLonToEcef(0, 0), 0.1);
  assert.ok(e0.x > 0 && e0.z > 0);
  const ll = vector3ToLatLon(e0);
  assert.ok(Math.abs(ll.lon - 0.1 / DEG) < 1e-9, 'longitude advanced by theta');
});

test('siteVelocityEci has magnitude OMEGA_EARTH * R_EARTH * cos(lat) and points east', () => {
  for (const lat of [0, 50, -30, 89]) {
    const r = latLonToEcef(lat, 90);
    const v = siteVelocityEci(r);
    const expected = OMEGA_EARTH * R_EARTH * Math.cos(lat * DEG);
    assert.ok(Math.abs(v.length() - expected) < 1e-12, `lat ${lat}: ${v.length()} vs ${expected}`);
    const { east } = localFrameEci(r);
    if (lat < 89) assert.ok(v.clone().normalize().distanceTo(east) < 1e-9, `east at lat ${lat}`);
    assert.ok(Math.abs(v.dot(r)) < 1e-9, 'tangential');
  }
  assert.ok(siteVelocityEci(new Vector3(0, R_EARTH, 0)).length() < 1e-15, 'zero at the pole');
});

test('localFrameEci is right-handed and agrees with localFrame(lat, lon)', () => {
  const r = latLonToEcef(50, 90);
  const f = localFrameEci(r);
  const g = localFrame(50, 90);
  for (const k of ['up', 'east', 'north']) {
    assert.ok(Math.abs(f[k].length() - 1) < 1e-12, `${k} unit`);
    assert.ok(f[k].distanceTo(g[k]) < 1e-12, `${k} agrees`);
  }
  assert.ok(new Vector3().crossVectors(f.east, f.north).distanceTo(f.up) < 1e-12, 'east x north = up');
  assert.ok(f.north.y > 0, 'north has a +Y component');
  assert.ok(Math.abs(f.up.dot(f.east)) < 1e-12 && Math.abs(f.up.dot(f.north)) < 1e-12);
});

test('greatCircleDistance of a quarter turn is pi R / 2', () => {
  const d = greatCircleDistance(latLonToEcef(0, 0), latLonToEcef(0, 90, 500));
  assert.ok(Math.abs(d - (Math.PI * R_EARTH) / 2) < 1e-9);
});
