// -----------------------------------------------------------------------------
// A virtual clock for the app: the wall clock and the monotonic clock move
// together, and the monotonic clock moves 1 µs at EVERY read (a decision that
// reads it twice sees two instants, as with a real clock). Timers fire only
// when the test runs the clock forward (`run(ms)`), in their order.
// -----------------------------------------------------------------------------

export const START = Date.UTC(2026, 9, 26, 10, 0, 0);

/** Lets the pending promises (and the fake bridge) settle. */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function createClock(start = START) {
  let mono = 1000;
  let wall = start;
  let nextId = 1;
  const pending = new Map();
  const clock = {
    reads: 0,
    now: () => wall + Math.floor(mono - 1000),
    monotonic: () => {
      clock.reads += 1;
      mono += 0.001;
      return mono;
    },
    peek: () => mono,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId;
        nextId += 1;
        pending.set(id, { fn, at: mono + Math.max(0, ms ?? 0) });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
      setInterval: () => 0,
      clearInterval: () => {},
    },
    pending: () => [...pending.values()].map((t) => t.at - mono).sort((a, b) => a - b),
    /** Moves the clocks `ms` forward, firing the timers due on the way. */
    async run(ms) {
      const until = mono + ms;
      for (;;) {
        await settle();
        let first;
        for (const [id, t] of pending) {
          if (t.at <= until && (!first || t.at < first[1].at)) {
            first = [id, t];
          }
        }
        if (!first) {
          break;
        }
        pending.delete(first[0]);
        if (first[1].at > mono) {
          mono = first[1].at;
        }
        first[1].fn();
      }
      if (until > mono) {
        mono = until;
      }
      await settle();
    },
    /** Moves the wall clock alone (a clock set back or forward). */
    jumpWall(ms) {
      wall += ms;
    },
  };
  return clock;
}
