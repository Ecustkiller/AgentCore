// @vitest-environment jsdom
/**
 * 按需抽槽：真正需要参数的时刻是第二次要用这个工作流、看到任务里写死着上一轮主题时，
 * 所以「跑一次」打开时才抽，抽完当场摆出来让用户过目。
 *
 * 铁律：抽取从不挡用户——等的时候能直接开跑，抽不到、抽挂了都退回无参数形态。
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

import { ApiError } from "@/services/api";
import { type FolderMeta, listFolders } from "@/services/folders";
import type {
  WorkflowDefinition,
  WorkflowSlot,
} from "@/services/workflowDefinition";
import type { WorkflowSource } from "@/services/workflowSource";
import {
  type UserWorkflow,
  runWorkflow,
  suggestWorkflowSlots,
} from "@/services/workflows";
import { MemoryRouter } from "react-router-dom";
import { RunWorkflowDialog } from "../RunWorkflowDialog";

const folders = vi.mocked(listFolders);
const run = vi.mocked(runWorkflow);
const suggest = vi.mocked(suggestWorkflowSlots);

const WAITING = /正在看看这个工作流/;
const ORIGINAL_TOPIC = "Notion 的协作功能定价";

/** 出处在工作流顶层（服务端权威字段），画布存一次也抹不掉它。 */
const TURN_SOURCE: WorkflowSource = {
  kind: "turn",
  conversationId: "c-1",
  messageId: "m-1",
};

function cloudFolder(id: string, name: string): FolderMeta {
  return { id, name, mode: "cloud", localRootId: null, localSubpath: null };
}

/** 对话固化来的工作流的图：任务里写死着上一轮的主题。 */
function fromTurn(slots?: WorkflowSlot[]): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "step_1",
        kind: "agent_step",
        role: "研究员",
        task: `调研 ${ORIGINAL_TOPIC}`,
      },
    ],
    edges: [],
    ...(slots ? { slots } : {}),
  };
}

function workflow(id: string, definition: WorkflowDefinition): UserWorkflow {
  return {
    id,
    name: "竞品调研",
    description: null,
    definition,
    source: TURN_SOURCE,
    version: 2,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

/** 抽到了：任务文本换成占位符，顶层声明槽位，`default` = 上一轮的原值。 */
function extracted(id: string): UserWorkflow {
  return workflow(id, {
    nodes: [
      {
        id: "step_1",
        kind: "agent_step",
        role: "研究员",
        task: "调研 {{topic}}",
      },
    ],
    edges: [],
    slots: [{ key: "topic", label: "调研主题", default: ORIGINAL_TOPIC }],
  });
}

function dialog(props: {
  workflowId: string;
  definition?: WorkflowDefinition;
  source?: WorkflowSource | null;
  open?: boolean;
  onSlotsSuggested?: (w: UserWorkflow) => void;
}) {
  return (
    <MemoryRouter>
      <RunWorkflowDialog
        open={props.open ?? true}
        workflowId={props.workflowId}
        workflowName="竞品调研"
        definition={props.definition}
        source={props.source === undefined ? TURN_SOURCE : props.source}
        onSlotsSuggested={props.onSlotsSuggested}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
}

/** 工作区没加载完时「开跑」是禁用的，先等它。 */
function waitForFolders() {
  return screen.findByRole("option", { name: "工作" });
}

function runButton(): HTMLElement {
  return screen.getByRole("button", { name: "开跑" });
}

beforeEach(() => {
  folders.mockReset();
  folders.mockResolvedValue([cloudFolder("f1", "工作")]);
  run.mockReset();
  run.mockResolvedValue({ conversationId: null });
  suggest.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("RunWorkflowDialog 按需抽槽", () => {
  it("抽到了就把参数表摆出来预填，等待期间照样能直接开跑", async () => {
    let land: (w: UserWorkflow) => void = () => {};
    suggest.mockReturnValue(
      new Promise<UserWorkflow>((resolve) => {
        land = resolve;
      }),
    );
    const seen: UserWorkflow[] = [];
    render(
      dialog({
        workflowId: "wf-found",
        definition: fromTurn(),
        onSlotsSuggested: (w) => seen.push(w),
      }),
    );

    // 抽的过程中：如实说在抽，且不禁用「开跑」。
    expect(await screen.findByText(WAITING)).toBeTruthy();
    await waitForFolders();
    expect(runButton().hasAttribute("disabled")).toBe(false);

    land(extracted("wf-found"));

    const box = (await screen.findByLabelText(
      "调研主题",
    )) as HTMLTextAreaElement;
    expect(box.value).toBe(ORIGINAL_TOPIC);
    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
    expect(suggest.mock.calls).toEqual([["wf-found"]]);
    // 父层拿到最新那份（服务端 definition 已被换掉），别再抽第二遍。
    expect(seen.map((w) => w.id)).toEqual(["wf-found"]);

    fireEvent.change(box, { target: { value: "Linear 的项目视图定价" } });
    fireEvent.click(runButton());
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]?.[1]?.slots).toEqual({
      topic: "Linear 的项目视图定价",
    });
  });

  it("父层把抽到的槽位吸收进 definition 后，摆出来的那份不抖掉", async () => {
    const next = extracted("wf-adopt");
    suggest.mockResolvedValue(next);
    const { rerender } = render(
      dialog({ workflowId: "wf-adopt", definition: fromTurn() }),
    );

    await waitForFolders();
    expect(await screen.findByLabelText("调研主题")).toBeTruthy();

    // 编辑页会把服务端最新那份换进来（画布没动过时），此时 `definition` 已带槽位。
    rerender(dialog({ workflowId: "wf-adopt", definition: next.definition }));

    const box = (await screen.findByLabelText(
      "调研主题",
    )) as HTMLTextAreaElement;
    expect(box.value).toBe(ORIGINAL_TOPIC);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it("抽不出来不是错误：退回无参数形态，请求与今天逐字一致", async () => {
    // 抽不出来时服务端返回的 definition 与调用前一致（仍然没有 slots）。
    suggest.mockResolvedValue(workflow("wf-none", fromTurn()));
    render(dialog({ workflowId: "wf-none", definition: fromTurn() }));

    await waitForFolders();
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
    expect(screen.queryByText("可换参数")).toBeNull();

    fireEvent.click(runButton());
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]?.[1]).toEqual({
      folderId: "f1",
      note: null,
      slots: {},
    });
  });

  it("抽槽请求挂了不弹错误挡人，重开时可以再试一次", async () => {
    suggest.mockRejectedValue(
      new ApiError(500, JSON.stringify({ error: { message: "抽槽开小差" } })),
    );
    const { rerender } = render(
      dialog({ workflowId: "wf-failed", definition: fromTurn() }),
    );

    await waitForFolders();
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
    expect(screen.queryByText("抽槽开小差")).toBeNull();
    expect(runButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(runButton());
    await waitFor(() => expect(run).toHaveBeenCalled());

    // 挂掉是可重试的，不像「抽不出来」那样记下来。
    rerender(
      dialog({ workflowId: "wf-failed", definition: fromTurn(), open: false }),
    );
    rerender(dialog({ workflowId: "wf-failed", definition: fromTurn() }));
    await waitForFolders();
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
  });

  it("已经有槽位就不抽：直接用已有的那份", async () => {
    const slots: WorkflowSlot[] = [
      { key: "topic", label: "调研主题", default: ORIGINAL_TOPIC },
    ];
    render(dialog({ workflowId: "wf-has", definition: fromTurn(slots) }));

    const box = (await screen.findByLabelText(
      "调研主题",
    )) as HTMLTextAreaElement;
    expect(box.value).toBe(ORIGINAL_TOPIC);
    await waitForFolders();
    expect(suggest).not.toHaveBeenCalled();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("不是对话固化的工作流不抽（任务里没有上一轮写死的值）", async () => {
    render(
      dialog({
        workflowId: "wf-blank",
        definition: { nodes: [], edges: [] },
        source: null,
      }),
    );

    await waitForFolders();
    expect(suggest).not.toHaveBeenCalled();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("判据只认服务端那份出处：definition 里写着 source 也不算", async () => {
    // 老数据（或用户自己在画布里塞的）会带上这个键；它是客户端整份覆盖的文档，
    // 说了不算。反过来也一样：画布上没有它，服务端说是固化来的就照抽。
    render(
      dialog({
        workflowId: "wf-forged",
        definition: {
          nodes: [],
          edges: [],
          source: { conversation_id: "c-9", message_id: "m-9" },
        },
        source: null,
      }),
    );

    await waitForFolders();
    expect(suggest).not.toHaveBeenCalled();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("抽过一次什么都没抽到，重开不再白等一遍", async () => {
    suggest.mockResolvedValue(workflow("wf-empty", fromTurn()));
    const { rerender } = render(
      dialog({ workflowId: "wf-empty", definition: fromTurn() }),
    );

    await waitForFolders();
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));

    rerender(
      dialog({ workflowId: "wf-empty", definition: fromTurn(), open: false }),
    );
    rerender(dialog({ workflowId: "wf-empty", definition: fromTurn() }));

    await waitForFolders();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(WAITING)).toBeNull();
  });
});
