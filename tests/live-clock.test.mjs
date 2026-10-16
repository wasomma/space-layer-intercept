import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClock } from '../src/live/clock.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('waiting, then standby, until a launch arrives', () => {
  const c = createLiveClock();
  assert.equal(c.status(0), 'waiting');
  assert.equal(c.hostTime(0), null);
  assert.equal(c.simT(0), null);
  c.receive({ type: 'clock', hostTime: 100, rate: 1, paused: false }, 10);
  assert.equal(c.status(10), 'standby');
  assert.ok(near(c.hostTime(10.5), 100.5));
  assert.equal(c.simT(10.5), null);
});

test('simT counts from the ignition host time, through a countdown', () => {
  const c = createLiveClock();
  c.receive({ type: 'clock', hostTime: 100, rate: 1, paused: false }, 0);
  c.receive({ type: 'launch', ignitionHostTime: 110 }, 0);
  assert.ok(near(c.simT(0), -10));
  assert.equal(c.status(0), 'countdown');
  assert.ok(near(c.simT(2), -8));
  c.receive({ type: 'clock', hostTime: 112, rate: 1, paused: false }, 12);
  assert.equal(c.status(12), 'live');
  assert.ok(near(c.simT(12.25), 2.25));
});

test('the host rate scales the extrapolation, and pause holds the time', () => {
  const c = createLiveClock();
  c.receive({ type: 'launch', ignitionHostTime: 0 }, 0);
  c.receive({ type: 'clock', hostTime: 10, rate: 4, paused: false }, 0);
  assert.ok(near(c.simT(0.5), 12));
  assert.equal(c.rate(0.5), 4);
  c.receive({ type: 'clock', hostTime: 12, rate: 0, paused: true }, 0.5);
  assert.equal(c.status(1), 'paused');
  assert.ok(near(c.simT(3), 12));
  assert.equal(c.rate(3), 0);
});

test('extrapolation stops after lostAfter seconds and the status turns lost', () => {
  const c = createLiveClock({ lostAfter: 5 });
  c.receive({ type: 'launch', ignitionHostTime: 0 }, 0);
  c.receive({ type: 'clock', hostTime: 20, rate: 1, paused: false }, 0);
  assert.equal(c.status(4.9), 'live');
  assert.equal(c.status(5.1), 'lost');
  assert.ok(near(c.simT(60), 25));
  assert.equal(c.rate(60), 0);
});

test('small backward steps are held, large jumps pass', () => {
  const c = createLiveClock();
  c.receive({ type: 'launch', ignitionHostTime: 0 }, 0);
  c.receive({ type: 'clock', hostTime: 10, rate: 1, paused: false }, 0);
  assert.ok(near(c.simT(1), 11));
  // A late clock message: host 10.9 at wall 1.0 would step back 0.1 s.
  c.receive({ type: 'clock', hostTime: 10.9, rate: 1, paused: false }, 1);
  assert.ok(near(c.simT(1), 11), 'held');
  assert.ok(near(c.simT(1.2), 11.1), 'resumes once past the held time');
  // A host-side jump back (a restart) passes straight through.
  c.receive({ type: 'clock', hostTime: 2, rate: 1, paused: false }, 2);
  assert.ok(near(c.simT(2), 2));
});

test('reset returns to standby; malformed messages are ignored', () => {
  const c = createLiveClock();
  c.receive({ type: 'clock', hostTime: 5, rate: 1, paused: false }, 0);
  c.receive({ type: 'launch', ignitionHostTime: 0 }, 0);
  assert.equal(c.status(0), 'live');
  c.receive({ type: 'reset' }, 0);
  assert.equal(c.status(0), 'standby');
  assert.equal(c.launch(), null);
  c.receive(null, 0);
  c.receive({ type: 'clock', hostTime: 'x' }, 0);
  c.receive({ type: 'launch' }, 0);
  c.receive({ type: 'state', t: 3 }, 0);
  assert.equal(c.status(0), 'standby');
  assert.ok(near(c.hostTime(0), 5));
});
