// Dev harness for the HUD, served at /dev/hud.html by the dev server.
//
// A fake clock ticks animation time 0..90 (looping) and feeds hud.update() every animation frame
// with the fields src/main.js passes: t, simT, warp, beatId, playing, speed, freeCam, readouts.
// simT and warp come from a hand-authored beat table (the fixed animation boundaries of 5.6 with
// plausible simulation anchors) and the readouts (5.10) from a fake trajectory, so the clock, the
// warp badge, the event stamps and the readout rows all change over the run. The harness does
// not import src/sim/, so it works whatever state the scenario is in. Every number below is a
// placeholder for the picture (illustrative), not an output of the model.
//
// The harness honours the HUD's callbacks (play, pause, seek, speed, jumpBeat, toggleFreeCam,
// replay), so the transport, scrubber, event log, summary card and keyboard shortcuts can be
// exercised without the 3D scene. Every emitted callback is logged to the console and appended
// to window.__hudHarness.emitted.
//
// Query parameters:
//   ?t=<seconds>   start animation time (default 0)
//   ?paused=1      start paused
//   ?speed=<s>     start speed (0.5, 1 or 2)
//   ?freecam=1     start with the fake free-cam flag on
//   ?labels=0      hide the .viz-label style samples
//   ?bare=1        update() gets only the v1 fields (t, beatId, playing, speed, freeCam): the HUD
//                  derives simT and warp from the beats, and the readouts panel stays hidden
//   ?bare=2        as bare=1, and the beats and events also lack their simulation anchors: the
//                  clock and stamps show T+--:-- and the warp badge is hidden

import { createHud } from '../src/hud/index.js';

const params = new URLSearchParams(window.location.search);
const bare = Number(params.get('bare')) || 0;
const DURATION = 90;

// ---- fake scenario (simulation seconds from ignition; illustrative placeholders) ------------

const KEY = {
  detect: 34,
  track: 49,
  link1: 69,
  link2: 89,
  assign: 109,
  burnout: 180,
  release: 310,
  intercept: 820,
};
const DELTA_V_KMS = 1.62; // illustrative
const CLOSING_KMS = 4.8; // illustrative

// The fixed animation boundaries with simulation anchors from KEY.
const BEATS = [
  { id: 'establishing', label: 'Constellation', start: 0, end: 10, simStart: -60, simEnd: -4 },
  { id: 'launch', label: 'Launch', start: 10, end: 24, simStart: -4, simEnd: 10 },
  { id: 'boost', label: 'Boost and acquisition', start: 24, end: 38, simStart: 10, simEnd: KEY.track + 20 },
  { id: 'handoff', label: 'Handoff', start: 38, end: 50, simStart: KEY.track + 20, simEnd: KEY.assign + 10 },
  { id: 'engage', label: 'Engage', start: 50, end: 72, simStart: KEY.assign + 10, simEnd: KEY.intercept - 8 },
  { id: 'intercept', label: 'Intercept', start: 72, end: 84, simStart: KEY.intercept - 8, simEnd: KEY.intercept + 4 },
  { id: 'resolution', label: 'Resolution', start: 84, end: 90, simStart: KEY.intercept + 4, simEnd: KEY.intercept + 900 },
].map((b) => ({ ...b, warp: (b.simEnd - b.simStart) / (b.end - b.start) }));

function beatAt(animT) {
  let beat = BEATS[0];
  for (const b of BEATS) if (b.start <= animT) beat = b;
  return beat;
}

function animToSim(animT) {
  const b = beatAt(animT);
  return b.simStart + (animT - b.start) * b.warp;
}

function simToAnim(simT) {
  if (simT <= BEATS[0].simStart) return BEATS[0].start;
  for (const b of BEATS) {
    if (simT >= b.simStart && simT < b.simEnd) return b.start + (simT - b.simStart) / b.warp;
  }
  return BEATS[BEATS.length - 1].end;
}

function mmss(secs) {
  const s = Math.max(0, Math.ceil(secs - 1e-6));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Simulation-time events, mapped to animation time as timeline.js does.
const SIM_EVENTS = [
  { t: -60, text: 'Constellation nominal' },
  { t: -10, text: 'Launcher erected' },
  { t: -0.5, text: 'Canister open' },
  { t: 0, text: 'Ignition' },
  { t: KEY.detect, text: 'Sensor sat: launch detected' },
  { t: KEY.track, text: 'Track established' },
  { t: KEY.link1, text: 'Handoff to relay' },
  { t: KEY.link2, text: 'Handoff to interceptor sat' },
  { t: KEY.assign, text: `Solution: dV ${DELTA_V_KMS.toFixed(2)} km/s, intercept T+${mmss(KEY.intercept)}` },
  { t: KEY.burnout, text: 'Burnout' },
  { t: KEY.release, text: 'Interceptor released' },
  { t: KEY.intercept, text: 'Intercept' },
  { t: KEY.intercept + 4, text: 'Engagement complete' },
];
const EVENTS = SIM_EVENTS.map((e) => ({ t: simToAnim(e.t), simT: e.t, text: e.text }));

// Fake threat trajectory: a quadratic climb to 260 km at burnout, then a parabolic coast toward a
// 1250 km apogee; speed rises to 6.9 km/s at burnout and bleeds off with altitude in the coast.
function threatAltKm(simT) {
  if (simT <= KEY.burnout) return 260 * (simT / KEY.burnout) ** 2;
  const u = (1050 - simT) / (1050 - KEY.burnout);
  return 1250 - (1250 - 260) * u * u;
}

function threatSpeedKms(simT) {
  if (simT <= KEY.burnout) return 0.4 + 6.5 * (simT / KEY.burnout) ** 1.5;
  return Math.sqrt(Math.max(0, 6.9 * 6.9 - 0.017 * (threatAltKm(simT) - 260)));
}

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Readout rows of 5.10, present only when meaningful, as preformatted strings. */
function readoutsAt(simT) {
  if (simT < 0 || simT >= KEY.intercept) return [];
  const rows = [
    { id: 'threatAlt', label: 'THREAT ALT', value: `${intFormat.format(threatAltKm(simT))} km` },
    { id: 'threatSpd', label: 'THREAT SPD', value: `${threatSpeedKms(simT).toFixed(2)} km/s` },
    { id: 'phase', label: 'PHASE', value: simT < KEY.burnout ? 'BOOST' : 'COAST' },
  ];
  if (simT >= KEY.assign) rows.push({ id: 'kvDv', label: 'KV dV', value: `${DELTA_V_KMS.toFixed(2)} km/s` });
  if (simT >= KEY.release) {
    rows.push({ id: 'kvTtg', label: 'KV TTG', value: mmss(KEY.intercept - simT) });
    rows.push({ id: 'closing', label: 'CLOSING', value: `${CLOSING_KMS.toFixed(1)} km/s` });
  }
  return rows;
}

// ---- fake clock ------------------------------------------------------------------------------

function wrap(t) {
  if (!Number.isFinite(t)) return 0;
  const m = t % DURATION;
  return m < 0 ? m + DURATION : m;
}

const clock = {
  t: wrap(Number(params.get('t') ?? 0)),
  playing: params.get('paused') !== '1',
  speed: Number(params.get('speed')) > 0 ? Number(params.get('speed')) : 1,
  freeCam: params.get('freecam') === '1',
};

function seek(t) {
  clock.t = wrap(Number(t));
}
function play() {
  clock.playing = true;
}
function pause() {
  clock.playing = false;
}
function setSpeed(s) {
  clock.speed = Number.isFinite(s) && s > 0 ? s : 1;
}
function setFreeCam(on) {
  clock.freeCam = Boolean(on);
}

function stateAt(t) {
  const beat = beatAt(t);
  const simT = animToSim(t);
  return {
    t,
    simT,
    warp: beat.warp,
    beatId: beat.id,
    playing: clock.playing,
    speed: clock.speed,
    freeCam: clock.freeCam,
    readouts: readoutsAt(simT),
  };
}

// ---- HUD -------------------------------------------------------------------------------------

const hudBeats =
  bare >= 2 ? BEATS.map(({ id, label, start, end }) => ({ id, label, start, end })) : BEATS;
const hudEvents = bare >= 2 ? EVENTS.map(({ t, text }) => ({ t, text })) : EVENTS;

const hud = createHud({
  root: document.getElementById('hud'),
  beats: hudBeats,
  duration: DURATION,
  events: hudEvents,
});

const emitted = [];
const counts = {};

function record(name, args) {
  const entry = { name, args, t: clock.t, at: performance.now() };
  emitted.push(entry);
  if (emitted.length > 500) emitted.shift();
  console.log(`[hud] ${name}`, ...args, `(at t=${clock.t.toFixed(2)})`);
}

// First listener per name: log it. Second listener per name: count it. Two listeners on every
// name exercise the HUD's support for several callbacks under one name.
const NAMES = ['play', 'pause', 'seek', 'speed', 'jumpBeat', 'toggleFreeCam', 'replay'];
for (const name of NAMES) {
  counts[name] = 0;
  hud.on(name, (...args) => record(name, args));
  hud.on(name, () => {
    counts[name] += 1;
  });
}

hud.on('play', play);
hud.on('pause', pause);
hud.on('seek', (t) => seek(t));
hud.on('speed', (s) => setSpeed(s));
hud.on('jumpBeat', (id) => {
  const beat = BEATS.find((b) => b.id === id);
  if (beat) seek(beat.start);
});
hud.on('toggleFreeCam', () => setFreeCam(!clock.freeCam));
hud.on('replay', () => {
  seek(0);
  play();
});

// ---- .viz-label samples ----------------------------------------------------------------------
// Emulates CSS2DRenderer placement (translate(-50%, -50%) translate(x px, y px) on an
// absolutely positioned element) so the label style can be checked without three.js.

const SAMPLES = [
  { text: 'SENSOR SAT', modifier: 'sensor' },
  { text: 'RELAY', modifier: 'relay' },
  { text: 'INTERCEPTOR SAT', modifier: 'interceptor-sat' },
  { text: 'TARGET ASSIGNED', modifier: 'interceptor-sat' },
  { text: 'INTERCEPTOR', modifier: 'interceptor' },
  { text: 'INTERCEPT', modifier: null },
  { text: 'THREAT', modifier: 'threat' },
  { text: 'TRACK', modifier: 'sensor' },
  { text: 'MOBILE LAUNCHER', modifier: null },
  { text: 'LINK SAMPLE', modifier: 'link' },
];

const labelLayer = document.getElementById('labels');
const samples = [];

function placeSamples() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const r = Math.min(w, h) * 0.3;
  samples.forEach(({ anchor, label }, i) => {
    // Spread around the stand-in globe's rim, upper half first.
    const angle = Math.PI * (1.08 + (0.84 * i) / Math.max(1, samples.length - 1));
    const x = w / 2 + Math.cos(angle) * r * 1.15;
    const y = h / 2 + Math.sin(angle) * r * 1.05;
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    label.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  });
}

if (params.get('labels') !== '0') {
  for (const sample of SAMPLES) {
    const anchor = document.createElement('div');
    anchor.className = 'harness-anchor';
    const label = document.createElement('div');
    label.className = sample.modifier ? `viz-label viz-label--${sample.modifier}` : 'viz-label';
    label.textContent = sample.text;
    label.style.position = 'absolute';
    labelLayer.append(anchor, label);
    samples.push({ anchor, label });
  }
  placeSamples();
  window.addEventListener('resize', placeSamples);
}

// ---- frame loop ------------------------------------------------------------------------------

let lastNow = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  if (clock.playing) clock.t = wrap(clock.t + dt * clock.speed);

  const state = stateAt(clock.t);
  if (bare) {
    const { t, beatId, playing, speed, freeCam } = state;
    hud.update({ t, beatId, playing, speed, freeCam });
  } else {
    hud.update(state);
  }
}
requestAnimationFrame(frame);

// ---- verification hooks ----------------------------------------------------------------------

window.__hudHarness = {
  seek,
  t: () => clock.t,
  simT: () => animToSim(clock.t),
  play,
  pause,
  setSpeed,
  freeCam: setFreeCam,
  state: () => stateAt(clock.t),
  beats: BEATS,
  events: EVENTS,
  emitted,
  counts,
  hud,
};
