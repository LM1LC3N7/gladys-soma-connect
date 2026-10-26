// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP GET to SOMA
// Connect (its API has no TLS), on node:http. A deadline for the whole
// exchange, a size cap on the body (one buffer allocated once, filled in
// place), no redirect followed, no keep-alive, no User-Agent. Resolves
// { status, headers, body } for any status; rejects a SomaError for the
// transport failures, with `sent` true as soon as the request was written to
// a connected socket (it may then have reached SOMA Connect).
// `sendWithin`: the connection must be up within this many ms, else nothing is
// written (a command never leaves late). `beforeSend`: the last check of a
// command, once connected, right before the first byte is written.
// `onHandle`: receives { idleFor(), cut(), closed } while the request runs,
// so that a stop can cut a read that has been silent for a second, and open
// its own connection only once that one is closed.
// Adapted from LM1LC3N7/gladys-slide (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { SomaError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new SomaError('invalid', { sent });
  }
  // Only our own words: a system message may carry an address.
  return new SomaError('unreachable', { sent });
}

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 * @param {(handle: { idleFor: () => number, cut: () => void, closed: Promise<void> }) => (() => void)} [options.onHandle]
 *   called once the request exists; the function it returns is called when it ends
 */
export function httpGet({ host, port, path, timeout, sendWithin, maxBytes, beforeSend, onHandle }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // Until the request is written to a connected socket, nothing has left.
    let connected = false;
    let lastActivity = performance.now();
    let release = () => {};
    let markClosed = () => {};
    const closed = new Promise((done) => {
      markClosed = done;
    });

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      release();
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new SomaError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new SomaError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      lastActivity = performance.now();
      req.end();
    };

    try {
      req = http.request({
        method: 'GET',
        host,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json',
          host: `${host}:${port}`,
          connection: 'close',
        },
      });
      req.on('close', () => markClosed());
      if (onHandle) {
        release =
          onHandle({
            idleFor: () => performance.now() - lastActivity,
            cut: () => finish(new SomaError('cut', { sent: connected })),
            closed,
          }) ?? (() => {});
      }
      req.on('response', (res) => {
        const buffer = Buffer.allocUnsafe(maxBytes);
        let size = 0;
        lastActivity = performance.now();
        res.on('data', (chunk) => {
          lastActivity = performance.now();
          if (size + chunk.length > maxBytes) {
            finish(new SomaError('tooLarge', { sent: true }));
            return;
          }
          chunk.copy(buffer, size);
          size += chunk.length;
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: buffer.subarray(0, size),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a header it refuses: a failure, never a crash.
      markClosed();
      finish(transportError(err, false));
    }
  });
}
