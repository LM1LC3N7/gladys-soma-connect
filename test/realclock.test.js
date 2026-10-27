// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing SOMA Connect: the reads really start, at 0,
// the interval and twice the interval, with a bounded number of timers; a
// stop refused by SOMA Connect is really tried again every 250 ms. The time
// is sped up 20 times (the 30 s interval is 1.5 s) but it is the real
// clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SomaApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { SomaClient } from '../src/soma/client.js';
import { httpGet } from '../src/soma/http.js';
import { memoryStore } from '../src/store.js';

const SPEED = 20;
const INTERVAL = POLL_INTERVAL.min * 1000;
const MAC = 'e3:aa:00:00:00:01';
const quiet = () => {};

async function bridgeServer(onRequest, speed = SPEED) {
  const server = createServer((req, res) => {
    onRequest(req.url, performance.now() * speed);
    let body = { result: 'success' };
    if (req.url === '/list_devices') {
      body = { result: 'success', version: '2.3.1', shades: [{ mac: MAC, name: 'Salon' }] };
    } else if (req.url.startsWith('/get_shade_state')) {
      body = { result: 'success', position: 30 };
    } else if (req.url.startsWith('/get_battery_level')) {
      body = { result: 'success', battery_level: 400 };
    } else if (req.url.startsWith('/stop_shade') && onRequest.refuseStops > 0) {
      onRequest.refuseStops -= 1;
      body = { result: 'error', msg: 'busy' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function realApp(config, speed = SPEED) {
  let timersSet = 0;
  // When the app sends each list_devices (the real node:http underneath): the
  // pacing of the app, without the latency of a loaded machine.
  const sent = [];
  const request = (options) => {
    if (options.path === '/list_devices') sent.push(performance.now() * speed);
    return httpGet(options);
  };
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / speed);
    },
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms / speed),
    clearInterval: (handle) => clearInterval(handle),
  };
  const gladys = createFakeGladys({ selector: 'soma-connect', config });
  const app = new SomaApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    client: new SomaClient({ request }),
    now: () => Date.now() * speed,
    monotonic: () => performance.now() * speed,
    timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  return { app, gladys, sent, timersSet: () => timersSet };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const reads = [];
  const server = await bridgeServer((url, at) => {
    if (url === '/list_devices') reads.push(at);
  });
  const { app, gladys, sent, timersSet } = realApp({
    address: `127.0.0.1:${server.address().port}`,
    poll_interval: POLL_INTERVAL.min,
  });
  const started = performance.now() * SPEED;
  try {
    await gladys.connect();
    const deadline = started + INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await sleep(2);
    }
    const until = (reads[0] ?? started) + 2.5 * INTERVAL;
    while (performance.now() * SPEED < until) {
      await sleep(5);
    }
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = sent.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads seen at ${reads.map((t) => Math.round(t - started))}`);
  assert.equal(sent.length, 3, `reads sent at ${at}`);
  assert.ok(sent[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    // Paced from the start of each cycle: what runs before the request (the
    // write of /data) moves the send by a few real ms (times SPEED).
    assert.ok(gap >= 0.95 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet() <= 12, `${timersSet()} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('real clock: a stop refused is tried again every 250 ms, and gets through', async () => {
  const stops = [];
  const record = (url, at) => {
    if (url.startsWith('/stop_shade')) stops.push(at);
  };
  record.refuseStops = 3;
  // Sped up 10 times only: 250 ms are 25 real ms, well above the jitter of a
  // loaded machine.
  const server = await bridgeServer(record, 10);
  const { app, gladys } = realApp({ address: `127.0.0.1:${server.address().port}` }, 10);
  try {
    await gladys.connect();
    while (gladys.fake.discoveredDevices.length === 0) {
      await sleep(2);
    }
    const id = gladys.fake.discoveredDevices[0].external_id;
    const ack = await gladys.fake.setValue({ external_id: id }, { external_id: `${id}:state` }, 0);
    assert.equal(ack.success, true, ack.error);
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(stops.length, 4);
  for (let i = 1; i < stops.length; i += 1) {
    const gap = stops[i] - stops[i - 1];
    // Seen by the server: the latency of the refused answer (a few real ms, times
    // the speed) shortens the gap seen here.
    assert.ok(gap >= 100 && gap < 1000, `gaps ${stops.map((t) => Math.round(t - stops[0]))}`);
  }
});
