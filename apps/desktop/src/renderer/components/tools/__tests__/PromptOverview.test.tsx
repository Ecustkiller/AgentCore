// @vitest-environment jsdom
import { PromptOverview } from "@/components/tools/PromptOverview";
import {
  type PromptCatalogItem,
  type PromptRail,
  type PromptRailFolder,
  mineCatalogId,
  skillCatalogId,
  toolCatalogId,
} from "@/lib/promptCatalog";
import type { CapabilityTool } from "@/services/capabilities";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function emptyRail(over: Partial<PromptRail> = {}): PromptRail {
  return {
    constitution: [],
    memory: [],
    alwaysMine: [],
    folders: [],
    official: [],
    tools: [],
    ...over,
  };
}

function sharedItem(text: string): PromptCatalogItem {
  return {
    id: "shared",
    kind: "shared",
    group: "factory",
    label: "全员共享准则",
    depth: 0,
    text,
  };
}

function mineItem(over: {
  id: string;
  label: string;
  content?: string;
  applyMode?: "always" | "on_demand";
}): Extract<PromptCatalogItem, { kind: "mine" }> {
  const content = over.content ?? "";
  const applyMode = over.applyMode ?? "on_demand";
  return {
    id: mineCatalogId(over.id),
    kind: "mine",
    group: "mine",
    label: over.label,
    depth: 0,
    mineId: over.id,
    description: "",
    content,
    version: "v1",
    applyMode,
    aiMaintained: false,
    memoryKind: null,
    listable: applyMode !== "always",
    disputed: false,
    alwaysChars: applyMode === "always" ? content.length : null,
    parentId: null,
  };
}

function capTool(name: string, resident: boolean): CapabilityTool {
  const summaries: Record<string, string> = {
    file_read: "读工作区文件",
    host: "本机排查 / 修理 / 查看这台电脑",
  };
  return {
    name,
    face: "file",
    resident,
    summary: summaries[name] ?? name,
    description: name,
    parameters: {},
    approval: "never",
    available_to: ["ceo", "worker"],
  };
}

function toolItem(
  name: string,
  resident: boolean,
): Extract<PromptCatalogItem, { kind: "tool" }> {
  return {
    id: toolCatalogId(name),
    kind: "tool",
    group: "factory",
    label: name,
    depth: 0,
    parentId: null,
    tool: capTool(name, resident),
  };
}

const otherFolder: PromptRailFolder = {
  id: "virtual:其他",
  name: "其他",
  source: "other",
  documentId: null,
  items: [],
};

function filledRail(): PromptRail {
  return emptyRail({
    constitution: [sharedItem("aaaa")],
    alwaysMine: [
      mineItem({
        id: "rule",
        label: "短约束",
        content: "hellohello",
        applyMode: "always",
      }),
    ],
    folders: [
      {
        id: "folder:other",
        name: "其他",
        source: "other",
        documentId: null,
        items: [
          mineItem({ id: "d1", label: "合同审查", applyMode: "on_demand" }),
        ],
      },
    ],
    official: [
      {
        id: skillCatalogId("thin_skill"),
        kind: "skill",
        group: "factory",
        label: "薄技能",
        depth: 0,
        tocGroup: "编排",
        parentId: null,
        skill: {
          name: "thin_skill",
          summary: "薄技能",
          body: "thin-body",
          group: "编排",
          blurb: "写一条按需薄技能",
        },
      },
    ],
    tools: [toolItem("file_read", true), toolItem("host", false)],
  });
}

function renderOverview(
  over: Partial<ComponentProps<typeof PromptOverview>> = {},
) {
  const noop = () => {};
  return render(
    <PromptOverview
      rail={filledRail()}
      selectedId={null}
      dropDest={null}
      otherFolder={otherFolder}
      connectors={[]}
      connectorError={null}
      showConnectors={false}
      renamingFolderId={null}
      busy={false}
      onOpenItem={vi.fn()}
      onCreateMine={vi.fn()}
      onCreateFolder={vi.fn()}
      onSubmitRenameFolder={vi.fn()}
      onCancelRenameFolder={vi.fn()}
      onAddConnector={null}
      onAcceptAlwaysDrag={noop}
      onDropAlways={noop}
      onAcceptFolderDrag={noop}
      onDropFolder={noop}
      onRejectDrag={noop}
      {...over}
    />,
  );
}

describe("PromptOverview", () => {
  it("常驻叶子直接铺成货架卡，点开对应条目", () => {
    const onOpenItem = vi.fn();
    renderOverview({ onOpenItem });
    fireEvent.click(screen.getByRole("button", { name: "全员共享准则" }));
    fireEvent.click(screen.getByRole("button", { name: "短约束" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual([
      "shared",
      mineCatalogId("rule"),
    ]);
    expect(screen.queryByRole("button", { name: "角色身份" })).toBeNull();
    expect(
      within(screen.getByTestId("prompt-rail-always")).getByRole("button", {
        name: "读工作区文件",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-rail-on-demand")).queryByRole(
        "button",
        {
          name: "读工作区文件",
        },
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).getByText(
        "官方",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).queryByText(
        "开场即用",
      ),
    ).toBeNull();
    expect(screen.queryByTestId("prompt-resident-bar")).toBeNull();
    expect(screen.getByTestId("prompt-overview").textContent).not.toMatch(/%/);
  });

  it("空核也留卡，点得开", () => {
    const onOpenItem = vi.fn();
    renderOverview({
      rail: emptyRail({
        constitution: [sharedItem("")],
      }),
      onOpenItem,
    });
    fireEvent.click(screen.getByRole("button", { name: "全员共享准则" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual(["shared"]);
    expect(screen.queryByRole("button", { name: "角色身份" })).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-always-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-on-demand-tools")).toBeNull();
  });

  it("按需叶子铺在概览上，夹只当区标题", () => {
    const onOpenItem = vi.fn();
    renderOverview({ onOpenItem });
    expect(screen.getByRole("heading", { name: "其他" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "合同审查" })).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-rail-on-demand")).queryByRole(
        "heading",
        { name: "官方" },
      ),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "薄技能" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "合同审查" }));
    fireEvent.click(screen.getByRole("button", { name: "薄技能" }));
    fireEvent.click(
      within(screen.getByTestId("prompt-rail-on-demand")).getByRole("button", {
        name: "本机排查 / 修理 / 查看这台电脑",
      }),
    );
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual([
      mineCatalogId("d1"),
      skillCatalogId("thin_skill"),
      toolCatalogId("host"),
    ]);
    expect(screen.queryByTestId("memory-updates-view")).toBeNull();
    expect(screen.getByTestId("prompt-overview").textContent).not.toMatch(/%/);
  });

  it("按需先铺我的夹再官方 HOW；连接器与查阅后启用留在按需，开场即用进常驻", () => {
    renderOverview({
      showConnectors: true,
      connectors: [{ id: "connector:fs", label: "Filesystem" }],
      onAddConnector: vi.fn(),
    });
    const always = screen.getByTestId("prompt-rail-always");
    const onDemand = screen.getByTestId("prompt-rail-on-demand");
    const create = screen.getByTestId("prompt-rail-create");
    const folders = screen.getByTestId("my-skills");
    const official = screen.getByTestId("prompt-rail-official");
    const connectors = screen.getByTestId("prompt-rail-connectors");
    const onDemandTools = screen.getByTestId("prompt-rail-on-demand-tools");
    expect(screen.queryByTestId("prompt-rail-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory-resident")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory-deferred")).toBeNull();
    expect(screen.queryByRole("heading", { name: "工具" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "文件" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "出厂项" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "官方" })).toBeNull();
    expect(
      always.compareDocumentPosition(onDemand) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(always.contains(onDemandTools)).toBe(false);
    expect(onDemand.contains(connectors)).toBe(true);
    expect(onDemand.contains(onDemandTools)).toBe(true);
    expect(onDemand.contains(official)).toBe(true);
    expect(
      create.compareDocumentPosition(folders) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      folders.compareDocumentPosition(official) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      official.compareDocumentPosition(onDemandTools) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      onDemandTools.compareDocumentPosition(connectors) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(create).getByRole("button", { name: "新建条目" }),
    ).toBeTruthy();
    expect(within(create).getByRole("button", { name: "新建夹" })).toBeTruthy();
    expect(onDemandTools.querySelector(".overflow-x-auto")).toBeNull();
    expect(official.querySelector(".overflow-x-auto")).toBeNull();
    expect(onDemandTools.querySelector(".grid")).toBeTruthy();
    expect(official.querySelector(".grid")).toBeTruthy();
    expect(screen.queryByTestId("prompt-overview-updates")).toBeNull();
    expect(screen.getByRole("heading", { name: "常驻" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "按需" })).toBeTruthy();
    expect(screen.getByText("每回合都带着")).toBeTruthy();
    expect(screen.getByText("用到才翻")).toBeTruthy();
    expect(screen.queryByText("只读说明书")).toBeNull();
    expect(within(always).getByText("读工作区文件")).toBeTruthy();
    expect(
      within(onDemandTools).getByText("本机排查 / 修理 / 查看这台电脑"),
    ).toBeTruthy();
    expect(
      within(always).queryByText("本机排查 / 修理 / 查看这台电脑"),
    ).toBeNull();
    expect(within(onDemand).queryByText("读工作区文件")).toBeNull();
  });

  it("空夹是拖放空卡，不是通栏虚线", () => {
    renderOverview({
      rail: emptyRail({
        folders: [
          {
            id: "folder:law",
            name: "法律合规",
            source: "user",
            documentId: "law",
            items: [],
          },
        ],
      }),
    });
    expect(screen.getByText("拖到这里")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "拖到这里" })).toBeNull();
  });

  it("货架卡走同一套填槽：准则不塞正文、官方 HOW 不打组名、连接器不标本机", () => {
    renderOverview({
      showConnectors: true,
      connectors: [{ id: "connector:fs", label: "Filesystem" }],
    });
    expect(screen.getByText("每回合都在的工作宪法")).toBeTruthy();
    expect(screen.queryByText("aaaa")).toBeNull();
    expect(screen.queryByText("角色身份")).toBeNull();
    expect(
      screen.queryByText("主 Agent 常驻身份；队员按任务写编制"),
    ).toBeNull();
    expect(screen.getByText("写一条按需薄技能")).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-rail-official")).queryByText("编排"),
    ).toBeNull();
    expect(
      within(
        screen.getByTestId(`prompt-tile-${skillCatalogId("thin_skill")}`),
      ).getByText("官方"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByTestId(`prompt-tile-${skillCatalogId("thin_skill")}`),
      ).queryByText("工具"),
    ).toBeNull();
    expect(
      within(screen.getByTestId("prompt-rail-connectors")).queryByText("本机"),
    ).toBeNull();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).queryByText(
        "文件",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).getByText(
        "读工作区文件",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).getByText(
        "工具",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-tile-tool:file_read")).getByText(
        "官方",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-tile-tool:host")).getByText(
        "本机排查 / 修理 / 查看这台电脑",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("prompt-tile-tool:host")).queryByText(
        "查阅后启用",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("prompt-tile-tool:host")).getByText("官方"),
    ).toBeTruthy();
  });
});
