// -----------------------------------------------------------------------------
// The errors of the SOMA Connect client, by kind. The message is English
// (logs) and never holds an address nor a body of SOMA Connect; src/i18n.js
// says them to the user.
//
// `sent`: whether a request that could have had an effect left (its first
// byte written to a connected socket). `answered`: SOMA Connect answered,
// saying it did nothing (an "error" result, a 4xx, a 429): the request had no
// effect. A command error with neither is "not sent"; `sent` without
// `answered` is "sent, without confirmation".
// -----------------------------------------------------------------------------

export const ERROR_KINDS = [
  'unreachable', // no connection (refused, no route, reset before the request)
  'timeout', // no answer in time
  'late', // the connection did not come up in time: nothing written
  'cut', // a read cut to give the way to a stop
  'invalid', // something answered, but not in HTTP (a wrong port)
  'tooLarge', // an answer over the size cap
  'format', // an answer that is not one of SOMA Connect
  'refused', // SOMA Connect answered "error" (the shade out of Bluetooth reach, a bad MAC...)
  'notFound', // HTTP 404 (another firmware: the other form of the URL is tried)
  'rate', // HTTP 429
  'server', // HTTP 5xx
  'http', // another HTTP status
];

export class SomaError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {{ sent?: boolean, answered?: boolean, status?: number, retryAfter?: number }} [details]
   *   retryAfter in ms
   */
  constructor(kind, { sent = false, answered = false, status, retryAfter } = {}) {
    super(status === undefined ? kind : `${kind} (HTTP ${status})`);
    this.name = 'SomaError';
    this.kind = kind;
    this.sent = sent;
    this.answered = answered;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, now = Date.now()) {
  if (typeof value !== 'string' || value === '' || value.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
