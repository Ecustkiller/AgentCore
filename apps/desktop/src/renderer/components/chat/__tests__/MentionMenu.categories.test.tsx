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
  {
    id: "team",
    label: "团队",
    count: 0,
    disabled: true,
    hint: "多 Agent 回合后可点名",
  },
  { id: "conversation", label: "对话", count: 4, disabled: false },
  { id: "folder", label: "文件夹", count: 0, disabled: false },
  { id: "file", label: "文件", count: 12, disabled: false },
];

const noop = () => {};

describe("MentionMenu 一级目录", () => {
  it("空查询顶行附件 + 四类，不列出对话标题", () => {
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
    expect(screen.getByText("团队")).toBeTruthy();
    expect(screen.getByText("对话")).toBeTruthy();
    expect(screen.getByText("文件夹")).toBeTruthy();
    expect(screen.getByText("文件")).toBeTruthy();
    expect(screen.getByText("多 Agent 回合后可点名")).toBeTruthy();
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
});
