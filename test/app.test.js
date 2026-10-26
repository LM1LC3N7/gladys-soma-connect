// -----------------------------------------------------------------------------
// SomaApp: discovery, reads, pacing, positions, commands and their
// confirmation, against the SDK's fake Gladys, the exact handlers of the
// container and a fake SOMA Connect, on a clock that moves at every read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { createClock, START } from './helpers/clock.js';
import { createBridge, ID_A, ID_T, MAC_A, MAC_T } from './helpers/fakeBridge.js';
import { HOUR, KEY, MINUTE, SECOND, created, id, setup } from './helpers/app.js';

/** The last transport badge published for a device. */
const badge = (gladys, externalId) =>
  gladys.fake.transports.filter((t) => t.device_external_id === externalId).at(-1);

const createdBoth = () => [created(ID_A), created(ID_T, 'tilt', 'Bureau')];

test('discovery: one shutter per device of SOMA Connect, position and battery', async () => {
  const { gladys, bridge, status, store } = await setup({ devices: createdBoth() });
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [id(ID_A), id(ID_T)],
  );
  const shade = devices[0];
  assert.equal(shade.name, 'Salon');
  assert.deepEqual(
    shade.features.map((f) => [f.category, f.type, f.read_only]),
    [
      ['shutter', 'state', false],
      ['shutter', 'position', false],
      ['battery', 'integer', true],
    ],
  );
  // Shade 30 (SOMA, 0 = open) -> 70 % open; tilt 40 -> 60.
  assert.equal(gladys.fake.lastState(id(ID_A, 'position')), 70);
  assert.equal(gladys.fake.lastState(id(ID_T, 'position')), 60);
  // battery_level 400 -> 2 × (400 − 360) = 80; battery_percentage 77.
  assert.equal(gladys.fake.lastState(id(ID_A, 'battery')), 80);
  assert.equal(gladys.fake.lastState(id(ID_T, 'battery')), 77);
  assert.equal(status().connected, true);
  assert.match(status().message.en, /connected, 2 device\(s\), read every 60 s/);
  assert.equal(bridge.of('list_devices').length, 1);
  // Old firmware: the path form.
  assert.equal(bridge.of('get_shade_state')[0].path, `/get_shade_state/${MAC_A}`);
  // /data: the address, the firmware and the shades (a stop needs no read).
  assert.deepEqual(store.data.bridge, { address: KEY, version: '2.3.1' });
  assert.deepEqual(
    store.data.shades.map((s) => [s.mac, s.kind]),
    [
      [MAC_A, 'shade'],
      [MAC_T, 'tilt'],
    ],
  );
  assert.ok(store.data.lastAttemptAt >= START);
});

test('firmware 3: the query form of the URL', async () => {
  const clock = createClock();
  const bridge = createBridge(clock, { version: '3.1.2' });
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal(bridge.of('get_shade_state')[0].path, `/get_shade_state?mac=${MAC_A}`);
  const ack = await setValue(ID_A, 'position', 25);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.of('set_shade_position')[0].path, `/set_shade_position?mac=${MAC_A}&pos=75`);
});

test('a tilt closed upwards reads as closed; the commands never close upwards', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_T).position = 90;
  bridge.shades.get(MAC_T).upwards = true;
  const { gladys, setValue } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal(gladys.fake.lastState(id(ID_T, 'position')), 10);
  assert.equal((await setValue(ID_T, 'state', -1)).success, true);
  assert.equal(bridge.of('set_shade_position').at(-1).route.pos, '100');
  assert.equal((await setValue(ID_T, 'state', 1)).success, true);
  assert.equal(bridge.of('set_shade_position').at(-1).route.pos, '0');
});

test('a position out of bounds is never published nor taken', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).position = 150;
  const { gladys, status } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal(gladys.fake.lastState(id(ID_A, 'position')), undefined);
  assert.match(status().message.en, /Salon: not read \(not an answer of SOMA Connect\)/);
});

test('reads: never sooner than the interval, then at the interval', async () => {
  const { clock, bridge, gladys } = await setup({ devices: createdBoth() });
  assert.equal(bridge.of('list_devices').length, 1);
  // The Test button, a scan, a reconnection, a configuration saved unchanged: no read.
  await gladys.fake.action('test_connection', {});
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ address: '192.168.1.50' });
  await gladys.disconnect();
  await gladys.connect();
  await clock.run(59 * SECOND);
  assert.equal(bridge.of('list_devices').length, 1);
  await clock.run(2 * SECOND);
  assert.equal(bridge.of('list_devices').length, 2);
  await clock.run(60 * SECOND);
  assert.equal(bridge.of('list_devices').length, 3);
  // The battery: at most once an hour (each read wakes the shade).
  assert.equal(bridge.of('get_battery_level').length, 2);
  await clock.run(HOUR);
  assert.equal(bridge.of('get_battery_level').length, 4);
});

test('a restart reads no sooner than the interval (the time kept in /data)', async () => {
  const store = memoryStore();
  const clock = createClock();
  const first = await setup({ clock, store, devices: createdBoth() });
  await first.app.stop();
  const bridge = createBridge(clock);
  await clock.run(10 * SECOND);
  await setup({ clock, bridge, store, devices: createdBoth() });
  assert.equal(bridge.of('list_devices').length, 0);
  await clock.run(59 * SECOND);
  assert.equal(bridge.of('list_devices').length, 0);
  await clock.run(2 * SECOND);
  assert.equal(bridge.of('list_devices').length, 1);
  // The battery read before the restart is not read again within the hour.
  assert.equal(bridge.of('get_battery_level').length, 0);
});

test('the configuration of Gladys not read: tried again, with a status; moves refused', async () => {
  // The first call is the resynchronization of the SDK itself; the app's two next fail.
  let calls = 0;
  const clock = createClock();
  const bridge = createBridge(clock);
  const { gladys, setValue, status } = await setup({
    clock,
    bridge,
    devices: createdBoth(),
    getConfig: async () => {
      calls += 1;
      if (calls === 2 || calls === 3) {
        throw new Error('Request timeout');
      }
      return { address: '192.168.1.50' };
    },
  });
  assert.equal(status().connected, false);
  assert.match(status().message.en, /not read yet; tried again in 5 s/);
  const ack = await setValue(ID_A, 'position', 50);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore chargée/);
  await clock.run(5 * SECOND);
  assert.match(status().message.en, /tried again in 10 s/);
  await clock.run(11 * SECOND);
  assert.equal(status().connected, true);
  assert.equal(bridge.of('list_devices').length, 1);
  assert.ok(gladys.fake.discoveredDevices.length === 2);
});

test('an address not understood is never shown back; .local and credentials are said', async () => {
  const { status, bridge } = await setup({ config: { address: 'my-secret-key%%' } });
  assert.equal(status().connected, false);
  assert.doesNotMatch(status().message.en, /my-secret-key/);
  assert.match(status().message.en, /not understood/);
  assert.equal(bridge.requests.length, 0);
  const local = await setup({ config: { address: 'soma.local' } });
  assert.match(local.status().message.en, /\.local/);
  const creds = await setup({ config: { address: 'admin:pw@192.168.1.50' } });
  assert.doesNotMatch(creds.status().message.en, /pw|admin/);
  assert.match(creds.status().message.en, /"@"/);
});

test('a move: the position asked (100 − Gladys), confirmed by a read of it', async () => {
  const { setValue, bridge, clock, gladys } = await setup({ devices: createdBoth() });
  const ack = await setValue(ID_A, 'position', 20);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.of('set_shade_position')[0].path, `/set_shade_position/${MAC_A}/80`);
  await clock.run(2 * SECOND);
  assert.equal(gladys.fake.lastState(id(ID_A, 'position')), 20);
  const transport = badge(gladys, id(ID_A));
  assert.equal(transport.degraded, undefined);
});

test('open and close; bad values are refused and nothing is sent', async () => {
  const { setValue, bridge } = await setup({ devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'state', 1)).success, true);
  assert.equal(bridge.of('set_shade_position').at(-1).route.pos, '0');
  assert.equal((await setValue(ID_A, 'state', -1)).success, true);
  assert.equal(bridge.of('set_shade_position').at(-1).route.pos, '100');
  for (const bad of ['', null, true, 2, 101, -1, 'abc', Number.NaN]) {
    const key = bad === 2 ? 'state' : 'position';
    const ack = await setValue(ID_A, key, bad);
    assert.equal(ack.success, false, `${bad}`);
  }
  assert.equal(bridge.of('set_shade_position').length, 2);
  const battery = await setValue(ID_A, 'battery', 50);
  assert.equal(battery.success, false);
});

test('a move not reached: badge and status after the last follow-up read', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).frozen = true;
  const { setValue, gladys, status } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal((await setValue(ID_A, 'position', 0)).success, true);
  await clock.run(5 * SECOND);
  // A read equal to the position before the move: "not applied yet", nothing said.
  assert.doesNotMatch(status().message.en, /did not reach/);
  await clock.run(90 * SECOND);
  assert.match(
    status().message.en,
    /Salon: 70 % open; battery 80 %; did not reach 0 % \(read 70 %\)/,
  );
  const transport = badge(gladys, id(ID_A));
  assert.equal(transport.degraded, true);
});

test('a refused move (shade out of Bluetooth reach) says so; nothing done', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.shades.get(MAC_A).reachable = false;
  const ack = await setValue(ID_A, 'position', 10);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Refusée : SOMA Connect a répondu une erreur/);
});

test('a move not sent (no connection) is "not sent"; one without an answer "sent, without confirmation"', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, gladys } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'set_shade_position', 'unreachable');
  let ack = await setValue(ID_A, 'position', 10);
  assert.match(ack.error, /Non envoyée : pas de connexion/);
  bridge.fail((r) => r?.name === 'set_shade_position', 'timeout');
  ack = await setValue(ID_A, 'position', 10);
  assert.match(ack.error, /Envoyée, sans confirmation/);
  await clock.run(0);
  const transport = badge(gladys, id(ID_A));
  assert.equal(transport.degraded, true);
});

test('a scene of five shades with slow answers sets the five', async () => {
  const clock = createClock();
  const shades = [1, 2, 3, 4, 5].map((n) => ({
    mac: `e3:aa:00:00:00:0${n}`,
    name: `Store ${n}`,
    type: 'shade',
    position: 0,
    battery_level: 400,
  }));
  const bridge = createBridge(clock, { shades });
  const devices = shades.map((s, n) => created(`e3aa0000000${n + 1}`, 'shade', s.name));
  const { setValue } = await setup({ clock, bridge, devices });
  bridge.latency = 900;
  const acks = shades.map((_s, n) => setValue(`e3aa0000000${n + 1}`, 'position', 0));
  await clock.run(5 * SECOND);
  const results = await Promise.all(acks);
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, true],
  );
  assert.equal(bridge.of('set_shade_position').length, 5);
});

test('moves of one shade wait their turn, a few at most', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.latency = 500;
  const acks = [10, 20, 30, 40, 50, 60, 70].map((p) => setValue(ID_A, 'position', p));
  await clock.run(10 * SECOND);
  const results = await Promise.all(acks);
  // One sent, four waiting: the sixth and the seventh refused at once; the
  // ones that cannot leave within 3.5 s of their arrival are refused unsent.
  assert.equal(results[5].success, false);
  assert.match(results[5].error, /attendent déjà/);
  assert.match(results[6].error, /attendent déjà/);
  const sent = bridge.of('set_shade_position').length;
  assert.equal(results.filter((r) => r.success).length, sent);
  assert.ok(sent >= 4 && sent <= 5, `${sent} sent`);
});

test('a 429: paused (reads and moves wait), kept in /data', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { setValue, status, store } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.fail((r) => r?.name === 'list_devices', {
    status: 429,
    headers: { 'retry-after': '600' },
    body: Buffer.from(''),
  });
  await clock.run(60 * SECOND);
  assert.match(status().message.en, /paused for 10 min/);
  assert.ok(store.data.pause.until > START);
  const ack = await setValue(ID_A, 'position', 50);
  assert.match(ack.error, /en pause/);
  const reads = bridge.of('list_devices').length;
  await clock.run(5 * MINUTE);
  assert.equal(bridge.of('list_devices').length, reads);
  await clock.run(5.5 * MINUTE);
  assert.equal(bridge.of('list_devices').length, reads + 1);
});

test('SOMA Connect unreachable: spaced tries, never sooner than the interval; the others kept', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { status } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.down = true;
  await clock.run(60 * SECOND);
  assert.match(status().message.en, /unreachable \(no connection\); tried again in 1 min/);
  const before = bridge.requests.length;
  bridge.down = false;
  await clock.run(59 * SECOND);
  assert.equal(bridge.requests.length, before);
  await clock.run(2 * SECOND);
  assert.ok(bridge.requests.length > before);
  assert.equal(status().connected, true);
});

test('one shade out of reach never holds the others', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.shades.get(MAC_A).reachable = false;
  const { status, gladys } = await setup({ clock, bridge, devices: createdBoth() });
  assert.equal(gladys.fake.lastState(id(ID_T, 'position')), 60);
  assert.match(status().message.en, /Salon: not read \(SOMA Connect answered an error/);
  assert.equal(badge(gladys, id(ID_A)).transport, 'unreachable');
  assert.equal(badge(gladys, id(ID_T)).transport, 'local');
});

test('a type changed in SOMA Connect applies at the next Scan only', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { status, gladys } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.shades.get(MAC_A).type = 'tilt';
  await clock.run(61 * SECOND);
  assert.match(status().message.en, /press "Scan"/);
  assert.equal(
    gladys.fake.discoveredDevices[0].params.find((p) => p.name === 'SOMA_TYPE').value,
    'shade',
  );
  await gladys.fake.scanRequest();
  assert.equal(
    gladys.fake.discoveredDevices[0].params.find((p) => p.name === 'SOMA_TYPE').value,
    'tilt',
  );
  assert.doesNotMatch(status().message.en, /press "Scan"/);
});

test('a device published again never loses a feature; duplicates and junk are skipped', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  bridge.listExtra = [
    { mac: MAC_A, name: 'Double', type: 'shade' },
    { mac: 'not-a-mac', name: 'X' },
    'junk',
  ];
  const device = created(ID_A);
  device.features.push({
    name: 'Old',
    external_id: id(ID_A, 'old'),
    category: 'shutter',
    type: 'state',
    min: -1,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
  });
  const { gladys, status } = await setup({ clock, bridge, devices: [device] });
  const published = gladys.fake.discoveredDevices.find((d) => d.external_id === id(ID_A));
  assert.ok(published.features.some((f) => f.external_id === id(ID_A, 'old')));
  assert.equal(published.name, 'Salon');
  assert.match(status().message.en, /1 entry\(ies\) of list_devices repeat a MAC address/);
});

test('a device no longer listed is said in the status, its badge unreachable', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const gone = created('e3aa000000ff', 'shade', 'Ancien');
  const { status, gladys } = await setup({ clock, bridge, devices: [...createdBoth(), gone] });
  assert.match(status().message.en, /No longer listed by SOMA Connect: Ancien/);
  const last = badge(gladys, gone.external_id);
  assert.equal(last.transport, 'unreachable');
});

test('values of a failing SOMA Connect are never republished as new', async () => {
  const clock = createClock();
  const bridge = createBridge(clock);
  const { gladys } = await setup({ clock, bridge, devices: createdBoth() });
  bridge.down = true;
  await clock.run(60 * SECOND);
  const count = gladys.fake.states.length;
  await gladys.fake.deviceUpdated(created(ID_A));
  await clock.run(30 * MINUTE);
  assert.equal(gladys.fake.states.length, count);
});

test('the language of the feature names', async () => {
  const { gladys } = await setup({ config: { address: '192.168.1.50', language: 'en' } });
  assert.equal(gladys.fake.discoveredDevices[0].features[0].name, 'Open / close');
  await gladys.fake.configUpdated({ address: '192.168.1.50', language: 'fr' });
  assert.equal(gladys.fake.discoveredDevices[0].features[0].name, 'Ouverture / fermeture');
});
