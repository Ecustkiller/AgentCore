// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EPISODIC_SUMMARY_CLAMP_CHARS,
  MemoryUpdateCard,
} from "../MemoryUpdateCard";

const navigate = vi.fn();

let disclosureOpen = true;
const setDisclosureOpen = vi.fn(
  (updater: boolean | ((v: boolean) => boolean)) => {
    disclosureOpen =
      typeof updater === "function" ? updater(disclosureOpen) : updater;
  },
);

vi.mock("@/stores/disclosure", () => ({
  usePersistentDisclosure: () => [disclosureOpen, setDisclosureOpen],
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: () => [{ id: "c1", folderId: "F99", title: "t" }],
}));

vi.mock("@/hooks/useFolders", () => ({
  getFolders: () => [{ id: "F99", name: "白板" }],
}));

vi.mock("@/stores/conversation", async () => {
  const actual = await vi.importActual<typeof import("@/stores/conversation")>(
    "@/stores/conversation",
  );
  return {
    ...actual,
    useConversationStore: (
      sel: (s: { currentConversationId: string }) => unknown,
    ) => sel({ currentConversationId: "c1" }),
  };
});

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

describe("MemoryUpdateCard", () => {
  beforeEach(() => {
    navigate.mockClear();
    disclosureOpen = true;
    setDisclosureOpen.mockClear();
  });

  it("renders episodic light tip from summary", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "e1",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "episodic",
            summary: "本场讨论了用 pnpm 管理依赖。",
            items: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("已记下本场摘要")).toBeTruthy();
    expect(screen.getByText(/pnpm/)).toBeTruthy();
  });

  it("short episodic summary has no clamp controls", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "e-short",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "episodic",
            summary: "短摘要。",
            items: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("episodic-summary-toggle")).toBeNull();
    const tip = screen.getByText("短摘要。");
    expect(tip.className).not.toContain("line-clamp-2");
  });

  it("long episodic summary clamps by default and expands on title click", () => {
    disclosureOpen = false;
    const summary = "本场".repeat(EPISODIC_SUMMARY_CLAMP_CHARS);
    expect(summary.length).toBeGreaterThan(EPISODIC_SUMMARY_CLAMP_CHARS);

    const { rerender } = render(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "e-long",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "episodic",
            summary,
            items: [],
          }}
        />
      </MemoryRouter>,
    );

    const toggle = screen.getByTestId("episodic-summary-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const tip = screen.getByText(summary);
    expect(tip.className).toContain("line-clamp-2");

    fireEvent.click(toggle);
    expect(setDisclosureOpen).toHaveBeenCalled();

    disclosureOpen = true;
    rerender(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "e-long",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "episodic",
            summary,
            items: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen
        .getByTestId("episodic-summary-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText(summary).className).not.toContain("line-clamp-2");
  });

  it("renders semantic diff card with scope overview and project pill", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "s1",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "semantic",
            items: [
              {
                action: "add",
                file: "画像",
                section: "关于用户的事实",
                scope: "global",
                content: "倾向使用 bun",
                target: "global/profile",
              },
              {
                action: "add",
                file: "画像",
                section: "技术栈与工具",
                scope: "project",
                content: "本项目用 Vite",
                target: "project/F99/profile",
                projectId: "F99",
              },
            ],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/记忆已更新 · 全局 \+ 本项目 · 白板/)).toBeTruthy();
    expect(screen.getByText("2 项")).toBeTruthy();
    expect(screen.getByText("本项目 · 白板")).toBeTruthy();
    expect(screen.getByText("移到本项目")).toBeTruthy();
    expect(screen.getByText("移到全局")).toBeTruthy();
  });

  it("falls back to projectId when target does not encode folderId", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          update={{
            id: "s2",
            createdAt: "2026-07-19T12:00:00Z",
            kind: "semantic",
            items: [
              {
                action: "add",
                file: "画像",
                section: "关于用户的事实",
                scope: "project",
                content: "本项目用 React",
                target: "broken-target",
                projectId: "F99",
              },
            ],
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTitle("在「AI 记忆」中打开画像"));
    expect(navigate).toHaveBeenCalledWith("/files", {
      state: {
        openMemoryLeaf: {
          path: "broken-target",
          name: "画像.md",
          projectId: "F99",
        },
        focusWsId: "folder:F99",
      },
    });
  });
});
