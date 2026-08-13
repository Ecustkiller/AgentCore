// @vitest-environment jsdom
/**
 * 画布侧看得见也改得了槽位；改一处不能顺手抹掉 definition 的其余部分。
 */
import type { WorkflowDefinition } from "@/services/workflowDefinition";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowSlotsPanel } from "../WorkflowSlotsPanel";

function definitionWith(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "step1",
        kind: "agent_step",
        role: "调研员",
        task: "调研 {{topic}} 的定价",
      },
    ],
    edges: [],
    slots: [{ key: "topic", label: "调研主题", default: "Notion 的协作功能" }],
    ...overrides,
  };
}

function renderPanel(definition: WorkflowDefinition) {
  const onChange = vi.fn();
  render(<WorkflowSlotsPanel definition={definition} onChange={onChange} />);
  return onChange;
}

function nextDefinition(onChange: ReturnType<typeof vi.fn>) {
  expect(onChange).toHaveBeenCalledTimes(1);
  return onChange.mock.calls[0][0] as WorkflowDefinition;
}

afterEach(() => {
  cleanup();
});

describe("WorkflowSlotsPanel", () => {
  it("列出槽位、当前默认值与引用它的步骤数", () => {
    renderPanel(definitionWith());

    expect(screen.getByText("{{topic}}")).toBeTruthy();
    expect(screen.getByText("1 个步骤用到")).toBeTruthy();
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "调研主题",
    );
    expect((screen.getByLabelText("默认值") as HTMLTextAreaElement).value).toBe(
      "Notion 的协作功能",
    );
  });

  it("改默认值只动这一个槽位，节点与顶层其余字段原样带走", () => {
    const onChange = renderPanel(
      definitionWith({
        slots: [
          {
            key: "topic",
            label: "调研主题",
            default: "Notion 的协作功能",
            hint: "后端写的",
          },
        ],
        future_policy: { level: 2 },
      }),
    );

    fireEvent.change(screen.getByLabelText("默认值"), {
      target: { value: "Linear 的项目视图" },
    });

    const next = nextDefinition(onChange);
    expect(next.slots).toEqual([
      {
        key: "topic",
        label: "调研主题",
        default: "Linear 的项目视图",
        hint: "后端写的",
      },
    ]);
    expect(next.nodes).toHaveLength(1);
    expect(next.future_policy).toEqual({ level: 2 });
  });

  it("没有槽位的工作流说清「按图原样跑」，不摆空表单", () => {
    renderPanel(
      definitionWith({
        nodes: [
          { id: "step1", kind: "agent_step", role: "调研员", task: "扫竞品" },
        ],
        slots: undefined,
      }),
    );

    expect(screen.getByText(/没有可换参数/)).toBeTruthy();
    expect(screen.queryByLabelText("默认值")).toBeNull();
  });

  it("任务里引用了未声明的占位符时如实提示，并可一键登记", () => {
    const onChange = renderPanel(
      definitionWith({
        nodes: [
          {
            id: "step1",
            kind: "agent_step",
            role: "调研员",
            task: "调研 {{topic}}，侧重 {{angle}}",
          },
        ],
      }),
    );

    expect(screen.getByText(/未声明的参数/)).toBeTruthy();
    expect(screen.getByText("{{angle}}")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "登记" }));

    expect(nextDefinition(onChange).slots).toEqual([
      { key: "topic", label: "调研主题", default: "Notion 的协作功能" },
      { key: "angle", label: "angle", default: "" },
    ]);
  });
});
