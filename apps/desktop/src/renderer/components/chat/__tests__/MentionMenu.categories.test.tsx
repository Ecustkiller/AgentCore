// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MentionMenu } from "../MentionMenu";
import type { MentionCategoryRow } from "../message-input/mentionMenuLevel";

const categories: MentionCategoryRow[] = [
  {
    id: "attach",
    label: "附件",
    count: 0,
    disabled: false,
    hint: "从本机添加",
  },
  { id: "file", label: "文件", count: 12, disabled: false },
  { id: "folder", label: "文件夹", count: 0, disabled: false },
  { id: "conversation", label: "对话", count: 4, disabled: false },
];

const noop = () => {};

describe("MentionMenu 一级目录", () => {
  it("空查询顶行附件 + 文件/文件夹/对话，空团队不占位", () => {
    const onAttach = vi.fn();
    const onDrill = vi.fn();
    render(
      <MentionMenu
        sections={[]}
        flatItems={[]}
        activeIndex={0}
        loading={false}
        error={null}
        query=""
        showSearch={false}
        noFileSources={false}
        showCategoryLevel
        categories={categories}
        canGoBack={false}
        onQueryChange={noop}
        onKeyDown={noop}
        onSelect={noop}
        onHover={noop}
        onDrill={onDrill}
        onAttach={onAttach}
        onBack={noop}
        onAddRoot={noop}
        searchInputRef={{ current: null }}
      />,
    );

    expect(screen.getByText("附件")).toBeTruthy();
    expect(screen.getByText("从本机添加")).toBeTruthy();
    expect(document.querySelector("[data-mention-attach-sep]")).toBeTruthy();
    const attachBtn = document.querySelector(
      "[data-mention-category='attach']",
    );
    expect(attachBtn?.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.queryByText("团队")).toBeNull();
    expect(screen.getByText("对话")).toBeTruthy();
    expect(screen.getByText("文件夹")).toBeTruthy();
    expect(screen.getByText("文件")).toBeTruthy();
    expect(screen.queryByText("多 Agent 回合后可点名")).toBeNull();
    expect(screen.queryByText("其他对话")).toBeNull();
    expect(
      document.querySelector("[data-mention-level='categories']"),
    ).toBeTruthy();

    fireEvent.mouseDown(attachBtn as HTMLElement);
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onDrill).not.toHaveBeenCalled();
  });

  it("index load failure is muted, not destructive", () => {
    render(
      <MentionMenu
        sections={[]}
        flatItems={[]}
        activeIndex={0}
        loading={false}
        error="索引加载失败"
        query=""
        showSearch={false}
        noFileSources={false}
        showCategoryLevel
        categories={categories}
        canGoBack={false}
        onQueryChange={noop}
        onKeyDown={noop}
        onSelect={noop}
        onHover={noop}
        onDrill={noop}
        onAttach={noop}
        onBack={noop}
        onAddRoot={noop}
        searchInputRef={{ current: null }}
      />,
    );
    const fail = screen.getByText("索引加载失败");
    expect(fail.className).toContain("text-muted-foreground");
    expect(fail.className).not.toContain("destructive");
  });

  it("截断分区给出可见提示", () => {
    render(
      <MentionMenu
        sections={[
          {
            id: "file",
            label: "文件",
            items: [
              {
                sourceId: "local:r",
                sourceLabel: "Demo",
                relPath: "a.ts",
                name: "a.ts",
                display: "Demo/a.ts",
                kind: "file",
              },
            ],
            truncated: true,
          },
        ]}
        flatItems={[]}
        activeIndex={0}
        loading={false}
        error={null}
        query=""
        showSearch={false}
        noFileSources={false}
        showCategoryLevel={false}
        categories={categories}
        canGoBack
        focusedSectionLabel="文件"
        onQueryChange={noop}
        onKeyDown={noop}
        onSelect={noop}
        onHover={noop}
        onDrill={noop}
        onAttach={noop}
        onBack={noop}
        onAddRoot={noop}
        searchInputRef={{ current: null }}
      />,
    );
    expect(
      screen.getByText("仅显示部分结果，输入关键词可搜索全部"),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-mention-truncated='file']"),
    ).toBeTruthy();
  });
});
