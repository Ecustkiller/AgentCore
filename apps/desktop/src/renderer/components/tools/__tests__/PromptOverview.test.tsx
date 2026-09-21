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
    listable: applyMode !== "always",
    disputed: false,
    alwaysChars: applyMode === "always" ? content.length : null,
    parentId: null,
  };
}

function capTool(name: string, resident: boolean): CapabilityTool {
  const summaries: Record<string, string> = {
    read: "读工作区文件",
    host: "这台电脑。",
  };
  return {
    name,
    face: "file",
    resident,
    summary: summaries[name] ?? name,
    blurb:
      name === "read"
        ? "打开文本、代码或图片，看里面写了什么"
        : "看本机屏幕、键鼠和已打开的应用",
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
    tools: [toolItem("read", true), toolItem("host", true)],
  });
}

function renderOverview(
  over: Partial<ComponentProps<typeof PromptOverview>> = {},
) {
  const noop = () => {};
  return render(
    <PromptOverview
      pane="mine"
      rail={filledRail()}
      selectedId={null}
      dropDest={null}
      otherFolder={otherFolder}
      renamingFolderId={null}
      busy={false}
      onOpenItem={vi.fn()}
      onCreateMine={vi.fn()}
      onCreateFolder={vi.fn()}
      onSubmitRenameFolder={vi.fn()}
      onCancelRenameFolder={vi.fn()}
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
  it("必带叶子铺成矮卡，点开对应条目", () => {
    const onOpenItem = vi.fn();
    renderOverview({ onOpenItem });
    fireEvent.click(screen.getByRole("button", { name: "短约束" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual([
      mineCatalogId("rule"),
    ]);
    expect(screen.queryByRole("button", { name: "全员共享准则" })).toBeNull();
    expect(screen.queryByRole("button", { name: "读工作区文件" })).toBeNull();
    expect(screen.queryByTestId("prompt-tile-tool:read")).toBeNull();
    expect(screen.queryByTestId("prompt-resident-bar")).toBeNull();
    expect(screen.getByTestId("prompt-overview").textContent).not.toMatch(/%/);
  });

  it("空必带也留区，拖得进", () => {
    renderOverview({
      rail: emptyRail(),
    });
    expect(screen.getByRole("heading", { name: "必带" })).toBeTruthy();
    expect(screen.getByText("拖一条进来，下一回合就会带上。")).toBeTruthy();
    expect(
      screen.queryByText("没有必带条目。拖一条进来，下一回合就会带上。"),
    ).toBeNull();
    expect(screen.getByText("还没有夹。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "还没有夹。" })).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-constitution")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-always-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-on-demand-tools")).toBeNull();
  });

  it("按需叶子铺成行，夹只当区标题", () => {
    const onOpenItem = vi.fn();
    renderOverview({ onOpenItem });
    expect(screen.getByRole("heading", { name: "其他" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "合同审查" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "合同审查" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual([
      mineCatalogId("d1"),
    ]);
    expect(screen.queryByTestId("memory-updates-view")).toBeNull();
    expect(screen.getByTestId("prompt-overview").textContent).not.toMatch(/%/);
  });

  it("按需先铺我的夹；出厂工具和官方 HOW 不在我的", () => {
    renderOverview();
    const always = screen.getByTestId("prompt-rail-always");
    const onDemand = screen.getByTestId("prompt-rail-on-demand");
    const create = screen.getByTestId("prompt-rail-create");
    const folders = screen.getByTestId("my-skills");
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-on-demand-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-factory")).toBeNull();
    expect(screen.queryByRole("heading", { name: "工具" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "文件" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "出厂项" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "官方" })).toBeNull();
    expect(screen.queryByRole("button", { name: "薄技能" })).toBeNull();
    expect(screen.queryByRole("button", { name: "读工作区文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "这台电脑。" })).toBeNull();
    expect(
      always.compareDocumentPosition(onDemand) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(onDemand.contains(folders)).toBe(true);
    expect(
      create.compareDocumentPosition(folders) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(create).queryByRole("button", { name: "新建条目" }),
    ).toBeNull();
    expect(within(create).getByRole("button", { name: "新建夹" })).toBeTruthy();
    expect(screen.queryByTestId("prompt-overview-updates")).toBeNull();
    expect(screen.getByRole("heading", { name: "必带" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "按需" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "连接器" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "手上的工具" })).toBeNull();
    expect(
      screen.queryByText("打开文本、代码或图片，看里面写了什么"),
    ).toBeNull();
    expect(screen.queryByText("写一条按需薄技能")).toBeNull();
    expect(screen.queryByText("每回合都带着")).toBeNull();
    expect(screen.queryByText("用到才翻")).toBeNull();
  });

  it("空夹是拖放空文案，不是按钮", () => {
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

  it("必带矮卡不塞准则正文", () => {
    renderOverview();
    expect(screen.queryByText("aaaa")).toBeNull();
    expect(screen.queryByRole("button", { name: "全员共享准则" })).toBeNull();
    expect(screen.queryByText("每回合都在的工作宪法")).toBeNull();
    expect(screen.queryByRole("button", { name: "薄技能" })).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByTestId("prompt-tile-tool:read")).toBeNull();
    expect(screen.queryByText("本机")).toBeNull();
  });

  it("官方栏：提示词（准则在前）/ 工具分区", () => {
    const onOpenItem = vi.fn();
    renderOverview({ pane: "official", onOpenItem });
    fireEvent.click(screen.getByRole("button", { name: "全员共享准则" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual(["shared"]);
    const prompts = screen.getByTestId("prompt-rail-prompts");
    expect(
      within(prompts)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["全员共享准则", "薄技能"]);
    expect(within(prompts).getByText("每回合都在的工作宪法")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "提示词" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "工具" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "准则" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "教法" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "必带" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "按需" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "手上的工具" })).toBeNull();
    expect(screen.queryByRole("button", { name: "短约束" })).toBeNull();
    expect(screen.queryByRole("button", { name: "合同审查" })).toBeNull();
    expect(
      within(screen.getByTestId("prompt-rail-tools")).getByRole("button", {
        name: "读工作区文件",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("prompt-tile-tool:read")).toBeTruthy();
    expect(screen.queryByTestId("prompt-rail-always")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-on-demand")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-connectors")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-constitution")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
    expect(screen.queryByText("aaaa")).toBeNull();
  });

  it("官方空核也留卡，点得开", () => {
    const onOpenItem = vi.fn();
    renderOverview({
      pane: "official",
      rail: emptyRail({
        constitution: [sharedItem("")],
      }),
      onOpenItem,
    });
    fireEvent.click(screen.getByRole("button", { name: "全员共享准则" }));
    expect(onOpenItem.mock.calls.map((call) => call[0])).toEqual(["shared"]);
    expect(screen.getByTestId("prompt-rail-prompts")).toBeTruthy();
    expect(screen.getByText("每回合都在的工作宪法")).toBeTruthy();
    expect(screen.queryByTestId("prompt-rail-constitution")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-tools")).toBeNull();
  });
});
