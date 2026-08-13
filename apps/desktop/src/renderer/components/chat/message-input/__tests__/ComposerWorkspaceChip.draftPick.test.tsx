// @vitest-environment jsdom
/**
 * 草稿态「在哪工作」动作区（双模式工作区 §5.1）。
 *
 * 位置由一行组标签承担，动作名只留动词短语——动作行不得回潮成教学文案 / 副标题；
 * 全菜单只有一条分隔线（动作区 ↔ 文件夹列表），组标签不得带线。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { setComposerChannelPreference } from "@/lib/composerChannelPreference";
import type { FolderMeta } from "@/services/folders";
import { useFoldersStore } from "@/stores/folders";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const grouped = vi.hoisted(() => ({
  value: { folders: [], conversations: [] } as {
    folders: FolderMeta[];
    conversations: { folderId?: string | null; updatedAt: string }[];
  },
}));

vi.mock("@/hooks/useConversations", () => ({
  useGroupedConversations: () => ({ data: grouped.value }),
  getConversations: () => [],
}));

import { ComposerWorkspaceChip } from "../ComposerWorkspaceChip";

// jsdom lacks the browser APIs Radix's floating content touches on open.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

/** `hasLocalFiles()` = fsApi preload present and not the web runtime. */
function setHasLocalDisk(present: boolean) {
  (window as unknown as { fsApi?: unknown }).fsApi = present ? {} : undefined;
}

function localFolder(
  id: string,
  name: string,
  localSubpath: string | null,
): FolderMeta {
  return { id, name, mode: "local", localRootId: "root-1", localSubpath };
}

/** Opens the draft chip's pick view; returns the popover content. */
function openPicker(): HTMLElement {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ComposerWorkspaceChip conversationId={null} />
      </TooltipProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText("在哪工作"));
  return screen.getByRole("dialog");
}

/** Elements actually drawing a horizontal rule (exact class token, not `border-border`). */
function rules(menu: HTMLElement): Element[] {
  return [menu, ...menu.querySelectorAll("*")].filter((el) =>
    [...el.classList].some((c) => c === "border-t" || c === "border-b"),
  );
}

function precedes(a: Element, b: Element): boolean {
  return Boolean(
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

beforeEach(() => {
  grouped.value = { folders: [], conversations: [] };
  setHasLocalDisk(true);
  setComposerChannelPreference("cloud");
  useFoldersStore.setState({ draftWorkspaceIntent: { kind: "quick_cloud" } });
});

afterEach(() => {
  cleanup();
  setHasLocalDisk(false);
});

describe("DraftChip pick view · 动作区", () => {
  it("四个动作只留动词短语，落点不占单独一行", () => {
    const menu = within(openPicker());

    for (const name of [
      "新建文件夹",
      "从本机导入",
      "从 Git 克隆",
      "打开本机文件夹",
    ]) {
      expect(menu.getByRole("button", { name })).toBeTruthy();
    }

    // 快速对话 keeps its own wording / check state, above the actions.
    expect(
      precedes(menu.getByText("快速对话"), menu.getByText("新建文件夹")),
    ).toBe(true);
    expect(menu.queryByText("在「我的文件」里新建文件夹")).toBeNull();
    expect(menu.queryByText("导入本机文件夹到「我的文件」")).toBeNull();
    // No group label row (folder rows carry 我的文件 in their own hint).
    expect(menu.queryByText("我的文件")).toBeNull();
  });

  it("全菜单只有一条分隔线，落在动作区与文件夹列表之间", () => {
    const content = openPicker();
    const menu = within(content);

    const dividers = rules(content);
    expect(dividers).toHaveLength(1);
    const separator = dividers[0];

    expect(precedes(menu.getByText("了解区别"), separator)).toBe(true);
    expect(precedes(separator, menu.getByText("文件夹"))).toBe(true);
  });

  it("保留「打开本机文件夹」的上次徽标", () => {
    setComposerChannelPreference("local_traditional");
    const menu = within(openPicker());

    const row = menu.getByRole("button", { name: /打开本机文件夹/ });
    expect(within(row).getByText("上次")).toBeTruthy();
  });

  it("无本机盘：只剩新建文件夹，后三项与分隔线不变", () => {
    setHasLocalDisk(false);
    const content = openPicker();
    const menu = within(content);

    expect(menu.getByRole("button", { name: "新建文件夹" })).toBeTruthy();
    expect(menu.queryByText("从本机导入")).toBeNull();
    expect(menu.queryByText("从 Git 克隆")).toBeNull();
    expect(menu.queryByText("打开本机文件夹")).toBeNull();
    expect(rules(content)).toHaveLength(1);
  });
});

describe("folderLocationHint · 本机位置", () => {
  it("subpath 只是文件夹自己的名字时不重复成「本机 · 白板」", () => {
    grouped.value = {
      folders: [localFolder("f-board", "白板", "白板")],
      conversations: [],
    };
    const menu = within(openPicker());

    expect(menu.getByText("白板")).toBeTruthy();
    expect(menu.getByText("本机文件夹")).toBeTruthy();
    expect(menu.queryByText("本机 · 白板")).toBeNull();
  });

  it("嵌套 subpath 只留文件夹之上的那段", () => {
    grouped.value = {
      folders: [localFolder("f-web", "web", "apps/web")],
      conversations: [],
    };
    const menu = within(openPicker());

    expect(menu.getByText("本机 · apps")).toBeTruthy();
  });

  it("没有 subpath 时仍是「本机文件夹」", () => {
    grouped.value = {
      folders: [localFolder("f-repo", "MyRepo", null)],
      conversations: [],
    };
    const menu = within(openPicker());

    expect(menu.getByText("本机文件夹")).toBeTruthy();
  });
});
