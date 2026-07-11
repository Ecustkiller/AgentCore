// @vitest-environment jsdom
/**
 * 终审区钻取惯例（全场统一「名字/身份行 = 打开 run 详情侧栏」）：
 * - 「主持人终审」标题 + 模型徽章这组身份行在 moderatorRun 在时是钻取按钮，
 *   侧栏标题沿用「主持人」；
 * - 「裁决过程」文字链接已删（文字链接只留给就地展开）；
 * - moderatorRun 缺席（进行中 / 旧产物）时标题退回纯文本。
 */

import type { Execution, RunNode } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebateModel } from "../../model";
import { FinaleStage } from "../FinaleStage";

// 续辩 CTA 拉整套对话/会话 store，与钻取无关 → 打桩。
vi.mock("../../Continue", () => ({ DebateContinue: () => null }));

function moderatorRun(id = "moderator"): RunNode {
  return {
    id,
    agentId: id,
    status: "completed",
    kind: "agent",
    model: "deepseek/deepseek-chat",
    parentRunId: null,
    revisionOf: null,
    receivedContext: [],
  } as unknown as RunNode;
}

function makeModel(overrides: Partial<DebateModel> = {}): DebateModel {
  return {
    form: "debate",
    motion: "是否采用方案 A",
    stopReason: null,
    moderatorRunId: "moderator",
    narrativeFirst: false,
    rounds: [],
    brief: null,
    sides: null,
    closings: [],
    opening: null,
    settled: true,
    ...overrides,
  } as DebateModel;
}

function executionWith(runs: RunNode[]): Execution {
  return {
    status: "completed",
    runs,
    agents: [],
    frames: [],
    debate: null,
    debateRounds: [],
    debateDecisions: [],
    teamNotes: [],
  } as unknown as Execution;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FinaleStage 钻取惯例", () => {
  it("身份行（标题 + 模型徽章）是钻取按钮，裁决过程链接已删", () => {
    const showRunDetail = vi.fn();
    useSidePanelStore.setState({ showRunDetail });
    render(
      <FinaleStage
        model={makeModel()}
        execution={executionWith([moderatorRun()])}
        messageId="m1"
      />,
    );

    expect(screen.queryByRole("button", { name: "裁决过程" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /主持人终审/ }));

    expect(showRunDetail).toHaveBeenCalledWith("m1", "moderator", "主持人");
  });

  it("无 moderatorRun 时标题退回纯文本", () => {
    render(
      <FinaleStage
        model={makeModel({ moderatorRunId: null })}
        execution={executionWith([])}
        messageId="m1"
      />,
    );

    expect(screen.getByText("主持人终审")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /主持人终审/ })).toBeNull();
  });
});
