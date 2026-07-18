// @vitest-environment jsdom
// 完成条件卡（批次验收 / completion_criteria）：delivery_status 的缺口 / 待操作渲染契约。
import type { DeliveryStatusPayload } from "@/types/events";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryStatusCard } from "../DeliveryStatusCard";

afterEach(() => {
  cleanup();
});

const partial: DeliveryStatusPayload = {
  execution_id: "exec-1",
  state: "partial",
  summary: "已交付 2 个文件；1 项缺口",
  delivered_files: ["build_pptx.py", "讲稿.md"],
  gaps: [
    {
      role: "课件工程师",
      description: "course.pptx 未生成（云端无执行环境，脚本未运行）",
    },
  ],
  actions: [
    {
      kind: "bind_local_folder",
      description: "绑定本地文件夹后，团队可在你的电脑上运行脚本生成产物。",
    },
  ],
};

describe("DeliveryStatusCard", () => {
  it("renders partial state with gaps and bind action button", () => {
    render(<DeliveryStatusCard status={partial} conversationId="c1" />);
    expect(screen.getByText("完成条件")).toBeTruthy();
    expect(screen.getByText("部分未满足")).toBeTruthy();
    expect(screen.getByText("团队可能重派")).toBeTruthy();
    expect(screen.getByText("已交付 2 个文件；1 项缺口")).toBeTruthy();
    expect(screen.getByText(/course\.pptx 未生成/)).toBeTruthy();
    // 已知 bind_local_folder 行动项 → 真按钮（复用 ask_user 卡的绑定通路）。
    expect(screen.getByRole("button", { name: "绑定本地文件夹" })).toBeTruthy();
  });

  it("renders blocked state and treats unknown action kinds as plain hints", () => {
    render(
      <DeliveryStatusCard
        status={{
          execution_id: "exec-2",
          state: "blocked",
          summary: "未能交付：1 项缺口",
          delivered_files: [],
          gaps: [
            { role: "验收", description: "尚无 worker 成功运行 code_execute" },
          ],
          actions: [{ kind: "future_kind", description: "未来的提示行" }],
        }}
        conversationId="c1"
      />,
    );
    expect(screen.getByText("未满足")).toBeTruthy();
    expect(screen.getByText("团队可能重派")).toBeTruthy();
    expect(screen.getByText("未来的提示行")).toBeTruthy();
    // 未知 kind 不渲染按钮（向前兼容：按普通提示行呈现）。
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for delivered state (清单由产出文件卡承载)", () => {
    const { container } = render(
      <DeliveryStatusCard
        status={{
          execution_id: "exec-3",
          state: "delivered",
          summary: "已交付 2 个文件",
          delivered_files: ["a.md", "b.md"],
          gaps: [],
          actions: [],
        }}
        conversationId="c1"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("hides bind button without a conversation id (预览/离线回放)", () => {
    render(<DeliveryStatusCard status={partial} conversationId={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("badges known cutoff reason codes on gaps", () => {
    render(
      <DeliveryStatusCard
        status={{
          execution_id: "exec-4",
          state: "partial",
          summary: "已交付 1 个文件；1 项缺口",
          delivered_files: ["大纲.md"],
          gaps: [
            {
              role: "课件工程师",
              description: "队员因 token 预算触顶被迫收口，产出可能不完整",
              reason: "token_budget",
            },
          ],
          actions: [],
        }}
        conversationId="c1"
      />,
    );
    expect(screen.getByText("预算触顶")).toBeTruthy();
    expect(screen.getByText(/token 预算触顶/)).toBeTruthy();
  });
});
