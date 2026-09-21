// @vitest-environment jsdom
import { formatMemoryTime } from "@/components/memory/MemoryUpdateItemRow";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryUpdateCard } from "../MemoryUpdateCard";

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

vi.mock("@/hooks/useFolders", () => ({
  getFolders: () => [{ id: "F99", name: "白板" }],
}));

describe("MemoryUpdateCard", () => {
  beforeEach(() => {
    disclosureOpen = true;
    setDisclosureOpen.mockClear();
  });

  it("does not render leftover semantic / organized memory cards", () => {
    const { container } = render(
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
          ],
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/记忆已更新/)).toBeNull();
    expect(screen.queryByText(/记忆已整理/)).toBeNull();
  });

  it("quota card names denied entries and holders, hiding the fingerprint row", () => {
    render(
      <MemoryUpdateCard
        update={{
          id: "q1",
          createdAt: "2026-07-19T12:00:00Z",
          kind: "quota",
          summary: "常驻用户规则已满（120/80 字符）：以下 1 条没能写进常驻。",
          items: [
            {
              action: "quota",
              file: "",
              section: "",
              scope: "global",
              content: "fp-hash-must-not-render",
              target: "",
            },
            {
              action: "quota_denied",
              file: "语气.md",
              section: "",
              scope: "global",
              content: "这次的更新没能写入常驻（40 字符）",
              target: "",
            },
            {
              action: "quota_holder",
              file: "占坑规则.md",
              section: "",
              scope: "global",
              content: "占用 100 字符",
              target: "",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/常驻用户规则已满（120\/80 字符）/)).toBeTruthy();
    expect(screen.queryByText("fp-hash-must-not-render")).toBeNull();
    expect(screen.getByText("2 项")).toBeTruthy();
    expect(screen.getByText("未写入")).toBeTruthy();
    expect(screen.getByText("这次的更新没能写入常驻（40 字符）")).toBeTruthy();
    expect(screen.getByText("占用")).toBeTruthy();
    expect(screen.getByText("占用 100 字符")).toBeTruthy();
    expect(screen.queryByText("移到本文件夹")).toBeNull();
    expect(screen.queryByText("移到全局")).toBeNull();
  });

  it("renders a fingerprint-only quota card without an empty item list", () => {
    render(
      <MemoryUpdateCard
        update={{
          id: "q2",
          createdAt: "2026-07-19T12:00:00Z",
          kind: "quota",
          summary: "常驻用户规则已满（120/80 字符）。",
          items: [
            {
              action: "quota",
              file: "",
              section: "",
              scope: "global",
              content: "fp-only",
              target: "",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/常驻用户规则已满/)).toBeTruthy();
    expect(screen.queryByText("1 项")).toBeNull();
    expect(screen.queryByText("fp-only")).toBeNull();
  });

  it("labels the quota card with its anchor time", () => {
    const anchorAt = "2026-07-19T12:00:00Z";
    const createdAt = "2026-07-19T12:05:00Z";
    render(
      <MemoryUpdateCard
        update={{
          id: "q-anchored",
          createdAt,
          anchorAt,
          kind: "quota",
          summary: "常驻用户规则已满",
          items: [],
        }}
      />,
    );
    expect(screen.getByText(formatMemoryTime(anchorAt))).toBeTruthy();
    expect(screen.queryByText(formatMemoryTime(createdAt))).toBeNull();
  });

  it("quota rows are not deep-links", () => {
    render(
      <MemoryUpdateCard
        update={{
          id: "q-no-nav",
          createdAt: "2026-07-19T12:00:00Z",
          kind: "quota",
          summary: "常驻用户规则已满",
          items: [
            {
              action: "quota_holder",
              file: "占坑规则.md",
              section: "",
              scope: "global",
              content: "占用 100 字符",
              target: "global/profile",
            },
          ],
        }}
      />,
    );
    expect(screen.queryByTitle(/在设定中打开/)).toBeNull();
    expect(screen.queryByRole("button", { name: /占坑规则/ })).toBeNull();
  });
});
