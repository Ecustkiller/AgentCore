// @vitest-environment jsdom
/**
 * 设置二级导航的信息架构：四组十项（原来是六组，其中三组各只有一项）。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { MorePage } from "../MorePage";

function renderNav() {
  return render(
    <MemoryRouter initialEntries={["/more/general"]}>
      <MorePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("MorePage 导航分组", () => {
  it("groups the ten sub-pages under four headings", () => {
    const { container } = renderNav();
    const groups = Array.from(container.querySelectorAll("nav h2")).map(
      (h) => h.textContent,
    );
    expect(groups).toEqual(["账户", "模型", "偏好", "关于"]);
    expect(container.querySelectorAll("nav a")).toHaveLength(10);
  });

  it("keeps every group multi-item, so no heading outweighs its content", () => {
    const { container } = renderNav();
    for (const group of container.querySelectorAll("nav > div > div")) {
      expect(group.querySelectorAll("a").length).toBeGreaterThan(1);
    }
  });

  it("points 偏好 at 通用 / 消息隐私 / 快捷键", () => {
    renderNav();
    expect(
      screen.getByRole("link", { name: "通用" }).getAttribute("href"),
    ).toBe("/more/general");
    expect(
      screen.getByRole("link", { name: "消息隐私" }).getAttribute("href"),
    ).toBe("/more/messages");
    expect(
      screen.getByRole("link", { name: "快捷键" }).getAttribute("href"),
    ).toBe("/more/shortcuts");
    expect(screen.queryByRole("link", { name: "外观" })).toBeNull();
  });

  it("keeps 反馈 next to 关于 instead of owning a group", () => {
    renderNav();
    expect(
      screen.getByRole("link", { name: "反馈" }).getAttribute("href"),
    ).toBe("/more/feedback");
  });
});
