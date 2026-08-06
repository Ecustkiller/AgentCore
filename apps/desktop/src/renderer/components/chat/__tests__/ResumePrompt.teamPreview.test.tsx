// @vitest-environment jsdom
/**
 * 开工卡可操作面：delegate / debate 均两键（授权开工·开赛 / 取消）；
 * continue + 非空备注 = 嘱咐注入；debate 无「调整」。
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumePrompt } from "../ResumePrompt";

const submitInteraction = vi.fn().mockResolvedValue("ok");
const notifyError = vi.fn();

vi.mock("@/services/interactionSubmit", () => ({
  submitInteraction: (...args: unknown[]) => submitInteraction(...args),
  submitInteractionFeedback: (result: "busy" | "orphaned") =>
    result === "orphaned" ? "确认已失效" : "请稍候再试",
}));

vi.mock("@/lib/toast", () => ({
  notifyError: (...args: unknown[]) => notifyError(...args),
}));

const pendingRef: { current: unknown[] } = { current: [] };

vi.mock("@/stores/conversation", () => ({
  useConversationStore: (
    sel: (s: { currentConversationId: string }) => unknown,
  ) => sel({ currentConversationId: "c1" }),
}));

vi.mock("@/stores/pausedTurns", () => ({
  usePausedTurnStore: (sel: (s: { pending: unknown[] }) => unknown) =>
    sel({ pending: pendingRef.current }),
}));

vi.mock("@/stores/interactions", () => ({
  useInteractionStore: (sel: (s: { byId: Map<string, unknown> }) => unknown) =>
    sel({ byId: new Map() }),
}));

function makeTeamPreview(over: Record<string, unknown> = {}) {
  return {
    messageId: "m1",
    conversationId: "c1",
    checkpointId: "cp1",
    kind: "team_preview",
    userMessage: "组团做定价",
    userMessageId: "u1",
    steps: [],
    pending: [],
    workers: [
      {
        run_id: "r1",
        role: "研究员",
        task: "调研",
        depends_on: [],
      },
    ],
    tools: ["file_write", "code_execute"],
    primitive: "delegate",
    motion: "",
    form: "",
    sides: [],
    maxRounds: 0,
    thorough: true,
    question: "",
    context: "",
    assumptions: [],
    questions: [],
    intent: "kickoff",
    origin: "server",
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pendingRef.current = [];
});

beforeEach(() => {
  pendingRef.current = [makeTeamPreview()];
  submitInteraction.mockReset();
  submitInteraction.mockResolvedValue("ok");
  notifyError.mockReset();
});

describe("ResumePrompt · team_preview delegate", () => {
  it("后端 headline 优先展示在导语", () => {
    pendingRef.current = [
      makeTeamPreview({ headline: "MVP主流程 · 预计 1 人" }),
    ];
    render(<ResumePrompt />);
    expect(screen.getByText("MVP主流程 · 预计 1 人")).toBeTruthy();
    expect(screen.getByText("分工预览")).toBeTruthy();
  });

  it("仅两按钮：授权并开工 + 取消；无逐次审批 / 调整", () => {
    render(<ResumePrompt />);
    expect(screen.queryByText("等你确认 · 确认后才会开工")).toBeNull();
    expect(screen.getByText("预计 1 人开工")).toBeTruthy();
    expect(screen.getByText("分工预览")).toBeTruthy();
    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("逐次审批开工")).toBeNull();
    expect(screen.queryByText("调整")).toBeNull();
    expect(screen.getByText("将授权的执行能力")).toBeTruthy();
  });

  it("主按钮带非空备注发 continue（非 adjust）", () => {
    render(<ResumePrompt />);
    fireEvent.change(screen.getByPlaceholderText(/对全体队员的嘱咐/), {
      target: { value: "  先做公开竞品  " },
    });
    fireEvent.click(screen.getByText("授权并开工"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "continue",
          note: "先做公开竞品",
        }),
      }),
    );
  });

  it("submitInteraction 非 ok 时 toast，不假成功", async () => {
    submitInteraction.mockResolvedValue("busy");
    render(<ResumePrompt />);
    fireEvent.click(screen.getByText("授权并开工"));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith("请稍候再试");
    });
  });

  it("队员任务默认折叠为一行摘要，点击可展开全文", () => {
    const longTask =
      "第一行调研公开竞品定价\n第二行整理对比表\n第三行给出建议区间";
    pendingRef.current = [
      makeTeamPreview({
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            task: longTask,
            depends_on: [],
          },
        ],
      }),
    ];
    render(<ResumePrompt />);

    const toggle = screen.getByRole("button", { name: "展开 研究员 任务" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".line-clamp-1")).toBeTruthy();
    expect(toggle.querySelector(".whitespace-pre-wrap")).toBeNull();

    fireEvent.click(toggle);
    const opened = screen.getByRole("button", { name: "收起 研究员 任务" });
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    expect(opened.querySelector(".whitespace-pre-wrap")).toBeTruthy();
    expect(opened.querySelector(".line-clamp-1")).toBeNull();
    expect(opened.textContent).toContain("第三行给出建议区间");
  });

  it("限高滚动壳：内容区可滚、CTA 钉底", () => {
    pendingRef.current = [
      makeTeamPreview({
        workers: Array.from({ length: 8 }, (_, i) => ({
          run_id: `r${i}`,
          role: `队员${i}`,
          task: `任务说明 ${i}\n补充细节很多很多很多`,
          depends_on: [],
        })),
      }),
    ];
    const { container } = render(<ResumePrompt />);
    const shell = Array.from(container.querySelectorAll("div")).find((el) =>
      el.className.includes("max-h-[min(60vh,36rem)]"),
    );
    expect(shell).toBeTruthy();
    expect(shell?.className).toContain("overflow-hidden");
    expect(shell?.className).toContain("flex-col");

    const scroll = Array.from(container.querySelectorAll("div")).find(
      (el) =>
        el.className.includes("overflow-y-auto") &&
        el.className.includes("min-h-0") &&
        el.className.includes("flex-1"),
    );
    expect(scroll).toBeTruthy();

    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(screen.getByPlaceholderText(/对全体队员的嘱咐/)).toBeTruthy();
  });

  it("纳入开关：排除无依赖队员后 continue 带 excluded_run_ids", () => {
    pendingRef.current = [
      makeTeamPreview({
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            task: "调研",
            depends_on: [],
            write_capability: "can_write_files",
            write_capability_label: "可改文件",
          },
          {
            run_id: "r2",
            role: "撰写员",
            task: "写报告",
            depends_on: [],
            write_capability: "text_only",
            write_capability_label: "仅文字报告",
          },
        ],
      }),
    ];
    render(<ResumePrompt />);
    fireEvent.click(screen.getByRole("switch", { name: "纳入本轮 · 撰写员" }));
    fireEvent.click(screen.getByText("授权并开工"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "continue",
          excluded_run_ids: ["r2"],
        }),
      }),
    );
    const cold = submitInteraction.mock.calls[0][0].cold as Record<
      string,
      unknown
    >;
    expect(cold.write_capability_overrides).toBeUndefined();
  });

  it("可改文件→仅文字：continue 带 write_capability_overrides", () => {
    pendingRef.current = [
      makeTeamPreview({
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            task: "调研",
            depends_on: [],
            write_capability: "can_write_files",
            write_capability_label: "可改文件",
          },
          {
            run_id: "r2",
            role: "撰写员",
            task: "写报告",
            depends_on: [],
            write_capability: "can_write_files",
            write_capability_label: "可改文件",
          },
        ],
      }),
    ];
    render(<ResumePrompt />);
    fireEvent.click(
      screen.getByRole("button", { name: "研究员 收紧为仅文字" }),
    );
    fireEvent.click(screen.getByText("授权并开工"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "continue",
          write_capability_overrides: [
            { run_id: "r1", capability: "text_only" },
          ],
        }),
      }),
    );
  });

  it("仍被依赖的岗禁止排除并短提示；至少保留 1 人", () => {
    pendingRef.current = [
      makeTeamPreview({
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            task: "调研",
            depends_on: [],
          },
          {
            run_id: "r2",
            role: "撰写员",
            task: "写报告",
            depends_on: ["r1"],
          },
        ],
      }),
    ];
    render(<ResumePrompt />);
    const r1Switch = screen.getByRole("switch", { name: "纳入本轮 · 研究员" });
    const r2Switch = screen.getByRole("switch", { name: "纳入本轮 · 撰写员" });
    expect(r1Switch).toHaveProperty("disabled", true);
    expect(screen.getByTestId("team-preview-dep-block-hint").textContent).toBe(
      "仍有队员依赖此岗",
    );
    // 排除下游后：上游不再被依赖，但成唯一纳入者 → 仍禁止关到 0
    fireEvent.click(r2Switch);
    expect(r1Switch).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByText("授权并开工"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "continue",
          excluded_run_ids: ["r2"],
        }),
      }),
    );
  });

  it("stop 不带修正字段", () => {
    pendingRef.current = [
      makeTeamPreview({
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            task: "调研",
            depends_on: [],
            write_capability: "can_write_files",
            write_capability_label: "可改文件",
          },
          {
            run_id: "r2",
            role: "撰写员",
            task: "写报告",
            depends_on: [],
          },
        ],
      }),
    ];
    render(<ResumePrompt />);
    fireEvent.click(screen.getByRole("switch", { name: "纳入本轮 · 撰写员" }));
    fireEvent.click(
      screen.getByRole("button", { name: "研究员 收紧为仅文字" }),
    );
    fireEvent.click(screen.getByText("取消"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "stop",
        }),
      }),
    );
    const cold = submitInteraction.mock.calls[0][0].cold as Record<
      string,
      unknown
    >;
    expect(cold.excluded_run_ids).toBeUndefined();
    expect(cold.write_capability_overrides).toBeUndefined();
  });
});

describe("ResumePrompt · team_preview debate", () => {
  beforeEach(() => {
    pendingRef.current = [
      makeTeamPreview({
        primitive: "debate",
        tools: [],
        workers: [],
        motion: "该不该上四天工作制？",
        sides: [
          { key: "pro", name: "正方", stance: "应推广" },
          { key: "con", name: "反方", stance: "暂缓" },
        ],
        maxRounds: 5,
      }),
    ];
  });

  it("仅两按钮：授权开赛 + 取消；无调整 / 逐次审批", () => {
    render(<ResumePrompt />);
    expect(screen.queryByText("等你确认 · 确认后才会开赛")).toBeNull();
    expect(screen.getByText("预计 2 方开赛")).toBeTruthy();
    expect(screen.getByText("授权开赛")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("调整")).toBeNull();
    expect(screen.queryByText("逐次审批开工")).toBeNull();
    expect(screen.getByPlaceholderText(/开赛嘱咐/)).toBeTruthy();
    // cold Badge 与 hot DebateBody 共用 formatDebateBudgetLabel（含「上限」）
    expect(screen.getByText("认真辩透 · 上限 5 轮")).toBeTruthy();
  });

  it("主按钮带嘱咐发 continue；辩论不附修正字段", () => {
    render(<ResumePrompt />);
    fireEvent.change(screen.getByPlaceholderText(/开赛嘱咐/), {
      target: { value: "最关心成本谁买单" },
    });
    fireEvent.click(screen.getByText("授权开赛"));
    expect(submitInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        cold: expect.objectContaining({
          decision: "continue",
          note: "最关心成本谁买单",
        }),
      }),
    );
    const cold = submitInteraction.mock.calls[0][0].cold as Record<
      string,
      unknown
    >;
    expect(cold.excluded_run_ids).toBeUndefined();
    expect(cold.write_capability_overrides).toBeUndefined();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("开工卡不再提供 research_first 第三键（庭前取证内化）", () => {
    render(<ResumePrompt />);
    expect(screen.queryByText("先多视角调研再辩")).toBeNull();

    pendingRef.current = [
      makeTeamPreview({
        primitive: "debate",
        tools: [],
        workers: [],
        motion: "该不该上四天工作制？",
        sides: [
          { key: "pro", name: "正方", stance: "应推广" },
          { key: "con", name: "反方", stance: "暂缓" },
        ],
        maxRounds: 5,
      }),
    ];
    cleanup();
    render(<ResumePrompt />);
    expect(screen.queryByText("先多视角调研再辩")).toBeNull();
    expect(screen.getByText("授权开赛")).toBeTruthy();
  });
});
