import { createCappedFlushScheduler } from "@/services/sse/streamFlushScheduler";
import { describe, expect, it } from "vitest";

function makeClock() {
  let now = 0;
  const raf = new Map<number, () => void>();
  const timeouts = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  const clock = {
    now: () => now,
    raf: (cb: () => void) => {
      const id = nextId++;
      raf.set(id, cb);
      return id;
    },
    caf: (id: number) => {
      raf.delete(id);
    },
    timeout: (cb: () => void, ms: number) => {
      const id = nextId++;
      timeouts.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    ctimeout: (id: ReturnType<typeof setTimeout>) => {
      timeouts.delete(id as unknown as number);
    },
  };
  return {
    clock,
    setNow: (n: number) => {
      now = n;
    },
    flushRaf: () => {
      const batch = [...raf.values()];
      raf.clear();
      for (const cb of batch) cb();
    },
    flushTimeouts: () => {
      const batch = [...timeouts.values()];
      timeouts.clear();
      for (const t of batch) t.cb();
    },
    rafCount: () => raf.size,
    timeoutCount: () => timeouts.size,
    lastTimeoutMs: () => [...timeouts.values()].at(-1)?.ms,
  };
}

describe("createCappedFlushScheduler", () => {
  it("coalesces queues onto one raf when idle", () => {
    const env = makeClock();
    const s = createCappedFlushScheduler(16, env.clock);
    let n = 0;
    s.schedule("k", () => {
      n += 1;
    });
    s.schedule("k", () => {
      n += 1;
    });
    expect(env.rafCount()).toBe(1);
    env.flushRaf();
    expect(n).toBe(1);
  });

  it("waits out the interval after a run instead of following vsync", () => {
    const env = makeClock();
    const s = createCappedFlushScheduler(16, env.clock);
    let n = 0;
    s.schedule("k", () => {
      n += 1;
      s.noteRan("k");
    });
    env.flushRaf();
    expect(n).toBe(1);
    env.setNow(5);
    s.schedule("k", () => {
      n += 1;
      s.noteRan("k");
    });
    expect(env.rafCount()).toBe(0);
    expect(env.timeoutCount()).toBe(1);
    expect(env.lastTimeoutMs()).toBe(11);
    env.flushTimeouts();
    expect(n).toBe(2);
  });

  it("cancel drops a scheduled run", () => {
    const env = makeClock();
    const s = createCappedFlushScheduler(16, env.clock);
    let n = 0;
    s.schedule("k", () => {
      n += 1;
    });
    s.cancel("k");
    env.flushRaf();
    expect(n).toBe(0);
  });
});
