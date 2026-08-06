// @vitest-environment jsdom
/**
 * Render + interaction tests for the mobile 离线恢复 card (结构化挂起 2b / 挂起即收口 ②).
 *
 * ResumeCard is the SINGLE durable surface for a turn that paused at a checkpoint and then
 * lost its live stream — surfaced on reopen, and (under ②, post flag-on) the moment a live
 * stream ENDS at a checkpoint (message_end finish_reason=paused → ChatPage.refreshPaused).
 * Unlike PauseCard it reads a PERSISTED PausedTurnSummary and asks the parent to drive a
 * fresh resume stream. These assert the two kind branches (ask_user / plan_review), that the
 * note rides along, and the plan_review-only 调整 gating — coverage the durable path lacked.
 * Dense kinds (team_preview / walls) use Latch + Interaction Sheet; Modal is stubbed (jsdom
 * lacks showModal). The block comment keeps the @vitest-environment directive file-leading
 * past organizeImports.
 */

import type { PausedTurnSummary } from "@/api/turn";
import { ResumeCard } from "@/components/ResumeCard";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

afterEach(cleanup);

function summary(over: Partial<PausedTurnSummary> = {}): PausedTurnSummary {
  return {
    message_id: "m-server-1",
    checkpoint_id: "cp1",
    kind: "ask_user",
    user_message: "做 A 还是 B？",
    user_message_id: "u1",
    question: "先做 A 还是 B?",
    context: "两条路线各有取舍。",
    // 契约序列化必带（服务端带默认值恒输出；仅 team_preview 开工卡才有具体值）
    form: "",
    motion: "",
    primitive: "delegate",
    max_rounds: 0,
    thorough: true,
    browser_login: false,
    ...over,
  };
}

describe("ResumeCard · ask_user", () => {
  it("renders the offline headline, the original request, question + context", () => {
    render(<ResumeCard paused={summary()} onResume={vi.fn()} />);
    expect(screen.getByText("需要你拍板（已离线保留）")).toBeTruthy();
    expect(screen.getByText("做 A 还是 B？")).toBeTruthy();
    expect(screen.getByText("先做 A 还是 B?")).toBeTruthy();
    expect(screen.getByText("两条路线各有取舍。")).toBeTruthy();
    // ask_user has no 调整 (that is plan_review-only steer).
    expect(screen.queryByText("调整")).toBeNull();
  });

  it("提交 submits continue with the trimmed note", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={summary()} onResume={onResume} />);
    fireEvent.change(screen.getByPlaceholderText(/可选/), {
      target: { value: "  选 A  " },
    });
    fireEvent.click(screen.getByText("提交"));
    expect(onResume).toHaveBeenCalledWith("continue", "选 A", []);
  });

  it("取消 submits stop（硬停，非 empty continue）", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={summary()} onResume={onResume} />);
    expect(screen.queryByText("跳过")).toBeNull();
    fireEvent.click(screen.getByText("取消"));
    expect(onResume).toHaveBeenCalledWith("stop", "", []);
    expect(onResume).not.toHaveBeenCalledWith(
      "continue",
      expect.anything(),
      expect.anything(),
    );
  });

  it("本机目录 action 可点 → LocalPickerFailureCard unavailable（不灰掉、不提交）", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "decision",
          questions: [
            {
              id: "q0",
              prompt: "工作区",
              kind: "choice",
              multiple: false,
              options: [
                { label: "打开本地项目", action: "open_local_project" },
                { label: "继续用云端" },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    const folderBtn = screen.getByRole("button", { name: /打开本地项目/ });
    expect((folderBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(folderBtn);
    const card = screen.getByTestId("local-picker-failure-card");
    expect(card.getAttribute("data-failure-kind")).toBe("unavailable");
    expect(card.textContent).toContain("本机目录仅桌面端可用");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("proposal_pick 行选映射进 selected；CTA 采用此方案", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "proposal_pick",
          questions: [
            {
              id: "q0",
              prompt: "选方案",
              kind: "choice",
              multiple: false,
              options: [{ label: "方案 A" }, { label: "方案 B" }],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(
      document.querySelector('[data-ask-intent="proposal_pick"]'),
    ).toBeTruthy();
    expect(screen.getAllByText("方案挑选 · 选一条推进").length).toBeGreaterThan(
      0,
    );
    fireEvent.click(screen.getByText("方案 A"));
    fireEvent.click(screen.getByText("采用此方案"));
    expect(onResume).toHaveBeenCalledWith("continue", "", ["方案 A"]);
  });

  it("proposal_pick 空选不可提交", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "proposal_pick",
          questions: [
            {
              id: "q0",
              prompt: "选方案",
              kind: "choice",
              multiple: false,
              options: [{ label: "方案 A" }, { label: "方案 B" }],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    const cta = screen.getByRole("button", { name: "采用此方案" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cta);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("organize_plan 默认可剔除；非全保留；CTA 确认并整理（n）", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "organize_plan",
          questions: [
            {
              id: "q0",
              prompt: "保留哪些操作",
              kind: "choice",
              multiple: true,
              options: [
                { label: "a → b", op: "move", source: "a", destination: "b" },
                { label: "删 x", op: "delete", path: "x" },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(
      document.querySelector('[data-ask-intent="organize_plan"]'),
    ).toBeTruthy();
    expect(
      screen.getAllByText("整理方案 · 确认要执行的项").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("取消勾选即剔除")).toBeTruthy();
    expect(screen.getByText("a → b")).toBeTruthy();
    // Uncheck second item — not keep-all.
    fireEvent.click(screen.getByText("删 x"));
    fireEvent.click(screen.getByRole("button", { name: /确认并整理/ }));
    expect(onResume).toHaveBeenCalledWith("continue", "", ["a → b"]);
    expect(onResume.mock.calls[0][2]).not.toEqual(["a → b", "删 x"]);
  });

  it("organize_plan 空选禁 CTA", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "organize_plan",
          questions: [
            {
              id: "q0",
              prompt: "保留哪些操作",
              kind: "choice",
              multiple: true,
              options: [
                { label: "a → b", op: "move", source: "a", destination: "b" },
                { label: "删 x", op: "delete", path: "x" },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText("a → b"));
    fireEvent.click(screen.getByText("删 x"));
    const cta = screen.getByRole("button", { name: /^确认并整理$/ });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cta);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("risk_ack 行式多选；严重度灰字；空选可继续", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "risk_ack",
          questions: [
            {
              id: "q0",
              prompt: "本轮处理哪些风险",
              kind: "choice",
              multiple: true,
              options: [
                { label: "[高] 密钥轮换", detail: "优先" },
                { label: "[低] 文档补齐" },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(document.querySelector('[data-ask-intent="risk_ack"]')).toBeTruthy();
    expect(screen.getByText("密钥轮换")).toBeTruthy();
    expect(screen.getByText("高")).toBeTruthy();
    expect(screen.getByText("低")).toBeTruthy();
    // Empty selection allowed.
    fireEvent.click(screen.getByText("确认并继续"));
    expect(onResume).toHaveBeenCalledWith("continue", "", []);
  });

  it("decision default 预选 + compose 答复 +「其他」逃逸", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "decision",
          questions: [
            {
              id: "q0",
              prompt: "先做哪条",
              kind: "choice",
              multiple: false,
              default: "方案 A",
              options: [{ label: "方案 A" }, { label: "方案 B" }],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(document.querySelector('[data-ask-intent="decision"]')).toBeTruthy();
    expect(screen.getByText("其他…")).toBeTruthy();
    // Default preselected — one-click submit composes.
    fireEvent.click(screen.getByText("提交"));
    expect(onResume).toHaveBeenCalledWith(
      "continue",
      "我的答复：\n· 先做哪条：方案 A",
      [],
    );
  });

  it("daily_review 默认全选，取消勾选后提交带 selected", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "daily_review",
          questions: [
            {
              id: "q0",
              prompt: "落盘哪些提案",
              kind: "choice",
              multiple: true,
              options: [
                {
                  label: "偏好简洁",
                  review_kind: "preference",
                  body: "短句",
                },
                { label: "规则先问", review_kind: "rule", body: "先确认" },
                {
                  label: "主题：周报节奏",
                  review_kind: "topic",
                  body: "周五",
                },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(
      screen.getAllByText("复盘提案 · 确认要落盘的项").length,
    ).toBeGreaterThan(0);
    expect(
      document.querySelector('[data-ask-intent="daily_review"]'),
    ).toBeTruthy();
    expect(screen.getByText("偏好 · 短句")).toBeTruthy();
    expect(screen.getByText("规则 · 先确认")).toBeTruthy();
    expect(
      screen.getByText(/确认后服务端直接写入记忆\/规则\/文档/),
    ).toBeTruthy();
    expect(screen.getByText("取消勾选即跳过")).toBeTruthy();

    // Seed all three; uncheck one.
    fireEvent.click(screen.getByText("主题：周报节奏"));
    fireEvent.click(screen.getByRole("button", { name: /确认落盘/ }));
    expect(onResume).toHaveBeenCalledWith("continue", "", [
      "偏好简洁",
      "规则先问",
    ]);
  });

  it("daily_review 全取消后确认落盘禁用", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          intent: "daily_review",
          questions: [
            {
              id: "q0",
              prompt: "落盘哪些提案",
              kind: "choice",
              multiple: true,
              options: [
                { label: "偏好简洁", review_kind: "preference", body: "短句" },
                { label: "规则先问", review_kind: "rule", body: "先确认" },
              ],
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText("偏好简洁"));
    fireEvent.click(screen.getByText("规则先问"));
    const cta = screen.getByRole("button", { name: /^确认落盘$/ });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cta);
    expect(onResume).not.toHaveBeenCalled();
  });
});

describe("ResumeCard · plan_review", () => {
  const planReview = (
    over: Partial<PausedTurnSummary> = {},
  ): PausedTurnSummary =>
    summary({
      kind: "plan_review",
      checkpoint_id: "pr1",
      question: "",
      context: "",
      steps: [{ role: "调研", output_summary: "方案就绪" }],
      pending: [{ role: "执行" }],
      ...over,
    });

  it("renders the plan_review headline and the completed step", () => {
    render(<ResumeCard paused={planReview()} onResume={vi.fn()} />);
    expect(
      screen.getAllByText("执行已暂停 · 待你决定是否继续").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("调研")).toBeTruthy();
    expect(screen.getByText("方案就绪")).toBeTruthy();
  });

  it("调整 is gated until a note is typed, then steers with it", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={planReview()} onResume={onResume} />);
    const adjust = screen.getByText("调整") as HTMLButtonElement;
    expect(adjust.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/可选/), {
      target: { value: "换个方向" },
    });
    expect(adjust.disabled).toBe(false);
    fireEvent.click(adjust);
    expect(onResume).toHaveBeenCalledWith("adjust", "换个方向", []);
  });
});

describe("ResumeCard · team_preview", () => {
  const teamPreview = (
    over: Partial<PausedTurnSummary> = {},
  ): PausedTurnSummary =>
    summary({
      kind: "team_preview",
      checkpoint_id: "tp1",
      question: "",
      context: "",
      workers: [
        {
          run_id: "r1",
          role: "调研",
          task: "做A",
          depends_on: [],
          write_capability: "can_write_files",
          write_capability_label: "可改文件",
        },
      ],
      tools: ["file_write"],
      primitive: "delegate",
      ...over,
    });

  it("非 debate 仅授权并开工 + 取消，无调整 / 逐次审批", () => {
    render(<ResumeCard paused={teamPreview()} onResume={vi.fn()} />);
    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("调整")).toBeNull();
    expect(screen.queryByText("逐次审批开工")).toBeNull();
    expect(screen.getByText("纳入本轮")).toBeTruthy();
    expect(screen.getByText("本批工具：file_write")).toBeTruthy();
  });

  it("Latch + Sheet：默认打开可点 CTA；收起留 latch，再打开不丢控件", () => {
    render(<ResumeCard paused={teamPreview()} onResume={vi.fn()} />);
    // Sheet open → latch hidden so chat column is not double-taxed.
    expect(screen.queryByTestId("resume-card-latch")).toBeNull();
    expect(screen.getByText("授权并开工")).toBeTruthy();
    fireEvent.click(screen.getByTestId("interaction-sheet-collapse"));
    expect(screen.queryByText("授权并开工")).toBeNull();
    const latch = screen.getByTestId("resume-card-latch");
    expect(latch).toBeTruthy();
    expect(screen.getByText("1 人待确认 · 点开授权开工")).toBeTruthy();
    fireEvent.click(latch);
    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(screen.getByText("纳入本轮")).toBeTruthy();
  });

  it("主按钮带嘱咐发 continue（未改正时无修正载荷）", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={teamPreview()} onResume={onResume} />);
    fireEvent.change(screen.getByPlaceholderText(/对全体队员的嘱咐/), {
      target: { value: "更简洁" },
    });
    fireEvent.click(screen.getByText("授权并开工"));
    expect(onResume).toHaveBeenCalledWith("continue", "更简洁", [], {
      excluded_run_ids: [],
      write_capability_overrides: [],
    });
  });

  it("可排除多余岗；continue 带 excluded_run_ids", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={teamPreview({
          workers: [
            {
              run_id: "r1",
              role: "调研",
              task: "做A",
              depends_on: [],
              write_capability: "text_only",
              write_capability_label: "仅文字报告",
            },
            {
              run_id: "r2",
              role: "写作",
              task: "做B",
              depends_on: [],
              write_capability: "can_write_files",
              write_capability_label: "可改文件",
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByLabelText("纳入本轮 写作"));
    fireEvent.click(screen.getByText("授权并开工"));
    expect(onResume).toHaveBeenCalledWith("continue", "", [], {
      excluded_run_ids: ["r2"],
      write_capability_overrides: [],
    });
  });

  it("至少保留 1 人：关到 0 被拒并提示", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={teamPreview()} onResume={onResume} />);
    fireEvent.click(screen.getByLabelText("纳入本轮 调研"));
    expect(screen.getByTestId("team-include-hint").textContent).toBe(
      "至少保留 1 名队员",
    );
    fireEvent.click(screen.getByText("授权并开工"));
    expect(onResume).toHaveBeenCalledWith("continue", "", [], {
      excluded_run_ids: [],
      write_capability_overrides: [],
    });
  });

  it("仍被他人 depends_on 引用的岗禁止排除", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={teamPreview({
          workers: [
            {
              run_id: "r1",
              role: "调研",
              task: "做A",
              depends_on: [],
              write_capability: "text_only",
              write_capability_label: "仅文字报告",
            },
            {
              run_id: "r2",
              role: "写作",
              task: "做B",
              depends_on: ["r1"],
              write_capability: "can_write_files",
              write_capability_label: "可改文件",
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByLabelText("纳入本轮 调研"));
    expect(screen.getByTestId("team-include-hint").textContent).toBe(
      "仍有队员依赖此岗",
    );
    fireEvent.click(screen.getByText("授权并开工"));
    expect(onResume).toHaveBeenCalledWith("continue", "", [], {
      excluded_run_ids: [],
      write_capability_overrides: [],
    });
  });

  it("可改文件 → 仅文字：continue 带 write_capability_overrides", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={teamPreview()} onResume={onResume} />);
    expect(screen.getByText("可改文件")).toBeTruthy();
    fireEvent.click(screen.getByText("改为仅文字"));
    fireEvent.click(screen.getByText("授权并开工"));
    expect(onResume).toHaveBeenCalledWith("continue", "", [], {
      excluded_run_ids: [],
      write_capability_overrides: [{ run_id: "r1", capability: "text_only" }],
    });
  });

  it("已是仅文字无升权入口；stop 不带修正", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={teamPreview({
          workers: [
            {
              run_id: "r1",
              role: "调研",
              task: "做A",
              depends_on: [],
              write_capability: "text_only",
              write_capability_label: "仅文字报告",
            },
            {
              run_id: "r2",
              role: "写作",
              task: "做B",
              depends_on: [],
              write_capability: "can_write_files",
              write_capability_label: "可改文件",
            },
          ],
        })}
        onResume={onResume}
      />,
    );
    expect(screen.queryByText("改为仅文字")).toBeTruthy(); // r2 only
    // tighten + exclude then stop → amendments ignored (undefined)
    fireEvent.click(screen.getByText("改为仅文字"));
    fireEvent.click(screen.getByLabelText("纳入本轮 写作"));
    fireEvent.click(screen.getByText("取消"));
    expect(onResume).toHaveBeenCalledWith("stop", "", []);
  });

  it("debate 仅开赛 + 取消；嘱咐走 continue；无纳入控件", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={teamPreview({
          primitive: "debate",
          workers: [],
          motion: "辩题",
          sides: [{ name: "正方", stance: "赞成" }],
        })}
        onResume={onResume}
      />,
    );
    expect(screen.getByText("开赛")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("调整")).toBeNull();
    expect(screen.queryByText("纳入本轮")).toBeNull();
    expect(screen.queryByText("先多视角调研再辩")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/开赛嘱咐/), {
      target: { value: "最关心成本谁买单" },
    });
    fireEvent.click(screen.getByText("开赛"));
    expect(onResume).toHaveBeenCalledWith("continue", "最关心成本谁买单", []);
  });

  it("开工卡不再提供 research_first 第三键（庭前取证内化）", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={teamPreview({
          primitive: "debate",
          workers: [],
          motion: "辩题",
          sides: [{ name: "正方", stance: "赞成" }],
        })}
        onResume={onResume}
      />,
    );
    expect(screen.queryByText("先多视角调研再辩")).toBeNull();
    expect(screen.getByText("开赛")).toBeTruthy();
  });
});

describe("ResumeCard · ask_user browser_login", () => {
  it("renders 需要你登录 + Sandbox 引导；可开直播；无假打开浏览器", () => {
    const onOpenLive = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          browser_login: true,
          question: "请登录目标站点",
        })}
        onResume={vi.fn()}
        onOpenLive={onOpenLive}
      />,
    );
    expect(screen.getByText(/需要你登录/)).toBeTruthy();
    expect(screen.getByText("请登录目标站点")).toBeTruthy();
    expect(screen.getByText(/Sandbox/)).toBeTruthy();
    expect(screen.queryByText(/手机暂无内嵌浏览器/)).toBeNull();
    expect(screen.queryByText(/桌面端完成登录/)).toBeNull();
    expect(screen.getByText("已登录，继续")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.getByTestId("browser-login-open-live")).toBeTruthy();
    fireEvent.click(screen.getByText("查看直播"));
    expect(onOpenLive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("跳过")).toBeNull();
    expect(screen.queryByText("停止")).toBeNull();
    expect(screen.queryByText("打开浏览器")).toBeNull();
    expect(screen.queryByText("需要你拍板（已离线保留）")).toBeNull();
  });

  it("无 onOpenLive 时不显示「查看直播」", () => {
    render(
      <ResumeCard
        paused={summary({ browser_login: true, question: "登录" })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("browser-login-open-live")).toBeNull();
    expect(screen.getByText(/Sandbox/)).toBeTruthy();
  });

  it("已登录，继续 → continue + note「已登录，继续」", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({ browser_login: true, question: "登录" })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText("已登录，继续"));
    expect(onResume).toHaveBeenCalledWith("continue", "已登录，继续", []);
  });

  it("取消 → stop（wire decision=stop）", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({ browser_login: true, question: "登录" })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText("取消"));
    expect(onResume).toHaveBeenCalledWith("stop", "", []);
  });

  it("有 assumptions →「按假设继续」+ note=假设文案", () => {
    const onResume = vi.fn();
    render(
      <ResumeCard
        paused={summary({
          browser_login: true,
          question: "登录",
          assumptions: [{ id: "a0", label: "登录", value: "用户已登录" }],
        })}
        onResume={onResume}
      />,
    );
    expect(screen.getByText(/未答则按此继续：登录：用户已登录/)).toBeTruthy();
    fireEvent.click(screen.getByText("按假设继续"));
    expect(onResume).toHaveBeenCalledWith("continue", "登录：用户已登录", []);
  });

  it("无 assumptions 时不显示「按假设继续」", () => {
    render(
      <ResumeCard
        paused={summary({ browser_login: true, question: "登录" })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByText("按假设继续")).toBeNull();
  });

  it("普通 ask 不受影响：仍是拍板标题 + 取消", () => {
    render(<ResumeCard paused={summary()} onResume={vi.fn()} />);
    expect(screen.getByText("需要你拍板（已离线保留）")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText(/需要你登录/)).toBeNull();
    expect(screen.queryByTestId("browser-login-decision")).toBeNull();
  });
});
