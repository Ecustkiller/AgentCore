// @vitest-environment jsdom
/**
 * 开工卡被动记录：默认一行结论收起，点开才看队员明细；
 * resolved / pending 摘要文案与各 decision label 对齐。
 */

import type { TeamPreviewDisplay } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamPreviewCard } from "../TeamPreviewCard";

vi.mock("@/stores/disclosure", () => ({
  usePersistentDisclosure: (_key: string | null, initial: boolean) => {
    const { useState } = require("react");
    return useState(initial);
  },
}));

function makePreview(
  overrides: Partial<TeamPreviewDisplay> = {},
): TeamPreviewDisplay {
  return {
    id: "tp-1",
    primitive: "delegate",
    workers: [
      {
        run_id: "r1",
        role: "研究员",
        task: "调研竞品定价策略与公开资料",
        depends_on: [],
        debate: false,
      },
      {
        run_id: "r2",
        role: "撰写员",
        task: "基于调研写定价建议",
        depends_on: ["r1"],
        debate: true,
      },
    ],
    tools: [],
    motion: "",
    form: "",
    sides: [],
    maxRounds: 0,
    thorough: true,
    status: "resolved",
    decision: "continue",
    note: "",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TeamPreviewCard", () => {
  it("resolved 默认收起为一行结论，不含队员任务全文", () => {
    render(<TeamPreviewCard preview={makePreview()} />);

    const toggle = screen.getByRole("button", {
      name: /已授权开工 · 首波已放行 · 2 名队员/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("研究员")).toBeNull();
    expect(screen.queryByText("调研竞品定价策略与公开资料")).toBeNull();
  });

  it("点击展开后显示队员角色、任务、依赖与辩论标记", () => {
    render(<TeamPreviewCard preview={makePreview()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /已授权开工 · 首波已放行 · 2 名队员/,
      }),
    );

    expect(
      screen
        .getByRole("button", {
          name: /已授权开工 · 首波已放行 · 2 名队员/,
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("研究员")).toBeTruthy();
    expect(screen.getByText("撰写员")).toBeTruthy();
    expect(screen.getByText("调研竞品定价策略与公开资料")).toBeTruthy();
    expect(screen.getByText("基于调研写定价建议")).toBeTruthy();
    expect(screen.getByText("依赖 1 步")).toBeTruthy();
    expect(screen.getByText("辩论")).toBeTruthy();
  });

  it("resolved 展开后显示备注 note", () => {
    render(
      <TeamPreviewCard
        preview={makePreview({ note: "先做公开竞品，不做内部访谈" })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /已授权开工 · 首波已放行 · 2 名队员/,
      }),
    );
    expect(screen.getByText("先做公开竞品，不做内部访谈")).toBeTruthy();
  });

  it("pending 默认收起为等待开工确认摘要，且无操作 CTA", () => {
    render(
      <TeamPreviewCard
        preview={makePreview({ status: "pending", decision: null })}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: /等待开工确认 · 2 名队员/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("研究员")).toBeNull();
    // 被动记录：只有开合，没有开工 / 停止类操作 CTA
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("pending 点击可展开队员明细", () => {
    render(
      <TeamPreviewCard
        preview={makePreview({ status: "pending", decision: null })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /等待开工确认 · 2 名队员/ }),
    );
    expect(screen.getByText("研究员")).toBeTruthy();
    expect(screen.getByText("撰写员")).toBeTruthy();
  });

  it.each([
    ["per_call", "已开工 · 将逐次审批能力调用 · 2 名队员"],
    ["adjust", "已调整 · 备注已注入队员并开做 · 2 名队员"],
    ["stop", "已停止 · 团队未启动 · 2 名队员"],
    ["timeout", "未及时回应，已自动开做 · 2 名队员"],
    ["orphaned", "已失效（回合已结束或服务已重启） · 2 名队员"],
  ] as const)("resolved decision=%s 保留既有 label 文案", (decision, label) => {
    render(<TeamPreviewCard preview={makePreview({ decision })} />);
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });

  it("debate pending 显示辩题与各方立场", () => {
    render(
      <TeamPreviewCard
        preview={makePreview({
          primitive: "debate",
          workers: [],
          status: "pending",
          decision: null,
          motion: "该不该上四天工作制？",
          form: "debate",
          sides: [
            { key: "pro", name: "正方", stance: "应推广" },
            { key: "con", name: "反方", stance: "暂缓" },
          ],
          maxRounds: 5,
          thorough: true,
        })}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: /等待开工确认 · 2 方/,
    });
    fireEvent.click(toggle);
    expect(screen.getByText("该不该上四天工作制？")).toBeTruthy();
    expect(screen.getByText("正方")).toBeTruthy();
    expect(screen.getByText("应推广")).toBeTruthy();
    expect(screen.getByText(/认真辩透 · 上限 5 轮/)).toBeTruthy();
  });
});
