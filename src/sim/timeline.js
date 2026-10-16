// Timeline: beats, per-beat time warp, and the animation <-> simulation time mapping.
//
// The seven beats have fixed animation boundaries; their simulation anchors come from the
// scenario. Within a beat the mapping is linear, sim = simStart + (animT - start) * warp with
// warp = (simEnd - simStart) / (end - start), and consecutive beats share their anchors, so the
// mapping is piecewise linear and continuous over the whole 90 s. Pure, Node-importable.
//
// To re-time the film, edit the animation boundaries in BEAT_TABLE; the simulation anchors
// follow the scenario (simAnchors) and the model follows DEFAULT_PARAMS in scenario.js.

export const TOTAL_DURATION = 90;

/** Animation boundaries of the seven beats (5.6), fixed. */
const BEAT_TABLE = [
  { id: 'establishing', label: 'Constellation', start: 0, end: 10 },
  { id: 'launch', label: 'Launch', start: 10, end: 24 },
  { id: 'boost', label: 'Boost and acquisition', start: 24, end: 38 },
  { id: 'handoff', label: 'Handoff', start: 38, end: 50 },
  // Phase 2 follow-up: Engage runs to 76 and Intercept is 76-83 (5.6 had 72-84 and 84-90), so the
  // real-time approach is short and the time goes to the course view and the closing pull-back.
  { id: 'engage', label: 'Engage', start: 50, end: 76 },
  { id: 'intercept', label: 'Intercept', start: 76, end: 83 },
  { id: 'resolution', label: 'Resolution', start: 83, end: 90 },
];

/**
 * Simulation seconds of real-time approach at the start of the Intercept beat (5.6 had 8): Engage's
 * eased pace slows into real time this long before impact, so the close-in is brief.
 */
const INTERCEPT_LEAD = 3;

/** Simulation anchors [simStart, simEnd] of each beat from the scenario (5.6). */
function simAnchors(scenario) {
  const { tTrack } = scenario.detection;
  const { tAssign } = scenario.handoff;
  const { tIntercept } = scenario.engagement;
  return [
    [-60, -4],
    [-4, 10],
    [10, tTrack + 20],
    [tTrack + 20, tAssign + 10],
    [tAssign + 10, tIntercept - INTERCEPT_LEAD],
    [tIntercept - INTERCEPT_LEAD, tIntercept + 4],
    [tIntercept + 4, tIntercept + 900],
  ];
}

/**
 * Slow motion around the kill-vehicle release (Phase 2 follow-up): inside the Engage beat, the
 * animation window [animStart, animEnd] plays the simulation from simLead seconds before release
 * to simTail seconds after the kick burn ends, so the launch out of the tube is watchable; the
 * rest of the beat is split linearly on either side. The beat keeps its anchors.
 */
const RELEASE_SLOWMO = { beat: 'engage', animStart: 55.5, animEnd: 60.5, simLead: 0.5, simTail: 0.5 };

/**
 * One segment of the time mapping: [start, end] in animation time onto [simStart, simEnd], with
 * warp w0 at its start and w1 at its end and zero rate of change of warp at both ends. The
 * mapping is the quintic Hermite through the two anchors with those end slopes and zero end
 * accelerations, so the pace eases in and out inside the segment and joins its neighbours with
 * matching warp and no kink; with w0 = w1 = the mean warp it is exactly linear. End slopes that
 * would make the curve non-monotone fall back to linear. `warp` is the segment's mean.
 */
function segment(start, end, simStart, simEnd, w0, w1) {
  const warp = (simEnd - simStart) / (end - start);
  const seg = { start, end, simStart, simEnd, warp, w0, w1 };
  let ok = Number.isFinite(w0) && Number.isFinite(w1) && w0 > 0 && w1 > 0;
  for (let i = 0; ok && i <= 128; i++) ok = segWarp(seg, start + ((end - start) * i) / 128) > 0;
  if (!ok) {
    seg.w0 = warp;
    seg.w1 = warp;
  }
  return seg;
}

/** Simulation time of segment s at animation time a (linear extrapolation outside it). */
function segSim(s, a) {
  const d = s.end - s.start;
  const u = (a - s.start) / d;
  if (u <= 0) return s.simStart + (a - s.start) * s.w0;
  if (u >= 1) return s.simEnd + (a - s.end) * s.w1;
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  const h0 = 1 - 10 * u3 + 15 * u4 - 6 * u5;
  const h1 = u - 6 * u3 + 8 * u4 - 3 * u5;
  const h4 = -4 * u3 + 7 * u4 - 3 * u5;
  const h5 = 10 * u3 - 15 * u4 + 6 * u5;
  return h0 * s.simStart + h1 * s.w0 * d + h4 * s.w1 * d + h5 * s.simEnd;
}

/** Warp (d sim / d anim) of segment s at animation time a. */
function segWarp(s, a) {
  const d = s.end - s.start;
  const u = Math.min(1, Math.max(0, (a - s.start) / d));
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u3 * u;
  const d0 = -30 * u2 + 60 * u3 - 30 * u4;
  const d1 = 1 - 18 * u2 + 32 * u3 - 15 * u4;
  const d4 = -12 * u2 + 28 * u3 - 15 * u4;
  const d5 = 30 * u2 - 60 * u3 + 30 * u4;
  return (d0 * s.simStart + d5 * s.simEnd) / d + d1 * s.w0 + d4 * s.w1;
}

/** Animation time of segment s at simulation time simT (monotone; bisection unless linear). */
function segAnim(s, simT) {
  if (s.w0 === s.warp && s.w1 === s.warp) return s.start + (simT - s.simStart) / s.warp;
  let lo = s.start;
  let hi = s.end;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (segSim(s, mid) < simT) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Segments of one beat. One linear segment for every beat except Engage, which gets the release
 * slow motion when it fits, eased at both sides (quintic, so the pace never kinks) (Phase 2 follow-up): time slows smoothly into the
 * slow motion as the slew finishes, speeds up out of it after the burn, and slows smoothly into
 * the Intercept beat's real time, so the course view flows across that join with no change of
 * pace.
 */
function beatSegments(beat, scenario, nextWarp) {
  const whole = [segment(beat.start, beat.end, beat.simStart, beat.simEnd, beat.warp, beat.warp)];
  const S = RELEASE_SLOWMO;
  if (beat.id !== S.beat) return whole;
  const E = scenario.engagement;
  const s0 = E.tRelease - S.simLead;
  const s1 = E.tRelease + (E.kv ? E.kv.burnDuration : 0) + S.simTail;
  if (!(s0 > beat.simStart && s1 < beat.simEnd && S.animStart > beat.start && S.animEnd < beat.end)) return whole;
  const slow = (s1 - s0) / (S.animEnd - S.animStart);
  const approachWarp = (s0 - beat.simStart) / (S.animStart - beat.start);
  return [
    segment(beat.start, S.animStart, beat.simStart, s0, approachWarp, slow),
    segment(S.animStart, S.animEnd, s0, s1, slow, slow),
    segment(S.animEnd, beat.end, s1, beat.simEnd, slow, Number.isFinite(nextWarp) ? nextWarp : beat.warp),
  ];
}

/**
 * Every anchor in both simulation and animation time ({ name: { sim, anim } }), for the check
 * script and the README: the beat starts as `<beatId>Beat` (and `end`), then the named
 * events. Filled by buildTimeline; exported as a live object so importers see the values of
 * the most recently built timeline.
 */
export const KEY_TIMES = {};

/**
 * @param {object} scenario from buildScenario
 * @returns {{ beats: Array<{ id, label, start, end, simStart, simEnd, warp }>,
 *   animToSim(animT: number): number, simToAnim(simT: number): number,
 *   getBeat(animT: number): object, warpAt(animT: number): number,
 *   events: Array<{ t, simT, text }>, keyTimes: object }}
 */
export function buildTimeline(scenario) {
  const anchors = simAnchors(scenario);
  const beats = BEAT_TABLE.map((b, i) => {
    const [simStart, simEnd] = anchors[i];
    return { ...b, simStart, simEnd, warp: (simEnd - simStart) / (b.end - b.start) };
  });
  beats.forEach((beat, i) => {
    beat.segments = beatSegments(beat, scenario, beats[i + 1] ? beats[i + 1].warp : undefined);
  });
  const first = beats[0];
  const last = beats[beats.length - 1];
  const segments = beats.flatMap((b) => b.segments);

  /** The beat containing animT; times before 0 map to the first beat, at or after 90 to the last. */
  function getBeat(animT) {
    if (!(animT > first.start)) return first;
    for (const b of beats) if (animT >= b.start && animT < b.end) return b;
    return last;
  }

  /** The segment containing animT (same clamping as getBeat). */
  function getSegment(animT) {
    const b = getBeat(animT);
    for (const s of b.segments) if (animT >= s.start && animT < s.end) return s;
    return animT < b.start ? b.segments[0] : b.segments[b.segments.length - 1];
  }

  /** Simulation time at animation time animT (extrapolated linearly outside [0, 90]). */
  function animToSim(animT) {
    return segSim(getSegment(animT), animT);
  }

  /** Animation time at simulation time simT, clamped to [0, 90]. */
  function simToAnim(simT) {
    if (!(simT > first.simStart)) return first.start;
    for (const s of segments) {
      if (simT >= s.simStart && simT < s.simEnd) {
        return s.warp > 0 ? segAnim(s, simT) : s.start;
      }
    }
    return last.end;
  }

  /** The warp in effect at animT (varies inside Engage's eased segments; the beat's mean elsewhere). */
  function warpAt(animT) {
    return segWarp(getSegment(animT), animT);
  }

  const events = (scenario.events || []).map((e) => ({ t: simToAnim(e.t), simT: e.t, text: e.text }));

  const keyTimes = {};
  for (const b of beats) keyTimes[`${b.id}Beat`] = { sim: b.simStart, anim: b.start };
  keyTimes.end = { sim: last.simEnd, anim: last.end };
  const { tDetect, tTrack } = scenario.detection;
  const { tLink1, tLink2, tAssign } = scenario.handoff;
  const { tOrient, tRelease, tIntercept } = scenario.engagement;
  const named = {
    erectStart: -60,
    erected: -10,
    lidOpen: -0.5,
    ignition: 0,
    detect: tDetect,
    track: tTrack,
    link1: tLink1,
    link2: tLink2,
    assign: tAssign,
    burnout: scenario.missile.burnout.t,
    orient: tOrient,
    release: tRelease,
    intercept: tIntercept,
    complete: tIntercept + 4,
    apogee: scenario.missile.tApogee,
    impact: scenario.missile.tImpact,
  };
  for (const [k, sim] of Object.entries(named)) keyTimes[k] = { sim, anim: simToAnim(sim) };
  for (const k of Object.keys(KEY_TIMES)) delete KEY_TIMES[k];
  Object.assign(KEY_TIMES, keyTimes);

  return { beats, animToSim, simToAnim, getBeat, warpAt, events, keyTimes };
}
