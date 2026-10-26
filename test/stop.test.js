// -----------------------------------------------------------------------------
// STOP, the protective command: before the first read (from /data), through
// a pause, tried again within its 3.5 s, kept and sent again by the next
// reads, cancelling the moves not sent yet, cutting a silent read, sent again
// when the reads contradict it, and never sent after a newer move accepted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { createClock } from './helpers/clock.js';
import { createBridge, ID_A, ID_T, MAC_A, MAC_T } from './helpers/fakeBridge.js';
import { KEY, MINUTE, SECOND, created, setup } from './helpers/app.js';

const createdBoth = () => [created(ID_A), created(ID_T, 'tilt', 'Bureau')];
const stopOf = (r) => r?.name === 'stop_shade';
const kept = (version = '3.0.4') => ({
  bridge: { address: KEY, version },
  shades: [
    { mac: MAC_A, kind: 'shade' },
    { mac: MAC_T, kind: 'tilt' },
  ],
});

test('stop before the configuration is read: the address, firmware and shades of /data', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  let calls = 0;
  const { setValue, status } = await setup({
    clock,
    bridge,
    store: memoryStore(kept()),
    devices: createdBoth(),
    getConfig: async () => {
      calls += 1;
      if (calls > 1) throw new Error('Request timeout');
      return {};
    },
  });
  assert.match(status().message.en, /not read yet/);
  assert.equal(bridge.requests.length, 0);
  const ack = await setValue(ID_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    bridge.requests.map((r) => r.path),
    [`/stop_shade?mac=${MAC_A}`],
  );
  // A move waits for the configuration.
  const move = await setValue(ID_A, 'position', 10);
  assert.equal(move.success, false);
});

test('stop with the firmware unknown: the path form, then the query form after a 404', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  bridge.down = true;
  const { setValue } = await setup({
    clock,
    bridge,
    store: memoryStore({ shades: kept().shades }),
    devices: createdBoth(),
  });
  bridge.down = false;
  const ack = await setValue(ID_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    bridge.requests.filter((r) => r.path.startsWith('/stop_shade')).map((r) => r.path),
    [`/stop_shade/${MAC_A}`, `/stop_shade?mac=${MAC_A}`],
  );
});

test('stop goes through a 429 pause; a move does not', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, status } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', {
    status: 429,
    headers: {},
    body: Buffer.from(''),
  });
  await clock.run(61 * SECOND);
  assert.match(status().message.en, /paused/);
  assert.equal((await setValue(ID_A, 'position', 10)).success, false);
  const ack = await setValue(ID_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.of('stop_shade').length, 1);
});

test('stop tried again every 250 ms within its 3.5 s', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  let tries = 0;
  bridge.fail(
    (r) => {
      if (stopOf(r)) tries += 1;
      return stopOf(r);
    },
    'unreachable',
    3,
  );
  const pending = setValue(ID_A, 'state', 0);
  await clock.run(2 * SECOND);
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  // Three refused connections, then the fourth try.
  assert.equal(tries, 3);
  assert.equal(bridge.of('stop_shade').length, 1);
});

test('a stop that never gets through: kept in /data, sent again by the next reads (3 times at most)', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const store = memoryStore();
  const { setValue, status, gladys } = await setup({
    clock,
    bridge,
    store,
    devices: createdBoth(),
  });
  bridge.fail(stopOf, { status: 200, headers: {}, body: Buffer.from('{"result":"error"}') }, 100);
  const pending = setValue(ID_A, 'state', 0);
  await clock.run(4 * SECOND);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt non envoyé .*renvoyé à la prochaine lecture/);
  const sent = bridge.of('stop_shade').length;
  assert.ok(sent >= 10 && sent <= 15, `${sent} tries in 3.5 s`);
  assert.deepEqual(
    store.data.stops.map((s) => [s.mac, s.resends]),
    [[MAC_A, 0]],
  );
  assert.match(
    status().message.en,
    /a stop did not get through: sent again at the next read \(0\/3\)/,
  );
  const transports = gladys.fake.transports.filter((t) => t.device_external_id.endsWith(ID_A));
  assert.equal(transports.at(-1).degraded, true);
  // Three rounds, each with its own 3.5 s, then given up.
  for (let round = 1; round <= 3; round += 1) {
    await clock.run(61 * SECOND);
  }
  assert.match(status().message.en, /given up after 3 tries/);
  assert.deepEqual(store.data.stops, []);
  const after = bridge.of('stop_shade').length;
  await clock.run(5 * MINUTE);
  assert.equal(bridge.of('stop_shade').length, after);
});

test('a stop kept is sent again after a restart, before any read', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.0.4' });
  const store = memoryStore({ ...kept(), stops: [{ mac: MAC_A, at: 1, resends: 1 }] });
  await setup({ clock, bridge, store, devices: createdBoth() });
  assert.equal(bridge.requests[0].path, `/stop_shade?mac=${MAC_A}`);
  assert.deepEqual(store.data.stops, []);
});

test('a newer move accepted cancels the resend of an older stop', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const store = memoryStore();
  const { setValue } = await setup({ clock, bridge, store, devices: createdBoth() });
  bridge.fail(stopOf, 'unreachable', 100);
  const pending = setValue(ID_A, 'state', 0);
  await clock.run(4 * SECOND);
  assert.equal((await pending).success, false);
  assert.equal(store.data.stops.length, 1);
  bridge.failures = [];
  const move = await setValue(ID_A, 'position', 40);
  assert.equal(move.success, true, move.error);
  await clock.run(0);
  assert.deepEqual(store.data.stops, []);
  await clock.run(2 * MINUTE);
  assert.equal(bridge.of('stop_shade').length, 0);
});

test('stop cancels the moves of that shade not sent yet; an older move never leaves after it', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'set_shade_position', { latency: 1000 });
  const first = setValue(ID_A, 'position', 10);
  const second = setValue(ID_A, 'position', 90);
  await clock.run(100);
  const stop = setValue(ID_A, 'state', 0);
  await clock.run(5 * SECOND);
  const [a, b, s] = await Promise.all([first, second, stop]);
  assert.equal(s.success, true, s.error);
  assert.equal(b.success, false);
  assert.match(b.error, /Annulée par un arrêt/);
  // The first move was leaving: answered, then a second stop.
  assert.equal(a.success, true);
  const names = bridge.requests
    .map((r) => r.route.name)
    .filter((name) => ['set_shade_position', 'stop_shade'].includes(name));
  assert.deepEqual(names, ['set_shade_position', 'stop_shade', 'stop_shade']);
});

test('stop of a tilt and of a shade side by side (no lane)', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.latency = 900;
  const acks = [setValue(ID_A, 'state', 0), setValue(ID_T, 'state', 0)];
  await clock.run(1000);
  const results = await Promise.all(acks);
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true],
  );
});

test('a read silent for a second is cut, and the stop goes', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, app } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', 'hang');
  await clock.run(61 * SECOND);
  assert.equal(app.client.reads.size, 1);
  await clock.run(1500);
  const ack = await setValue(ID_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(app.client.reads.size, 0);
  assert.equal(bridge.of('stop_shade').length, 1);
});

test('a read answering is not cut by a stop', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, app } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', 'hang');
  await clock.run(60.1 * SECOND);
  assert.equal(app.client.reads.size, 1);
  await clock.run(500);
  const ack = await setValue(ID_A, 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(app.client.reads.size, 1);
});

test('a stop the follow-up reads contradict (still going the same way) is sent again, once', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).frozen = true;
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  // Closing (70 -> 0), then a stop.
  assert.equal((await setValue(ID_A, 'position', 0)).success, true);
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  bridge.shades.get(MAC_A).position = 40; // read at 2 s: Gladys 60
  await clock.run(2 * SECOND);
  bridge.shades.get(MAC_A).position = 50; // read at 5 s: Gladys 50, still closing
  await clock.run(3 * SECOND);
  assert.equal(bridge.of('stop_shade').length, 2);
  // The cycle reads never send a stop, even with the shade moving.
  for (const p of [60, 70, 80]) {
    bridge.shades.get(MAC_A).position = p;
    await clock.run(30 * SECOND);
  }
  assert.equal(bridge.of('stop_shade').length, 2);
});

test('a move from the app or a remote after a stop is never stopped by Gladys', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  await clock.run(10 * SECOND);
  // The user opens it from the SOMA app.
  for (const p of [20, 10, 0]) {
    bridge.shades.get(MAC_A).position = p;
    await clock.run(20 * SECOND);
  }
  assert.equal(bridge.of('stop_shade').length, 1);
});

test('after a stop, two equal reads or a move the other way end the check', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).frozen = true;
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'position', 0)).success, true);
  assert.equal((await setValue(ID_A, 'state', 0)).success, true);
  bridge.shades.get(MAC_A).position = 40;
  await clock.run(2 * SECOND);
  bridge.shades.get(MAC_A).position = 10; // opening: someone else moves it
  await clock.run(3 * SECOND);
  assert.equal(bridge.of('stop_shade').length, 1);
});

test('a stop that may have left (no answer) says so and is kept for the next read', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const store = memoryStore();
  const { setValue } = await setup({ clock, bridge, store, devices: createdBoth() });
  bridge.fail(stopOf, 'timeout');
  const ack = await setValue(ID_A, 'state', 0);
  assert.match(ack.error, /Envoyée, sans confirmation/);
  assert.equal(store.data.stops.length, 1);
  await clock.run(61 * SECOND);
  assert.equal(bridge.of('stop_shade').length, 2);
  assert.deepEqual(store.data.stops, []);
});
