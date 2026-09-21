import { ToolboxShell } from "@/pages/toolbox/ToolboxShell";
import { isKnownAppRoute } from "@/pages/toolbox/manual/gates/appRoutes";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function renderShell(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/toolbox" element={<ToolboxShell />}>
          <Route path="mine/skills" element={<div>技能内容</div>} />
        </Route>
        <Route
          path="/toolbox/guides"
          element={<div data-testid="guides">旧说明书书签</div>}
        />
        <Route
          path="/toolbox/market"
          element={<div data-testid="market">市场内容</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("工具箱壳", () => {
  it("目录壳不设种类 tab，不挂说明书，标题由目录页头负责", () => {
    renderShell(APP_PATHS.toolbox.mine.skills);
    expect(
      screen.queryByRole("heading", { level: 1, name: "工具箱" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { level: 1, name: "提示词" }),
    ).toBeNull();
    expect(screen.queryByRole("tablist", { name: "工具箱" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "我的" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "工具箱种类" })).toBeNull();
    expect(screen.queryByRole("link", { name: "提示词" })).toBeNull();
    expect(screen.queryByRole("link", { name: "说明书" })).toBeNull();
    expect(screen.queryByRole("link", { name: "市场" })).toBeNull();
    expect(screen.queryByRole("link", { name: "手册" })).toBeNull();
    expect(screen.queryByRole("link", { name: "连接器" })).toBeNull();
    expect(screen.getByText("技能内容")).toBeTruthy();
  });

  it("种类没有独立工具 tab", () => {
    renderShell(APP_PATHS.toolbox.mine.skills);
    expect(screen.queryByRole("link", { name: "工具" })).toBeNull();
    expect(screen.queryByRole("link", { name: "工作流" })).toBeNull();
    expect(screen.queryByRole("link", { name: "连接器" })).toBeNull();
  });

  it("提示词走页面留白", () => {
    const skills = renderShell(APP_PATHS.toolbox.mine.skills);
    const skillsInner = skills.container.querySelector(".mx-auto");
    expect(skillsInner?.className).toContain("px-6");
    expect(skillsInner?.className).toContain("py-6");
  });

  it("创作书签仍是已知路由", () => {
    expect(APP_PATHS.toolbox.store).toBe("/toolbox/market");
    expect(isKnownAppRoute(APP_PATHS.toolbox.market)).toBe(true);
    expect(isKnownAppRoute(APP_PATHS.toolbox.official)).toBe(true);
    expect(isKnownAppRoute("/toolbox/store")).toBe(true);
    expect(isKnownAppRoute(APP_PATHS.toolbox.guides)).toBe(true);
    expect(isKnownAppRoute(APP_PATHS.toolbox.mine.creation)).toBe(true);
  });
});
