// @vitest-environment jsdom
/**
 * 从一轮协作固化来的工作流，详情页给一条回到那一轮的路。
 *
 * 出处是服务端权威字段（带原对话与消息定位），所以「这图是从哪来的」有据可查；
 * 手画 / 模板复制来的没有出处，就不该凭空长出这个入口。
 */
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import type { UserWorkflow } from "@/services/workflows";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workflows", () => ({
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  suggestWorkflowSlots: vi.fn(),
}));
vi.mock("@/services/folders", () => ({ listFolders: vi.fn(async () => []) }));
vi.mock("@/lib/toast", () => ({ notifySuccess: vi.fn() }));
// 画布是 react-flow，渲染它要真实布局；这里只关心页头那条入口。
vi.mock("../WorkflowCanvas", () => ({
  WorkflowCanvas: () => <div data-testid="canvas" />,
}));

import { ApiError } from "@/services/api";
import { getWorkflow, patchWorkflow } from "@/services/workflows";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { WorkflowEditorPage } from "../WorkflowEditorPage";

const load = vi.mocked(getWorkflow);
const save = vi.mocked(patchWorkflow);

function workflow(source: UserWorkflow["source"]): UserWorkflow {
  return {
    id: "wf-1",
    name: "竞品调研",
    description: null,
    definition: { nodes: [], edges: [] },
    source,
    version: 2,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

/** 落地页只回显路由，让断言看的是跳到哪一条消息，而不是对话页的实现。 */
function ConversationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="landed">{`${pathname}${search}`}</div>;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={[APP_PATHS.toolbox.workflows.edit("wf-1")]}>
      <Routes>
        <Route
          path={APP_PATHS.toolbox.workflows.edit(":workflowId")}
          element={<WorkflowEditorPage />}
        />
        <Route path="/conversations/:id" element={<ConversationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  load.mockReset();
  save.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("工作流详情页 · 回到原对话", () => {
  it("固化来的工作流可以跳回存下它的那一轮", async () => {
    load.mockResolvedValue(
      workflow({ kind: "turn", conversationId: "c-1", messageId: "m-1" }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "回到原对话" }));

    expect(screen.getByTestId("landed").textContent).toBe(
      "/conversations/c-1?msg=m-1",
    );
  });

  it("没有出处的工作流不长出这个入口", async () => {
    load.mockResolvedValue(workflow(null));
    renderPage();

    expect(await screen.findByTestId("canvas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到原对话" })).toBeNull();
  });
});

describe("工作流详情页 · 可恢复失败", () => {
  it("加载失败走 muted 行内文案", async () => {
    load.mockRejectedValue(
      new ApiError(
        500,
        JSON.stringify({ error: { message: "工作流服务开小差" } }),
      ),
    );
    renderPage();

    const err = await screen.findByText("工作流服务开小差");
    expect(err.className).toContain("text-muted-foreground");
    expect(err.className).not.toContain("destructive");
  });

  it("保存失败走 muted 行内文案", async () => {
    load.mockResolvedValue(workflow(null));
    save.mockRejectedValue(
      new ApiError(500, JSON.stringify({ error: { message: "保存开小差" } })),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "保存" }));

    const err = await screen.findByText("保存开小差");
    expect(err.className).toContain("text-muted-foreground");
    expect(err.className).not.toContain("destructive");
  });

  it("定义校验 warning 琥珀句保持 warning", async () => {
    load.mockResolvedValue({
      ...workflow(null),
      definition: {
        nodes: [{ id: "s1", kind: "agent_step", role: "", task: "调研" }],
        edges: [],
      },
    });
    renderPage();

    const issue = await screen.findByText("队员步骤须填写角色");
    expect(issue.closest("ul")?.className).toContain("text-warning");
    expect(issue.closest("ul")?.className).not.toContain("destructive");
  });
});
