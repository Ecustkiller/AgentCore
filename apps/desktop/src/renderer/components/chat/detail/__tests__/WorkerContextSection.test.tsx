// @vitest-environment jsdom

import { WorkerContextSection } from "@/components/chat/detail/WorkerContextSection";
import type { ContextBlockWire } from "@/types/events";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/disclosure", () => ({
  usePersistentDisclosure: (_key: string | null, initial: boolean) =>
    useState(initial),
}));

const blocks: ContextBlockWire[] = [
  {
    channel: "task",
    heading: "你的任务",
    body: "调研竞品定价",
    chars: 6,
    truncated: false,
    files: [],
    source_role: "",
    source_run_id: "",
    fidelity: "",
  },
];

describe("WorkerContextSection", () => {
  it("普通模式只显示结构化分段，无系统提示词/LLM 窗口标题", () => {
    render(
      <WorkerContextSection
        blocks={blocks}
        diagnosticMode={false}
        diagnostic={{
          messages: [],
          available: false,
          loading: false,
          error: null,
        }}
        keyBase="t"
      />,
    );
    expect(screen.getByText("收到的上下文")).toBeTruthy();
    expect(screen.getByText("1 段")).toBeTruthy();
    expect(screen.queryByText("LLM 窗口")).toBeNull();
    expect(screen.queryByText(/系统提示词/)).toBeNull();
  });

  it("诊断模式展开后显示系统提示与结构化开场，不展示后续工作链轮次", () => {
    render(
      <WorkerContextSection
        blocks={blocks}
        diagnosticMode
        diagnostic={{
          messages: [
            { role: "system", content: "你是调研员。" },
            {
              role: "user",
              content: "## 你的任务\n调研竞品定价",
              origin: "context_blocks",
            },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "web_search", arguments: '{"q":"x"}' },
                },
              ],
            },
            {
              role: "tool",
              content: "search results",
              tool_call_id: "c1",
            },
          ],
          available: true,
          loading: false,
          error: null,
        }}
        keyBase="diag"
      />,
    );

    fireEvent.click(screen.getByText("收到的上下文"));
    expect(screen.getByText(/系统提示词/)).toBeTruthy();
    expect(screen.getByText("开场上下文（结构化分段）")).toBeTruthy();
    expect(screen.getByText("查看原始拼接")).toBeTruthy();
    // 后续轮与 ProcessTimeline 重复，诊断态也不再挂在此节。
    expect(screen.queryByText("助手")).toBeNull();
    expect(screen.queryByText("工具")).toBeNull();
    expect(screen.queryByText("web_search")).toBeNull();
    // 拼接原文不应直接铺在开场区（由结构化分段替代）。
    expect(screen.queryByText("## 你的任务\n调研竞品定价")).toBeNull();
  });

  it("REST error 只显示加载失败，不叠 journal 降级文案", () => {
    render(
      <WorkerContextSection
        blocks={blocks}
        diagnosticMode
        diagnostic={{
          messages: [],
          available: false,
          loading: false,
          error: "加载失败",
        }}
        keyBase="err"
      />,
    );
    fireEvent.click(screen.getByText("收到的上下文"));
    expect(screen.getByText("加载失败")).toBeTruthy();
    expect(screen.queryByText(/无法加载系统提示/)).toBeNull();
  });

  it("available=false 且无 error 时才显示 journal 降级", () => {
    render(
      <WorkerContextSection
        blocks={blocks}
        diagnosticMode
        diagnostic={{
          messages: [],
          available: false,
          loading: false,
          error: null,
        }}
        keyBase="degrade"
      />,
    );
    fireEvent.click(screen.getByText("收到的上下文"));
    expect(screen.getByText(/无法加载系统提示 \/ 原始拼接/)).toBeTruthy();
    expect(screen.queryByText("加载失败")).toBeNull();
  });
});
