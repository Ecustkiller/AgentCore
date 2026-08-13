// @vitest-environment jsdom
/**
 * Regression tests for the admin 公告 page.
 *
 * A notice reaches every user the moment it is published, and archiving locks it
 * against further edits — both used to fire off a single ghost-button click. The
 * draft form was equally forgiving: it only checked 标题 / 正文 / 摘要, so a CTA with
 * no link or an end time before its start could be saved and only fail in front of
 * users. These pin the confirmations and the form's guard rails.
 * The leading block comment keeps the @vitest-environment directive file-leading.
 */

import { NoticesPage } from "@/pages/NoticesPage";
import {
  type Notice,
  type NoticeListResponse,
  archiveNotice,
  createNotice,
  listNotices,
  publishNotice,
} from "@/services/adminNotices";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

vi.mock("@/services/adminNotices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/adminNotices")>();
  return {
    ...actual,
    listNotices: vi.fn(),
    createNotice: vi.fn(),
    updateNotice: vi.fn(),
    publishNotice: vi.fn(),
    archiveNotice: vi.fn(),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function notice(p: Partial<Notice> & { id: string; title: string }): Notice {
  return {
    body: "公告正文",
    card_template: "service",
    cover_url: null,
    created_at: "2026-08-01T00:00:00Z",
    created_by: "admin-1",
    cta_label: null,
    cta_url: null,
    dismiss_policy: "once",
    end_at: null,
    published_at: null,
    severity: "normal",
    start_at: null,
    status: "draft",
    summary: null,
    surface: "both",
    updated_at: "2026-08-01T00:00:00Z",
    ...p,
  };
}

function listResp(data: Notice[], total = data.length): NoticeListResponse {
  return { data, total };
}

/** Query-string readout, so URL-backed filter state can be asserted directly. */
function SearchProbe() {
  const [params] = useSearchParams();
  return <span data-testid="search">{params.toString()}</span>;
}

const search = () => screen.getByTestId("search").textContent;

function renderNotices(initial = "/notices") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SearchProbe />
      <NoticesPage />
    </MemoryRouter>,
  );
}

/** Opens 新建公告 and fills the two always-required fields. */
async function openDraftForm() {
  // Header action; the empty state offers a second one with the same label.
  fireEvent.click(screen.getAllByRole("button", { name: /新建公告/ })[0]!);
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("标题"), {
    target: { value: "维护通知" },
  });
  fireEvent.change(dialog.getByLabelText("正文"), {
    target: { value: "今晚维护" },
  });
  return dialog;
}

describe("NoticesPage", () => {
  it("渲染公告列表与总条数", async () => {
    vi.mocked(listNotices).mockResolvedValue(
      listResp([
        notice({ id: "n1", title: "计划维护", status: "published" }),
        notice({ id: "n2", title: "草稿一条" }),
      ]),
    );

    renderNotices();

    expect(await screen.findByText("计划维护")).toBeTruthy();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("已发布")).toBeTruthy();
    expect(table.getByText("草稿")).toBeTruthy();
    expect(screen.getByText(/共 2 条/)).toBeTruthy();
  });

  it("列表预览是一行纯文本，不吐 Markdown 源码", async () => {
    vi.mocked(listNotices).mockResolvedValue(
      listResp([
        notice({
          id: "n1",
          title: "版本更新",
          body: "## 本次更新\n- 桌面端 **0.9.14** 修复了[崩溃](https://example.com)\n- 手机端跟进",
        }),
      ]),
    );

    renderNotices();

    expect(
      await screen.findByText(
        "本次更新 · 桌面端 0.9.14 修复了崩溃 · 手机端跟进",
      ),
    ).toBeTruthy();
  });

  it("带 status 的链接直接打开就复现筛选后的视图", async () => {
    vi.mocked(listNotices).mockResolvedValue(
      listResp([notice({ id: "n1", title: "计划维护", status: "published" })]),
    );

    renderNotices("/notices?status=published");

    expect(await screen.findByText("计划维护")).toBeTruthy();
    expect(vi.mocked(listNotices).mock.calls[0]?.[0]).toMatchObject({
      status: "published",
      offset: 0,
    });
    expect((screen.getByLabelText("按状态筛选") as HTMLSelectElement).value).toBe(
      "published",
    );
  });

  it("链接里的非法状态回落成「全部」，不原样转发给接口", async () => {
    vi.mocked(listNotices).mockResolvedValue(
      listResp([notice({ id: "n1", title: "计划维护" })]),
    );

    renderNotices("/notices?status=banana");

    expect(await screen.findByText("计划维护")).toBeTruthy();
    expect(vi.mocked(listNotices).mock.calls[0]?.[0]?.status).toBeUndefined();
    expect((screen.getByLabelText("按状态筛选") as HTMLSelectElement).value).toBe("all");
  });

  it("改筛选写进 URL，并在同一次导航里丢掉 ?page=", async () => {
    vi.mocked(listNotices).mockResolvedValue(
      listResp([notice({ id: "n1", title: "计划维护" })], 200),
    );

    renderNotices("/notices?page=3");
    await screen.findByText("计划维护");
    expect(vi.mocked(listNotices).mock.calls[0]?.[0]?.offset).toBe(100);

    fireEvent.change(screen.getByLabelText("按状态筛选"), {
      target: { value: "draft" },
    });

    await waitFor(() => expect(search()).toBe("status=draft"));
    // One navigation, one request: writing the filter and the page separately would
    // flash 第 3 页 + 新筛选 and fire a wasted load that can land out of order.
    await waitFor(() => expect(vi.mocked(listNotices)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listNotices).mock.calls[1]?.[0]).toMatchObject({
      status: "draft",
      offset: 0,
    });
  });

  it("发布要先确认，确认后才调接口", async () => {
    const draft = notice({ id: "n1", title: "计划维护" });
    vi.mocked(listNotices).mockResolvedValue(listResp([draft]));
    vi.mocked(publishNotice).mockResolvedValue({ ...draft, status: "published" });

    renderNotices();

    fireEvent.click(await screen.findByRole("button", { name: /发布/ }));
    expect(vi.mocked(publishNotice)).not.toHaveBeenCalled();

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/无法撤回/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: /确认发布/ }));

    await waitFor(() => expect(vi.mocked(publishNotice)).toHaveBeenCalledWith("n1"));
  });

  it("归档要先确认，并说明归档后不能再编辑", async () => {
    const published = notice({ id: "n1", title: "计划维护", status: "published" });
    vi.mocked(listNotices).mockResolvedValue(listResp([published]));
    vi.mocked(archiveNotice).mockResolvedValue({ ...published, status: "archived" });

    renderNotices();

    fireEvent.click(await screen.findByRole("button", { name: /归档/ }));
    expect(vi.mocked(archiveNotice)).not.toHaveBeenCalled();

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/不能再编辑/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: /确认归档/ }));

    await waitFor(() => expect(vi.mocked(archiveNotice)).toHaveBeenCalledWith("n1"));
  });

  it("只填 CTA 链接不填文案时拒绝保存", async () => {
    vi.mocked(listNotices).mockResolvedValue(listResp([]));
    renderNotices();
    await screen.findByText("还没有公告");

    const dialog = await openDraftForm();
    fireEvent.change(dialog.getByLabelText("CTA 链接"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "创建草稿" }));

    expect(vi.mocked(createNotice)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("填了 CTA 链接就要填文案"),
    );
  });

  it("结束时间早于开始时间时拒绝保存", async () => {
    vi.mocked(listNotices).mockResolvedValue(listResp([]));
    renderNotices();
    await screen.findByText("还没有公告");

    const dialog = await openDraftForm();
    fireEvent.change(dialog.getByLabelText("开始时间"), {
      target: { value: "2026-08-02T10:00" },
    });
    fireEvent.change(dialog.getByLabelText("结束时间"), {
      target: { value: "2026-08-01T10:00" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "创建草稿" }));

    expect(vi.mocked(createNotice)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("结束时间要晚于开始时间"),
    );
  });

  it("封面必须是绝对 URL，改好后可以提交", async () => {
    vi.mocked(listNotices).mockResolvedValue(listResp([]));
    vi.mocked(createNotice).mockResolvedValue(notice({ id: "n9", title: "维护通知" }));
    renderNotices();
    await screen.findByText("还没有公告");

    const dialog = await openDraftForm();
    const cover = dialog.getByLabelText("封面 URL（可选）");
    fireEvent.change(cover, { target: { value: "images/banner.png" } });
    fireEvent.click(dialog.getByRole("button", { name: "创建草稿" }));
    expect(vi.mocked(createNotice)).not.toHaveBeenCalled();

    fireEvent.change(cover, { target: { value: "https://cdn.example.com/b.png" } });
    fireEvent.click(dialog.getByRole("button", { name: "创建草稿" }));

    await waitFor(() =>
      expect(vi.mocked(createNotice)).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "维护通知",
          cover_url: "https://cdn.example.com/b.png",
        }),
      ),
    );
  });

  it("筛选后的空态说明是筛选结果，并能清除筛选", async () => {
    vi.mocked(listNotices).mockResolvedValue(listResp([]));
    renderNotices();

    expect(await screen.findByText("还没有公告")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("按状态筛选"), {
      target: { value: "draft" },
    });
    expect(await screen.findByText("没有「草稿」状态的公告")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() =>
      expect((screen.getByLabelText("按状态筛选") as HTMLSelectElement).value).toBe(
        "all",
      ),
    );
    // 全部 is the default, so clearing leaves no residue in a link.
    expect(search()).toBe("");
  });
});
