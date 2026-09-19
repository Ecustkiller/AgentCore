/**
 * Cap streaming store flushes to 60Hz, independent of display refresh.
 *
 * `requestAnimationFrame` follows vsync (144Hz boards used to flush that often,
 * blowing a ~7ms frame budget). Comments already promised ≤60; this enforces it.
 */

export const STREAM_FLUSH_HZ = 60;
export const STREAM_FLUSH_INTERVAL_MS = 1000 / STREAM_FLUSH_HZ;

export type CappedFlushClock = {
  now: () => number;
  raf: (cb: () => void) => number;
  caf: (id: number) => void;
  timeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  ctimeout: (id: ReturnType<typeof setTimeout>) => void;
};

type Pending =
  | { kind: "raf"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

const defaultClock: CappedFlushClock = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(() => cb()),
  caf: (id) => cancelAnimationFrame(id),
  timeout: (cb, ms) => setTimeout(cb, ms),
  ctimeout: (id) => clearTimeout(id),
};

export function createCappedFlushScheduler(
  intervalMs: number = STREAM_FLUSH_INTERVAL_MS,
  clock: CappedFlushClock = defaultClock,
) {
  const pending = new Map<string, Pending>();
  const lastRun = new Map<string, number>();

  function cancel(key: string): void {
    const handle = pending.get(key);
    if (!handle) return;
    pending.delete(key);
    if (handle.kind === "raf") clock.caf(handle.id);
    else clock.ctimeout(handle.id);
  }

  function reset(key: string): void {
    cancel(key);
    lastRun.delete(key);
  }

  function noteRan(key: string): void {
    lastRun.set(key, clock.now());
  }

  function schedule(key: string, run: () => void): void {
    if (pending.has(key)) return;
    const last = lastRun.get(key);
    const wait =
      last == null ? 0 : Math.max(0, intervalMs - (clock.now() - last));
    const fire = (): void => {
      pending.delete(key);
      run();
    };
    if (wait === 0) {
      pending.set(key, { kind: "raf", id: clock.raf(fire) });
      return;
    }
    pending.set(key, { kind: "timeout", id: clock.timeout(fire, wait) });
  }

  return { schedule, cancel, reset, noteRan };
}

const shared = createCappedFlushScheduler();

export const scheduleCappedFlush = shared.schedule;
export const cancelCappedFlush = shared.cancel;
export const resetCappedFlush = shared.reset;
export const noteCappedFlush = shared.noteRan;
