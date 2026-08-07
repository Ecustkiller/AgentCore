// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatGrantOrganizeFolderAnswer,
  pickAndGrantOrganizeFolder,
} from "../grantOrganizeFolder";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: vi.fn(() => true),
}));

vi.mock("@/lib/revokeExternalGrant", () => ({
  revokeExternalGrant: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  api: {
    post: vi.fn(),
  },
}));

describe("formatGrantOrganizeFolderAnswer", () => {
  it("mentions organize session scope without absolute paths", () => {
    const text = formatGrantOrganizeFolderAnswer(
      "允许整理",
      "桌面 › 咨询",
      "external/咨询",
    );
    expect(text).toContain("可移动");
    expect(text).toContain("仅本次对话");
    expect(text).toContain("可撤销");
    expect(text).toContain("external/咨询");
    expect(text).not.toMatch(/^[A-Za-z]:\\/);
  });
});

describe("pickAndGrantOrganizeFolder", () => {
  beforeEach(async () => {
    const { api } = await import("@/services/api");
    vi.mocked(api.post).mockReset();
    window.fsApi = {
      grantSessionReadonlyRoot: vi.fn(),
    } as unknown as typeof window.fsApi;
  });

  it("always requests mode=organize (readonly→write still goes through this confirm path)", async () => {
    const { api } = await import("@/services/api");
    vi.mocked(window.fsApi.grantSessionReadonlyRoot).mockResolvedValue({
      ok: true,
      root: { id: "r1", name: "咨询", alias: "咨询", mode: "organize" },
      displayLabel: "桌面 › 咨询",
    });
    vi.mocked(api.post).mockResolvedValue({
      grant: { alias: "咨询", namespace: "external/咨询" },
    });

    const result = await pickAndGrantOrganizeFolder("conv-1", {
      wellKnown: "desktop",
      targetName: "咨询",
    });

    expect(window.fsApi.grantSessionReadonlyRoot).toHaveBeenCalledWith({
      conversationId: "conv-1",
      mode: "organize",
      wellKnown: "desktop",
      targetName: "咨询",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/workspace/external-grants",
      expect.objectContaining({ mode: "organize" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayLabel).toBe("桌面 › 咨询");
  });

  it("maps not_found without picker/cancel", async () => {
    vi.mocked(window.fsApi.grantSessionReadonlyRoot).mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
    const result = await pickAndGrantOrganizeFolder("conv-1", {
      wellKnown: "desktop",
      targetName: "失踪",
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
  });
});
