// @vitest-environment jsdom
import {
  ToolboxPageHeader,
  type ToolboxPageHeaderProps,
} from "@/components/toolbox/ToolboxPageHeader";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { useStandingInboxStore } from "@/stores/standingInbox";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function renderHeader(path: string, props?: ToolboxPageHeaderProps) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToolboxPageHeader {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStandingInboxStore.setState({ badge: 0 });
});

afterEach(cleanup);

describe("ToolboxPageHeader", () => {
  it("lists the five capability segments in toolbox order", () => {
    renderHeader(APP_PATHS.toolbox.tools);
    const nav = screen.getByRole("navigation", { name: "工具箱能力" });
    const labels = [...nav.querySelectorAll("a")].map((a) =>
      a.textContent?.replace(/\d+\+?$/, ""),
    );
    expect(labels).toEqual(["工具", "AI 提示词", "自动化", "工作流", "连接器"]);
  });

  it("routes every segment through APP_PATHS", () => {
    renderHeader(APP_PATHS.toolbox.tools);
    const nav = screen.getByRole("navigation", { name: "工具箱能力" });
    expect(
      [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ).toEqual([
      APP_PATHS.toolbox.tools,
      APP_PATHS.toolbox.guidelines,
      APP_PATHS.toolbox.automations.root,
      APP_PATHS.toolbox.workflows.root,
      APP_PATHS.toolbox.connectors,
    ]);
  });

  it("links back to 工具箱 without a page title", () => {
    const { container } = renderHeader(APP_PATHS.toolbox.connectors);
    expect(
      screen.getByRole("link", { name: "工具箱" }).getAttribute("href"),
    ).toBe(APP_PATHS.toolbox.root);
    // 当前位置由分段高亮承担，不再挂 h1 大标题。
    expect(container.querySelector("h1")).toBeNull();
  });

  it("highlights the current segment across its sub-routes", () => {
    renderHeader(APP_PATHS.toolbox.automations.inbox);
    expect(
      screen.getByRole("link", { name: /自动化/ }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: /工作流/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("hangs the standing-inbox badge on 自动化", () => {
    useStandingInboxStore.setState({ badge: 4 });
    renderHeader(APP_PATHS.toolbox.workflows.root);
    const badge = screen.getByLabelText("4 条待处理");
    expect(badge.textContent).toBe("4");
    expect(screen.getByRole("link", { name: /自动化/ }).contains(badge)).toBe(
      true,
    );
  });

  it("keeps the back link, the segments and the actions on one row", () => {
    const { container } = renderHeader(APP_PATHS.toolbox.workflows.root, {
      actions: <button type="button">新建工作流</button>,
    });
    const header = container.querySelector("header");
    expect(header?.className).toContain("flex");

    // 返回链接与分段条同处一组，动作插槽是这一行右端的兄弟节点——分段条不会
    // 因为断行被挤下去，「返回链接独占一行」的空行也就无处可生。
    const group = screen.getByRole("link", { name: "工具箱" }).parentElement;
    expect(group?.parentElement).toBe(header);
    expect(
      screen.getByRole("navigation", { name: "工具箱能力" }).parentElement,
    ).toBe(group);
    const slot = screen.getByRole("button", {
      name: "新建工作流",
    }).parentElement;
    expect(slot?.parentElement).toBe(header);
    expect(slot?.className).toContain("ml-auto");
  });

  it("puts a divider between the back link and the segments", () => {
    renderHeader(APP_PATHS.toolbox.tools);
    const backLink = screen.getByRole("link", { name: "工具箱" });
    const row = [...(backLink.parentElement?.children ?? [])];
    const nav = screen.getByRole("navigation", { name: "工具箱能力" });

    // 「工具箱」不能读成第六个分段项：中间隔着一条竖线。
    const dividerAt = row.indexOf(backLink) + 1;
    const divider = row[dividerAt];
    expect(divider?.getAttribute("aria-hidden")).toBe("true");
    expect(divider?.className).toContain("bg-border");
    expect(row.indexOf(nav)).toBe(dividerAt + 1);
  });

  it("separates the header from page content", () => {
    const { container } = renderHeader(APP_PATHS.toolbox.tools);
    expect(container.querySelector("header")?.className).toContain("border-b");
  });

  it("drops its own border when the page brings its own baseline", () => {
    const { container } = renderHeader(APP_PATHS.toolbox.automations.root, {
      bordered: false,
    });
    expect(container.querySelector("header")?.className).not.toContain(
      "border-b",
    );
  });
});
