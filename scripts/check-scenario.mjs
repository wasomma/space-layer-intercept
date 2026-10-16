// Samples the simulation under Node and asserts it is sane. Run with `npm run check`.
// The scenario assertions, one line per assertion, then the scenario summary
// (tuned values and search results). Exits non-zero on any failure.

import { buildScenario, createSimulation, TOTAL_DURATION, KEY_TIMES, propagateKepler, segmentClearsSphere } from '../src/sim/index.js';
import { transferArcMinRadius } from '../src/sim/scenario.js';
import { R_EARTH } from '../src/shared/constants.js';

const results = [];
const report = (name, ok, detail, problems = []) => results.push({ name, ok: Boolean(ok), detail, problems });
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

const tb = performance.now();
buildScenario();
const scenarioMs = performance.now() - tb;
const t0 = performance.now();
const { scenario, timeline, computeStates } = createSimulation();
const buildMs = performance.now() - t0;
const { missile, detection, handoff, engagement: E, sensorSat } = scenario;
const P = scenario.params;

// Build time.
report(
  'build-time',
  scenarioMs < 3000 && buildMs < 3000,
  `buildScenario ${scenarioMs.toFixed(0)} ms, with timeline and state computer ${buildMs.toFixed(0)} ms (limit 3000)`
);

// Range and apogee in band (5.3).
report('range', missile.rangeKm >= 8000 && missile.rangeKm <= 10000, `range ${f(missile.rangeKm, 0)} km (band 8000..10000)`);
report('apogee', missile.apogeeAltKm >= 900 && missile.apogeeAltKm <= 1600, `apogee ${f(missile.apogeeAltKm, 1)} km (band 900..1600)`);

// Detection early (5.4).
report('detect', detection.tDetect < 60, `tDetect ${f(detection.tDetect)} s (< 60), cone half-angle ${sensorSat.coneHalfAngleDeg} deg`);

// Event order.
{
  const order = [
    ['tDetect', detection.tDetect],
    ['tTrack', detection.tTrack],
    ['tLink1', handoff.tLink1],
    ['tLink2', handoff.tLink2],
    ['tAssign', handoff.tAssign],
    ['tOrient', E.tOrient],
    ['tRelease', E.tRelease],
    ['tIntercept', E.tIntercept],
    ['tImpact', missile.tImpact],
  ];
  const problems = [];
  for (let i = 0; i + 1 < order.length; i++) {
    if (!(order[i][1] < order[i + 1][1])) problems.push(`${order[i][0]} ${order[i][1]} !< ${order[i + 1][0]} ${order[i + 1][1]}`);
  }
  report('event-order', problems.length === 0, order.map(([n, t]) => `${n} ${f(t, 1)}`).join(' < '), problems);
}

// Kill vehicle meets the missile.
{
  const k = E.kv.stateAt(E.tIntercept);
  const m = missile.stateAt(E.tIntercept);
  const miss = k && m ? k.r.distanceTo(m.r) : Infinity;
  report('kv-meets-missile', miss < 1e-3, `miss distance at tIntercept ${miss.toExponential(2)} km (limit 1e-3)`);
}

// Delta-v within the cap.
{
  const cap = P.engagement.deltaVCapKms;
  const ok = E.deltaVKms <= E.deltaVCapKms && E.deltaVCapKms === cap;
  report('delta-v', ok, `|dV| ${f(E.deltaVKms, 4)} km/s (cap ${E.deltaVCapKms} km/s${E.deltaVCapKms !== cap ? ', raised from ' + cap : ''})`);
}

// Transfer arc floor: sampled every 1 s and the exact periapsis check.
{
  const tof = E.tIntercept - E.tRelease;
  let minR = Infinity;
  for (let t = 0; t <= tof; t += 1) minR = Math.min(minR, propagateKepler(E.kv.r0, E.kv.v1, t).r.length());
  const exact = transferArcMinRadius(E.kv.r0, E.kv.v1, missile.stateAt(E.tIntercept).r);
  const floor = R_EARTH + P.engagement.minArcAltKm;
  report(
    'transfer-arc',
    minR >= floor && exact >= floor,
    `lowest point ${f(Math.min(minR, exact) - R_EARTH, 1)} km altitude (floor ${P.engagement.minArcAltKm} km)`
  );
}

// Relay line of sight at tLink1 and tLink2.
{
  const problems = [];
  for (const [name, t] of [['tLink1', handoff.tLink1], ['tLink2', handoff.tLink2]]) {
    const rel = handoff.relaySat.stateAt(t).r;
    if (!segmentClearsSphere(rel, sensorSat.stateAt(t).r, R_EARTH)) problems.push(`relay to sensor sat blocked at ${name}`);
    if (!segmentClearsSphere(rel, E.interceptorSat.stateAt(t).r, R_EARTH)) problems.push(`relay to interceptor sat blocked at ${name}`);
  }
  report('relay-los', problems.length === 0, `relay ${handoff.relaySat.id} sees sensor sat ${sensorSat.id} and interceptor sat ${E.interceptorSat.id} at tLink1 and tLink2`, problems);
}

// Beams and the track line stay clear of the Earth over their whole windows (visual integrity).
{
  const problems = [];
  const sen = (t) => sensorSat.stateAt(t).r;
  const rel = (t) => handoff.relaySat.stateAt(t).r;
  const isat = (t) => E.interceptorSat.stateAt(t).r;
  const mis = (t) => missile.stateAt(t).r;
  const windows = [
    ['track', sen, mis, detection.tTrack, E.tIntercept - 1e-6],
    ['link1', sen, rel, handoff.tLink1, E.tIntercept + 4],
    ['link2', rel, isat, handoff.tLink2, E.tIntercept + 4],
  ];
  for (const [name, a, b, ta, tb] of windows) {
    for (let t = ta; t <= tb; t += 1) {
      if (!segmentClearsSphere(a(t), b(t), R_EARTH)) {
        problems.push(`${name} blocked by the Earth at t = ${f(t, 0)}`);
        break;
      }
    }
  }
  report('beam-los', problems.length === 0, 'track line and both handoff beams clear the Earth over their windows', problems);
}

// Every numeric field of computeStates finite for animT 0..90 step 0.1; trails within 256 points.
const samples = [];
{
  const problems = [];
  const trailProblems = [];
  let fields = 0;
  const walk = (value, path, seen) => {
    if (typeof value === 'number') {
      fields++;
      if (!Number.isFinite(value)) problems.push(`${path} = ${value}`);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, seen);
      return;
    }
    for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`, seen);
  };
  const steps = Math.round(TOTAL_DURATION * 10);
  for (let i = 0; i <= steps; i++) {
    const animT = i / 10;
    let s;
    try {
      s = computeStates(animT);
    } catch (err) {
      problems.push(`computeStates(${animT}) threw: ${err && err.stack ? err.stack : err}`);
      break;
    }
    samples.push(s);
    walk(s, `states(${animT})`, new Set());
    for (const actor of ['missile', 'kv']) {
      if (s[actor].trail.length > 256) trailProblems.push(`${actor} trail ${s[actor].trail.length} points at ${animT}`);
    }
    if (problems.length > 50) break;
  }
  report('finite', problems.length === 0 && samples.length === steps + 1, `${samples.length}/${steps + 1} samples, ${fields} numeric fields, ${problems.length} non-finite`, problems);
  report('trails', trailProblems.length === 0, 'missile and kill-vehicle trails at most 256 points', trailProblems);
}

// Fresh objects every call: two calls at the same time share no object.
{
  const problems = [];
  const collect = (value, set) => {
    if (value === null || typeof value !== 'object' || set.has(value)) return;
    set.add(value);
    for (const v of Array.isArray(value) ? value : Object.values(value)) collect(v, set);
  };
  for (const animT of [5, 16, 30, 45, 56.1, 60, 78, 80.5, 87]) {
    const a = new Set();
    const b = new Set();
    collect(computeStates(animT), a);
    collect(computeStates(animT), b);
    let shared = 0;
    for (const o of a) if (b.has(o)) shared++;
    if (shared) problems.push(`${shared} objects shared between two calls at ${animT}`);
  }
  report('fresh-objects', problems.length === 0, 'two computeStates calls at the same time share no object', problems);
}

// Camera: never on its target, never below 0.02 km (animT 0..90 step 0.01).
{
  const problems = [];
  let minAlt = Infinity;
  let minDist = Infinity;
  const steps = Math.round(TOTAL_DURATION * 100);
  for (let i = 0; i <= steps; i++) {
    const animT = i / 100;
    const c = computeStates(animT).camera;
    const alt = c.position.length() - R_EARTH;
    const dist = c.position.distanceTo(c.target);
    minAlt = Math.min(minAlt, alt);
    minDist = Math.min(minDist, dist);
    if (alt < 0.02) problems.push(`camera altitude ${f(alt, 4)} km at ${animT}`);
    if (!(dist > 1e-3)) problems.push(`camera on its target (${dist} km) at ${animT}`);
    const view = c.target.clone().sub(c.position).normalize();
    if (Math.abs(view.dot(c.up)) > 0.999) problems.push(`camera up parallel to the view at ${animT}`);
    if (problems.length > 20) break;
  }
  report('camera', problems.length === 0, `min altitude ${f(minAlt, 3)} km, min distance to target ${f(minDist, 3)} km`, problems);
}

// Beats contiguous, positive warps, continuous simulation time.
{
  const problems = [];
  const beats = timeline.beats;
  if (beats[0].start !== 0) problems.push(`first beat starts at ${beats[0].start}`);
  if (beats[beats.length - 1].end !== TOTAL_DURATION) problems.push(`last beat ends at ${beats[beats.length - 1].end}`);
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (!(b.warp > 0)) problems.push(`${b.id} warp ${b.warp}`);
    if (Math.abs(b.simStart + (b.end - b.start) * b.warp - b.simEnd) > 1e-9) problems.push(`${b.id} warp inconsistent`);
    if (i + 1 < beats.length) {
      const n = beats[i + 1];
      if (b.end !== n.start) problems.push(`gap between ${b.id} and ${n.id}`);
      if (Math.abs(b.simEnd - n.simStart) > 1e-9) problems.push(`sim discontinuity at ${n.id}`);
      const before = timeline.animToSim(n.start - 1e-9);
      const after = timeline.animToSim(n.start);
      if (Math.abs(after - before) > 1e-6) problems.push(`animToSim jumps at ${n.id}: ${before} -> ${after}`);
    }
  }
  // Linear segments inside each beat (the Engage release slow motion): contiguous, positive
  // warps, continuous simulation time, covering the beat exactly.
  for (const b of beats) {
    const segs = b.segments || [];
    if (!segs.length) problems.push(`${b.id} has no segments`);
    segs.forEach((s, j) => {
      if (!(s.warp > 0)) problems.push(`${b.id} segment ${j} warp ${s.warp}`);
      if (Math.abs(s.simStart + (s.end - s.start) * s.warp - s.simEnd) > 1e-9) problems.push(`${b.id} segment ${j} warp inconsistent`);
      if (j === 0 && (s.start !== b.start || Math.abs(s.simStart - b.simStart) > 1e-9)) problems.push(`${b.id} first segment misaligned`);
      if (j + 1 < segs.length && (s.end !== segs[j + 1].start || Math.abs(s.simEnd - segs[j + 1].simStart) > 1e-9)) problems.push(`${b.id} segment gap after ${j}`);
      if (j === segs.length - 1 && (s.end !== b.end || Math.abs(s.simEnd - b.simEnd) > 1e-9)) problems.push(`${b.id} last segment misaligned`);
    });
  }
  for (let i = 0; i < 900; i++) {
    const a = i / 10;
    const back = timeline.simToAnim(timeline.animToSim(a));
    if (Math.abs(back - a) > 1e-6) {
      problems.push(`simToAnim(animToSim(${a})) = ${back}`);
      break;
    }
  }
  const segText = beats
    .filter((b) => b.segments && b.segments.length > 1)
    .map((b) => `${b.id} segments ${b.segments.map((s) => 'x' + f(s.warp, 2)).join(' / ')}`);
  report('beats', problems.length === 0, beats.map((b) => `${b.id} x${f(b.warp, 2)}`).concat(segText).join(', '), problems);
}

// Pace: from the start of Engage to the end of Intercept the warp never steps (its eased
// segments join their neighbours with matching warp), and the camera pose is continuous across
// the joins where a beat continues the previous shot.
{
  const problems = [];
  const engage = timeline.beats.find((b) => b.id === 'engage');
  const intercept = timeline.beats.find((b) => b.id === 'intercept');
  const dt = 1 / 120;
  let worst = 0;
  for (let a = engage.start + dt; a < intercept.end; a += dt) worst = Math.max(worst, Math.abs(timeline.warpAt(a) - timeline.warpAt(a - dt)));
  if (worst > 1) problems.push(`warp steps by ${f(worst, 3)} within one 1/120 s frame`);
  const join = Math.abs(timeline.warpAt(intercept.start - 1e-6) - timeline.warpAt(intercept.start));
  if (join > 0.05) problems.push(`warp jumps by ${f(join, 3)} at the Engage/Intercept join`);
  for (const id of ['handoff', 'intercept', 'resolution']) {
    const b = timeline.beats.find((x) => x.id === id);
    const before = computeStates(b.start - 1e-6).camera;
    const after = computeStates(b.start).camera;
    const jump = before.position.distanceTo(after.position) / Math.max(1e-9, after.position.distanceTo(after.target));
    if (after.cutIn !== false) problems.push(`${id} is not marked as continuing the previous shot`);
    if (jump > 0.01) problems.push(`camera jumps by ${f(jump * 100, 2)} % of its range into ${id}`);
  }
  report('pace', problems.length === 0, `largest warp change per 1/120 s in Engage and Intercept ${f(worst, 3)}, ${f(join, 4)} at their join; camera continuous into handoff, intercept, resolution`, problems);
}

// Visibility windows.
{
  const problems = [];
  for (const s of samples) {
    const m = s.missile;
    const k = s.kv;
    if (s.simT < 0 && m.visible) problems.push(`missile visible before ignition at animT ${s.animT}`);
    if (s.simT >= E.tIntercept && m.visible) problems.push(`missile visible after intercept at animT ${s.animT}`);
    if (s.simT >= 0 && s.simT < E.tIntercept && !m.visible) problems.push(`missile hidden in flight at animT ${s.animT}`);
    if (s.simT < E.tRelease && k.visible) problems.push(`kill vehicle visible before release at animT ${s.animT}`);
    if (s.simT >= E.tIntercept && k.visible) problems.push(`kill vehicle visible after intercept at animT ${s.animT}`);
    if (s.simT >= E.tRelease && s.simT < E.tIntercept && !k.visible) problems.push(`kill vehicle hidden in flight at animT ${s.animT}`);
  }
  report('visibility', problems.length === 0, 'missile hidden before ignition and after intercept; kill vehicle hidden before release and after intercept', problems);
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.detail}`);
  if (!r.ok) {
    failed++;
    for (const p of r.problems.slice(0, 20)) console.log(`        ${p}`);
    if (r.problems.length > 20) console.log(`        ... and ${r.problems.length - 20} more`);
  }
}

// Summary: tuned values and search results (illustrative outcomes of a generic model).
console.log('');
console.log('scenario summary');
const thrust = P.thrustPhases.map((p) => p.accel).join(', ');
console.log(`  boost        accelerations ${thrust} km/s^2, PITCH_FINAL ${P.pitch.finalDeg} deg, azimuth ${P.launchAzimuthDeg} deg`);
console.log(`  burnout      t ${f(missile.burnout.t, 1)} s, speed ${f(missile.burnoutSpeedKms, 3)} km/s, altitude ${f(missile.burnoutAltKm, 1)} km`);
console.log(`  coast        apogee ${f(missile.apogeeAltKm, 1)} km at t ${f(missile.tApogee, 2)} s, impact t ${f(missile.tImpact, 2)} s, range ${f(missile.rangeKm, 0)} km`);
console.log(`  phases       PHASE_S ${scenario.phases.phaseSDeg} deg, PHASE_I ${scenario.phases.phaseIDeg} deg`);
console.log(`  sensor       ${sensorSat.id}, nadir ${f(sensorSat.nadirDistanceKm, 0)} km from the site at t = 0, cone ${sensorSat.coneHalfAngleDeg} deg`);
console.log(`  times        tDetect ${f(detection.tDetect, 1)}, tTrack ${f(detection.tTrack, 1)}, tLink1 ${f(handoff.tLink1, 1)}, tLink2 ${f(handoff.tLink2, 1)}, tAssign ${f(handoff.tAssign, 1)}`);
console.log(`               tOrient ${f(E.tOrient, 1)}, tRelease ${f(E.tRelease, 1)}, tIntercept ${f(E.tIntercept, 1)}, tImpact ${f(missile.tImpact, 2)}`);
console.log(`  engagement   interceptor sat ${E.interceptorSat.id}, relay ${handoff.relaySat.id}, |dV| ${f(E.deltaVKms, 4)} km/s, closing ${f(E.closingSpeedKms, 3)} km/s, intercept altitude ${f(E.interceptPoint.length() - R_EARTH, 1)} km`);
console.log(`  search       ${scenario.search.tracks} distinct tracks, ${scenario.search.candidates} candidates under the distance bound, ${scenario.search.evaluated} Lambert solves`);
console.log(`  warps        ${timeline.beats.map((b) => `${b.id} ${f(b.warp, 3)}`).join(', ')}`);
console.log(`  key times    ${Object.entries(KEY_TIMES).map(([k, v]) => `${k} ${f(v.sim, 1)}/${f(v.anim, 2)}`).join(', ')}`);
for (const line of scenario.log) console.log(`  log          ${line}`);

if (failed) {
  console.error(`check-scenario: FAILED (${failed} of ${results.length} assertions)`);
  process.exit(1);
}
console.log(`check-scenario: OK (${results.length} assertions)`);
