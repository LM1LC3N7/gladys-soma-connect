// -----------------------------------------------------------------------------
// A fake SOMA Connect behind the `request` of the client (no network): the
// five requests of pysoma, in the URL form of its firmware (query form from
// version 3, path form before; the other form answers 404), shades and tilts
// that move at once (or never, `frozen`), shades out of Bluetooth reach
// (`reachable: false`: an "error" result), a latency on the virtual clock,
// failures queued per request, and every request recorded.
// -----------------------------------------------------------------------------

import { SomaError } from '../../src/soma/errors.js';

export const MAC_A = 'e3:aa:00:00:00:01';
export const MAC_B = 'e3:aa:00:00:00:02';
export const MAC_T = 'c1:bb:00:00:00:03';
export const ID_A = 'e3aa00000001';
export const ID_B = 'e3aa00000002';
export const ID_T = 'c1bb00000003';

const json = (value, status = 200) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(value)),
});

/** The request name, the MAC and the position of a path, in the form of `version`. */
export function route(path, version) {
  const query = Number(String(version).split('.')[0]) >= 3;
  const url = new URL(path, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'list_devices') {
    return { name: 'list_devices' };
  }
  if (query) {
    if (parts.length !== 1) return undefined;
    return { name: parts[0], mac: url.searchParams.get('mac'), pos: url.searchParams.get('pos') };
  }
  if (url.search !== '' || parts.length < 2) return undefined;
  return { name: parts[0], mac: parts[1], pos: parts[2] };
}

export function createBridge(clock, { version = '2.3.1', shades } = {}) {
  const bridge = {
    version,
    shades: new Map(),
    requests: [],
    /** { match(route, path) => boolean, then, times } */
    failures: [],
    latency: 0,
    down: false,
    listExtra: [],
  };
  const list = shades ?? [
    { mac: MAC_A, name: 'Salon', type: 'shade', position: 30, battery_level: 400 },
    { mac: MAC_T, name: 'Bureau', type: 'tilt', position: 40, battery_percentage: 77 },
  ];
  for (const s of list) {
    bridge.shades.set(s.mac, { reachable: true, frozen: false, ...s });
  }

  bridge.fail = (match, then, times = 1) => {
    bridge.failures.push({ match, then, times });
  };
  bridge.of = (name) => bridge.requests.filter((r) => r.route?.name === name);
  bridge.position = (mac) => bridge.shades.get(mac).position;

  function answer(r) {
    if (r.name === 'list_devices') {
      return json({
        result: 'success',
        version: bridge.version,
        shades: [
          ...[...bridge.shades.values()].map((s) => ({ name: s.name, mac: s.mac, type: s.type })),
          ...bridge.listExtra,
        ],
      });
    }
    const shade = bridge.shades.get(r.mac);
    if (!shade) {
      return json({ result: 'error', msg: 'unknown mac' });
    }
    if (!shade.reachable) {
      return json({ result: 'error', msg: 'device not reachable' });
    }
    switch (r.name) {
      case 'get_shade_state':
        return json({
          result: 'success',
          position: shade.position,
          ...(shade.upwards ? { closed_upwards: 1 } : {}),
        });
      case 'get_battery_level':
        return json({
          result: 'success',
          ...(shade.battery_level !== undefined ? { battery_level: shade.battery_level } : {}),
          ...(shade.battery_percentage !== undefined
            ? { battery_percentage: shade.battery_percentage }
            : {}),
        });
      case 'set_shade_position':
        if (!shade.frozen) {
          shade.position = Number(r.pos);
          shade.upwards = false;
        }
        shade.lastPos = Number(r.pos);
        return json({ result: 'success' });
      case 'stop_shade':
        shade.stops = (shade.stops ?? 0) + 1;
        return json({ result: 'success' });
      default:
        return json({ result: 'error', msg: 'unknown' }, 404);
    }
  }

  bridge.request = async (options) => {
    const r = route(options.path, bridge.version);
    const failure = bridge.failures.find((f) => f.times > 0 && f.match(r, options.path));
    if (failure) {
      failure.times -= 1;
    }
    const then = failure?.then;
    if (bridge.down || then === 'unreachable') {
      throw new SomaError('unreachable');
    }
    if (options.beforeSend) {
      try {
        options.beforeSend();
      } catch (err) {
        err.beforeSend = true;
        err.sent = false;
        throw err;
      }
    }
    const entry = { path: options.path, route: r, at: clock.peek() };
    bridge.requests.push(entry);
    if (then === 'hang') {
      // A read that never answers: only a cut ends it.
      return new Promise((_resolve, reject) => {
        const started = clock.peek();
        const release = options.onHandle?.({
          idleFor: () => clock.peek() - started,
          cut: () => {
            release?.();
            reject(new SomaError('cut', { sent: true }));
          },
          closed: Promise.resolve(),
        });
      });
    }
    const latency = typeof then === 'object' && then?.latency ? then.latency : bridge.latency;
    if (latency > 0) {
      await new Promise((resolve) => clock.timers.setTimeout(resolve, latency));
    }
    if (then === 'timeout') {
      throw new SomaError('timeout', { sent: true });
    }
    if (typeof then === 'object' && then?.status) {
      return then;
    }
    if (!r) {
      return json({ result: 'error' }, 404);
    }
    return answer(r);
  };
  return bridge;
}
