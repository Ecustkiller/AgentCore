// @vitest-environment jsdom
import {
  createDocShare,
  getDoc,
  listDocShares,
  saveDocBody,
} from "@/services/docs";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/docs", () => ({
  getDoc: vi.fn(),
  renameDoc: vi.fn(),
  saveDocBody: vi.fn(),
  listDocShares: vi.fn(),
  createDocShare: vi.fn(),
  revokeDocShare: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/components/markdown/sourceToolbar", () => ({
  SourceToolbar: () => null,
}));

vi.mock("@/components/markdown/MarkdownSourceEditor", async () => {
  const React = await import("react");
  return {
    MarkdownSourceEditor: React.forwardRef(function Stub(
      props: {
        initialDoc?: string;
        editable?: boolean;
        onChange?: (value: string) => void;
        onSave?: () => void;
      },
      ref: React.Ref<unknown>,
    ) {
      const [value, setValue] = React.useState(props.initialDoc ?? "");
      React.useImperativeHandle(ref, () => ({
        getValue: () => value,
        getView: () => null,
        getSelectionContext: () => null,
        startRewriteReview: () => false,
        endRewriteReview: () => {},
      }));
      return React.createElement("textarea", {
        "aria-label": "文档正文",
        readOnly: props.editable === false,
        value,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
          setValue(e.target.value);
          props.onChange?.(e.target.value);
        },
      });
    }),
  };
});

import { DocEditorPage } from "../DocEditorPage";

const get = vi.mocked(getDoc);
const save = vi.mocked(saveDocBody);
const listShares = vi.mocked(listDocShares);
const createShare = vi.mocked(createDocShare);

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={["/docs/d1"]}>
      <Routes>
        <Route path="/docs/:docId" element={<DocEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocEditorPage", () => {
  beforeEach(() => {
    get.mockReset();
    save.mockReset();
    listShares.mockReset();
    createShare.mockReset();
    get.mockResolvedValue({
      id: "d1",
      title: "Q3",
      folder_id: "f1",
      folder_name: "方案",
      version: 1,
      can_write: true,
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
      body: { markdown: "初稿" },
    });
    save.mockResolvedValue({ ok: true, version: 2, conflict: false });
    listShares.mockResolvedValue([]);
    createShare.mockResolvedValue({
      id: "s1",
      url: "/shared/s1",
      title: "Q3",
      created_at: "2026-09-12T00:00:00Z",
      expires_at: null,
    });
  });

  it("loads title and markdown, autosaves an edit", async () => {
    renderEditor();
    expect(await screen.findByDisplayValue("Q3")).toBeTruthy();
    const area = await screen.findByDisplayValue("初稿");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.change(area, { target: { value: "改过" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(save).toHaveBeenCalled();
    const [, body, baseline] = save.mock.calls[0] ?? [];
    expect(baseline).toBe(1);
    expect(body).toEqual({ markdown: "改过" });
  });

  it("hides editors and share for a read-only member", async () => {
    get.mockResolvedValue({
      id: "d1",
      title: "Q3",
      folder_id: "f1",
      folder_name: "方案",
      version: 1,
      can_write: false,
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
      body: { markdown: "初稿" },
    });
    renderEditor();
    expect(await screen.findByText("只读成员不能改这份文档。")).toBeTruthy();
    expect(await screen.findByDisplayValue("初稿")).toBeTruthy();
    expect(
      (screen.getByLabelText("文档正文") as HTMLTextAreaElement).readOnly,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();
  });

  it("flushes unsaved markdown when leaving the page", async () => {
    const { unmount } = renderEditor();
    const area = await screen.findByDisplayValue("初稿");
    await act(async () => {
      fireEvent.change(area, { target: { value: "改过" } });
    });
    unmount();
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [, body] = save.mock.calls[0] ?? [];
    expect(body).toEqual({ markdown: "改过" });
  });

  it("flushes unsaved markdown before minting a share", async () => {
    renderEditor();
    const area = await screen.findByDisplayValue("初稿");
    await act(async () => {
      fireEvent.change(area, { target: { value: "改过" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分享" }));
    });
    expect(await screen.findByText("发布文档")).toBeTruthy();
    const mint = await screen.findByRole("button", { name: "发布" });
    await act(async () => {
      fireEvent.click(mint);
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(createShare).toHaveBeenCalled());
    const [, body] = save.mock.calls[0] ?? [];
    expect(body).toEqual({ markdown: "改过" });
    expect(createShare.mock.calls[0]?.[0]).toBe("d1");
  });
});
