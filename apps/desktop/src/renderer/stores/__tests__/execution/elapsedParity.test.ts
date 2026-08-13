/**
 * 「用时」两端同量：桌面 `elapsedMs(frames)` ≡ 共享 `turnElapsedMs(events)`（手机走后者）。
 *
 * 回归钉：手机曾把各队员时长求和当用时，同一回合桌面 40s / 手机 2m10s，并行度越高偏得越多。
 * 这条在全部一致性向量上比对两端算法，任何一端改了帧集合或口径都会在这里红。
 */
import { PREVIEW_FIXTURES } from "@/preview/fixtures";
import { frameFromEvent } from "@/stores/execution/frames";
import { elapsedMs } from "@/stores/execution/project";
import type { SSEEvent } from "@/types/events";
import { isRunFrameEvent, turnElapsedMs } from "@agentcore/protocol-fold-kit";
import { describe, expect, it } from "vitest";

function desktopElapsed(events: SSEEvent[]): number {
  const frames = events
    .map(frameFromEvent)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  return elapsedMs(frames);
}

describe("回合用时 · 桌面/手机同量", () => {
  const multiAgent = PREVIEW_FIXTURES.filter((f) =>
    f.events.some((e) => e.type === "run_started"),
  );

  it("有多 Agent 向量可比（守住语料本身）", () => {
    expect(multiAgent.length).toBeGreaterThan(0);
  });

  for (const fx of multiAgent) {
    it(`${fx.name}: 共享跨度 === 桌面 elapsedMs(frames)`, () => {
      expect(turnElapsedMs(fx.events)).toBe(desktopElapsed(fx.events));
    });
  }

  it("共享事件集合不比桌面帧集合多认事件（run_phase 未知相位除外）", () => {
    // 桌面对识别不了的 run_phase 不产帧；相位事件夹在 run 开跑与终态之间，落不到首尾，
    // 因此不影响跨度（上面的逐向量断言即是证明）。其余类型必须一一对上。
    for (const fx of PREVIEW_FIXTURES) {
      for (const ev of fx.events) {
        if (ev.type === "run_phase") continue;
        expect({ type: ev.type, frame: isRunFrameEvent(ev.type) }).toEqual({
          type: ev.type,
          frame: frameFromEvent(ev) !== null,
        });
      }
    }
  });

  it("并行回合的跨度小于各队员时长之和（并行省的时间不该被吃掉）", () => {
    const parallel = multiAgent.find((f) => {
      const done = f.events.filter((e) => e.type === "run_completed");
      if (done.length < 2) return false;
      const sum = done.reduce(
        (acc, e) =>
          acc + ((e.payload as { duration_ms?: number }).duration_ms ?? 0),
        0,
      );
      return sum > turnElapsedMs(f.events) && turnElapsedMs(f.events) > 0;
    });
    expect(parallel).toBeDefined();
  });
});
