/**
 * 恢复时刻本地化（429 / 平台配额闸门）。
 *
 * 时区断言分两层：`formatLocalMoment` 注入一个确定的时区，逐字钉住「8 月 15 日 00:00」这个
 * 格式；成句用例则拿本模块自己渲染出的时刻去拼期望串——跑测试的机器在哪个时区都成立，钉的
 * 是**措辞**，时刻正确性由第一层负责。
 */
import { describe, expect, it } from "vitest";
import { formatLocalMoment, withLocalRecoveryMoment } from "../recoveryMoment";

// 线上那句「8 月 14 日 16:00（UTC）」对中国用户其实是次日零点——本次改造要终结的正是它。
const UTC_1600 = "2026-08-14T16:00:00Z";

describe("formatLocalMoment", () => {
  it("按给定时区渲染，UTC 16:00 在北京是次日零点", () => {
    expect(formatLocalMoment(UTC_1600, "Asia/Shanghai")).toBe(
      "8 月 15 日 00:00",
    );
  });

  it("同一时刻在别的时区就是别的钟点（渲染的是本地时刻，不是 UTC）", () => {
    expect(formatLocalMoment(UTC_1600, "UTC")).toBe("8 月 14 日 16:00");
    expect(formatLocalMoment(UTC_1600, "America/Los_Angeles")).toBe(
      "8 月 14 日 09:00",
    );
  });

  it("不带时区参数时走设备本机时区", () => {
    const at = new Date(UTC_1600);
    const hh = String(at.getHours()).padStart(2, "0");
    const mm = String(at.getMinutes()).padStart(2, "0");
    expect(formatLocalMoment(UTC_1600)).toBe(
      `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${hh}:${mm}`,
    );
  });

  it("不标时区名——渲染出来的就是用户自己的钟", () => {
    expect(formatLocalMoment(UTC_1600, "Asia/Shanghai")).not.toContain("UTC");
  });

  it("无值 / 非法输入答不知道，不编一个时间出来", () => {
    expect(formatLocalMoment(null)).toBeNull();
    expect(formatLocalMoment(undefined)).toBeNull();
    expect(formatLocalMoment("")).toBeNull();
    expect(formatLocalMoment("下周三")).toBeNull();
  });
});

describe("withLocalRecoveryMoment", () => {
  const moment = formatLocalMoment(UTC_1600) as string;

  it("拿不到结构化时刻就原样转述服务端那句", () => {
    const fallback =
      "上游限流，本回合无法继续。你的服务商额度恢复前重试仍会失败。";
    expect(withLocalRecoveryMoment(fallback, {})).toBe(fallback);
    expect(withLocalRecoveryMoment(fallback, { context: {} })).toBe(fallback);
    expect(
      withLocalRecoveryMoment(fallback, { context: { recovery_at: null } }),
    ).toBe(fallback);
  });

  it("时刻非法时宁可少说一句，也不自己编时间", () => {
    const fallback = "上游限流，本回合无法继续。上游额度恢复前重试仍会失败。";
    expect(
      withLocalRecoveryMoment(fallback, {
        context: { recovery_at: "明天早上" },
      }),
    ).toBe(fallback);
  });

  it("BYOK 被限：说的是用户自己的服务商额度", () => {
    expect(
      withLocalRecoveryMoment("上游限流，本回合无法继续。", {
        code: "LLM_RATE_LIMIT",
        context: { recovery_at: UTC_1600, credential_source: "user" },
      }),
    ).toBe(
      `上游限流，本回合无法继续。你的服务商额度将于 ${moment} 恢复，在此之前重试仍会失败。`,
    );
  });

  it("来源不明：退回泛指的「上游额度」，不猜是谁的钱", () => {
    expect(
      withLocalRecoveryMoment("上游限流，本回合无法继续。", {
        code: "LLM_RATE_LIMIT",
        context: { recovery_at: UTC_1600 },
      }),
    ).toBe(
      `上游限流，本回合无法继续。上游额度将于 ${moment} 恢复，在此之前重试仍会失败。`,
    );
  });

  it("平台额度撞上游墙：整句重写 + 保留 BYOK 次级出口", () => {
    expect(
      withLocalRecoveryMoment("平台模型额度已用完，本回合无法继续。", {
        code: "QUOTA_EXCEEDED",
        context: { recovery_at: UTC_1600, credential_source: "platform" },
      }),
    ).toBe(
      `平台模型额度已用完，本回合无法继续。上游将于 ${moment} 恢复；或在「设置 · 服务商」接入自己的 API Key 立即继续。`,
    );
  });

  it("配额闸门：保留服务端那句的用量数字，另起一句说重置时刻", () => {
    const gate =
      "已达每日 token 上限（1,234 / 5,000），额度重置后可继续；或接入自己的 key 继续（设置 · 服务商）。";
    expect(
      withLocalRecoveryMoment(gate, {
        code: "QUOTA_EXCEEDED",
        context: { reset_at: UTC_1600 },
      }),
    ).toBe(`${gate}额度将于 ${moment} 重置。`);
  });

  it("服务端那句没有句末标点时补一个，不粘成一句", () => {
    expect(
      withLocalRecoveryMoment("本月额度已用完", {
        context: { reset_at: UTC_1600 },
      }),
    ).toBe(`本月额度已用完。额度将于 ${moment} 重置。`);
  });

  it("两个时刻都在时以 recovery_at 为准（上游那堵墙更晚放行）", () => {
    const out = withLocalRecoveryMoment("上游限流，本回合无法继续。", {
      code: "LLM_RATE_LIMIT",
      context: { recovery_at: UTC_1600, reset_at: "2026-08-14T00:00:00Z" },
    });
    expect(out).toContain(`将于 ${moment} 恢复`);
    expect(out).not.toContain("重置");
  });

  it("渲染结果里不出现时区名", () => {
    expect(
      withLocalRecoveryMoment("上游限流，本回合无法继续。", {
        code: "LLM_RATE_LIMIT",
        context: { recovery_at: UTC_1600, credential_source: "user" },
      }),
    ).not.toContain("UTC");
  });
});
