// @vitest-environment jsdom
/**
 * RulesPage — list GLOBAL rules, toggle 常驻/按需 via apply_mode chip,
 * create + expand-edit wiring.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  getTokens: () => ({ access_token: "a", refresh_token: "r" }),
}));

vi.mock("@/api/documents", () => ({
  listUserRules: vi.fn(),
  createRuleDocument: vi.fn(),
  getDocument: vi.fn(),
  updateDocumentApplyMode: vi.fn(),
  writeDocument: vi.fn(),
  renameDocument: vi.fn(),
  deleteDocument: vi.fn(),
  isDocumentsUnavailable: (e: unknown) =>
    e instanceof Error && e.message === "unavailable",
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import {
  createRuleDocument,
  getDocument,
  listUserRules,
  updateDocumentApplyMode,
} from "@/api/documents";
import { RulesPage } from "@/pages/RulesPage";

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  parentId: null,
  folderId: null,
  kind: "document" as const,
  role: "rule" as const,
  aiMaintained: false,
  applyMode: "always" as const,
  name: "语气规则.md",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUserRules).mockResolvedValue([]);
});

afterEach(cleanup);

describe("RulesPage", () => {
  it("uses icon-btn back + centered bar-title", async () => {
    render(<RulesPage />);
    expect(screen.getByLabelText("返回").className).toMatch(/icon-btn/);
    expect(document.querySelector(".bar-title")?.textContent).toBe("规则");
    expect(screen.queryByText("← 文件")).toBeNull();
    expect(await screen.findByText("还没有全局规则")).toBeTruthy();
  });

  it("empty state shows hint + 新建规则 CTA", async () => {
    render(<RulesPage />);
    expect(await screen.findByText("还没有全局规则")).toBeTruthy();
    expect(screen.getByText("短硬约束用常驻，长条文或偶发用按需")).toBeTruthy();
    expect(screen.getAllByText("新建规则").length).toBeGreaterThan(0);
  });

  it("lists rules with 常驻/按需 chips and toggles apply_mode", async () => {
    vi.mocked(listUserRules).mockResolvedValue([
      rule({ id: "g1", name: "语气规则.md", applyMode: "always" }),
      rule({ id: "g2", name: "偶发.md", applyMode: "on_demand" }),
    ]);
    vi.mocked(updateDocumentApplyMode).mockResolvedValue(
      rule({ id: "g1", name: "语气规则.md", applyMode: "on_demand" }),
    );

    render(<RulesPage />);
    expect(await screen.findByText("语气规则.md")).toBeTruthy();
    expect(screen.getByText("偶发.md")).toBeTruthy();
    expect(screen.getByText("常驻")).toBeTruthy();
    expect(screen.getByText("按需")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("应用方式：常驻，点击切换"));
    await waitFor(() => {
      expect(updateDocumentApplyMode).toHaveBeenCalledWith("g1", "on_demand");
    });
    expect(await screen.findByText("已设为按需")).toBeTruthy();
  });

  it("新建规则 calls createRuleDocument and shows the new row", async () => {
    vi.mocked(createRuleDocument).mockResolvedValue({
      ...rule({ id: "new", name: "新规则.md" }),
      content: "",
      version: "v1",
    });

    render(<RulesPage />);
    await screen.findByText("还没有全局规则");
    const createBtn = screen.getAllByText("新建规则")[0];
    expect(createBtn).toBeDefined();
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(createRuleDocument).toHaveBeenCalledWith("新规则.md");
    });
    expect(await screen.findByText("新规则.md")).toBeTruthy();
    expect(screen.getByText("已新建规则（默认常驻）")).toBeTruthy();
  });

  it("expanding a rule loads body via getDocument", async () => {
    vi.mocked(listUserRules).mockResolvedValue([
      rule({ id: "g1", name: "语气规则.md" }),
    ]);
    vi.mocked(getDocument).mockResolvedValue({
      ...rule({ id: "g1", name: "语气规则.md" }),
      content: "必须简洁",
      version: "v1",
    });

    render(<RulesPage />);
    fireEvent.click(await screen.findByText("语气规则.md"));
    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledWith("g1");
    });
    expect(await screen.findByDisplayValue("必须简洁")).toBeTruthy();
  });

  it("unavailable endpoint shows calm note", async () => {
    vi.mocked(listUserRules).mockRejectedValue(new Error("unavailable"));
    render(<RulesPage />);
    expect(
      await screen.findByText("规则功能暂不可用（服务端待升级）"),
    ).toBeTruthy();
  });
});
