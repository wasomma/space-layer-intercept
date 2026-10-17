// Live clock: follows an external host's simulation clock from live link messages.
//
// createLiveClock({ lostAfter }) -> {
//   receive(msg, wallNow)  feed one message; wallNow is the local wall time in seconds
//   hostTime(wallNow)      the host clock extrapolated to wallNow, null before any clock message
//   simT(wallNow)          seconds from ignition (negative during a countdown), null before a launch
//   rate(wallNow)          host seconds per wall second (0 while paused or lost)
//   status(wallNow)        'waiting' | 'standby' | 'countdown' | 'live' | 'paused' | 'lost'
//   launch()               the current launch message, or null
// }
//
// Messages (README, "Live link"):
//   { type: 'clock', hostTime, rate, paused }  the host's simulation clock, sent about 10 times a second
//   { type: 'launch', ignitionHostTime, site, azimuthDeg }  T+0 is at host time ignitionHostTime
//   { type: 'reset' }  back to standby
// Anything else is ignored. Between clock messages the host time advances at the last reported
// rate, for at most lostAfter seconds; past that the status is 'lost' and the time holds. Small
// backward steps (a clock message that arrives later than the extrapolation expected) are held,
// so the output never runs backwards by less than BACKSTEP; larger steps are real jumps and pass.
// Pure; no DOM, no timers.

const BACKSTEP = 0.5; // s of host time

export function createLiveClock({ lostAfter = 5 } = {}) {
  let last = null; // { hostTime, rate, paused, wall }
  let launchMsg = null;
  let held = -Infinity; // the last host time returned

  function raw(wallNow) {
    if (!last) return null;
    const dt = Math.min(Math.max(0, wallNow - last.wall), lostAfter);
    return last.hostTime + (last.paused ? 0 : last.rate * dt);
  }

  function hostTime(wallNow) {
    const h = raw(wallNow);
    if (h === null) return null;
    if (h < held && held - h < BACKSTEP) return held;
    held = h;
    return h;
  }

  function lost(wallNow) {
    return last !== null && wallNow - last.wall > lostAfter;
  }

  return {
    receive(msg, wallNow) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'clock') {
        const h = Number(msg.hostTime);
        if (!Number.isFinite(h)) return;
        const rate = Number(msg.rate);
        last = { hostTime: h, rate: Number.isFinite(rate) && rate >= 0 ? rate : 1, paused: Boolean(msg.paused), wall: wallNow };
      } else if (msg.type === 'launch') {
        if (Number.isFinite(Number(msg.ignitionHostTime))) launchMsg = { ...msg, ignitionHostTime: Number(msg.ignitionHostTime) };
      } else if (msg.type === 'reset') {
        launchMsg = null;
      }
    },
    hostTime,
    simT(wallNow) {
      const h = hostTime(wallNow);
      if (h === null || !launchMsg) return null;
      return h - launchMsg.ignitionHostTime;
    },
    rate(wallNow) {
      if (!last || last.paused || lost(wallNow)) return 0;
      return last.rate;
    },
    status(wallNow) {
      if (!last) return 'waiting';
      if (lost(wallNow)) return 'lost';
      if (!launchMsg) return 'standby';
      if (last.paused) return 'paused';
      const h = raw(wallNow);
      return h < launchMsg.ignitionHostTime ? 'countdown' : 'live';
    },
    launch() {
      return launchMsg;
    },
  };
}
