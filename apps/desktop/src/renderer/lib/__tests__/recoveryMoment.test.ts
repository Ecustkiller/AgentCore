import {
  formatLocalMoment,
  recoveryMomentClause,
  withRecoveryMoment,
} from "@/lib/recoveryMoment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 恢复时刻按**用户本机时区**成文。线上原样是服务端措辞好的「8 月 14 日 16:00（UTC）」，
 * 中国用户照字面等到当天下午四点，真正能用的却是北京时间次日零点。
 */
describe("formatLocalMoment", () => {
  beforeAll(() => {
    vi.stubEnv("TZ", "Asia/Shanghai");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("把 UTC 瞬间读成用户本机的钟（线上算错一整天的那条）", () => {
    expect(formatLocalMoment("2026-08-14T16:00:00Z")).toBe("8 月 15 日 00:00");
  });

  it("不标时区名——屏幕上的钟就是他自己的，标了反而制造疑虑", () => {
    const text = formatLocalMoment("2026-08-14T16:00:00Z") ?? "";
    expect(text).not.toContain("UTC");
    expect(text).not.toContain("GMT");
    expect(text).not.toContain("+08");
  });

  it("缺字段 / 坏字符串一律 null——宁可不说，也不编一个时间", () => {
    expect(formatLocalMoment(null)).toBeNull();
    expect(formatLocalMoment(undefined)).toBeNull();
    expect(formatLocalMoment("")).toBeNull();
    expect(formatLocalMoment("明日 0 点（UTC）")).toBeNull();
  });
});

describe("formatLocalMoment · 与运行时区无关的不变量", () => {
  it("渲染的钟点回推得到同一个瞬间（不是把 UTC 直接当本地读）", () => {
    const iso = "2026-08-14T16:00:00Z";
    const text = formatLocalMoment(iso) ?? "";
    const m = text.match(/^(\d{1,2}) 月 (\d{1,2}) 日 (\d{2}):(\d{2})$/);
    expect(m).not.toBeNull();
    const [, month, day, hour, minute] = m as RegExpMatchArray;
    const roundTrip = new Date(
      new Date(iso).getFullYear(),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    expect(roundTrip.toISOString()).toBe(new Date(iso).toISOString());
  });
});

describe("recoveryMomentClause", () => {
  it("上游 429 说恢复，平台配额闸门说重置", () => {
    expect(recoveryMomentClause({ recovery_at: "2026-08-14T16:00:00Z" })).toBe(
      `额度将于 ${formatLocalMoment("2026-08-14T16:00:00Z")} 恢复。`,
    );
    expect(recoveryMomentClause({ reset_at: "2026-08-14T16:00:00Z" })).toBe(
      `额度将于 ${formatLocalMoment("2026-08-14T16:00:00Z")} 重置。`,
    );
  });

  it("SSE 把时刻挂在 error.context 上，同样认", () => {
    expect(
      recoveryMomentClause({
        context: { recovery_at: "2026-08-14T16:00:00Z" },
      }),
    ).toContain("恢复。");
  });

  it("没有时刻就没有子句", () => {
    expect(recoveryMomentClause(undefined)).toBeNull();
    expect(recoveryMomentClause({})).toBeNull();
    expect(
      recoveryMomentClause({ recovery_at: null, reset_at: null }),
    ).toBeNull();
  });
});

describe("withRecoveryMoment", () => {
  const FALLBACK =
    "上游限流，本回合无法继续。你的服务商额度恢复前重试仍会失败。";

  it("拿到时刻：语气照旧，只多出时刻本身", () => {
    const text = withRecoveryMoment(FALLBACK, {
      recovery_at: "2026-08-14T16:00:00Z",
    });
    expect(text.startsWith(FALLBACK)).toBe(true);
    expect(text.slice(FALLBACK.length)).toBe(
      `额度将于 ${formatLocalMoment("2026-08-14T16:00:00Z")} 恢复。`,
    );
  });

  it("拿不到时刻：原样用服务端那句", () => {
    expect(withRecoveryMoment(FALLBACK, undefined)).toBe(FALLBACK);
    expect(withRecoveryMoment(FALLBACK, { recovery_at: "坏字符串" })).toBe(
      FALLBACK,
    );
  });
});
