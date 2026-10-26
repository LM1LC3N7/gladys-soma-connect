// -----------------------------------------------------------------------------
// The pure parts: the answers of SOMA Connect, the positions, the address
// typed, the URL forms and the state kept in /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost } from '../src/config.js';
import {
  apiPositionFor,
  batteryOf,
  idOf,
  numberIn,
  positionOf,
  shadesOf,
  versionOf,
} from '../src/devices.js';
import { age } from '../src/i18n.js';
import { styleOf, urlOf } from '../src/soma/client.js';
import { normalizeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

test('positions: Gladys 100 = open; SOMA 0 = open; a tilt either way; bounds', () => {
  assert.equal(positionOf({ position: 0 }, 'shade'), 100);
  assert.equal(positionOf({ position: 100 }, 'shade'), 0);
  assert.equal(positionOf({ position: '30' }, 'shade'), 70);
  assert.equal(positionOf({ position: 101 }, 'shade'), undefined);
  assert.equal(positionOf({ position: -5 }, 'shade'), undefined);
  assert.equal(positionOf({ position: 30.4 }, 'shade'), 70);
  assert.equal(positionOf({ position: '30.6' }, 'shade'), 69);
  assert.equal(positionOf({ position: '' }, 'shade'), undefined);
  assert.equal(positionOf({ position: null }, 'shade'), undefined);
  assert.equal(positionOf({}, 'shade'), undefined);
  assert.equal(positionOf({ position: 40 }, 'tilt'), 60);
  assert.equal(positionOf({ position: 40, closed_upwards: 1 }, 'tilt'), 60);
  assert.equal(positionOf({ position: -100 }, 'tilt'), 0);
  assert.equal(positionOf({ position: 150 }, 'tilt'), undefined);
  for (let p = 0; p <= 100; p += 1) {
    assert.equal(apiPositionFor(p), 100 - p);
  }
  assert.equal(apiPositionFor(-20), 100);
  assert.equal(apiPositionFor(130), 0);
  assert.equal(apiPositionFor(33.4), 67);
});

test('battery: percentage, else the voltage level of Home Assistant, bounded', () => {
  assert.equal(batteryOf({ battery_percentage: 77 }), 77);
  assert.equal(batteryOf({ battery_percentage: 140 }), undefined);
  assert.equal(batteryOf({ battery_level: 400 }), 80);
  assert.equal(batteryOf({ battery_level: 450 }), 100);
  assert.equal(batteryOf({ battery_level: 300 }), 0);
  assert.equal(batteryOf({ battery_level: 5000 }), undefined);
  assert.equal(batteryOf({ battery_level: '400' }), undefined);
  assert.equal(batteryOf({}), undefined);
});

test('list_devices: MAC rule, kinds, duplicates, junk and the limit of 32', () => {
  assert.equal(idOf('E3:AA:00:00:00:01'), 'e3aa00000001');
  assert.equal(idOf('e3aa00000001'), 'e3aa00000001');
  for (const bad of ['e3-aa-00-00-00-01', 'e3:aa', 'x'.repeat(17), 12, null, '../list']) {
    assert.equal(idOf(bad), undefined, String(bad));
  }
  const list = shadesOf({
    shades: [
      { mac: 'e3:aa:00:00:00:01', name: 'Salon\u0000\u001b', type: 'shade' },
      { mac: 'e3:aa:00:00:00:02', name: 'Tilt', type: 'TILT' },
      { mac: 'e3:aa:00:00:00:03', name: 'Old' },
      { mac: 'E3:AA:00:00:00:01', name: 'Again' },
      { mac: 'bad' },
      null,
      ['x'],
    ],
  });
  assert.deepEqual(
    list.shades.map((s) => [s.id, s.name, s.kind]),
    [
      ['e3aa00000001', 'Salon', 'shade'],
      ['e3aa00000002', 'Tilt', 'tilt'],
      ['e3aa00000003', 'Old', 'shade'],
    ],
  );
  assert.equal(list.duplicates, 1);
  const many = shadesOf({
    shades: Array.from({ length: 40 }, (_v, n) => ({
      mac: `e3:aa:00:00:00:${n.toString(16).padStart(2, '0')}`,
    })),
  });
  assert.equal(many.shades.length, 32);
  assert.equal(many.dropped, 8);
  assert.deepEqual(shadesOf({ shades: 'x' }).shades, []);
  assert.equal(versionOf({ version: '2.3.1' }), '2.3.1');
  assert.equal(versionOf({ version: 'v3' }), undefined);
});

test('URL forms: query for firmware 3, path otherwise (pysoma); MAC checked', () => {
  assert.equal(styleOf('3.0.12'), 'query');
  // The rule of pysoma: the query form for a major version of exactly 3.
  assert.equal(styleOf('4.1'), 'path');
  assert.equal(styleOf('2.2.6'), 'path');
  assert.equal(styleOf(undefined), undefined);
  assert.equal(styleOf('abc'), undefined);
  const mac = 'e3:aa:00:00:00:01';
  assert.equal(
    urlOf('/set_shade_position', mac, 'query', 40),
    `/set_shade_position?mac=${mac}&pos=40`,
  );
  assert.equal(urlOf('/set_shade_position', mac, 'path', 40), `/set_shade_position/${mac}/40`);
  assert.equal(urlOf('/stop_shade', mac, 'path'), `/stop_shade/${mac}`);
  assert.throws(() => urlOf('/stop_shade', 'e3:aa:00:00:00:01&pos=0', 'query'), { kind: 'format' });
});

test('the address typed: IP or name, port 3000 by default, never shown back', () => {
  assert.deepEqual(parseHost('192.168.1.50').address, { host: '192.168.1.50', port: 3000 });
  assert.deepEqual(parseHost(' http://192.168.1.50:3001/list_devices ').address, {
    host: '192.168.1.50',
    port: 3001,
  });
  assert.deepEqual(parseHost('soma-connect.lan').address, { host: 'soma-connect.lan', port: 3000 });
  assert.equal(parseHost('https://192.168.1.50').invalid, true);
  assert.equal(parseHost('soma.local').local, true);
  assert.equal(parseHost('u:p@192.168.1.50').credentials, true);
  assert.equal(parseHost('192.168.1.50:70000').invalid, true);
  assert.equal(parseHost('999.1.1.1').invalid, true);
  const config = normalizeConfig({ address: 'gibberish!!', poll_interval: '5', language: 'xx' });
  assert.equal(config.invalid, true);
  assert.equal(config.pollInterval, 30);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ gladys_address: '192.168.1.50' }).address, undefined);
});

test('command values: never null, empty or a boolean', () => {
  assert.equal(numberIn('', 0, 100), undefined);
  assert.equal(numberIn(null, 0, 100), undefined);
  assert.equal(numberIn(true, 0, 100), undefined);
  assert.equal(numberIn('42', 0, 100), 42);
  assert.equal(numberIn(100.5, 0, 100), undefined);
});

test('/data: repaired and bounded, never in the future', () => {
  const m = normalizeMemory(
    {
      bridge: { address: '192.168.1.50:3000', version: '3.0.1' },
      shades: [
        { mac: 'e3:aa:00:00:00:01', kind: 'tilt' },
        { mac: 'e3:aa:00:00:00:01', kind: 'shade' },
        { mac: 'bad', kind: 'shade' },
      ],
      lastAttemptAt: NOW + 3600_000,
      pause: { until: NOW + 48 * 3600_000, failures: 3 },
      batteryAt: { e3aa00000001: NOW - 1000, bad: 5 },
      stops: [
        { mac: 'e3:aa:00:00:00:01', at: NOW, resends: 9 },
        { mac: 'x', at: NOW },
      ],
    },
    NOW,
  );
  assert.deepEqual(m.shades, [{ id: 'e3aa00000001', mac: 'e3:aa:00:00:00:01', kind: 'tilt' }]);
  assert.equal(m.lastAttemptAt, NOW);
  assert.equal(m.pause.until, NOW + 6 * 3600_000);
  assert.deepEqual(m.batteryAt, { e3aa00000001: NOW - 1000 });
  assert.deepEqual(m.stops, [{ mac: 'e3:aa:00:00:00:01', at: NOW, resends: 3 }]);
  assert.equal(m.bridge.version, '3.0.1');
  const empty = normalizeMemory('garbage', NOW);
  assert.deepEqual(empty.shades, []);
  assert.equal(empty.bridge, undefined);
  assert.equal(normalizeMemory({ pause: { until: NOW - 1 } }, NOW).pause, undefined);
});

test('durations: 59.6 s is "1 min", never "60 s"', () => {
  assert.equal(age(59_600), '1 min');
  assert.equal(age(45_000), '45 s');
  assert.equal(age(3 * 3600_000), '3 h');
});
