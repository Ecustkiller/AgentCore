// @vitest-environment jsdom
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { emptyWorkflowDefinition } from "@/services/workflowDefinition";
import type { UserWorkflow } from "@/services/workflows";
import { useStandingInboxStore } from "@/stores/standingInbox";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workflows", () => ({
  listWorkflows: vi.fn(),
  listWorkflowTemplates: vi.fn(async () => []),
  createWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  createWorkflowFromPlaybook: vi.fn(),
  runWorkflow: vi.fn(),
}));

vi.mock("@/services/folders", () => ({ listFolders: vi.fn(async () => []) }));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

import { listWorkflows } from "@/services/workflows";
import { MemoryRouter } from "react-router-dom";
import { WorkflowsPage } from "../WorkflowsPage";

const workflows = vi.mocked(listWorkflows);

const WORKFLOW: UserWorkflow = {
  id: "wf-1",
  name: "周报流水线",
  description: null,
  definition: emptyWorkflowDefinition(),
  source: null,
  version: 3,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[APP_PATHS.toolbox.workflows.root]}>
      <WorkflowsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStandingInboxStore.setState({ badge: 0 });
  workflows.mockReset();
  workflows.mockResolvedValue([WORKFLOW]);
});

afterEach(cleanup);

describe("工作流列表 · 统一页头", () => {
  it("主 CTA 进页头动作位，页内不再自绘返回链接与大标题", async () => {
    const { container } = renderPage();
    await screen.findByText("周报流水线");

    const header = container.querySelector("header");
    expect(screen.getAllByRole("link", { name: "工具箱" })).toHaveLength(1);
    expect(container.querySelector("h1")).toBeNull();
    expect(
      header?.contains(screen.getByRole("button", { name: "新建工作流" })),
    ).toBe(true);
  });

  it("分段条点亮工作流，可横跳到其它能力页", async () => {
    const { container } = renderPage();
    await screen.findByText("周报流水线");

    const nav = screen.getByRole("navigation", { name: "工具箱能力" });
    expect(container.querySelector("header")?.contains(nav)).toBe(true);
    expect(
      screen.getByRole("link", { name: "工作流" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "连接器" }).getAttribute("href"),
    ).toBe(APP_PATHS.toolbox.connectors);
  });

  it("说明文降级为内容区说明行，不占页头", async () => {
    const { container } = renderPage();
    await screen.findByText("周报流水线");

    const note = screen.getByText(/可保存的团队拆法/);
    expect(container.querySelector("header")?.contains(note)).toBe(false);
  });
});
