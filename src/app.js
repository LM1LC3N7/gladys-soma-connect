// -----------------------------------------------------------------------------
// The integration: one SOMA Connect (its IP address in the configuration),
// read every poll interval (list_devices, then the position of each shade,
// its battery at most once an hour), one Gladys device per shade (a
// shutter), the transport badges, the "Test the connection" button, and the
// commands (open, close, stop, position). index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// Commands:
//   - a move (open, close, position) goes through the lane of its shade (one
//     at a time, 4 waiting at most); the shades have a lane each, so a scene
//     that moves five shades sends the five side by side. A move is sent
//     within 3.5 s of its arrival or refused unsent, answered by 4.3 s; a
//     move that may have reached SOMA Connect is never answered "not sent"
//     ("sent, without confirmation", then reads); never retried. The position
//     written is always an integer 0..100 (checked again in the client).
//   - STOP never waits: no lane, no read before it, no option; it goes
//     through a 429/5xx pause and a backoff, works before the first read (the
//     address, the firmware and the shades are kept in /data), and cancels
//     every move of that shade not sent yet (a move asked before a stop never
//     leaves after it). A read silent for a second is cut first, and the stop
//     opens its connection once that one is closed. A stop that fails is
//     tried again every 250 ms within its 3.5 s, then kept (in /data) and
//     sent again by the next reads, 3 times at most, unless a newer move of
//     that shade was accepted meanwhile. A stop followed by reads that show
//     the shade still moving is sent again (3 times at most).
//   - The ack says that SOMA Connect accepted the command. A move is
//     confirmed only by a read of the position asked (within 2 %); a read
//     equal to the position before the move is "not applied yet"; the
//     follow-up reads (2, 5, 20, 45, 90 s) conclude, and a position never
//     reached shows on the badge and in the status.
// Reads: never sooner than the interval (the Test button, a scan, a
// reconnection to Gladys, a configuration saved unchanged, a restart: the
// time of the last read is kept in /data), except the reads that follow a
// command; one read of a shade at a time; a read begun before a command left
// is not applied; a read of an older configuration publishes nothing
// (generation checked after every await).
// Failures: 429/5xx -> a pause of 1 min to 6 h kept in /data; anything else
// -> 30 s, 1, 2, 5 min, never sooner than the interval. One shade that does
// not answer (out of Bluetooth reach of SOMA Connect) never holds the others.
//
// Two clocks: `now` (wall clock) for what /data keeps; `monotonic` paces the
// reads, the pauses, the deadlines and the freshness, so that a wall clock
// set back or forward never stops nor hurries them. Each decision reads the
// clock once (`dueAt(mono)` takes the instant read by its caller).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseHost } from './config.js';
import { COVER_STATE, FEATURES, LIMITS, MINUTE, SECOND, TIMINGS } from './constants.js';
import {
  apiPositionFor,
  batteryOf,
  buildDevice,
  nameOf,
  numberIn,
  parseExternalId,
  positionOf,
  shadeIds,
  shadesOf,
  versionOf,
} from './devices.js';
import { ERRORS, T, age, join, reasonOf, word } from './i18n.js';
import { Lane, LaneFull } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import { SomaClient, styleOf } from './soma/client.js';

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
];

const COMMAND_KEYS = new Set([FEATURES.STATE, FEATURES.POSITION]);
const PAUSE_KINDS = new Set(['rate', 'server']);
const NOT_SOMA_KINDS = new Set(['format', 'http', 'invalid', 'tooLarge', 'notFound']);
/** A stop failing so is tried again within its budget: nothing reached the motor. */
const RETRY_KINDS = new Set([
  'unreachable',
  'late',
  'refused',
  'notFound',
  'http',
  'rate',
  'server',
]);

const freshShade = ({ id, mac, kind, name = '' }) => ({
  id,
  mac,
  kind,
  /** The kind listed last: a change applies at the next Scan only. */
  kindSeen: kind,
  name,
  /** true: in the last list_devices; undefined: known from /data only. */
  listed: undefined,
  lane: new Lane(LIMITS.laneWaiting),
  tickets: new Set(),
  /** The request of a move between its first byte and its answer. */
  inFlight: undefined,
  /** Number of the last move accepted by SOMA Connect (a newer one cancels an older stop). */
  acceptedSeq: 0,
  /** Number of the last stop asked: a move numbered before it never leaves. */
  stopSeq: 0,
  /** When the last command left (monotonic): a read begun before is not applied. */
  lastSentAt: -Infinity,
  position: undefined,
  readAt: undefined,
  online: undefined,
  reason: undefined,
  battery: undefined,
  batteryReadAt: undefined,
  /** When the battery was last asked (monotonic; kept in /data as wall clock). */
  batteryAt: -Infinity,
  target: undefined,
  before: undefined,
  unconfirmed: false,
  notReached: undefined,
  followUps: new Set(),
  reading: undefined,
  readingSince: -Infinity,
  /** A stop that did not get through: `{ seq, resends, at, given }`. */
  pendingStop: undefined,
  /** After a stop: the reads that check the shade stopped. */
  stopWatch: undefined,
});

export class SomaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'soma-connect' }),
    client = new SomaClient(),
    store = fileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.loaded = false;
    this.started = false;
    this.memory = undefined;
    this.generation = 0;
    /** The address the commands go to: the configuration's, else the one kept in /data. */
    this.address = undefined;
    this.version = undefined;
    /** id -> shade */
    this.shades = new Map();
    this.bridge = { online: undefined, failures: 0, nextTryAt: -Infinity };
    this.pause = undefined;
    this.lastAttemptAt = undefined;
    this.lastStopRound = undefined;
    this.listNotes = { duplicates: 0, dropped: 0 };
    this.timer = undefined;
    /** The timer of the stops kept (independent of the configuration and of the reads). */
    this.stopTimer = undefined;
    this.stopping = undefined;
    this.closed = false;
    this.busy = undefined;
    this.configRetry = { timer: undefined, failures: 0, wait: undefined };
    this.commandSeq = 0;
    /** device external id -> device published in this run (a publication never shrinks) */
    this.known = new Map();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** /data, once: the address, the firmware, the shades, the pause and the stops kept. */
  async loadMemory() {
    if (this.memory) {
      return;
    }
    const raw = await this.store.load().catch(() => null);
    if (this.memory) {
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const m = normalizeMemory(raw, now);
    this.memory = m;
    // Wall-clock times brought onto the monotonic clock.
    const toMono = (wall) => mono - (now - wall);
    if (m.lastAttemptAt > 0) {
      // Written at most once a minute: the real last read may be up to a
      // minute later than the one kept.
      this.lastAttemptAt = Math.min(mono, toMono(m.lastAttemptAt) + TIMINGS.attemptPersistEvery);
    }
    if (m.pause) {
      this.pause = { due: toMono(m.pause.until), failures: m.pause.failures, kind: m.pause.kind };
    }
    if (m.bridge) {
      this.address = parseHost(m.bridge.address).address;
      this.version = m.bridge.version;
      this.client.style = m.bridge.style;
    }
    for (const kept of m.shades) {
      const shade = freshShade(kept);
      if (m.batteryAt[kept.id]) {
        shade.batteryAt = toMono(m.batteryAt[kept.id]);
      }
      this.shades.set(kept.id, shade);
    }
    for (const stop of m.stops) {
      const shade = [...this.shades.values()].find((s) => s.mac === stop.mac);
      if (shade) {
        shade.pendingStop = { seq: 0, resends: stop.resends, at: stop.at, given: false };
      }
    }
  }

  /**
   * Connected to Gladys: the configuration is read (tried again from 5 s up
   * to every 5 min while it fails, with a status; a stop still works from
   * /data meanwhile). After a reconnection, what Gladys keeps in memory
   * (status, Discovery tab, badges) is sent again; nothing is read sooner.
   */
  async connected(getConfig) {
    await this.loadMemory();
    // The stops kept leave now, whatever becomes of the configuration.
    this.scheduleStops();
    if (this.started && this.loaded) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    }
    this.started = true;
    await this.readConfig(getConfig);
  }

  async readConfig(getConfig) {
    this.clearConfigRetry();
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.configRetry.failures += 1;
      const wait = Math.min(
        TIMINGS.configRetryMin * 2 ** Math.min(this.configRetry.failures - 1, 10),
        TIMINGS.configRetryMax,
      );
      this.configRetry.wait = wait;
      this.logger.warn(
        `Reading the configuration failed (${err?.name ?? 'Error'}); again in ${age(wait)}`,
      );
      this.configRetry.timer = this.timers.setTimeout(() => {
        this.configRetry.timer = undefined;
        this.readConfig(getConfig).catch(() => this.logger.error('Start failed'));
      }, wait);
      await this.updateStatus();
      return;
    }
    this.configRetry.failures = 0;
    this.configRetry.wait = undefined;
    await this.configUpdated(raw, { republish: true });
  }

  clearConfigRetry() {
    if (this.configRetry.timer !== undefined) {
      this.timers.clearTimeout(this.configRetry.timer);
      this.configRetry.timer = undefined;
    }
  }

  /**
   * A configuration saved (or read at the start). Another address starts
   * over; anything else (interval, language) applies at once, without a read.
   */
  async configUpdated(raw = {}, { republish = false } = {}) {
    await this.loadMemory();
    this.clearConfigRetry();
    this.configRetry.wait = undefined;
    const next = normalizeConfig(raw);
    if (!this.loaded || next.key !== this.config.key) {
      await this.start(next);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (previous.pollInterval !== next.pollInterval && !this.busy) {
      this.schedule();
    }
    if (republish) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll({ states: republish });
  }

  async start(config) {
    this.halt();
    const generation = this.generation;
    const first = !this.loaded;
    this.loaded = true;
    this.config = config;
    if (config.address) {
      // start() runs at the first configuration and when the address changes.
      const kept = this.memory.bridge;
      if (!first || kept?.address !== config.key) {
        // Another SOMA Connect: read at once; its firmware is the one kept
        // for that address, else not known yet.
        this.version = kept?.address === config.key ? kept.version : undefined;
        this.lastAttemptAt = undefined;
        this.lastStopRound = undefined;
      }
      this.address = config.address;
    }
    if (!first) {
      this.bridge = { online: undefined, failures: 0, nextTryAt: -Infinity };
    }
    this.published = undefined;
    this.badges = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll();
    if (generation !== this.generation || !config.address) {
      return;
    }
    this.schedule();
  }

  /** Timers of the reads and of the follow-ups stopped (a new generation). */
  halt() {
    this.generation += 1;
    this.clearTimer();
    for (const shade of this.shades.values()) {
      for (const handle of shade.followUps) {
        this.timers.clearTimeout(handle);
      }
      shade.followUps.clear();
    }
    this.publisher.stop();
  }

  async stop() {
    this.halt();
    this.closed = true;
    if (this.stopTimer !== undefined) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    this.clearConfigRetry();
    await this.saveAttempt(true);
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async saveMemory() {
    if (!this.memory) {
      return;
    }
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The time of the last read in /data: at most once a minute (or at a clean stop). */
  async saveAttempt(force = false) {
    if (!this.memory || this.lastAttemptAt === undefined) {
      return;
    }
    const wall = this.now() - (this.monotonic() - this.lastAttemptAt);
    if (
      force
        ? wall > this.memory.lastAttemptAt
        : wall - this.memory.lastAttemptAt >= TIMINGS.attemptPersistEvery
    ) {
      this.memory.lastAttemptAt = Math.round(wall);
      await this.saveMemory();
    }
  }

  // --- Pacing ----------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** How long a read stays recent: two intervals and a minute. */
  freshFor() {
    return 2 * this.interval + TIMINGS.attemptPersistEvery;
  }

  /** The rest of the pause (ms), capped to its maximum at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /** The monotonic time from which the next read may start, from the caller's instant. */
  dueAt(mono) {
    let due = this.lastAttemptAt === undefined ? mono : this.lastAttemptAt + this.interval;
    if (this.bridge.online === false) {
      due = Math.max(due, this.bridge.nextTryAt);
    }
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  hasPendingStops() {
    return [...this.shades.values()].some((s) => s.pendingStop && !s.pendingStop.given);
  }

  /**
   * When the stops kept are sent again: once a minute, through a pause or a
   * backoff, with or without the configuration (the address kept in /data);
   * at once after a restart.
   */
  stopsDueAt(mono) {
    return this.lastStopRound === undefined ? mono : this.lastStopRound + MINUTE;
  }

  /** The timer of the stops kept: its own, armed from /data at the start. */
  scheduleStops() {
    if (this.stopTimer !== undefined) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    if (this.closed || !this.hasPendingStops()) {
      return;
    }
    const mono = this.monotonic();
    this.stopTimer = this.timers.setTimeout(
      () => {
        this.stopTimer = undefined;
        this.runStops()
          .catch(() => this.logger.error('Sending the stops kept failed'))
          .finally(() => this.scheduleStops());
      },
      Math.max(0, this.stopsDueAt(mono) - mono),
    );
  }

  /** One round of the stops kept, never two at once. */
  runStops() {
    if (!this.stopping) {
      this.lastStopRound = this.monotonic();
      this.stopping = this.resendStops()
        .then(() => this.publishAll())
        .finally(() => {
          this.stopping = undefined;
        });
    }
    return this.stopping;
  }

  /** One timer: the next read, when due. */
  schedule() {
    this.clearTimer();
    if (!this.loaded || !this.config.address) {
      return;
    }
    const mono = this.monotonic();
    const at = this.dueAt(mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.loop(generation);
        }
      },
      Math.max(0, at - mono),
    );
  }

  async loop(generation) {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`Refresh failed (${err?.name ?? 'Error'})`);
    }
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /** One cycle at a time: a tick during a cycle joins it. */
  tick(options = {}) {
    if (!this.busy) {
      this.busy = this.cycle(options).finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  async cycle({ force = false } = {}) {
    const generation = this.generation;
    const address = this.config.address;
    if (!address) {
      return;
    }
    const gone = () => generation !== this.generation;
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0 || (!force && mono < this.dueAt(mono))) {
      await this.publishAll();
      return;
    }
    this.lastAttemptAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt();
    if (gone()) return;
    let json;
    try {
      json = await this.client.listDevices(address, { timeout: TIMINGS.readTimeout });
    } catch (err) {
      if (gone()) return;
      if (err?.kind === 'cut') {
        // Cut to give the way to a stop: not a failure of SOMA Connect. Read
        // again in a few seconds (the read did not happen).
        this.lastAttemptAt = this.monotonic() - this.interval + TIMINGS.cutRetry;
        return;
      }
      await this.bridgeFailed(err);
      await this.publishAll();
      return;
    }
    if (gone()) return;
    await this.applyList(json);
    if (gone()) return;
    // Different shades answer independently: a few at a time.
    const listed = [...this.shades.values()].filter((s) => s.listed === true);
    await Promise.all(listed.map((s) => this.readShade(s, generation, { withBattery: true })));
    if (gone()) return;
    await this.saveStyle();
    await this.publishAll();
  }

  /** The URL form that answered, kept in /data (tried first after a restart). */
  async saveStyle() {
    const bridge = this.memory.bridge;
    if (bridge && this.client.style && bridge.style !== this.client.style) {
      bridge.style = this.client.style;
      await this.saveMemory();
    }
  }

  /** list_devices failed: a pause (429, 5xx of the list) or a backoff, never sooner than the interval. */
  async bridgeFailed(err) {
    this.bridge.online = false;
    this.bridge.error = err?.kind ?? 'error';
    this.bridge.reason = reasonOf(err);
    if (PAUSE_KINDS.has(err?.kind)) {
      await this.startPause(err);
      return;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.bridge.failures, TIMINGS.backoff.length - 1)],
    );
    this.bridge.failures += 1;
    this.bridge.wait = wait;
    this.bridge.nextTryAt = this.monotonic() + wait;
    this.logger.warn(`SOMA Connect: ${this.bridge.reason.en}; next try in ${age(wait)}`);
  }

  /**
   * A 429 (any request) or a 5xx of list_devices: the moves wait (a stop and
   * a close never) for what Retry-After asks (1 min to 6 h), else 1, 2, 4, then
   * 5 min; the reads wait for that and never come sooner than the interval
   * anyway (dueAt). Kept in /data.
   */
  async startPause(err) {
    const failures = (this.pause?.failures ?? this.memory.pause?.failures ?? 0) + 1;
    const wait =
      err.retryAfter !== undefined
        ? Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, err.retryAfter))
        : Math.min(TIMINGS.pauseNoRetryAfter, TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10));
    const kind = err.kind === 'rate' ? 'rate' : 'server';
    this.pause = { due: this.monotonic() + wait, failures, kind };
    this.memory.pause = { until: this.now() + wait, failures, kind };
    await this.saveMemory();
    this.logger.warn(`SOMA Connect: ${reasonOf(err).en}, paused for ${age(wait)}`);
  }

  /** A list_devices answered: the firmware, the shades; the pause and the backoff lift. */
  async applyList(json) {
    this.bridge = { online: true, failures: 0, nextTryAt: -Infinity };
    this.pause = undefined;
    const version = versionOf(json);
    const { shades, duplicates, dropped } = shadesOf(json);
    this.listNotes = { duplicates, dropped };
    if (version) {
      this.version = version;
    }
    const seen = new Set();
    for (const s of shades) {
      seen.add(s.id);
      let shade = this.shades.get(s.id);
      if (!shade) {
        shade = freshShade(s);
        this.shades.set(s.id, shade);
      }
      shade.mac = s.mac;
      shade.name = s.name;
      shade.kindSeen = s.kind;
      shade.listed = true;
    }
    for (const shade of this.shades.values()) {
      if (!seen.has(shade.id)) {
        shade.listed = false;
      }
    }
    const m = this.memory;
    const before = JSON.stringify([m.bridge, m.shades, m.pause]);
    m.bridge = { address: this.config.key, version: this.version };
    m.shades = [...this.shades.values()]
      .filter((s) => s.listed)
      .map((s) => ({ mac: s.mac, kind: s.kind }));
    m.pause = undefined;
    if (JSON.stringify([m.bridge, m.shades, m.pause]) !== before) {
      await this.saveMemory();
    }
  }

  /**
   * One read of a shade at a time: a read asked while one runs joins it,
   * unless that one began before a command of this shade left (it would show
   * the shade before it): then it runs after it.
   */
  readShade(shade, generation, { withBattery = false, followUp = false } = {}) {
    if (shade.reading && shade.readingSince > shade.lastSentAt && !withBattery && !followUp) {
      return shade.reading;
    }
    const previous = shade.reading ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.readShadeNow(shade, generation, withBattery, followUp));
    shade.reading = run;
    shade.readingSince = this.monotonic();
    run
      .finally(() => {
        if (shade.reading === run) {
          shade.reading = undefined;
        }
      })
      .catch(() => {});
    return run;
  }

  async readShadeNow(shade, generation, withBattery, followUp) {
    const address = this.config.address;
    if (generation !== this.generation || !address) {
      return;
    }
    const startedAt = this.monotonic();
    let json;
    try {
      json = await this.client.shadeState(address, shade.mac, styleOf(this.version), {
        timeout: TIMINGS.readTimeout,
      });
    } catch (err) {
      if (generation === this.generation) {
        await this.shadeFailed(shade, err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.applyState(shade, json, startedAt, followUp);
    const mono = this.monotonic();
    if (withBattery && mono >= shade.batteryAt + TIMINGS.batteryEvery) {
      shade.batteryAt = mono;
      this.memory.batteryAt[shade.id] = this.now();
      await this.saveMemory();
      if (generation !== this.generation) return;
      try {
        const answer = await this.client.battery(address, shade.mac, styleOf(this.version), {
          timeout: TIMINGS.readTimeout,
        });
        if (generation !== this.generation) return;
        const battery = batteryOf(answer);
        if (battery !== undefined) {
          shade.battery = battery;
          shade.batteryReadAt = this.monotonic();
        }
      } catch (err) {
        // Asked again in an hour: a battery not read changes nothing else.
        this.logger.debug(`${nameOf(shade)}: battery not read (${reasonOf(err).en})`);
      }
    }
  }

  /**
   * A read of one shade failed: that shade only is "not read" (a 5xx on one
   * shade never holds the others); a 429 pauses the bridge; a read cut for a
   * stop changes nothing (the follow-up reads of the stop read it again).
   */
  async shadeFailed(shade, err) {
    if (err?.kind === 'cut') {
      return;
    }
    shade.online = false;
    shade.reason = reasonOf(err);
    if (err?.kind === 'rate') {
      this.bridge.reason = shade.reason;
      await this.startPause(err);
    }
  }

  /**
   * A get_shade_state answered, unless the read began before a command left.
   * A move is confirmed only by a read of its position; a read equal to the
   * position before it is "not applied yet". After a stop, a position that
   * still changes between two reads sends the stop again.
   */
  applyState(shade, json, startedAt, followUp = false) {
    if (startedAt <= shade.lastSentAt) {
      this.logger.debug('Read begun before a command, position not applied');
      return;
    }
    const position = positionOf(json, shade.kind);
    if (position === undefined) {
      shade.online = false;
      shade.reason = reasonOf({ kind: 'format' });
      return;
    }
    shade.online = true;
    shade.reason = undefined;
    shade.position = position;
    shade.readAt = this.monotonic();
    const tolerance = LIMITS.positionTolerance;
    if (shade.target !== undefined) {
      if (Math.abs(shade.target - position) <= tolerance) {
        shade.target = undefined;
        shade.before = undefined;
        shade.unconfirmed = false;
        shade.notReached = undefined;
        shade.concludeNext = false;
      } else if (shade.concludeNext) {
        // The follow-up reads ended without a fresh read: this one concludes.
        this.conclude(shade);
      }
    } else {
      shade.unconfirmed = false;
      if (shade.notReached && Math.abs(shade.notReached.read - position) > tolerance) {
        shade.notReached = undefined;
      }
    }
    // After a stop, only the follow-up reads of its first seconds check it:
    // the shade still going the way it went is stopped again; two equal reads
    // (it stopped) or a move the other way (someone moves it from the app or
    // a remote) end the check. A read of the cycle never sends a stop.
    const watch = shade.stopWatch;
    if (watch && followUp) {
      if (shade.readAt > watch.until) {
        shade.stopWatch = undefined;
      } else if (watch.lastPos !== undefined) {
        const moved = position - watch.lastPos;
        if (Math.abs(moved) <= tolerance) {
          shade.stopWatch = undefined;
        } else if (watch.direction === 0 || Math.sign(moved) === watch.direction) {
          watch.lastPos = position;
          this.stopContradicted(shade, watch);
        } else {
          shade.stopWatch = undefined;
        }
      } else {
        watch.lastPos = position;
      }
    }
  }

  /** A stop the reads contradict (the shade still moves): sent again, 3 times at most. */
  stopContradicted(shade, watch) {
    if (watch.resends >= LIMITS.stopResends || shade.acceptedSeq > watch.seq) {
      return;
    }
    watch.resends += 1;
    this.logger.warn(`${nameOf(shade)}: still moving after a stop, stop sent again`);
    this.sendStop(shade, watch.seq, this.monotonic())
      .then((result) => {
        if (!result.ok && !result.skipped) {
          this.keepStop(shade, watch.seq, result.err).catch(() => {});
        }
      })
      .catch(() => {});
  }

  /**
   * The stops kept are sent again side by side (each with its own 3.5 s), 3
   * times at most, to the address of the configuration or, before it is read,
   * the one kept in /data; /data written once for the round.
   */
  async resendStops() {
    const round = [...this.shades.values()].filter((s) => s.pendingStop && !s.pendingStop.given);
    await Promise.all(
      round.map(async (shade) => {
        const pending = shade.pendingStop;
        if (shade.acceptedSeq > pending.seq) {
          shade.pendingStop = undefined;
          return;
        }
        pending.resends += 1;
        const result = await this.sendStop(shade, pending.seq, this.monotonic());
        if (shade.pendingStop !== pending) {
          return;
        }
        if (result.ok || result.skipped) {
          this.logger.info(`${nameOf(shade)}: stop kept, sent again`);
          shade.pendingStop = undefined;
          if (result.ok) {
            this.watchStop(shade, pending.seq, 0);
          }
        } else if (pending.resends >= LIMITS.stopResends) {
          pending.given = true;
          this.logger.warn(`${nameOf(shade)}: stop given up after ${pending.resends} tries`);
        }
      }),
    );
    if (round.length > 0) {
      this.memory.stops = [...this.shades.values()]
        .filter((s) => s.pendingStop && !s.pendingStop.given)
        .map((s) => ({ mac: s.mac, at: s.pendingStop.at, resends: s.pendingStop.resends }));
      await this.saveMemory();
    }
  }

  /** A stop that did not get through: kept in /data, sent again by the next reads. */
  async keepStop(shade, seq, err) {
    if (shade.acceptedSeq > seq) {
      return;
    }
    const resends = shade.pendingStop?.given ? 0 : (shade.pendingStop?.resends ?? 0);
    shade.pendingStop = { seq, resends, at: this.now(), given: false };
    this.memory.stops = [
      ...this.memory.stops.filter((s) => s.mac !== shade.mac),
      { mac: shade.mac, at: shade.pendingStop.at, resends },
    ];
    this.logger.warn(`${nameOf(shade)}: stop not through (${reasonOf(err).en}), kept`);
    // Its own 3.5 s of tries count as a round: the next one comes a minute later.
    this.lastStopRound = this.monotonic();
    await this.saveMemory();
    this.scheduleStops();
  }

  async dropStop(shade) {
    shade.pendingStop = undefined;
    const before = this.memory.stops.length;
    this.memory.stops = this.memory.stops.filter((s) => s.mac !== shade.mac);
    if (this.memory.stops.length !== before) {
      await this.saveMemory();
    }
  }

  // --- Status ----------------------------------------------------------------

  shadeState(shade) {
    const base = {
      battery:
        shade.batteryReadAt !== undefined &&
        this.monotonic() - shade.batteryReadAt <= 2 * TIMINGS.batteryEvery + this.freshFor()
          ? shade.battery
          : undefined,
      notReached: shade.notReached,
      unconfirmed: shade.unconfirmed,
      stop: shade.pendingStop,
    };
    if (shade.online === true) {
      return { ...base, kind: 'ok', position: this.freshPosition(shade) };
    }
    if (shade.online === false) {
      return { ...base, kind: 'down', reason: shade.reason ?? reasonOf(undefined) };
    }
    return { ...base, kind: 'waiting' };
  }

  /** `[connected, message]`. */
  status() {
    const config = this.config;
    if (!this.loaded) {
      return [false, T.configRetry(age(this.configRetry.wait ?? TIMINGS.configRetryMin))];
    }
    const notes = [
      config.credentialsInHost ? T.credentialsInHost : undefined,
      config.local ? T.local : config.invalid ? T.invalid : undefined,
    ];
    if (!config.address) {
      return [
        false,
        join(config.credentialsInHost || config.invalid ? undefined : T.noAddress, ...notes),
      ];
    }
    const mono = this.monotonic();
    const key = config.key;
    let head;
    const pause = this.pauseLeft(mono);
    if (pause > 0) {
      head =
        this.pause.kind === 'rate'
          ? T.paused(key, age(pause))
          : T.bridgeError(key, this.bridge.reason ?? reasonOf({ kind: 'server' }), age(pause));
    } else if (this.bridge.online === true) {
      const count = [...this.shades.values()].filter((s) => s.listed === true).length;
      head = T.bridgeOk(key, this.version, count, config.pollInterval);
    } else if (this.bridge.online === false) {
      const wait = age(Math.max(0, this.bridge.nextTryAt - mono) || this.interval);
      head = NOT_SOMA_KINDS.has(this.bridge.error)
        ? T.bridgeNotSoma(key, this.bridge.reason, wait)
        : T.bridgeDown(key, this.bridge.reason, wait);
    } else {
      head = T.connecting(key);
    }
    const lines = [];
    for (const shade of this.shades.values()) {
      if (shade.listed === false && !shade.pendingStop) {
        continue;
      }
      lines.push(T.shadeLine(nameOf(shade), this.shadeState(shade)));
    }
    const listed = [...this.shades.values()].filter((s) => s.listed === true);
    const orphans = this.orphans();
    const names = orphans
      .map((d) =>
        typeof d.name === 'string' && d.name !== ''
          ? d.name.slice(0, LIMITS.name)
          : d.external_id.split(':').at(-1),
      )
      .join(', ');
    return [
      this.bridge.online === true && pause === 0,
      join(
        head,
        this.bridge.online === true && listed.length === 0 ? T.noDevices : undefined,
        ...lines,
        this.listNotes.duplicates > 0 ? T.duplicates(this.listNotes.duplicates) : undefined,
        this.listNotes.dropped > 0 ? T.dropped(this.listNotes.dropped) : undefined,
        listed.some((s) => s.kind !== s.kindSeen) ? T.kindChanged : undefined,
        orphans.length > 0 ? T.orphans(names) : undefined,
        ...notes,
      ),
    ];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    let connected;
    let message;
    try {
      [connected, message] = this.status();
    } catch (err) {
      // Never a dead status: a value not understood is said so.
      this.logger.error(`Status failed (${err?.name ?? 'Error'})`);
      [connected, message] = [false, ERRORS.generic];
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  /** The created devices of this integration that SOMA Connect no longer lists (once it was read). */
  orphans() {
    if (this.bridge.online !== true) {
      return [];
    }
    return (this.gladys.devices ?? []).filter((device) => {
      const target = parseExternalId(this.gladys, device?.external_id);
      return target && target.key === undefined && this.shades.get(target.id)?.listed !== true;
    });
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) {
      this.queueStates();
      await this.flush();
    }
    await this.publishBadges();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: one device per shade listed in this run. A created
   * device never loses a feature (Gladys would otherwise mark it changed, and
   * "Update" would drop their history), and a device seen earlier in this run
   * stays.
   */
  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const shade of this.shades.values()) {
      if (shade.listed !== true) {
        continue;
      }
      const device = buildDevice(this.gladys, shade, { language: this.config.language });
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created.get(device.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of KEPT_FIELDS) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
        }
      }
      this.known.set(device.external_id, device);
    }
    const devices = [...this.known.values()];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** A position read recently from a shade that answers, or undefined (never an old one dated anew). */
  freshPosition(shade) {
    if (
      shade.online !== true ||
      shade.readAt === undefined ||
      this.monotonic() - shade.readAt > this.freshFor() ||
      this.bridge.online !== true
    ) {
      return undefined;
    }
    return shade.position;
  }

  /** The last values, for the created features only (the ack never waits for it). */
  queueStates(created = this.createdFeatures()) {
    for (const shade of this.shades.values()) {
      const ids = shadeIds(this.gladys, shade.id);
      const position = this.freshPosition(shade);
      if (position !== undefined && created.has(ids.feature(FEATURES.POSITION))) {
        this.publisher.push(ids.feature(FEATURES.POSITION), { state: position });
      }
      const battery = this.shadeState(shade).battery;
      if (
        battery !== undefined &&
        this.bridge.online === true &&
        created.has(ids.feature(FEATURES.BATTERY))
      ) {
        this.publisher.push(ids.feature(FEATURES.BATTERY), { state: battery });
      }
    }
  }

  /** The badge of a created shade. */
  badgeOf(shade) {
    if (
      !shade ||
      this.bridge.online !== true ||
      this.pauseLeft(this.monotonic()) > 0 ||
      shade.online === false
    ) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (shade.pendingStop) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.stop };
    }
    if (shade.unconfirmed) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    if (shade.notReached) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.notReached(shade.notReached.target, shade.notReached.read),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    if (this.bridge.online === undefined) {
      // Not read yet since the start: no badge rather than a wrong one.
      return;
    }
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const target = parseExternalId(this.gladys, device?.external_id);
      if (!target || target.key !== undefined) {
        continue;
      }
      const shade = this.shades.get(target.id);
      if (
        shade &&
        shade.listed === true &&
        shade.online === undefined &&
        this.pauseLeft(this.monotonic()) === 0
      ) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        ...this.badgeOf(shade?.listed ? shade : undefined),
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
    await this.updateStatus();
  }

  /**
   * The Discovery tab asks for a scan: the shades of the last read, sent
   * again (no read); a type changed in SOMA Connect applies now.
   */
  async scan() {
    let changed = false;
    for (const shade of this.shades.values()) {
      if (shade.listed === true && shade.kind !== shade.kindSeen) {
        shade.kind = shade.kindSeen;
        shade.position = undefined;
        shade.readAt = undefined;
        changed = true;
      }
    }
    if (changed && this.memory) {
      this.memory.shades = [...this.shades.values()]
        .filter((s) => s.listed)
        .map((s) => ({ mac: s.mac, kind: s.kind }));
      await this.saveMemory();
    }
    this.published = undefined;
    this.known.clear();
    await this.publishDevices();
    await this.updateStatus();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": a read now, unless one ran less than an interval
   * ago (then its result); a pause asked by SOMA Connect holds.
   */
  async testConnection() {
    if (!this.loaded || !this.config.address) {
      return this.status()[1];
    }
    const mono = this.monotonic();
    if (this.lastAttemptAt !== undefined && mono < this.lastAttemptAt + this.interval) {
      await this.updateStatus();
      return join(T.test.recent(age(this.lastAttemptAt + this.interval - mono)), this.status()[1]);
    }
    await this.tick({ force: true });
    if (!this.busy) {
      this.schedule();
    }
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  /** What a command asks: { kind: 'stop' } | { kind: 'move', position }. */
  planOf(key, value) {
    if (key === FEATURES.STATE) {
      const v = numberIn(value, -1, 1);
      if (v === COVER_STATE.STOP) {
        return { kind: 'stop' };
      }
      if (v === COVER_STATE.OPEN) {
        return { kind: 'move', position: 100 };
      }
      if (v === COVER_STATE.CLOSE) {
        return { kind: 'close', position: 0 };
      }
      throw this.refusal(ERRORS.badValue);
    }
    const v = numberIn(value, 0, 100);
    if (v === undefined) {
      throw this.refusal(ERRORS.badValue);
    }
    const position = Math.round(v);
    return { kind: position === 0 ? 'close' : 'move', position };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || !COMMAND_KEYS.has(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const plan = this.planOf(target.key, value);
    if (plan.kind === 'stop') {
      return this.stopNow(target.id, received);
    }
    if (plan.kind === 'close') {
      return this.closeNow(target.id, received);
    }
    if (!this.loaded) {
      throw this.refusal(ERRORS.notLoaded);
    }
    const shade = this.shades.get(target.id);
    if (!shade || shade.listed === false) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noAddress);
    }
    const pause = this.pauseLeft(received);
    if (pause > 0) {
      throw this.refusal(this.pauseRefusal(pause));
    }
    this.commandSeq += 1;
    const ticket = { seq: this.commandSeq, plan, generation: this.generation, cancelled: false };
    shade.tickets.add(ticket);
    try {
      return await shade.lane.run(() => this.move(shade, ticket, received));
    } catch (err) {
      if (err instanceof LaneFull) {
        throw this.refusal(ERRORS.busy(LIMITS.laneWaiting + 1));
      }
      throw err;
    } finally {
      shade.tickets.delete(ticket);
    }
  }

  /** Why a move waits: a 429 (asked to slow down) or an error of SOMA Connect. */
  pauseRefusal(pause) {
    return this.pause?.kind === 'rate' ? ERRORS.paused(age(pause)) : ERRORS.bridgeError(age(pause));
  }

  /** The checks of a move: on arrival in the lane and right before its first byte. */
  checkMove(shade, ticket, sendBy) {
    const mono = this.monotonic();
    if (ticket.cancelled || ticket.seq < shade.stopSeq) {
      throw this.refusal(ERRORS.stopped);
    }
    if (ticket.generation !== this.generation) {
      throw this.refusal(ERRORS.configChanged);
    }
    const pause = this.pauseLeft(mono);
    if (pause > 0) {
      throw this.refusal(this.pauseRefusal(pause));
    }
    if (mono > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  async move(shade, ticket, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => this.checkMove(shade, ticket, sendBy);
    check();
    const { position } = ticket.plan;
    const pos = apiPositionFor(position);
    const name = `${nameOf(shade)}: position ${position}`;
    const before = shade.position;
    const mono = this.monotonic();
    const request = this.client.setPosition(
      this.config.address,
      shade.mac,
      pos,
      styleOf(this.version),
      {
        timeout: Math.max(200, answerBy - mono),
        sendWithin: sendBy - mono,
        // The very last check, right before the request leaves.
        beforeSend: () => {
          check();
          shade.lastSentAt = this.monotonic();
        },
      },
    );
    shade.inFlight = request;
    try {
      await request;
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      throw await this.moveFailed(shade, ticket, name, err, before);
    } finally {
      if (shade.inFlight === request) {
        shade.inFlight = undefined;
      }
    }
    this.logger.info(`${name} accepted`);
    this.moveAccepted(shade, ticket, before, true);
  }

  /**
   * A move accepted, or that may have left (`accepted` false): it waits for
   * the reads of its position. Only an accepted one stops an older stop from
   * being sent again (in doubt, the stop goes).
   */
  moveAccepted(shade, ticket, before, accepted) {
    if (ticket.generation !== this.generation) {
      return;
    }
    if (ticket.seq < shade.stopSeq) {
      // A stop came while it was leaving: no position to wait for.
      return;
    }
    if (accepted) {
      shade.acceptedSeq = Math.max(shade.acceptedSeq, ticket.seq);
      if (shade.pendingStop && shade.pendingStop.seq < ticket.seq) {
        this.dropStop(shade).catch(() => {});
      }
      if (shade.stopWatch && shade.stopWatch.seq < ticket.seq) {
        shade.stopWatch = undefined;
      }
    }
    shade.target = ticket.plan.position;
    shade.before = before;
    shade.notReached = undefined;
    shade.concludeNext = false;
    this.followUp(shade, ticket.generation);
    this.publishAll().catch(() => {});
  }

  /** The refusal of a move that failed after it was planned. */
  async moveFailed(shade, ticket, name, err, before) {
    const reason = reasonOf(err);
    if (!err?.sent && !err?.answered) {
      this.logger.warn(`${name} NOT sent (${reason.en})`);
      return this.refusal(err?.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
    }
    if (ticket.generation !== this.generation) {
      return this.refusal(err.answered ? ERRORS.refused(reason) : ERRORS.sentUnconfirmed(reason));
    }
    if (err?.kind === 'rate') {
      await this.startPause(err);
    }
    if (err.answered) {
      // SOMA Connect answered with a refusal: nothing done.
      this.logger.warn(`${name} refused (${reason.en})`);
      return this.refusal(ERRORS.refused(reason));
    }
    // A silence, a dropped connection, a 5xx, an answer not understood: it
    // may have been done: confirmed only by a read of the position asked.
    shade.unconfirmed = true;
    this.moveAccepted(shade, ticket, before, false);
    this.logger.warn(`${name} sent, NOT confirmed (${reason.en})`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /**
   * STOP: never behind a lane, a read, an option, a pause or a backoff; with
   * the address, the firmware and the shade kept in /data before the first
   * read. Every move of that shade not sent yet is cancelled first, even when
   * this stop fails; a move leaving meanwhile is followed by a second stop.
   */
  async stopNow(id, received) {
    const shade = this.shades.get(id);
    if (!shade) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    for (const pending of shade.tickets) {
      pending.cancelled = true;
    }
    this.commandSeq += 1;
    const seq = this.commandSeq;
    shade.stopSeq = seq;
    // The way the shade went (Gladys: +1 opening, -1 closing, 0 unknown).
    const from = shade.before ?? shade.position;
    const direction =
      shade.target === undefined || from === undefined ? 0 : Math.sign(shade.target - from);
    shade.target = undefined;
    shade.concludeNext = false;
    shade.before = undefined;
    shade.notReached = undefined;
    const address = this.config.address ?? this.address;
    if (!address) {
      throw this.refusal(ERRORS.noAddress);
    }
    const leaving = shade.inFlight;
    const result = await this.sendStop(shade, seq, received);
    if (result.skipped) {
      return;
    }
    if (leaving) {
      this.reaffirmStop(shade, seq, leaving);
    }
    if (result.ok) {
      this.logger.info(`${nameOf(shade)}: stop sent`);
      if (shade.pendingStop) {
        await this.dropStop(shade);
      }
      this.watchStop(shade, seq, direction);
      return;
    }
    await this.keepStop(shade, seq, result.err);
    this.publishAll().catch(() => {});
    const err = result.err;
    if (err?.sent && !err?.answered) {
      throw this.refusal(ERRORS.sentUnconfirmed(reasonOf(err)));
    }
    throw this.refusal(ERRORS.stopNotSent(reasonOf(err)));
  }

  /** The reads of the first seconds after a stop check it (see applyState). */
  watchStop(shade, seq, direction) {
    shade.stopWatch = {
      seq,
      direction,
      lastPos: undefined,
      resends: 0,
      until: this.monotonic() + TIMINGS.stopWatchFor,
    };
    this.followUp(shade, this.generation);
  }

  /**
   * One stop: a read silent for a second is cut first (its connection closed
   * before this one opens), then the stop, tried again every 250 ms within
   * 3.5 s of `received` while nothing reached the motor. Skipped when a move
   * of that shade newer than this stop was accepted meanwhile.
   * @returns {Promise<{ ok?: true, skipped?: true, err?: Error }>}
   */
  sendStop(shade, seq, received) {
    const address = this.config.address ?? this.address;
    return this.sendProtective(shade, {
      received,
      newer: () => shade.acceptedSeq > seq,
      request: (options) => this.client.stop(address, shade.mac, styleOf(this.version), options),
    });
  }

  /**
   * A protective request (stop, close): a read silent for a second is cut
   * first, then the request, tried again every 250 ms within 3.5 s of
   * `received` while nothing reached the motor; skipped once `newer()`.
   */
  async sendProtective(shade, { received, newer, request }) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    if (this.client.reads.size > 0) {
      await this.client.cutStalled(TIMINGS.stalledAfter, TIMINGS.closeWait, this.timers);
    }
    let lastErr;
    for (;;) {
      const mono = this.monotonic();
      if (newer()) {
        return { skipped: true };
      }
      if (mono > sendBy) {
        return { err: lastErr ?? { kind: 'late' } };
      }
      try {
        await request({
          timeout: Math.max(200, answerBy - mono),
          sendWithin: sendBy - mono,
          beforeSend: () => {
            if (newer()) {
              const skipped = new Error('a newer command went first');
              skipped.skipped = true;
              throw skipped;
            }
            shade.lastSentAt = this.monotonic();
          },
        });
        return { ok: true };
      } catch (err) {
        if (err?.skipped) {
          return { skipped: true };
        }
        lastErr = err;
        if (!RETRY_KINDS.has(err?.kind)) {
          // It may have reached the motor (a silence, an answer not understood).
          return { err };
        }
      }
      if (this.monotonic() + TIMINGS.stopRetryEvery > sendBy) {
        return { err: lastErr };
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.stopRetryEvery));
    }
  }

  /**
   * A move was leaving when the stop came: once it is answered, stop again
   * (with its own 3.5 s), unless a move asked after the stop was accepted.
   */
  reaffirmStop(shade, seq, leaving) {
    Promise.resolve(leaving)
      .catch(() => {})
      .then(async () => {
        if (shade.acceptedSeq > seq) {
          return;
        }
        const result = await this.sendStop(shade, seq, this.monotonic());
        if (result.ok) {
          this.logger.info(`${nameOf(shade)}: stop sent again after a move that was leaving`);
        } else if (!result.skipped) {
          await this.keepStop(shade, seq, result.err);
        }
      })
      .catch(() => {});
  }

  /**
   * Reads after a command, spaced over the travel of the shade; one series
   * per shade (a new command replaces it). They never give way to a cycle:
   * each waits for the read of that shade running, if any. After the last one,
   * a position asked and not read is shown on the badge and in the status.
   */
  followUp(shade, generation) {
    if (generation !== this.generation) {
      return;
    }
    for (const handle of shade.followUps) {
      this.timers.clearTimeout(handle);
    }
    shade.followUps.clear();
    TIMINGS.followUps.forEach((delay, index) => {
      const last = index === TIMINGS.followUps.length - 1;
      const handle = this.timers.setTimeout(() => {
        shade.followUps.delete(handle);
        if (generation !== this.generation) {
          return;
        }
        const read =
          this.pauseLeft(this.monotonic()) > 0
            ? Promise.resolve()
            : this.readShade(shade, generation, { followUp: index < 2 });
        read
          .then(async () => {
            if (generation !== this.generation) {
              return;
            }
            if (last) {
              this.conclude(shade);
            }
            await this.publishAll();
          })
          .catch(() => this.logger.error('Refresh failed'));
      }, delay);
      shade.followUps.add(handle);
    });
  }

  /**
   * The travel is over: a position asked and not read is "not reached", on a
   * read made after the command only; without one (a pause, the shade not
   * read), "not confirmed" until the next read, which concludes.
   */
  conclude(shade) {
    shade.stopWatch = undefined;
    if (shade.target === undefined) {
      return;
    }
    this.badges = undefined;
    if (
      shade.position === undefined ||
      shade.online !== true ||
      shade.readAt === undefined ||
      shade.readAt <= shade.lastSentAt
    ) {
      shade.unconfirmed = true;
      shade.concludeNext = true;
      return;
    }
    shade.notReached = { target: shade.target, read: shade.position };
    shade.unconfirmed = false;
    shade.concludeNext = false;
    this.logger.warn(
      `${nameOf(shade)}: did not reach ${shade.target} % (read ${shade.position} %)`,
    );
    shade.target = undefined;
    shade.before = undefined;
  }

  /**
   * CLOSE: protective like a stop: no lane, no read, no option, through a
   * pause, before the configuration is read (address and shade of /data); it
   * replaces the moves of that shade not sent yet. Tried again every 250 ms
   * within 3.5 s, never kept nor sent again by itself (after a restart
   * neither). A newer stop (or a newer move accepted) cancels it.
   */
  async closeNow(id, received) {
    const shade = this.shades.get(id);
    if (!shade || shade.listed === false) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const address = this.config.address ?? this.address;
    if (!address) {
      throw this.refusal(ERRORS.noAddress);
    }
    for (const pending of shade.tickets) {
      pending.cancelled = true;
    }
    this.commandSeq += 1;
    const ticket = {
      seq: this.commandSeq,
      plan: { kind: 'close', position: 0 },
      generation: this.generation,
    };
    const leaving = shade.inFlight;
    const before = shade.position;
    const result = await this.sendClose(shade, ticket, address, received);
    if (leaving) {
      // A move was leaving: once it is answered, close again (unless newer).
      Promise.resolve(leaving)
        .catch(() => {})
        .then(async () => {
          const again = await this.sendClose(shade, ticket, address, this.monotonic());
          if (again.ok) {
            this.moveAccepted(shade, ticket, before, true);
          }
        })
        .catch(() => {});
    }
    if (result.skipped) {
      throw this.refusal(shade.stopSeq > ticket.seq ? ERRORS.stopped : ERRORS.superseded);
    }
    if (result.ok) {
      this.logger.info(`${nameOf(shade)}: close accepted`);
      this.moveAccepted(shade, ticket, before, true);
      return;
    }
    const err = result.err;
    const reason = reasonOf(err);
    if (err?.kind === 'rate') {
      await this.startPause(err);
    }
    if (err?.sent && !err?.answered) {
      shade.unconfirmed = true;
      this.moveAccepted(shade, ticket, before, false);
      this.logger.warn(`${nameOf(shade)}: close sent, NOT confirmed (${reason.en})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.logger.warn(`${nameOf(shade)}: close NOT sent (${reason.en})`);
    throw this.refusal(err?.answered ? ERRORS.refused(reason) : ERRORS.notSent(reason));
  }

  sendClose(shade, ticket, address, received) {
    return this.sendProtective(shade, {
      received,
      newer: () => shade.stopSeq > ticket.seq || shade.acceptedSeq > ticket.seq,
      request: (options) =>
        this.client.setPosition(address, shade.mac, apiPositionFor(0), styleOf(this.version), {
          ...options,
          beforeSend: () => {
            options.beforeSend();
            shade.lastSentAt = this.monotonic();
          },
        }),
    });
  }
}
