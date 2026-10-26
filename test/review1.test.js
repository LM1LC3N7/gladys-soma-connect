// -----------------------------------------------------------------------------
// The points of review r1: one shade in 5xx holds no other, kept stops leave
// without the configuration, both URL forms tried whatever the firmware says,
// a read cut for a stop is no failure, close is protective, kept stops leave
// side by side, and the follow-ups conclude on a fresh read only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { createClock } from './helpers/clock.js';
import { createBridge, ID_A, ID_T, MAC_A, MAC_T } from './helpers/fakeBridge.js';
import { KEY, MINUTE, SECOND, created, setup } from './helpers/app.js';

const createdBoth = () => [created(ID_A), created(ID_T, 'tilt', 'Bureau')];
const status503 = { status: 503, headers: {}, body: Buffer.from('') };
const status429 = { status: 429, headers: {}, body: Buffer.from('') };
const failingConfig = () => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls > 1) throw new Error('Request timeout');
    return {};
  };
};

test('I2: a 5xx on one shade holds no other shade, and pauses nothing', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, status } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'get_shade_state' && r.mac === MAC_T, status503, 100);
  await clock.run(61 * SECOND);
  assert.match(status().message.en, /Bureau: not read \(error \(HTTP 503\)\)/);
  assert.doesNotMatch(status().message.en, /paused/);
  const ack = await setValue(ID_A, 'position', 50);
  assert.equal(ack.success, true, ack.error);
});

test('I2: a 429 on one shade pauses the moves of the bridge, said as such', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, status } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'get_shade_state' && r.mac === MAC_T, status429);
  await clock.run(61 * SECOND);
  assert.match(status().message.en, /asked to slow down \(HTTP 429\)/);
  const ack = await setValue(ID_A, 'position', 50);
  assert.match(ack.error, /ralentir \(HTTP 429\)/);
});

test('I2: a 5xx of the list with a 1 h interval holds the moves 5 min at most', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, gladys } = await setup({
    clock,
    bridge,
    config: { address: '192.168.1.50', poll_interval: 3600 },
    devices: createdBoth(),
  });
  bridge.fail((r) => r?.name === 'list_devices', status503, 10);
  await gladys.fake.action('test_connection', {});
  await clock.run(3601 * SECOND);
  const refused = await setValue(ID_A, 'position', 50);
  assert.match(refused.error, /erreur à la liste des appareils/);
  await clock.run(5 * MINUTE);
  const ack = await setValue(ID_A, 'position', 50);
  assert.equal(ack.success, true, ack.error);
});

test('I3: a kept stop leaves at once and is resent while getConfig() fails', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  bridge.fail((r) => r?.name === 'stop_shade', 'unreachable', 1000);
  const store = memoryStore({
    bridge: { address: KEY, version: '3.0.4' },
    shades: [{ mac: MAC_A, kind: 'shade' }],
    stops: [{ mac: MAC_A, at: 1, resends: 0 }],
  });
  let tries = 0;
  bridge.failures[0].match = (r) => {
    if (r?.name === 'stop_shade') tries += 1;
    return r?.name === 'stop_shade';
  };
  const { status } = await setup({
    clock,
    bridge,
    store,
    devices: createdBoth(),
    getConfig: failingConfig(),
  });
  assert.ok(tries >= 1, 'a stop at once');
  await clock.run(10 * MINUTE);
  // Three rounds of 3.5 s (a try every 250 ms), then given up.
  assert.ok(tries >= 30 && tries <= 45, `${tries} tries`);
  assert.deepEqual(store.data.stops, []);
  assert.match(status().message.en, /not read yet/);
  bridge.failures = [];
});

test('I3: a kept stop gets through without the configuration', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  const store = memoryStore({
    bridge: { address: KEY, version: '3.0.4' },
    shades: [{ mac: MAC_A, kind: 'shade' }],
    stops: [{ mac: MAC_A, at: 1, resends: 1 }],
  });
  await setup({ clock, bridge, store, devices: createdBoth(), getConfig: failingConfig() });
  assert.deepEqual(
    bridge.requests.map((r) => r.path),
    [`/stop_shade?mac=${MAC_A}`],
  );
  assert.deepEqual(store.data.stops, []);
});

test('I4: firmware 4 on the path form (pysoma): the stop and the moves pass', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '4.0.1' });
  bridge.form = 'path';
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  assert.equal((await setValue(ID_A, 'position', 30)).success, true);
  assert.equal(bridge.requests.filter((r) => r.route === undefined).length, 0);
});

test('I4: firmware 4 on the query form: one 404, then the form that answered', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '4.0.1' });
  bridge.form = 'query';
  const { setValue, store } = await setup({ clock, bridge, devices: createdBoth() });
  // The first reads, side by side, each meet one 404; then the form is known.
  const misses = () => bridge.requests.filter((r) => r.route === undefined).length;
  assert.ok(misses() <= 2, `${misses()} 404`);
  const before = misses();
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  assert.equal((await setValue(ID_A, 'position', 30)).success, true);
  await clock.run(61 * SECOND);
  assert.equal(misses(), before);
  assert.equal(store.data.bridge.style, 'query');
});

test('I5: a list cut for a stop is no failure: still connected, read again soon', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, status, gladys } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', 'hang');
  await clock.run(61.5 * SECOND);
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  await clock.run(0);
  assert.equal(status().connected, true);
  assert.doesNotMatch(status().message.en, /unreachable|cut/);
  const transports = gladys.fake.transports.filter((t) => t.device_external_id.endsWith(ID_T));
  assert.equal(transports.at(-1).transport, 'local');
  const lists = bridge.of('list_devices').length;
  await clock.run(5 * SECOND);
  assert.equal(bridge.of('list_devices').length, lists + 1);
});

test('I7: close goes through a 429 pause', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', status429);
  await clock.run(61 * SECOND);
  assert.equal((await setValue(ID_A, 'position', 40)).success, false);
  const ack = await setValue(ID_A, 'state', -1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.of('set_shade_position').at(-1).route.pos, '100');
  const zero = await setValue(ID_A, 'position', 0);
  assert.equal(zero.success, true, zero.error);
});

test('I7: close before the configuration is read, from /data', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  const store = memoryStore({
    bridge: { address: KEY, version: '3.0.4' },
    shades: [{ mac: MAC_A, kind: 'shade' }],
  });
  const { setValue } = await setup({
    clock,
    bridge,
    store,
    devices: createdBoth(),
    getConfig: failingConfig(),
  });
  const ack = await setValue(ID_A, 'state', -1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    bridge.requests.map((r) => r.path),
    [`/set_shade_position?mac=${MAC_A}&pos=100`],
  );
});

test('I7: close never meets a full lane; it replaces the moves waiting', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.latency = 600;
  const moves = [10, 20, 30, 40, 50].map((p) => setValue(ID_A, 'position', p));
  await clock.run(100);
  const close = setValue(ID_A, 'state', -1);
  await clock.run(10 * SECOND);
  const [ack, ...rest] = await Promise.all([close, ...moves]);
  assert.equal(ack.success, true, ack.error);
  // The first move was leaving; the four waiting are cancelled.
  assert.equal(rest.filter((r) => r.success).length, 1);
  const positions = bridge.of('set_shade_position').map((r) => r.route.pos);
  assert.deepEqual(positions.slice(0, 1), ['90']);
  // The last word is the close (sent again after the move that was leaving).
  assert.equal(positions.at(-1), '100');
});

test('I7: a close that never gets through is refused, never kept nor resent', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const store = memoryStore();
  const { setValue } = await setup({ clock, bridge, store, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'set_shade_position', 'unreachable', 1000);
  const pending = setValue(ID_A, 'state', -1);
  await clock.run(4 * SECOND);
  const ack = await pending;
  assert.match(ack.error, /Non envoyée/);
  assert.deepEqual(store.data.stops, []);
  bridge.failures = [];
  await clock.run(5 * MINUTE);
  assert.equal(bridge.of('set_shade_position').length, 0);
});

test('I7: a newer stop cancels a close still trying', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'set_shade_position', 'unreachable', 1000);
  const close = setValue(ID_A, 'state', -1);
  await clock.run(600);
  const stop = setValue(ID_A, 'state', 0);
  await clock.run(4 * SECOND);
  const [c, s] = await Promise.all([close, stop]);
  assert.match(c.error, /Annulée par un arrêt/);
  assert.equal(s.success, true, s.error);
  assert.equal(bridge.of('set_shade_position').length, 0);
});

test('M3: the stops kept of several shades leave side by side', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  bridge.latency = 2000;
  const store = memoryStore({
    bridge: { address: KEY, version: '3.0.4' },
    shades: [
      { mac: MAC_A, kind: 'shade' },
      { mac: MAC_T, kind: 'tilt' },
    ],
    stops: [
      { mac: MAC_A, at: 1, resends: 0 },
      { mac: MAC_T, at: 1, resends: 0 },
    ],
  });
  await setup({ clock, bridge, store, devices: createdBoth(), connect: true });
  const stops = bridge.of('stop_shade');
  assert.equal(stops.length, 2);
  assert.ok(stops[1].at - stops[0].at < 100);
});

test('M4: follow-ups skipped by a pause never conclude "not reached" on an old read', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).frozen = true;
  const { setValue, status } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'position', 20)).success, true);
  // A 429 on the first follow-up: the others are skipped by the pause.
  bridge.fail((r) => r?.name === 'get_shade_state' && r.mac === MAC_A, {
    status: 429,
    headers: { 'retry-after': '600' },
    body: Buffer.from(''),
  });
  await clock.run(95 * SECOND);
  assert.doesNotMatch(status().message.en, /did not reach/);
  assert.match(status().message.en, /not confirmed yet/);
});
