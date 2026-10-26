// -----------------------------------------------------------------------------
// The lane of one shade: its moves one at a time, in their order of arrival,
// a few waiting at most (more are refused at once, never queued without
// bound). Each move keeps the deadline counted from its own arrival. The
// shades of one SOMA Connect have a lane each: a scene that moves five shades
// sends the five side by side. A stop never takes a lane (src/app.js).
// -----------------------------------------------------------------------------

export class LaneFull extends Error {
  constructor() {
    super('lane full');
    this.name = 'LaneFull';
  }
}

export class Lane {
  constructor(maxWaiting) {
    this.maxWaiting = maxWaiting;
    this.waiting = [];
    this.busy = false;
  }

  /** Runs `task` when the moves before it are done; rejects LaneFull when too many wait. */
  run(task) {
    if (this.busy && this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new LaneFull());
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.waiting.length === 0) {
      return;
    }
    const next = this.waiting.shift();
    this.busy = true;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}
