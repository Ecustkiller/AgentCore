// @vitest-environment jsdom
/**
 * 全局设定：只验详情顶栏同构（icon-btn 返回 + bar-title），不改表单逻辑。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  getTokens: () => ({ access_token: "a", refresh_token: "r" }),
}));

vi.mock("@/api/memory", () => ({
  listMemoryUpdates: vi.fn(async () => []),
  listMemoryTopics: vi.fn(async () => []),
  getMemoryFile: vi.fn(async () => ({ content: "", version: "v1" })),
  writeMemoryFile: vi.fn(),
  writeMemoryTopic: vi.fn(),
  getMemoryTopic: vi.fn(),
  isFeatureUnavailable: () => false,
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigate,
    useLocation: () => ({ hash: "" }),
  };
});

import { MemoryPage } from "@/pages/MemoryPage";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("MemoryPage", () => {
  it("uses icon-btn back + centered bar-title", async () => {
    render(<MemoryPage />);
    expect(screen.getByLabelText("返回").className).toMatch(/icon-btn/);
    expect(document.querySelector(".bar-title")?.textContent).toBe("全局设定");
    expect(screen.queryByText("← 文件")).toBeNull();
    expect(await screen.findByText(/还没有记忆更新/)).toBeTruthy();
  });
});
