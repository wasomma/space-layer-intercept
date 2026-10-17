// HUD overlay and transport.
//
//   createHud({ root, beats, duration, events, live })
//     -> { update({ t, simT, warp, beatId, playing, speed, freeCam, readouts, live }), on(name, callback), destroy() }
//
//   beats:  [{ id, label, start, end, simStart, simEnd, warp }]  animation boundaries (s) and
//           simulation anchors (s from ignition); simStart is shown on the summary card.
//   events: [{ t, simT, text }]  a line appears in the log once animation time reaches t and is
//           stamped with its simulation time simT.
//   update(): t is animation time (scrubber, beat fallback, event log); simT drives the mission
//           clock (T-mm:ss before ignition, T+mm:ss after); warp drives the badge (x10, REAL TIME
//           at 1); readouts [{ id, label, value }] are preformatted strings for the bottom-right
//           panel (5.10), written to the DOM only when a value changes.
//
// Plain DOM, built once under `root`. The HUD never reads the clock or the scenario: update()
// hands it the current state (about 60 times a second) and it writes to the DOM only when a
// rendered value actually changes. User input is reported through on() callbacks:
//   play, pause, seek(t), speed(s), jumpBeat(id), toggleFreeCam, replay
// Several callbacks may be registered under one name; they run in registration order.
// on() returns an unsubscribe function; destroy() removes the DOM and the key listener.
// Both are additions to the section 4.3 contract and may be ignored.
//
// Missing fields are tolerated. Without simT (in update() or on an event) the simulation time is
// derived from the beats' simStart and warp passed at creation, and shown as T+--:-- when those
// are missing too. Without warp the current beat's warp is used; a badge with no positive warp
// is hidden. A missing or malformed readouts array empties the panel, which hides when empty.
//
// Live mode (createHud({ ..., live: true })): the transport and the REPLAY button are hidden,
// since an external host drives the time, and a status badge sits under the beat label.
// update({ live: { text, level } }) sets it; level is 'ok', 'wait' or 'warn'. simT: null shows
// T+--:-- (no launch yet) instead of falling back to the beats.

import { cssVars } from '../shared/palette.js';
import './hud.css';

const CALLBACK_NAMES = ['play', 'pause', 'seek', 'speed', 'jumpBeat', 'toggleFreeCam', 'replay'];
const SPEEDS = [0.5, 1, 2];
const LOG_LINES = 6;
const SUMMARY_BEAT_ID = 'resolution';
// ArrowLeft restarts the current beat when more than this many seconds into it,
// otherwise it goes to the previous beat.
const BEAT_BACK_GRACE = 1;
// A scrub to the very end is held just short of duration, because a looping clock wraps
// duration back to 0.
const END_GUARD = 1e-3;
// A warp this close to 1 reads REAL TIME. Beat warps are ratios of doubles, so a real-time beat
// can arrive as 0.9999999999.
const REAL_TIME_TOLERANCE = 5e-3;

const TITLE = 'SPACE-LAYER INTERCEPT';
const SUBTITLE = 'Physics-driven concept. Generic parameters. Not a model of any real system.';
const REAL_TIME = 'REAL TIME';
const NO_TIME = 'T+--:--';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** A finite number from x, or NaN. null, undefined and '' count as missing, not as 0. */
function num(x) {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Simulation time as T+mm:ss, or T-mm:ss before ignition. Floored to the whole second, so the
 * text never runs ahead of the simulation and each label lasts exactly one second: -0.4 s reads
 * T-00:01 and ignition itself T+00:00 (there is no T-00:00). Minutes are not folded into hours.
 * Used for the mission clock, the event stamps and the summary card.
 */
function formatSimTime(simT) {
  if (!Number.isFinite(simT)) return NO_TIME;
  const secs = Math.floor(simT + 1e-6);
  const a = Math.abs(secs);
  return `T${secs < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/**
 * Warp badge text: REAL TIME at warp 1, otherwise x<warp> rounded for reading: whole numbers
 * from 10 up (x149), one decimal from 1 to 10 (x5.6, x4), two significant digits below 1
 * (x0.25). Empty (badge hidden) when the warp is missing or not positive.
 */
function formatWarp(warp) {
  if (!Number.isFinite(warp) || warp <= 0) return '';
  if (Math.abs(warp - 1) <= REAL_TIME_TOLERANCE) return REAL_TIME;
  let n;
  if (warp >= 10) n = Math.round(warp);
  else if (warp >= 1) n = Math.round(warp * 10) / 10;
  else n = Number(warp.toPrecision(2));
  // Just outside the real-time tolerance the rounding above would print x1; show two decimals.
  if (n === 1) n = Math.round(warp * 100) / 100;
  return `x${n}`;
}

/**
 * Readouts as [{ id, label, value }] with string fields and unique ids. Entries that are not
 * objects are skipped; a missing id falls back to the label, then to the position.
 */
function normaliseReadouts(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object') continue;
    const label = r.label == null ? '' : String(r.label);
    let id = r.id == null || r.id === '' ? label || `row-${i}` : String(r.id);
    if (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    out.push({ id, label, value: r.value == null ? '' : String(r.value) });
  }
  return out;
}

/** True when keyboard input belongs to a text field rather than to the HUD. */
function isTextEntry(target) {
  if (!target || target.nodeType !== 1) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file', 'image'].includes(type);
}

/** Drop focus after a pointer click so a later Space or Enter does not re-press the button. */
function releaseFocus(event) {
  if (event.detail > 0 && event.currentTarget && typeof event.currentTarget.blur === 'function') {
    event.currentTarget.blur();
  }
}

export function createHud({ root, beats = [], duration, events = [], live = false } = {}) {
  if (!root) throw new Error('createHud: a root element is required');

  // Palette as CSS custom properties on :root, so var(--c-*) resolves for the HUD and for
  // the 3D labels outside the HUD root.
  const rootStyle = document.documentElement.style;
  for (const [name, value] of Object.entries(cssVars())) rootStyle.setProperty(name, value);

  const beatList = (Array.isArray(beats) ? beats : [])
    .filter((b) => b && b.id != null)
    .map((b) => {
      const start = num(b.start);
      const end = num(b.end);
      const simStart = num(b.simStart);
      const simEnd = num(b.simEnd);
      let warp = num(b.warp);
      if (!Number.isFinite(warp) && Number.isFinite(simStart) && Number.isFinite(simEnd) && end > start) {
        warp = (simEnd - simStart) / (end - start);
      }
      return { id: b.id, label: String(b.label ?? b.id), start, end, simStart, warp };
    })
    .sort((a, b) => a.start - b.start);
  const total =
    Number.isFinite(duration) && duration > 0
      ? duration
      : beatList.reduce((m, b) => Math.max(m, Number.isFinite(b.end) ? b.end : 0), 0) || 1;

  function beatIndexAt(t) {
    let index = 0;
    for (let i = 0; i < beatList.length; i++) {
      if (beatList[i].start <= t) index = i;
    }
    return index;
  }

  /**
   * Fallback only, for an update() or an event without simT: the simulation time at animation
   * time t from the beats' anchors (sim = simStart + (t - start) * warp), NaN when they carry none.
   */
  function simFromBeats(t) {
    if (beatList.length === 0 || !Number.isFinite(t)) return NaN;
    const b = beatList[beatIndexAt(t)];
    return b.simStart + (t - b.start) * b.warp;
  }

  const eventList = (Array.isArray(events) ? events : [])
    .filter((e) => e && Number.isFinite(num(e.t)))
    .map((e) => {
      const t = num(e.t);
      let simT = num(e.simT);
      if (!Number.isFinite(simT)) simT = simFromBeats(t);
      return { t, simT, stamp: formatSimTime(simT), text: String(e.text ?? '') };
    })
    .sort((a, b) => a.t - b.t || a.simT - b.simT || 0);

  // ---- callbacks -------------------------------------------------------------------------

  const handlers = new Map(CALLBACK_NAMES.map((name) => [name, []]));

  function on(name, callback) {
    if (typeof callback !== 'function') throw new TypeError(`hud.on("${name}"): callback must be a function`);
    if (!handlers.has(name)) {
      console.warn(`hud.on: unknown callback name "${name}"`);
      handlers.set(name, []);
    }
    const list = handlers.get(name);
    list.push(callback);
    return () => {
      const i = list.indexOf(callback);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function emit(name, ...args) {
    const list = handlers.get(name);
    if (!list || list.length === 0) return;
    for (const callback of list.slice()) {
      try {
        callback(...args);
      } catch (err) {
        console.error(`hud "${name}" callback failed`, err);
      }
    }
  }

  // ---- last rendered state (DOM is written only when one of these changes) ---------------

  const view = {
    t: 0,
    clock: null,
    warp: null,
    beatId: undefined,
    progress: -1,
    playing: undefined,
    speed: undefined,
    freeCam: undefined,
    eventCount: -1,
    summary: undefined,
    live: null,
  };
  // Rendered readout rows in display order: { id, label, value, node, labelNode, valueNode }.
  const readoutRows = [];

  // ---- DOM ---------------------------------------------------------------------------------

  root.classList.add('hud-root');
  root.classList.toggle('is-live', Boolean(live));

  // Top left: title block.
  const title = el('div', 'hud-title');
  title.append(el('div', 'hud-title__main', TITLE), el('div', 'hud-title__sub', SUBTITLE));

  // Top right: warp badge and mission clock on one row, current beat label below.
  const clockPanel = el('div', 'hud-clock hud-panel');
  const clockRow = el('div', 'hud-clock__row');
  const warpBadge = el('div', 'hud-warp is-hidden');
  const clockTime = el('div', 'hud-clock__time');
  clockRow.append(warpBadge, clockTime);
  const clockBeat = el('div', 'hud-clock__beat');
  clockPanel.append(clockRow, clockBeat);
  // Live mode only: the link status under the beat label.
  const liveBadge = el('div', 'hud-live');
  if (live) clockPanel.append(liveBadge);

  // Bottom left: event log.
  const logPanel = el('div', 'hud-log hud-panel');
  logPanel.setAttribute('role', 'log');

  // Bottom right: readouts panel, hidden while there are no rows.
  const readoutPanel = el('div', 'hud-readouts hud-panel is-empty');

  // Bottom centre: transport. Row 1 is the scrubber (beat-marker lane above a seek track),
  // row 2 the buttons.
  const transport = el('div', 'hud-transport hud-panel');

  const scrub = el('div', 'hud-scrub');
  const markerLane = el('div', 'hud-scrub__markers');
  const track = el('div', 'hud-scrub__track');
  const rail = el('div', 'hud-scrub__rail');
  const fill = el('div', 'hud-scrub__fill');
  const head = el('div', 'hud-scrub__head');
  track.append(rail, fill);

  const markers = beatList.map((beat) => {
    const left = (clamp(beat.start, 0, total) / total) * 100;
    const right = (clamp(Number.isFinite(beat.end) ? beat.end : total, 0, total) / total) * 100;
    const node = button('hud-scrub__marker');
    node.dataset.beat = beat.id;
    node.style.left = `${left}%`;
    node.style.width = `${Math.max(0, right - left)}%`;
    node.append(el('span', 'hud-scrub__marker-label', beat.label));
    node.addEventListener('click', (event) => {
      emit('jumpBeat', beat.id);
      releaseFocus(event);
    });
    markerLane.append(node);

    const tick = el('div', 'hud-scrub__tick');
    tick.style.left = `${left}%`;
    track.append(tick);
    return { id: beat.id, node };
  });
  track.append(head);
  scrub.append(markerLane, track);

  const controls = el('div', 'hud-controls');

  const playBtn = button('hud-btn hud-play');
  playBtn.append(el('span', 'hud-icon'));
  playBtn.addEventListener('click', (event) => {
    emit(view.playing ? 'pause' : 'play');
    releaseFocus(event);
  });

  const speedGroup = el('div', 'hud-speeds');
  speedGroup.setAttribute('role', 'group');
  const speedBtns = SPEEDS.map((s) => {
    const node = button('hud-btn hud-speed', `${s}x`);
    node.dataset.speed = String(s);
    node.addEventListener('click', (event) => {
      emit('speed', s);
      releaseFocus(event);
    });
    speedGroup.append(node);
    return { s, node };
  });

  const freeCamBtn = button('hud-btn hud-freecam', 'FREE CAM');
  freeCamBtn.addEventListener('click', (event) => {
    emit('toggleFreeCam');
    releaseFocus(event);
  });

  controls.append(playBtn, speedGroup, el('div', 'hud-controls__spacer'), freeCamBtn);
  transport.append(scrub, controls);

  // Centre: summary card, shown only during the resolution beat. Each beat with the simulation
  // time at which it starts.
  const summary = el('div', 'hud-summary hud-panel');
  const summaryList = el('ol', 'hud-summary__list');
  beatList.forEach((beat, i) => {
    const row = el('li', 'hud-summary__row');
    row.style.setProperty('--i', String(i));
    row.append(
      el('span', 'hud-summary__num', pad2(i + 1)),
      el('span', 'hud-summary__label', beat.label),
      el('span', 'hud-summary__time', formatSimTime(beat.simStart))
    );
    summaryList.append(row);
  });
  const replayBtn = button('hud-btn hud-replay', 'REPLAY');
  replayBtn.addEventListener('click', (event) => {
    emit('replay');
    releaseFocus(event);
  });
  summary.append(summaryList, replayBtn);

  const built = [title, clockPanel, logPanel, readoutPanel, transport, summary];
  root.append(...built);

  // ---- scrubber pointer input: click to seek, drag to scrub ----------------------------------

  let dragPointer = null;
  let lastSeekT = NaN;

  function seekFromPointer(clientX) {
    const rect = track.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    const t = Math.max(0, Math.min(frac * total, total - END_GUARD));
    if (t === lastSeekT) return;
    lastSeekT = t;
    emit('seek', t);
  }

  function endDrag(event) {
    if (dragPointer === null || event.pointerId !== dragPointer) return;
    dragPointer = null;
    track.classList.remove('is-dragging');
    try {
      track.releasePointerCapture(event.pointerId);
    } catch {
      // capture already released
    }
  }

  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragPointer = event.pointerId;
    lastSeekT = NaN;
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointer without an active pointer; plain click still seeks
    }
    track.classList.add('is-dragging');
    seekFromPointer(event.clientX);
  });
  track.addEventListener('pointermove', (event) => {
    if (dragPointer !== null && event.pointerId === dragPointer) seekFromPointer(event.clientX);
  });
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', endDrag);

  // ---- keyboard ----------------------------------------------------------------------------

  function stepBeat(direction) {
    if (beatList.length === 0) return;
    const t = view.t;
    const i = beatIndexAt(t);
    let target;
    if (direction < 0) {
      target = t - beatList[i].start > BEAT_BACK_GRACE ? i : Math.max(0, i - 1);
    } else {
      // Past the last beat, wrap to the first, matching the looping clock.
      target = i + 1 < beatList.length ? i + 1 : 0;
    }
    emit('jumpBeat', beatList[target].id);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    switch (event.key) {
      case ' ':
      case 'Spacebar':
        // preventDefault also stops a focused button from being pressed by the same key.
        event.preventDefault();
        if (!event.repeat) emit(view.playing ? 'pause' : 'play');
        break;
      case 'ArrowLeft':
        event.preventDefault();
        stepBeat(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        stepBeat(1);
        break;
      case 'c':
      case 'C':
        if (!event.repeat) emit('toggleFreeCam');
        break;
      case 'r':
      case 'R':
        if (!event.repeat) emit('replay');
        break;
      default:
        break;
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // ---- rendering ---------------------------------------------------------------------------

  function renderBeat(beatId) {
    const index = beatList.findIndex((b) => b.id === beatId);
    clockBeat.textContent = index >= 0 ? beatList[index].label : '';
    markers.forEach((m, i) => {
      m.node.classList.toggle('is-current', i === index);
      m.node.classList.toggle('is-past', index >= 0 && i < index);
    });
  }

  function renderWarp(text) {
    warpBadge.textContent = text;
    warpBadge.classList.toggle('is-realtime', text === REAL_TIME);
    warpBadge.classList.toggle('is-hidden', text === '');
  }

  function renderLog(count) {
    const frag = document.createDocumentFragment();
    for (let i = Math.max(0, count - LOG_LINES); i < count; i++) {
      const e = eventList[i];
      const line = el('div', i === count - 1 ? 'hud-log__line is-newest' : 'hud-log__line');
      // The two spaces are literal (white-space: pre) so the line reads "T+mm:ss  text".
      line.append(el('span', 'hud-log__stamp', e.stamp), '  ', el('span', 'hud-log__text', e.text));
      frag.append(line);
    }
    logPanel.replaceChildren(frag);
    logPanel.classList.toggle('is-empty', count === 0);
  }

  function createReadoutRow(r) {
    const node = el('div', 'hud-readouts__row is-new');
    const labelNode = el('span', 'hud-readouts__label', r.label);
    const valueNode = el('span', 'hud-readouts__value', r.value);
    node.append(labelNode, valueNode);
    // The fade-in plays once, on arrival; re-inserting the row later must not replay it.
    node.addEventListener('animationend', () => node.classList.remove('is-new'), { once: true });
    return { id: r.id, label: r.label, value: r.value, node, labelNode, valueNode };
  }

  function updateReadouts(list) {
    const next = normaliseReadouts(list);

    // Same rows in the same order: write only the values that changed.
    const sameRows =
      next.length === readoutRows.length &&
      next.every((r, i) => r.id === readoutRows[i].id && r.label === readoutRows[i].label);
    if (sameRows) {
      for (let i = 0; i < next.length; i++) {
        const row = readoutRows[i];
        if (next[i].value !== row.value) {
          row.value = next[i].value;
          row.valueNode.textContent = row.value;
        }
      }
      return;
    }

    // Rows added, removed, reordered or relabelled: rebuild the list in the new order, reusing
    // the nodes of rows that stay so only the new ones fade in.
    const byId = new Map(readoutRows.map((row) => [row.id, row]));
    const rows = next.map((r) => {
      const row = byId.get(r.id);
      if (!row) return createReadoutRow(r);
      if (row.label !== r.label) {
        row.label = r.label;
        row.labelNode.textContent = r.label;
      }
      if (row.value !== r.value) {
        row.value = r.value;
        row.valueNode.textContent = r.value;
      }
      return row;
    });
    readoutRows.length = 0;
    readoutRows.push(...rows);
    readoutPanel.replaceChildren(...rows.map((row) => row.node));
    readoutPanel.classList.toggle('is-empty', rows.length === 0);
  }

  let destroyed = false;

  function update(state = {}) {
    if (destroyed) return;
    const s = state && typeof state === 'object' ? state : {};
    const t = Number.isFinite(s.t) ? s.t : 0;
    view.t = t;

    const beatId = s.beatId ?? (beatList.length ? beatList[beatIndexAt(t)].id : null);
    if (beatId !== view.beatId) {
      view.beatId = beatId;
      renderBeat(beatId);
    }

    const simT = s.simT === null ? NaN : Number.isFinite(s.simT) ? s.simT : simFromBeats(t);
    const clockText = formatSimTime(simT);
    if (clockText !== view.clock) {
      view.clock = clockText;
      clockTime.textContent = clockText;
    }

    let warp = s.warp;
    if (!Number.isFinite(warp)) {
      const beat = beatList.find((b) => b.id === beatId);
      warp = beat ? beat.warp : NaN;
    }
    const warpText = formatWarp(warp);
    if (warpText !== view.warp) {
      view.warp = warpText;
      renderWarp(warpText);
    }

    const progress = Math.round(clamp(t / total, 0, 1) * 1e4) / 1e4;
    if (progress !== view.progress) {
      view.progress = progress;
      fill.style.transform = `scaleX(${progress})`;
      head.style.left = `${progress * 100}%`;
    }

    const playing = Boolean(s.playing);
    if (playing !== view.playing) {
      view.playing = playing;
      playBtn.classList.toggle('is-playing', playing);
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    const speed = Number.isFinite(s.speed) ? s.speed : 1;
    if (speed !== view.speed) {
      view.speed = speed;
      for (const { s: value, node } of speedBtns) {
        const active = Math.abs(value - speed) < 1e-9;
        node.classList.toggle('is-active', active);
        node.setAttribute('aria-pressed', String(active));
      }
    }

    const freeCam = Boolean(s.freeCam);
    if (freeCam !== view.freeCam) {
      view.freeCam = freeCam;
      freeCamBtn.classList.toggle('is-active', freeCam);
      freeCamBtn.setAttribute('aria-pressed', String(freeCam));
    }

    let count = 0;
    while (count < eventList.length && eventList[count].t <= t) count++;
    if (count !== view.eventCount) {
      view.eventCount = count;
      renderLog(count);
    }

    updateReadouts(s.readouts);

    const showSummary = beatId === SUMMARY_BEAT_ID;
    if (showSummary !== view.summary) {
      view.summary = showSummary;
      summary.classList.toggle('is-visible', showSummary);
      summary.setAttribute('aria-hidden', String(!showSummary));
      summary.inert = !showSummary;
    }

    if (live && s.live && typeof s.live === 'object') {
      const text = String(s.live.text ?? '');
      const level = ['ok', 'wait', 'warn'].includes(s.live.level) ? s.live.level : 'wait';
      const key = `${level}|${text}`;
      if (key !== view.live) {
        view.live = key;
        liveBadge.textContent = text;
        liveBadge.dataset.level = level;
      }
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('keydown', onKeyDown);
    for (const node of built) node.remove();
    root.classList.remove('hud-root');
    for (const list of handlers.values()) list.length = 0;
  }

  // First paint before the caller's first update().
  update({ t: 0 });

  return { update, on, destroy };
}
