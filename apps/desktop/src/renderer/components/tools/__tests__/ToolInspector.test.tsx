import type { CapabilityTool } from "@/services/capabilities";
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolInspector } from "../ToolInspector";

afterEach(cleanup);

const tool: CapabilityTool = {
  name: "web_search",
  face: "web",
  resident: true,
  summary: "联网检索",
  description:
    "联网检索：给出查询词，返回带出处的结果摘要。一次只搜 2–3 个核心词。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索词" },
      language: { type: "string", description: "可选语言" },
    },
    required: ["query"],
  },
  approval: "never",
  available_to: ["ceo", "worker"],
};

describe("ToolInspector", () => {
  it("一页说明书：干什么、要填什么；审批与谁能用不上正文", () => {
    render(<ToolInspector tool={tool} />);
    expect(screen.getByRole("heading", { name: "web_search" })).toBeTruthy();
    expect(screen.getByText("开场即用")).toBeTruthy();
    expect(screen.queryByText(/全员/)).toBeNull();
    expect(screen.queryByText(/自动执行/)).toBeNull();
    expect(screen.queryByText(/需审批/)).toBeNull();
    expect(screen.getByText("检索词")).toBeTruthy();
    expect(screen.getByText("query")).toBeTruthy();
    expect(screen.getByText("要填")).toBeTruthy();
    expect(screen.getByText("language")).toBeTruthy();
    expect(screen.queryByTestId("tool-face-source")).toBeNull();
    expect(screen.queryByRole("tab", { name: "源码" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("说明书导语是 schema description，不是卡上 summary", () => {
    render(<ToolInspector tool={tool} hideChrome />);
    const guide = screen.getByTestId("tool-face-guide");
    expect(guide.textContent).toContain("web_search");
    expect(guide.textContent).toContain("一次只搜");
    expect(guide.textContent).toContain("带出处");
  });

  it("空 properties 不写空参提示", () => {
    render(
      <ToolInspector
        tool={{ ...tool, parameters: { type: "object", properties: {} } }}
      />,
    );
    expect(screen.queryByText("没有要填的参数")).toBeNull();
    expect(screen.queryByText("query")).toBeNull();
    expect(screen.getByTestId("tool-face-guide")).toBeTruthy();
  });

  it("shows a capability hint", () => {
    render(<ToolInspector tool={tool} capabilityHint="未确认工具调用" />);
    expect(screen.getByText("未确认工具调用")).toBeTruthy();
  });
});
