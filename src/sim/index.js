// Simulation entry point. Pure, Node-importable (no DOM, no JSON imports).
//
// createSimulation(params) builds the scenario, the timeline and the state computer once
// and returns { scenario, timeline, computeStates }. The physics core (kepler, lambert,
// integrate, los) is re-exported for the check script and the dev harnesses.

import { buildScenario, DEFAULT_PARAMS } from './scenario.js';
import { buildTimeline, TOTAL_DURATION, KEY_TIMES } from './timeline.js';
import { createClock } from './clock.js';
import { createStateComputer } from './states.js';
import { createCamera } from './camera.js';

export { buildScenario, DEFAULT_PARAMS, buildTimeline, TOTAL_DURATION, KEY_TIMES, createClock, createStateComputer, createCamera };
export * from './kepler.js';
export * from './lambert.js';
export * from './integrate.js';
export * from './los.js';

/**
 * Build everything once: the scenario (boost, coast, shells, detection, handoff, engagement
 * search), the timeline with its per-beat warps, and the state computer.
 * @param {object} [params=DEFAULT_PARAMS]
 * @returns {{ scenario: object, timeline: object, computeStates: (animT: number) => object }}
 */
export function createSimulation(params = DEFAULT_PARAMS) {
  const scenario = buildScenario(params);
  const timeline = buildTimeline(scenario);
  const computeStates = createStateComputer(scenario, timeline);
  return { scenario, timeline, computeStates };
}
