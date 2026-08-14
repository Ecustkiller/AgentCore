// @vitest-environment jsdom
/**
 * @ 分类 sheet：一级目录附件/团队/对话/文件夹/文件；团队空态不可钻入。
 */
import { ComposerMentionSheet } from "@/components/ComposerMentionSheet";
import { buildMentionCategoryRows } from "@/lib/composerMention";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(cleanup);

describe("ComposerMentionSheet", () => {
  it("lists attach / team / conversation / folder / file; empty team is disabled", () => {
    const onPickAttach = vi.fn();
    const onDrill = vi.fn();
    const onClose = vi.fn();

    render(
      <ComposerMentionSheet
        query=""
        showCategoryLevel
        categories={buildMentionCategoryRows({
          counts: { team: 0, conversation: 2, folder: 1, file: 3 },
        })}
        items={[]}
        onQueryChange={vi.fn()}
        onDrill={onDrill}
        onBack={vi.fn()}
        onSelect={vi.fn()}
        onPickAttach={onPickAttach}
        onClose={onClose}
        canGoBack={false}
      />,
    );

    expect(screen.getByTestId("composer-mention-sheet")).toBeTruthy();
    expect(screen.getByLabelText("附件")).toBeTruthy();
    expect(screen.getByLabelText("团队：多 Agent 回合后可点名")).toBeTruthy();
    expect(screen.getByTestId("composer-mention-cat-team")).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByTestId("composer-mention-cat-conversation"),
    ).toBeTruthy();
    expect(screen.getByTestId("composer-mention-cat-folder")).toBeTruthy();
    expect(screen.getByTestId("composer-mention-cat-file")).toBeTruthy();
    expect(screen.queryByText(/上传/)).toBeNull();

    fireEvent.click(screen.getByTestId("composer-mention-attach"));
    expect(onPickAttach).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-mention-cat-team"));
    expect(onDrill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-mention-cat-conversation"));
    expect(onDrill).toHaveBeenCalledWith("conversation");
  });

  it("selects a drilled item into the caller", () => {
    const onSelect = vi.fn();
    render(
      <ComposerMentionSheet
        query=""
        showCategoryLevel={false}
        categories={[]}
        items={[
          {
            kind: "conversation",
            id: "c2",
            title: "上周复盘",
            label: "上周复盘",
          },
        ]}
        focusedLabel="对话"
        canGoBack
        onQueryChange={vi.fn()}
        onDrill={vi.fn()}
        onBack={vi.fn()}
        onSelect={onSelect}
        onPickAttach={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("上周复盘"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "conversation", id: "c2" }),
    );
  });
});
