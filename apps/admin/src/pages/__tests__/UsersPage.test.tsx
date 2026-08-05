// @vitest-environment jsdom
/**
 * Render tests for the admin 用户管理 page (AUD-012 测试覆盖补强 · admin 半).
 *
 * UsersPage owns the roster table + row actions (改角色 / 停用·启用 / 注销 / 配额). These pin
 * its happy paths and the key self-guards with the services mocked (no real HTTP) and the
 * not-under-test leaves (UserDetail / QuotaDialog) stubbed, so the test targets the page's
 * own list rendering, self-row guarding, status toggle, empty + error/retry branches. The
 * leading block comment keeps the @vitest-environment directive file-leading.
 */

import { UsersPage } from "@/pages/UsersPage";
import {
  type AdminUser,
  type AdminUserListItem,
  type AdminUserListResponse,
  deleteUser,
  listUsers,
  updateUser,
} from "@/services/adminUsers";
import { ApiError } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/adminUsers", () => ({
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Not under test here — stubbed so the roster test never pulls their module graph.
vi.mock("@/components/UserDetail", () => ({
  UserDetail: () => <div data-testid="user-detail" />,
}));
vi.mock("@/components/QuotaDialog", () => ({
  QuotaDialog: () => <div data-testid="quota-dialog" />,
}));

const SELF_ID = "self-id";

beforeEach(() => {
  useAuthStore.setState({
    status: "authenticated",
    user: {
      id: SELF_ID,
      username: "admin",
      displayName: "管理员",
      email: null,
      role: "admin",
      passwordMustChange: false,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function userItem(
  p: Partial<AdminUserListItem> & { id: string },
): AdminUserListItem {
  return {
    username: "user",
    display_name: "",
    email: null,
    role: "user",
    status: "active",
    deleted_at: null,
    is_unlimited: false,
    quota_daily_tokens: null,
    quota_daily_requests: null,
    quota_monthly_cost_cny: null,
    quota_daily_cost_cny: null,
    cost_total: 0,
    created_at: "2026-06-01T00:00:00Z",
    ...p,
  };
}

function listResp(
  data: AdminUserListItem[],
  total = data.length,
): AdminUserListResponse {
  return { data, total, page: 1, page_size: 20 };
}

function renderUsers(initialEntry = "/users") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/:userId" element={<UsersPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("UsersPage", () => {
  it("renders the roster from listUsers (names, self marker, count)", async () => {
    vi.mocked(listUsers).mockResolvedValue(
      listResp(
        [
          userItem({ id: SELF_ID, username: "alice", display_name: "Alice" }),
          userItem({ id: "u2", username: "bob", display_name: "Bob" }),
        ],
        2,
      ),
    );
    renderUsers();
    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText(/@bob/)).toBeTruthy();
    expect(screen.getByText("(我)")).toBeTruthy(); // the signed-in admin's own row
    expect(screen.getByText(/共 2 个账号/)).toBeTruthy();
  });

  it("guards self-row actions (role select + 停用 disabled for the signed-in admin)", async () => {
    vi.mocked(listUsers).mockResolvedValue(
      listResp([
        userItem({ id: SELF_ID, username: "alice", display_name: "Alice", role: "admin" }),
      ]),
    );
    renderUsers();
    await screen.findByText("Alice");
    expect((screen.getByDisplayValue("admin") as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "停用" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("停用 a non-self user → updateUser + toast + the row flips to 启用", async () => {
    vi.mocked(listUsers).mockResolvedValue(
      listResp(
        [
          userItem({ id: SELF_ID, username: "alice", display_name: "Alice", role: "admin" }),
          userItem({ id: "u2", username: "bob", display_name: "Bob" }),
        ],
        2,
      ),
    );
    vi.mocked(updateUser).mockResolvedValue({
      id: "u2",
      status: "disabled",
    } as unknown as AdminUser);
    renderUsers();
    await screen.findByText("Bob");
    // alice (self) 停用 is disabled; bob's is the enabled one.
    const enabled = screen
      .getAllByRole("button", { name: "停用" })
      .find((b) => !(b as HTMLButtonElement).disabled);
    fireEvent.click(enabled as HTMLButtonElement);
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith("u2", { status: "disabled" }),
    );
    expect(toast.success).toHaveBeenCalledWith("账号已停用");
    expect(await screen.findByRole("button", { name: "启用" })).toBeTruthy();
  });

  it("shows the empty state when no users match", async () => {
    vi.mocked(listUsers).mockResolvedValue(listResp([], 0));
    renderUsers();
    expect(await screen.findByText("没有匹配的用户")).toBeTruthy();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("surfaces a load error then recovers on 重试", async () => {
    vi.mocked(listUsers)
      .mockRejectedValueOnce(
        new ApiError(500, JSON.stringify({ error: { message: "服务器开小差" } })),
      )
      .mockResolvedValue(listResp([userItem({ id: "u2", display_name: "Bob" })], 1));
    renderUsers();
    expect(await screen.findByText("服务器开小差")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Bob")).toBeTruthy();
  });

  it("末页删光后钳回合法页并重新拉列表", async () => {
    const page2Only = userItem({
      id: "u21",
      username: "last",
      display_name: "LastOnPage2",
    });
    const page1Users = Array.from({ length: 20 }, (_, i) =>
      userItem({
        id: `u${i + 1}`,
        username: `user${i + 1}`,
        display_name: `User${i + 1}`,
      }),
    );
    vi.mocked(listUsers).mockImplementation(async (opts) => {
      if (opts.page === 2) return listResp([page2Only], 21);
      return listResp(page1Users, 20);
    });
    vi.mocked(deleteUser).mockResolvedValue({
      id: "u21",
      deleted_at: "2026-08-06T00:00:00Z",
    } as unknown as AdminUser);

    renderUsers("/users?page=2");
    expect(await screen.findByText("LastOnPage2")).toBeTruthy();
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "注销" }));
    fireEvent.click(screen.getByRole("button", { name: "确认注销" }));

    await waitFor(() => {
      expect(deleteUser).toHaveBeenCalledWith("u21");
      expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();
      expect(screen.getByText("User1")).toBeTruthy();
      expect(screen.queryByText("LastOnPage2")).toBeNull();
      expect(screen.queryByText("没有匹配的用户")).toBeNull();
    });
    expect(vi.mocked(listUsers).mock.calls.some((c) => c[0].page === 1)).toBe(
      true,
    );
  });

  it("search on ?page>1 keeps table aligned with page=1 (stale page>1 response ignored)", async () => {
    type Deferred = {
      resolve: (v: AdminUserListResponse) => void;
      promise: Promise<AdminUserListResponse>;
    };
    const deferreds: Deferred[] = [];
    vi.mocked(listUsers).mockImplementation(() => {
      let resolve!: (v: AdminUserListResponse) => void;
      const promise = new Promise<AdminUserListResponse>((r) => {
        resolve = r;
      });
      deferreds.push({ resolve, promise });
      return promise;
    });

    renderUsers("/users?page=2");
    await waitFor(() => expect(deferreds.length).toBe(1));
    deferreds[0]!.resolve(
      listResp(
        [userItem({ id: "p2", username: "page2user", display_name: "Page2User" })],
        40,
      ),
    );
    expect(await screen.findByText("Page2User")).toBeTruthy();
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("搜索用户名 / 昵称"), {
      target: { value: "alice" },
    });

    // Debounce (300ms) → filter effect may load page=2+q before setPage(1) settles.
    // Wait until the clamped page=1 fetch is actually in flight (not merely ≥2 calls).
    await waitFor(
      () => {
        const last = vi.mocked(listUsers).mock.calls.at(-1)?.[0];
        expect(last?.page).toBe(1);
        expect(last?.q).toBe("alice");
      },
      { timeout: 2000 },
    );

    const page2Stale = listResp(
      [userItem({ id: "stale", username: "stale", display_name: "StalePage2" })],
      40,
    );
    const page1Fresh = listResp(
      [userItem({ id: "a1", username: "alice", display_name: "AliceHit" })],
      1,
    );

    // Resolve newest first, then an older in-flight response — table must stay on page-1 data.
    const newest = deferreds[deferreds.length - 1]!;
    newest.resolve(page1Fresh);
    expect(await screen.findByText("AliceHit")).toBeTruthy();

    for (let i = 1; i < deferreds.length - 1; i++) {
      deferreds[i]!.resolve(page2Stale);
    }
    await waitFor(() => {
      expect(screen.getByText("AliceHit")).toBeTruthy();
      expect(screen.queryByText("StalePage2")).toBeNull();
      expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();
    });
  });
});
