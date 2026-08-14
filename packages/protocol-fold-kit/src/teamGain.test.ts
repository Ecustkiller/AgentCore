import { describe, expect, it } from "vitest";
import { COLLAB_SUMMARY_TOOLTIP, formatCollabSummary } from "./index";

describe("formatCollabSummary（队友互相挑出了几处）", () => {
  it("全为 0 / 缺省 → 沉默", () => {
    expect(formatCollabSummary(undefined)).toBeNull();
    expect(formatCollabSummary(null)).toBeNull();
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
      }),
    ).toBeNull();
  });

  it("换的是说法不是数：读起来是「互相把关」，不是四个负面内部计数", () => {
    const line = formatCollabSummary({
      boundary_yields: 2,
      scope_signals: 1,
      revises: 1,
      escalations: 4,
    });
    expect(line).toBe(
      "互相把关：发现跑偏 1 处 · 返工重写 1 处 · 中途改分工 2 次 · 先问再做 3 处",
    );
    // 旧口径的黑话不得回流。
    expect(line).not.toMatch(/纠偏|漂移|唤回|上报/);
  });

  it("scope 上报只数一次：escalations 已含 scope_signals，并列会重复计数", () => {
    // 3 次上报里 3 次都是跑偏 → 只说「发现跑偏 3 处」，不再另挂「先问再做 3 处」。
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 3,
        revises: 0,
        escalations: 3,
      }),
    ).toBe("互相把关：发现跑偏 3 处");
  });

  it("只有一项非零时只说那一项", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 2 处");
  });

  it("audit_drops 等诊断字段不参与（多余键不影响判定）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
        audit_drops: 3,
      } as never),
    ).toBeNull();
  });

  it("用户自己点的「立即改此人」不算队友互检", () => {
    // 3 次返工里 2 次是用户亲手点的热修——只有剩下 1 次是队友把关。
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 3,
        revises_by_user: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 1 处");
  });

  it("全都是用户自己点的 → 沉默（不许拿用户的动作给团队记功）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 1,
        boundary_yields_by_user: 1,
        scope_signals: 0,
        revises: 2,
        revises_by_user: 2,
        escalations: 0,
      }),
    ).toBeNull();
  });

  it("用户拍板的边界（计划复核）不算「中途改分工」", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 3,
        boundary_yields_by_user: 1,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
      }),
    ).toBe("互相把关：中途改分工 2 次");
  });

  it("缺 *_by_user 的旧数据照原样读（不因缺字段变负 / 变空）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 1,
        scope_signals: 0,
        revises: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 2 处 · 中途改分工 1 次");
  });

  it("tooltip 解释这些词，且不冒充质量评分", () => {
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("发现跑偏");
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("不是给结果打分");
    // 这一行只说队友做的事——把承诺写在用户读得到的地方。
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("你自己点的");
  });
});
