// @vitest-environment jsdom
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { useStandingInboxStore } from "@/stores/standingInbox";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationsPage } from "../AutomationsPage";

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path={APP_PATHS.toolbox.automations.root}
          element={<AutomationsPage />}
        >
          <Route index element={<div>任务面板</div>} />
          <Route path="inbox" element={<div>收件箱面板</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function subNav() {
  return screen.getByRole("navigation", { name: "自动化分区" });
}

beforeEach(() => {
  useStandingInboxStore.setState({ badge: 0 });
});

afterEach(cleanup);

describe("AutomationsPage 页头", () => {
  it("一级导航交给 ToolboxPageHeader，不再自绘返回链接与 h1", () => {
    const { container } = renderPage(APP_PATHS.toolbox.automations.root);

    expect(screen.getByRole("navigation", { name: "工具箱能力" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "工具箱" }).getAttribute("href"),
    ).toBe(APP_PATHS.toolbox.root);
    expect(container.querySelector("h1")).toBeNull();
  });

  it("页内只有一条二级导航，不再堆第二条 pill 分段", () => {
    renderPage(APP_PATHS.toolbox.automations.root);

    expect(
      screen
        .getAllByRole("navigation")
        .map((n) => n.getAttribute("aria-label")),
    ).toEqual(["工具箱能力", "自动化分区"]);
  });

  it("页头不画下边框，接缝处只留下划线 tab 那一条横线", () => {
    const { container } = renderPage(APP_PATHS.toolbox.automations.root);

    expect(container.querySelector("header")?.className).not.toContain(
      "border-b",
    );
    expect(subNav().className).toContain("border-b");
  });

  it("二级 tab 用下划线态，不用一级那套 pill 填充", () => {
    renderPage(APP_PATHS.toolbox.automations.root);

    const nav = subNav();
    expect(nav.className).toContain("border-b");

    const active = within(nav).getByRole("link", { name: "任务" });
    expect(active.className).not.toContain("bg-accent");
    // 下划线画成背景条：border 色工具类被 globals.css 的全局 `*` 规则盖掉。
    const underline = active.querySelector('span[aria-hidden="true"]');
    expect(underline?.className).toContain("bg-primary");
    expect(underline?.className).toContain("h-0.5");

    const idle = within(nav).getByRole("link", { name: /收件箱/ });
    expect(idle.querySelector('span[aria-hidden="true"]')).toBeNull();
  });
});

describe("AutomationsPage 二级 tab 深链", () => {
  it("根路径高亮「任务」并渲染任务面板", () => {
    renderPage(APP_PATHS.toolbox.automations.root);

    const nav = subNav();
    expect(
      within(nav)
        .getByRole("link", { name: "任务" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: /收件箱/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByText("任务面板")).toBeTruthy();
  });

  it("/inbox 高亮「收件箱」并渲染收件箱面板", () => {
    renderPage(APP_PATHS.toolbox.automations.inbox);

    const nav = subNav();
    expect(
      within(nav)
        .getByRole("link", { name: /收件箱/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    // `end` 精确匹配：子路由下「任务」必须熄灭。
    expect(
      within(nav)
        .getByRole("link", { name: "任务" })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByText("收件箱面板")).toBeTruthy();
    // 一级分段仍然停在「自动化」上。
    const top = screen.getByRole("navigation", { name: "工具箱能力" });
    expect(
      within(top)
        .getByRole("link", { name: /自动化/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("未读徽章同时挂在二级「收件箱」tab 上", () => {
    useStandingInboxStore.setState({ badge: 3 });
    renderPage(APP_PATHS.toolbox.automations.root);

    const nav = subNav();
    const badge = within(nav).getByLabelText("3 条待处理");
    expect(badge.textContent).toBe("3");
    expect(
      within(nav)
        .getByRole("link", { name: /收件箱/ })
        .contains(badge),
    ).toBe(true);
  });

  it("徽章过百收敛成 99+，tab 不会被撑开", () => {
    useStandingInboxStore.setState({ badge: 128 });
    renderPage(APP_PATHS.toolbox.automations.root);

    expect(within(subNav()).getByLabelText("128 条待处理").textContent).toBe(
      "99+",
    );
  });
});
