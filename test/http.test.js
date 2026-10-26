// -----------------------------------------------------------------------------
// The client on node:http against a real local server playing SOMA Connect
// (127.0.0.1 only): the URL forms, the size cap, beforeSend, `sent`, and a
// silent read cut for a stop (its connection closed before the stop opens).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SomaClient } from '../src/soma/client.js';

const MAC = 'e3:aa:00:00:00:01';

async function serve(handler) {
  const seen = [];
  let open = 0;
  const server = createServer((req, res) => {
    seen.push(req.url);
    handler(req, res);
  });
  server.on('connection', (socket) => {
    open += 1;
    socket.on('close', () => {
      open -= 1;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = { host: '127.0.0.1', port: server.address().port };
  return {
    address,
    seen,
    open: () => open,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const ok = (res, body = { result: 'success' }) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('the other URL form after a 404, within one deadline; the form that answered kept', async () => {
  const s = await serve((req, res) => {
    if (req.url.startsWith('/stop_shade?mac=')) return ok(res);
    res.writeHead(404);
    res.end();
  });
  try {
    const client = new SomaClient();
    await client.stop(s.address, MAC, undefined, { timeout: 2000 });
    assert.deepEqual(s.seen, [`/stop_shade/${MAC}`, `/stop_shade?mac=${MAC}`]);
    // The form that answered is kept: tried first from then on, whatever the
    // firmware says (a firmware 4 that kept the query form).
    s.seen.length = 0;
    await client.stop(s.address, MAC, 'path', { timeout: 2000 });
    assert.deepEqual(s.seen, [`/stop_shade?mac=${MAC}`]);
    // The form of the firmware wrong and nothing learned yet: the other one after the 404.
    const fresh = new SomaClient();
    s.seen.length = 0;
    await fresh.stop(s.address, MAC, 'path', { timeout: 2000 });
    assert.deepEqual(s.seen, [`/stop_shade/${MAC}`, `/stop_shade?mac=${MAC}`]);
  } finally {
    await s.close();
  }
});

test('an "error" result is a refusal (answered, nothing done); a position is checked again', async () => {
  const s = await serve((_req, res) => ok(res, { result: 'error', msg: 'not reachable' }));
  try {
    const client = new SomaClient();
    await assert.rejects(client.setPosition(s.address, MAC, 50, 'query', { timeout: 2000 }), {
      kind: 'refused',
      answered: true,
    });
    for (const bad of [-1, 101, 50.5, Number.NaN, '50']) {
      await assert.rejects(client.setPosition(s.address, MAC, bad, 'query', { timeout: 2000 }), {
        kind: 'format',
        sent: false,
      });
    }
    await assert.rejects(client.stop(s.address, 'e3:aa/../x', 'path', { timeout: 2000 }), {
      kind: 'format',
    });
    assert.equal(s.seen.length, 1);
  } finally {
    await s.close();
  }
});

test('an answer over the size cap is refused; nothing is read past it', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ result: 'success', junk: 'x'.repeat(100 * 1024) }));
  });
  try {
    await assert.rejects(new SomaClient().listDevices(s.address, { timeout: 2000 }), {
      kind: 'tooLarge',
    });
  } finally {
    await s.close();
  }
});

test('beforeSend refusing: nothing reaches SOMA Connect', async () => {
  const s = await serve((_req, res) => ok(res));
  try {
    const refusal = new Error('stopped');
    await assert.rejects(
      new SomaClient().setPosition(s.address, MAC, 10, 'path', {
        timeout: 2000,
        beforeSend: () => {
          throw refusal;
        },
      }),
      (err) => err === refusal && err.beforeSend === true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(s.seen, []);
  } finally {
    await s.close();
  }
});

test('no connection: not sent; a silence after the request: sent', async () => {
  const s = await serve(() => {});
  const port = s.address.port;
  try {
    await assert.rejects(new SomaClient().stop(s.address, MAC, 'path', { timeout: 300 }), {
      kind: 'timeout',
      sent: true,
    });
  } finally {
    await s.close();
  }
  await assert.rejects(
    new SomaClient().stop({ host: '127.0.0.1', port }, MAC, 'path', { timeout: 1000 }),
    { kind: 'unreachable', sent: false },
  );
});

test('a read silent for a second is cut, its connection closed before the stop opens', async () => {
  let stopAt;
  let openAtStop;
  const s = await serve((req, res) => {
    if (req.url.startsWith('/list_devices')) return; // never answers
    stopAt = performance.now();
    openAtStop = s.open();
    ok(res);
  });
  try {
    const client = new SomaClient();
    const read = client.listDevices(s.address, { timeout: 10_000 });
    const failed = assert.rejects(read, { kind: 'cut' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await client.cutStalled(1000, 200), 0, 'not silent for a second yet');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const cutAt = performance.now();
    assert.equal(await client.cutStalled(1000, 200), 1);
    await client.stop(s.address, MAC, 'path', { timeout: 2000 });
    await failed;
    assert.ok(stopAt - cutAt < 300, `stop ${Math.round(stopAt - cutAt)} ms after the cut`);
    // Only the stop's own connection was open when it arrived.
    assert.equal(openAtStop, 1);
    assert.equal(client.reads.size, 0);
  } finally {
    await s.close();
  }
});
