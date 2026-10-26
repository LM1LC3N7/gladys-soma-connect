// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the vocabulary of the SOMA Connect HTTP API and the tuning
// of the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the read interval (seconds), mirrored by the manifest. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** The port of the HTTP API of SOMA Connect when none is typed. */
export const DEFAULT_PORT = 3000;

/** At most this many shades of one SOMA Connect are taken. */
export const MAX_SHADES = 32;

/**
 * The HTTP API of SOMA Connect (pysoma, MIT, Wazombi Labs OÜ): GET requests,
 * JSON answers holding `result: "success"` (or "error" with `msg`). Firmware 3
 * takes the MAC address as a query parameter (`/stop_shade?mac=..`), older
 * firmware as a path segment (`/stop_shade/<mac>`).
 */
export const API = {
  list: '/list_devices',
  state: '/get_shade_state',
  battery: '/get_battery_level',
  setPosition: '/set_shade_position',
  stop: '/stop_shade',
};

/** The feature keys (frozen: the external ids end with them). */
export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
  BATTERY: 'battery',
};

/** Gladys COVER_STATE values (shutter `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

/** The kinds of SOMA devices (`type` of list_devices; missing before Connect 2.2.6: a shade). */
export const KINDS = { SHADE: 'shade', TILT: 'tilt' };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Size of an answer of SOMA Connect (list_devices of 32 shades is a few KB). */
  responseBytes: 64 * 1024,
  /** Entries of list_devices looked at (the first MAX_SHADES valid ones are kept). */
  listEntries: 128,
  /** Characters of a name read from SOMA Connect kept in Gladys. */
  name: 60,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
  /** Distance (in Gladys percent) under which a position read equals the one asked. */
  positionTolerance: 2,
  /** Moves of one shade waiting behind the one being sent; more are refused at once. */
  laneWaiting: 4,
  /** Reads of a cycle run side by side, at most. */
  readsAtOnce: 4,
  /** A refused or contradicted stop is sent again at most this many times. */
  stopResends: 3,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /** One read request (SOMA Connect asks the shade over Bluetooth: it can take a second or two). */
  readTimeout: 4 * SECOND,
  /** The battery of a shade is read at most this often (each read wakes the shade). */
  batteryEvery: HOUR,
  /** The last read time is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
  /** Delays after a failure of SOMA Connect (never sooner than the interval). */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** Bounds of the pause after a 429 or a 5xx (Retry-After, or doubled from the min). */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /**
   * Gladys acks a set_value within 5 s: a command not sent within 3.5 s of
   * its arrival is refused, never sent late; its answer is awaited until 4.3 s.
   */
  commandSendBy: 3500,
  commandAnswerBy: 4300,
  /** A stop that failed is tried again this often, within its 3.5 s. */
  stopRetryEvery: 250,
  /** A read without a byte for this long is cut when a stop needs the way. */
  stalledAfter: SECOND,
  /** A stop waits at most this long for the connection of a cut read to close. */
  closeWait: 200,
  /** A shade is read again at these delays after a command (a full travel can take a minute). */
  followUps: [2 * SECOND, 5 * SECOND, 20 * SECOND, 45 * SECOND, 90 * SECOND],
  /** The configuration of Gladys not read at the start: tried again from 5 s, doubled, up to 5 min. */
  configRetryMin: 5 * SECOND,
  configRetryMax: 5 * MINUTE,
};
