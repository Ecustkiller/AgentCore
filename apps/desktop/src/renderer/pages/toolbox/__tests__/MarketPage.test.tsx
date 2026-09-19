import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { MarketPage } from "@/pages/toolbox/market/MarketPage";
import type { SkillStoreListing } from "@/services/skillStore";
import { EMPTY_SKILL_STORE_GROUPS } from "@/services/skillStore";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/services/skillStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/skillStore")>();
  return {
    ...actual,
    listSkillStore: vi.fn(),
    getSkillStoreListing: vi.fn(),
    installSkill: vi.fn(),
    reportSkill: vi.fn(),
  };
});

const { listSkillStore, getSkillStoreListing, installSkill } = await import(
  "@/services/skillStore"
);

const ROW: SkillStoreListing = {
  id: "listing-1",
  name: "合同审查",
  description: "审合同时用",
  author: "ssauthor",
  version: "1",
  group: "writing",
  installed: false,
  hasUpdate: false,
  documentId: "doc-1",
  installDocumentId: null,
  status: "published",
  offersTools: [],
};

function shelf(items: SkillStoreListing[]) {
  const groups = { ...EMPTY_SKILL_STORE_GROUPS };
  for (const row of items) groups[row.group] += 1;
  return { items, page: 1, pageSize: 24, total: items.length, groups };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[APP_PATHS.toolbox.market]}>
      <MarketPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(listSkillStore).mockReset();
  vi.mocked(getSkillStoreListing).mockReset();
  vi.mocked(installSkill).mockReset();
  vi.mocked(listSkillStore).mockResolvedValue(shelf([ROW]));
  vi.mocked(getSkillStoreListing).mockResolvedValue({
    ...ROW,
    content: "HOW 正文",
  });
  vi.mocked(installSkill).mockResolvedValue({
    ...ROW,
    installed: true,
    hasUpdate: false,
  });
});

afterEach(cleanup);

describe("市场页", () => {
  it("货架只有提示词分组 chip，没有工作流种类", async () => {
    renderPage();
    await screen.findByRole("button", { name: "合同审查" });
    expect(screen.queryByRole("group", { name: "货架种类" })).toBeNull();
    expect(screen.queryByRole("button", { name: "工作流" })).toBeNull();
    expect(screen.queryByRole("button", { name: "工具" })).toBeNull();
    expect(screen.queryByRole("button", { name: "MCP" })).toBeNull();
    expect(screen.queryByRole("button", { name: "创作" })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "提示词分组" })).getByRole(
        "button",
        { name: "写作成稿" },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "工具箱种类" })).toBeNull();
    expect(
      screen.queryByRole("heading", { level: 1, name: "商店" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/模型组合：/)).toBeNull();
    expect(screen.getByLabelText("搜索提示词")).toBeTruthy();
  });

  it("点卡片出对话框，安装只调 install", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "合同审查" }));
    expect(await screen.findByTestId("skill-store-dialog")).toBeTruthy();
    expect(screen.getByTestId("skill-store-dialog").textContent).toContain(
      "审合同时用",
    );
    expect(await screen.findByText("HOW 正文")).toBeTruthy();
    expect(screen.queryByTestId("skill-store-offers")).toBeNull();
    expect(screen.queryByRole("button", { name: "展开正文" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => {
      expect(installSkill).toHaveBeenCalledWith("listing-1");
    });
  });

  it("快照带绑定时安装前披露手脚", async () => {
    vi.mocked(getSkillStoreListing).mockResolvedValue({
      ...ROW,
      content:
        "---\napply: on_demand\ndescription: 审合同时用\noffers_tools: host\n---\n怎么审",
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "合同审查" }));
    expect(await screen.findByTestId("skill-store-offers")).toBeTruthy();
    expect(screen.getByTestId("skill-store-offers").textContent).toContain(
      "host",
    );
    expect(screen.getByText("怎么审")).toBeTruthy();
  });

  it("首页官方精选不在本组条再铺一遍", async () => {
    vi.mocked(listSkillStore).mockResolvedValue(
      shelf([
        {
          ...ROW,
          id: "listing-legal",
          name: "民事答辩状",
          description:
            "写/打磨答辩状时按对方律师作战室组队：起草 → 原告红队 → 核验 → 人审。",
          author: "官方",
          group: "legal",
        },
      ]),
    );
    renderPage();
    expect(
      await screen.findByRole("button", { name: "民事答辩状" }),
    ).toBeTruthy();
    expect(screen.getByText(/对方律师作战室/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "官方精选" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "提示词" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "法律合规" })).toBeNull();
    const featured = screen
      .getByRole("heading", { name: "官方精选" })
      .closest("section");
    expect(featured?.querySelector(".overflow-x-auto")).toBeNull();
    expect(featured?.querySelector(".grid")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "民事答辩状" })).toHaveLength(
      1,
    );
  });

  it("绑了手脚的货架卡打工具，名单不铺上卡", async () => {
    vi.mocked(listSkillStore).mockResolvedValue(
      shelf([{ ...ROW, offersTools: ["host"] }]),
    );
    renderPage();
    const card = await screen.findByRole("button", { name: "合同审查" });
    expect(within(card).getByText("工具")).toBeTruthy();
    expect(within(card).queryByText("host")).toBeNull();
  });

  it("用户货按组出条", async () => {
    vi.mocked(listSkillStore).mockResolvedValue(
      shelf([
        {
          ...ROW,
          id: "listing-legal",
          name: "民事答辩状",
          description:
            "写/打磨答辩状时按对方律师作战室组队：起草 → 原告红队 → 核验 → 人审。",
          author: "官方",
          group: "legal",
        },
        ROW,
      ]),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "写作成稿" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "官方精选" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "法律合规" })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "提示词分组" })).getByRole(
        "button",
        { name: "法律合规" },
      ),
    ).toBeTruthy();
  });

  it("已装同版本显示已装；有更新则点更新仍走同一 install", async () => {
    vi.mocked(listSkillStore).mockResolvedValue(
      shelf([{ ...ROW, installed: true, hasUpdate: true }]),
    );
    vi.mocked(getSkillStoreListing).mockResolvedValue({
      ...ROW,
      installed: true,
      hasUpdate: true,
      content: "HOW 正文",
    });
    vi.mocked(installSkill).mockResolvedValue({
      ...ROW,
      installed: true,
      hasUpdate: false,
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "合同审查" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新" }));
    await waitFor(() => {
      expect(installSkill).toHaveBeenCalledWith("listing-1");
    });
  });

  it("空货架只留标题，不写上架说明书", async () => {
    vi.mocked(listSkillStore).mockResolvedValue(shelf([]));
    renderPage();
    expect(await screen.findByText("还没有可安装的内容")).toBeTruthy();
    expect(screen.queryByText(/上架/)).toBeNull();
    expect(screen.queryByText(/一键安装/)).toBeNull();
  });
});
