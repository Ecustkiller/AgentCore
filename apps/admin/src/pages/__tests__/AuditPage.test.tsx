// @vitest-environment jsdom
/**
 * Regression tests for the admin 操作审计 page.
 *
 * The log table used to apply whichever response landed last: two overlapping loads
 * could leave the older request's rows on screen under the newer filter, and nothing
 * re-fetched afterwards. Pins the "only the latest response wins" guard, the four
 * load states, the 详情 drill-in that replaced the truncate-plus-tooltip cell, and the
 * filters now living in the query string so a narrowed view can be shared as a link.
 * The leading block comment keeps the @vitest-environment directive file-leading.
 */

import { fmtTime } from "@/lib/utils";
import { AuditPage } from "@/pages/AuditPage";
import {
  type AdminAuditLogLine,
  type AdminAuditLogListResponse,
  listAuditLogs,
} from "@/services/adminAudit";
import { type AdminUserListResponse, listUsers } from "@/services/adminUsers";
import { ApiError } from "@/services/api";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/adminAudit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/adminAudit")>();
  return { ...actual, listAuditLogs: vi.fn() };
});
vi.mock("@/services/adminUsers", () => ({ listUsers: vi.fn() }));

beforeEach(() => {
  vi.mocked(listUsers).mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    page_size: 100,
  } as AdminUserListResponse);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Deferred<T> = { resolve: (value: T) => void; promise: Promise<T> };

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function logLine(
  p: Partial<AdminAuditLogLine> & { id: string; actor_username: string },
): AdminAuditLogLine {
  return {
    action: "user.update",
    actor_id: "admin-1",
    created_at: "2026-08-01T00:00:00Z",
    detail: null,
    target_id: null,
    target_type: "user",
    ...p,
  };
}

function logResp(
  data: AdminAuditLogLine[],
  total = data.length,
): AdminAuditLogListResponse {
  return { data, total, page: 1, page_size: 50 };
}

/**
 * Both the page and the filters live in the query string, so anything that edits it
 * from outside the page — a back/forward step, a bookmark, a pasted link — drives the
 * table just as the controls do. These stand in for that path.
 */
function PageJumper() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? "1");
  return (
    <button type="button" onClick={() => setParams({ page: String(page + 1) })}>
      外部翻页
    </button>
  );
}

function ActorJumper() {
  const [, setParams] = useSearchParams();
  return (
    <button type="button" onClick={() => setParams({ actor_id: "admin-9" })}>
      外部换操作者
    </button>
  );
}

/** Query-string readout, so URL-backed filter state can be asserted directly. */
function SearchProbe() {
  const [params] = useSearchParams();
  return <span data-testid="search">{params.toString()}</span>;
}

const search = () => screen.getByTestId("search").textContent;

function renderAudit(initial = "/audit") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <PageJumper />
      <ActorJumper />
      <SearchProbe />
      <AuditPage />
    </MemoryRouter>,
  );
}

describe("AuditPage", () => {
  it("渲染审计流水与总条数", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root" })], 7),
    );

    renderAudit();

    expect(await screen.findByText("root")).toBeTruthy();
    expect(screen.getByText(/共 7 条/)).toBeTruthy();
    // Scoped to the table: 修改用户 is also one of the 操作类型 filter options.
    expect(within(screen.getByRole("table")).getByText("修改用户")).toBeTruthy();
  });

  it("时间列走全站 fmtTime 口径（MM-DD HH:mm），不是 toLocaleString 长串", async () => {
    const created = "2026-08-01T03:04:05Z";
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root", created_at: created })]),
    );

    renderAudit();

    const table = within(await screen.findByRole("table"));
    expect(table.getByText(fmtTime(created))).toBeTruthy();
    expect(table.queryByText(new Date(created).toLocaleString())).toBeNull();
  });

  it("带筛选参数的链接直接打开就复现该视图", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root", action: "user.delete" })]),
    );

    renderAudit("/audit?action=user.delete&actor_id=admin-9");

    expect(await screen.findByText("root")).toBeTruthy();
    expect(vi.mocked(listAuditLogs).mock.calls[0]?.[0]).toMatchObject({
      action: "user.delete",
      actorId: "admin-9",
    });
    expect((screen.getByLabelText("按操作类型筛选") as HTMLSelectElement).value).toBe(
      "user.delete",
    );
    // admin-9 is in no roster here, so the select can only report it as selected if the
    // page still adds the fallback option for an operator who has since been demoted.
    const actorFilter = screen.getByLabelText("按操作者筛选") as HTMLSelectElement;
    expect(actorFilter.value).toBe("admin-9");
    expect(within(actorFilter).getByText("admin-9…")).toBeTruthy();
  });

  it("链接里的非法筛选值回落成「全部」，不原样转发给接口", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root" })]),
    );

    renderAudit("/audit?action=banana");

    expect(await screen.findByText("root")).toBeTruthy();
    expect(vi.mocked(listAuditLogs).mock.calls[0]?.[0].action).toBeUndefined();
    expect((screen.getByLabelText("按操作类型筛选") as HTMLSelectElement).value).toBe("");
  });

  it("改筛选写进 URL，并在同一次导航里丢掉 ?page=", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root" })], 200),
    );

    renderAudit("/audit?page=3");
    await screen.findByText("root");

    fireEvent.change(screen.getByLabelText("按操作类型筛选"), {
      target: { value: "user.delete" },
    });

    await waitFor(() => expect(search()).toBe("action=user.delete"));
    // One navigation, one request: writing the filter and the page separately would
    // flash 第 3 页 + 新筛选 and fire a wasted load that can land out of order.
    await waitFor(() => expect(vi.mocked(listAuditLogs)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listAuditLogs).mock.calls[1]?.[0]).toMatchObject({
      page: 1,
      action: "user.delete",
    });
  });

  it("按行内操作者筛选写进 URL；URL 换了人就不再沿用上一位的显示名", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_id: "admin-1", actor_username: "运维小李" })]),
    );

    renderAudit();
    fireEvent.click(await screen.findByRole("button", { name: "运维小李" }));

    await waitFor(() => expect(search()).toBe("actor_id=admin-1"));
    const actorFilter = screen.getByLabelText("按操作者筛选") as HTMLSelectElement;
    expect(actorFilter.value).toBe("admin-1");
    expect(within(actorFilter).getByText("运维小李")).toBeTruthy();

    // The name was captured for admin-1; a URL that swaps the actor must not keep
    // labelling the dropdown with it.
    fireEvent.click(screen.getByRole("button", { name: "外部换操作者" }));
    await waitFor(() => expect(actorFilter.value).toBe("admin-9"));
    expect(within(actorFilter).queryByText("运维小李")).toBeNull();
  });

  it("首屏加载时筛选控件不可用，数据到位后恢复且刷新期不再冻结", async () => {
    const pending: Deferred<AdminAuditLogListResponse>[] = [];
    vi.mocked(listAuditLogs).mockImplementation(() => {
      const d = makeDeferred<AdminAuditLogListResponse>();
      pending.push(d);
      return d.promise;
    });

    renderAudit();

    const actionFilter = screen.getByLabelText("按操作类型筛选") as HTMLSelectElement;
    expect(actionFilter.disabled).toBe(true);

    await waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(logResp([logLine({ id: "a1", actor_username: "root" })]));

    expect(await screen.findByText("root")).toBeTruthy();
    await waitFor(() => expect(actionFilter.disabled).toBe(false));

    // Refreshes must not re-freeze the filters: the race guard exists so the operator
    // can keep narrowing while a request is in flight. The tempting shorthand
    // `disabled={loading}` also re-locks after a filter yields zero rows — precisely
    // when they need to widen it again — so drive that exact case.
    fireEvent.change(actionFilter, { target: { value: "user.delete" } });
    await waitFor(() => expect(pending.length).toBe(2));
    expect(actionFilter.disabled).toBe(false);

    pending[1]!.resolve(logResp([], 0));
    expect(await screen.findByText("没有符合筛选的审计记录")).toBeTruthy();

    fireEvent.change(actionFilter, { target: { value: "user.update" } });
    await waitFor(() => expect(pending.length).toBe(3));
    expect(actionFilter.disabled).toBe(false);
  });

  it("后到的旧响应不覆盖新一页结果", async () => {
    const pending: Deferred<AdminAuditLogListResponse>[] = [];
    vi.mocked(listAuditLogs).mockImplementation(() => {
      const d = makeDeferred<AdminAuditLogListResponse>();
      pending.push(d);
      return d.promise;
    });

    renderAudit();
    await waitFor(() => expect(pending.length).toBe(1));
    pending[0]!.resolve(logResp([logLine({ id: "a0", actor_username: "初始操作者" })]));
    expect(await screen.findByText("初始操作者")).toBeTruthy();

    // Two URL-driven page steps in a row leave two overlapping loads whose responses
    // can come back in either order.
    const jump = screen.getByRole("button", { name: "外部翻页" });
    fireEvent.click(jump);
    await waitFor(() => expect(pending.length).toBe(2));
    fireEvent.click(jump);
    await waitFor(() => expect(pending.length).toBe(3));

    pending[2]!.resolve(logResp([logLine({ id: "a2", actor_username: "最新操作者" })]));
    expect(await screen.findByText("最新操作者")).toBeTruthy();

    // Settle the stale response *inside* act, so its continuation and any state it
    // sets are flushed before the assertions run. Wrapping these in `waitFor` instead
    // would make them vacuous: "过期操作者 is absent" is already true on the first
    // check — before the stale update could possibly have landed — so waitFor returns
    // immediately and the test passes even with the guard removed.
    await act(async () => {
      pending[1]!.resolve(
        logResp([logLine({ id: "a1", actor_username: "过期操作者" })]),
      );
      await pending[1]!.promise;
    });

    expect(screen.getByText("最新操作者")).toBeTruthy();
    expect(screen.queryByText("过期操作者")).toBeNull();
    expect(vi.mocked(listAuditLogs).mock.calls[2]?.[0].page).toBe(3);
  });

  it("详情不再靠 title 提示，整段 JSON 在对话框里可读", async () => {
    const reason = "配额上调：".repeat(12);
    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([
        logLine({
          id: "a1",
          actor_username: "root",
          target_id: "user-42",
          detail: { reason, quota_cny: 120 },
        }),
      ]),
    );

    renderAudit();

    const trigger = await screen.findByRole("button", { name: /查看详情/ });
    fireEvent.click(trigger);

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(new RegExp(reason))).toBeTruthy();
    expect(dialog.getByText(/"quota_cny": 120/)).toBeTruthy();
    expect(dialog.getByText("user-42")).toBeTruthy();
  });

  it("空结果给出空态而不是空表格，可一键清除筛选", async () => {
    vi.mocked(listAuditLogs).mockResolvedValue(logResp([], 0));

    renderAudit();

    expect(await screen.findByText("暂无审计记录")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.change(screen.getByLabelText("按操作类型筛选"), {
      target: { value: "user.delete" },
    });

    expect(await screen.findByText("没有符合筛选的审计记录")).toBeTruthy();
    // One in the filter row, one offered by the empty state itself.
    const clears = screen.getAllByRole("button", { name: "清除筛选" });
    expect(clears.length).toBe(2);
    fireEvent.click(clears[1]!);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("按操作类型筛选") as HTMLSelectElement).value,
      ).toBe(""),
    );
  });

  it("页码超出范围时说清是翻过头了，而不是「暂无记录」", async () => {
    vi.mocked(listAuditLogs)
      .mockResolvedValueOnce(logResp([logLine({ id: "a1", actor_username: "root" })], 7))
      .mockResolvedValue(logResp([], 7));

    renderAudit();
    await screen.findByText("root");

    fireEvent.click(screen.getByRole("button", { name: "外部翻页" }));

    expect(await screen.findByText("这一页没有审计记录")).toBeTruthy();
    expect(screen.getByText(/当前共 7 条/)).toBeTruthy();
    expect(screen.queryByText("暂无审计记录")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "回到第一页" }));
    await waitFor(() =>
      expect(vi.mocked(listAuditLogs).mock.calls[2]?.[0].page).toBe(1),
    );
  });

  it("加载失败给出错误态与重试", async () => {
    vi.mocked(listAuditLogs).mockRejectedValueOnce(
      new ApiError(502, JSON.stringify({ error: { message: "网关超时" } })),
    );
    renderAudit();

    expect(await screen.findByText("网关超时")).toBeTruthy();

    vi.mocked(listAuditLogs).mockResolvedValue(
      logResp([logLine({ id: "a1", actor_username: "root" })]),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("root")).toBeTruthy();
  });
});
