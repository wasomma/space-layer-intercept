// Master clock. Pure JS, importable in Node.
//
// createClock({ duration, loop }) returns a mutable clock object:
//   { t, playing, speed, duration, loop, play(), pause(), seek(t), setSpeed(s), tick(dt) }
// tick(dtSeconds) advances t by dt * speed while playing and wraps at duration when loop is true.

export function createClock({ duration = 75, loop = true } = {}) {
  const wrap = (t) => {
    if (loop) {
      const m = t % duration;
      return m < 0 ? m + duration : m;
    }
    return t < 0 ? 0 : t > duration ? duration : t;
  };

  const clock = {
    t: 0,
    playing: false,
    speed: 1,
    duration,
    loop,

    play() {
      clock.playing = true;
    },

    pause() {
      clock.playing = false;
    },

    /** Jump to time t (seconds). Wraps when looping, clamps otherwise. */
    seek(t) {
      clock.t = wrap(Number.isFinite(t) ? t : 0);
    },

    /** Playback rate multiplier (0.5, 1, 2, ...). */
    setSpeed(s) {
      clock.speed = Number.isFinite(s) && s > 0 ? s : 1;
    },

    /** Advance by dt seconds of wall time. */
    tick(dt) {
      if (!clock.playing || !Number.isFinite(dt)) return;
      const next = clock.t + dt * clock.speed;
      if (next >= duration && !loop) {
        clock.t = duration;
        clock.playing = false;
        return;
      }
      clock.t = wrap(next);
    },
  };

  return clock;
}
