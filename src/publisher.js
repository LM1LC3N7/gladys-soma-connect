// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The publisher keeps the LAST value of each feature, sends the pending ones
// every second within a per-minute budget and skips the unchanged ones
// (publishChangedStates, with a heartbeat so an unchanged value stays
// recently dated). One publisher for the whole integration, one flush at a
// time: the budget is global, whatever publishes at the same moment. A
// command never waits for it. Taken from LM1LC3N7/gladys-warema (same author,
// Apache-2.0), through LM1LC3N7/gladys-slide.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } */
    this.pending = new Map();
    /** send times of the last minute */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.pending.delete(key);
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    // Counted before the call: two flushes never spend the same room.
    for (let i = 0; i < batch.length; i += 1) {
      this.window.push(now);
    }
    try {
      await this.gladys.publishChangedStates(batch, { heartbeat: TIMINGS.stateHeartbeat });
      return batch.length;
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
