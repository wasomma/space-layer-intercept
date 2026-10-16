// Live link transport: a WebSocket to a live-link server, reconnecting until closed.
//
// liveUrlFromLocation(location) -> the WebSocket URL named by the page's ?live parameter, or null
//   ?live                     ws(s)://<this host>/live (the page is served by the live-link server)
//   ?live=ws://host:port/path that URL (ws: or wss: only)
// connectLive(url, { onMessage, onStatus }) -> { close() }
//   onMessage(msg) gets every message that parses as a JSON object with a string type;
//   onStatus(connected) reports each open and close. On open the viewer says hello.
// Reconnects 1, 2, 4, then every 5 seconds after a close.

import { LIVE_PROTOCOL } from '../sim/live.js';

const RECONNECT_MAX = 5; // s

export function liveUrlFromLocation(location) {
  const params = new URLSearchParams(location.search);
  if (!params.has('live')) return null;
  const value = params.get('live');
  if (!value) return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  } catch {
    // not a URL
  }
  console.warn(`live link: ignoring ?live=${value} (expected a ws:// or wss:// URL)`);
  return null;
}

export function connectLive(url, { onMessage = () => {}, onStatus = () => {} } = {}) {
  let socket = null;
  let closed = false;
  let delay = 1;
  let timer = null;

  function open() {
    socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      delay = 1;
      onStatus(true);
      socket.send(JSON.stringify({ type: 'hello', role: 'viewer', protocol: LIVE_PROTOCOL }));
    });
    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') onMessage(msg);
    });
    socket.addEventListener('close', () => {
      onStatus(false);
      if (closed) return;
      timer = setTimeout(open, delay * 1000);
      delay = Math.min(RECONNECT_MAX, delay * 2);
    });
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      if (socket) socket.close();
    },
  };
}
