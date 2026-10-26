// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never asks SOMA Connect again before its
// time, and so that "Stop" works before the first read:
//   - `bridge`: the address of SOMA Connect last read, its firmware version
//     and the URL form that last answered (tried first);
//   - `shades`: the MAC address and the kind (shade, tilt) of each device it
//     listed, so a stop (and a move) needs no read first;
//   - `pause`: the end of a pause (a 429, or a 5xx of list_devices) and its kind;
//   - `lastAttemptAt`: when SOMA Connect was last read (written at most once
//     a minute: src/app.js waits that minute more after a restart);
//   - `batteryAt`: per shade, when its battery was last read (at most once an
//     hour, even across restarts: each read wakes the shade);
//   - `stops`: the stops that did not get through, sent again by the next
//     reads (3 times at most), kept until then even across a restart.
// Times here are wall-clock milliseconds; src/app.js brings them onto its
// monotonic clock when it loads them. NO SECRET: there is none.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { KINDS, LIMITS, MAX_SHADES, TIMINGS } from './constants.js';
import { idOf } from './devices.js';
import { isRawMac, styleOf } from './soma/client.js';

export const STATE_FILE = '/data/soma-connect-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
const time = (value, now) =>
  Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), now) : 0;

/**
 * The persisted state, repaired and bounded: a pause never more than 6 h
 * away, a time never in the future (a clock that jumped, a file edited by
 * hand), only MAC addresses in the form SOMA Connect gives them.
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const bridge = object(data.bridge);
  const shades = [];
  for (const entry of list(data.shades, MAX_SHADES * 2)) {
    const s = object(entry);
    const id = idOf(s.mac);
    if (id && !shades.some((o) => o.id === id) && shades.length < MAX_SHADES) {
      shades.push({ id, mac: s.mac, kind: s.kind === KINDS.TILT ? KINDS.TILT : KINDS.SHADE });
    }
  }
  const pause = object(data.pause);
  const batteryAt = {};
  for (const [id, at] of Object.entries(object(data.batteryAt)).slice(0, MAX_SHADES * 2)) {
    if (/^[0-9a-f]{12}$/.test(id) && time(at, now) > 0) {
      batteryAt[id] = time(at, now);
    }
  }
  const stops = [];
  for (const entry of list(data.stops, MAX_SHADES)) {
    const s = object(entry);
    if (isRawMac(s.mac) && !stops.some((o) => o.mac === s.mac)) {
      stops.push({
        mac: s.mac,
        at: time(s.at, now),
        resends: Number.isInteger(s.resends)
          ? Math.min(Math.max(0, s.resends), LIMITS.stopResends)
          : 0,
      });
    }
  }
  return {
    bridge:
      typeof bridge.address === 'string' && bridge.address.length <= 300
        ? {
            address: bridge.address,
            version:
              typeof bridge.version === 'string' && styleOf(bridge.version)
                ? bridge.version
                : undefined,
            style: bridge.style === 'query' || bridge.style === 'path' ? bridge.style : undefined,
          }
        : undefined,
    shades,
    lastAttemptAt: time(data.lastAttemptAt, now),
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.pauseMax),
            failures: Number.isInteger(pause.failures)
              ? Math.min(Math.max(1, pause.failures), 20)
              : 1,
            kind: pause.kind === 'rate' ? 'rate' : 'server',
          }
        : undefined,
    batteryAt,
    stops,
  };
}
