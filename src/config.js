// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. There is no
// secret: the HTTP API of SOMA Connect has no authentication.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A text read from SOMA Connect, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (3000 by default). A pasted URL ("http://192.168.1.50:3000/list_devices")
 * is reduced to its host. Credentials in it are refused and never shown;
 * names in .local are refused (mDNS does not resolve in the container).
 * @returns {{ address?: { host: string, port: number }, invalid?: boolean, credentials?: boolean, local?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260 || /^https:\/\//i.test(text)) {
    // The API of SOMA Connect answers in plain HTTP only.
    return { invalid: true };
  }
  text = text.replace(/^http:\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: true };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: true };
  }
  if (/\.local\.?$/.test(host)) {
    return { local: true, invalid: true };
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? { address: { host, port } } : { invalid: true };
}

/** `host:port`: the key of the bridge in /data and in the statuses. */
export const addressKey = (address) => (address ? `${address.host}:${address.port}` : '');

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

/**
 * @returns {{ address?: { host: string, port: number }, key: string,
 *   invalid: boolean, local: boolean, credentialsInHost: boolean,
 *   pollInterval: number, language: 'fr'|'en' }}
 *   An address typed but not understood is never shown back (it may be
 *   something pasted in the wrong field): only that it is not understood.
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const parsed = parseHost(typeof c.address === 'string' ? c.address : '');
  return {
    address: parsed.address,
    key: addressKey(parsed.address),
    invalid: Boolean(parsed.invalid),
    local: Boolean(parsed.local),
    credentialsInHost: Boolean(parsed.credentials),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
