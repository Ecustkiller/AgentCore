// @vitest-environment jsdom
/**
 * 「换个主题再跑一次」的核心：槽位输入框预填固化那轮的原值。
 * 不动 = 原样重跑（请求里不带 slots），改一处 = 只带那一处。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/folders", () => ({ listFolders: vi.fn() }));
vi.mock("@/services/workflows", () => ({
  runWorkflow: vi.fn(),
  suggestWorkflowSlots: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ notifySuccess: vi.fn() }));

import { type FolderMeta, listFolders } from "@/services/folders";
import type { WorkflowSlot } from "@/services/workflowDefinition";
import { runWorkflow } from "@/services/workflows";
import { MemoryRouter } from "react-router-dom";
import { RunWorkflowDialog } from "../RunWorkflowDialog";

const folders = vi.mocked(listFolders);
const run = vi.mocked(runWorkflow);

const SLOTS: WorkflowSlot[] = [
  { key: "topic", label: "调研主题", default: "Notion 的协作功能定价" },
  { key: "angle", label: "侧重角度", default: "面向中小团队" },
];

function cloudFolder(id: string, name: string): FolderMeta {
  return { id, name, mode: "cloud", localRootId: null, localSubpath: null };
}

async function renderDialog(slots?: WorkflowSlot[]) {
  render(
    <MemoryRouter>
      <RunWorkflowDialog
        open
        workflowId="wf-1"
        workflowName="竞品调研"
        // 不传出处（= 不是对话固化的）：这里测已有槽位的交互，不触发按需抽槽。
        definition={{ nodes: [], edges: [], slots }}
        onClose={() => {}}
      />
    </MemoryRouter>,
  );
  // 工作区没加载完时「开跑」是禁用的。
  await screen.findByRole("option", { name: "工作" });
}

function slotBox(label: string): HTMLTextAreaElement {
  return screen.getByLabelText(label) as HTMLTextAreaElement;
}

async function clickRun() {
  fireEvent.click(screen.getByRole("button", { name: "开跑" }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  return run.mock.calls[0]?.[1];
}

beforeEach(() => {
  folders.mockReset();
  folders.mockResolvedValue([cloudFolder("f1", "工作")]);
  run.mockReset();
  run.mockResolvedValue({ conversationId: null });
});

afterEach(() => {
  cleanup();
});

describe("RunWorkflowDialog 可换参数", () => {
  it("预填上一轮固化的值，而不是空白必填表单", async () => {
    await renderDialog(SLOTS);

    expect(slotBox("调研主题").value).toBe("Notion 的协作功能定价");
    expect(slotBox("侧重角度").value).toBe("面向中小团队");
    expect(
      screen.getByRole("button", { name: "开跑" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("什么都不动就开跑 = 原样重跑（不带覆盖）", async () => {
    await renderDialog(SLOTS);

    expect((await clickRun())?.slots).toEqual({});
  });

  it("改了主题只带改动的那个槽位", async () => {
    await renderDialog(SLOTS);

    fireEvent.change(slotBox("调研主题"), {
      target: { value: "Linear 的项目视图定价" },
    });

    expect((await clickRun())?.slots).toEqual({
      topic: "Linear 的项目视图定价",
    });
  });

  it("「还原默认」把输入改回原值并撤掉覆盖", async () => {
    await renderDialog(SLOTS);

    fireEvent.change(slotBox("调研主题"), { target: { value: "别的主题" } });
    fireEvent.click(screen.getByRole("button", { name: "还原默认" }));

    expect(slotBox("调研主题").value).toBe("Notion 的协作功能定价");
    expect(screen.queryByRole("button", { name: "还原默认" })).toBeNull();
    expect((await clickRun())?.slots).toEqual({});
  });

  it("没有槽位的工作流不长出参数区，提交与今天一致", async () => {
    await renderDialog(undefined);

    expect(screen.queryByText("可换参数")).toBeNull();
    expect(screen.queryByRole("button", { name: "还原默认" })).toBeNull();
    expect(await clickRun()).toEqual({
      folderId: "f1",
      note: null,
      slots: {},
    });
  });
});
