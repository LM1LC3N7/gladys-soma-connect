// -----------------------------------------------------------------------------
// The HTTP API of SOMA Connect, ported from pysoma (MIT, Wazombi Labs OÜ, the
// maker of SOMA): list_devices, get_shade_state, get_battery_level,
// set_shade_position and stop_shade, as GET requests answered in JSON.
// The Bluetooth link to the shades stays inside SOMA Connect: this
// integration only speaks HTTP to it.
//
// Two forms of URL: firmware 3 takes `?mac=<mac>&pos=<pos>`, older firmware
// `/<mac>/<pos>` (pysoma reads the major version of list_devices). When the
// version is not known yet (a stop before the first read with nothing in
// /data), the path form is tried first and a 404 (nothing done) tries the
// other one within the same deadline.
// -----------------------------------------------------------------------------

import { API, LIMITS } from '../constants.js';
import { SomaError, retryAfterOf } from './errors.js';
import { httpGet } from './http.js';

/** The URL forms: 'query' (firmware 3 and later) or 'path' (older ones). */
export const STYLES = { QUERY: 'query', PATH: 'path' };

/** A MAC address as SOMA Connect gives it: six hexadecimal pairs separated by ':' (or 12 digits). */
const RAW_MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i;
export const isRawMac = (value) => typeof value === 'string' && RAW_MAC.test(value);

/** The URL form of a firmware version ("3.0.12" -> 'query'), or undefined when unknown. */
export function styleOf(version) {
  const major = /^(\d{1,4})(?:\.\d{1,6}){0,4}$/.exec(version ?? '')?.[1];
  if (major === undefined) {
    return undefined;
  }
  return Number(major) >= 3 ? STYLES.QUERY : STYLES.PATH;
}

/** The URL of a request for one shade. */
export function urlOf(base, mac, style, pos) {
  if (!isRawMac(mac)) {
    throw new SomaError('format');
  }
  if (style === STYLES.QUERY) {
    return pos === undefined ? `${base}?mac=${mac}` : `${base}?mac=${mac}&pos=${pos}`;
  }
  return pos === undefined ? `${base}/${mac}` : `${base}/${mac}/${pos}`;
}

/** The answer of SOMA Connect: a JSON object whose `result` is "success", else a SomaError. */
export function parseAnswer(res, now = Date.now()) {
  const status = res?.status;
  if (status === 404) {
    throw new SomaError('notFound', { sent: true, answered: true, status });
  }
  if (status === 429) {
    throw new SomaError('rate', {
      sent: true,
      answered: true,
      status,
      retryAfter: retryAfterOf(res.headers?.['retry-after'], now),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new SomaError('server', {
      sent: true,
      status,
      retryAfter: retryAfterOf(res.headers?.['retry-after'], now),
    });
  }
  if (status !== 200) {
    throw new SomaError('http', { sent: true, answered: true, status });
  }
  let json;
  try {
    json = JSON.parse(Buffer.from(res.body ?? '').toString('utf8'));
  } catch {
    throw new SomaError('format', { sent: true });
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.result !== 'string') {
    throw new SomaError('format', { sent: true });
  }
  if (json.result.toLowerCase() !== 'success') {
    throw new SomaError('refused', { sent: true, answered: true });
  }
  return json;
}

/** A position for SOMA Connect: an integer 0..100, else nothing leaves (the last guard). */
export function apiPosition(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new SomaError('format');
  }
  return value;
}

export class SomaClient {
  /**
   * @param {{ request?: typeof httpGet, now?: () => number }} [options]
   *   `request` is replaced in the tests (never the network).
   */
  constructor({ request = httpGet, now = Date.now } = {}) {
    this.request = request;
    this.now = now;
    /** The reads running (their handles): a stop may cut a silent one. */
    this.reads = new Set();
  }

  async call(address, path, { timeout, sendWithin, beforeSend, read = false }) {
    const res = await this.request({
      host: address.host,
      port: address.port,
      path,
      timeout,
      sendWithin,
      beforeSend,
      maxBytes: LIMITS.responseBytes,
      onHandle: read
        ? (handle) => {
            this.reads.add(handle);
            return () => this.reads.delete(handle);
          }
        : undefined,
    });
    return parseAnswer(res, this.now());
  }

  /**
   * A request for one shade, in the URL form of the firmware; unknown: the
   * path form, then the query form after a 404 (nothing done), within the
   * same deadline.
   */
  async forShade(address, base, mac, style, pos, options) {
    const styles = style ? [style] : [STYLES.PATH, STYLES.QUERY];
    const startedAt = this.now();
    for (let i = 0; ; i += 1) {
      const spent = this.now() - startedAt;
      try {
        return await this.call(address, urlOf(base, mac, styles[i], pos), {
          ...options,
          timeout: options.timeout - spent,
          sendWithin: options.sendWithin === undefined ? undefined : options.sendWithin - spent,
        });
      } catch (err) {
        if (err?.kind !== 'notFound' || i + 1 >= styles.length) {
          throw err;
        }
      }
    }
  }

  /** list_devices: `{ version, shades }` as SOMA Connect gives them (checked by src/devices.js). */
  listDevices(address, options) {
    return this.call(address, API.list, { ...options, read: true });
  }

  shadeState(address, mac, style, options) {
    return this.forShade(address, API.state, mac, style, undefined, { ...options, read: true });
  }

  battery(address, mac, style, options) {
    return this.forShade(address, API.battery, mac, style, undefined, { ...options, read: true });
  }

  /** set_shade_position: `pos` 0 (open) .. 100 (closed), an integer, checked again here. */
  async setPosition(address, mac, pos, style, options) {
    return this.forShade(address, API.setPosition, mac, style, apiPosition(pos), options);
  }

  stop(address, mac, style, options) {
    return this.forShade(address, API.stop, mac, style, undefined, options);
  }

  /**
   * The reads silent for `stalledAfter` ms are cut; resolves once their
   * connections are closed, or after `closeWait` ms at most.
   */
  async cutStalled(stalledAfter, closeWait, timers = globalThis) {
    const cut = [...this.reads].filter((h) => h.idleFor() >= stalledAfter);
    if (cut.length === 0) {
      return 0;
    }
    for (const handle of cut) {
      handle.cut();
    }
    let timer;
    await Promise.race([
      Promise.all(cut.map((h) => h.closed)),
      new Promise((resolve) => {
        timer = timers.setTimeout(resolve, closeWait);
      }),
    ]);
    timers.clearTimeout(timer);
    return cut.length;
  }
}
