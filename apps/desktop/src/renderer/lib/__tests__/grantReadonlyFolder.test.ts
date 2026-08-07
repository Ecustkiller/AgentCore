// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatGrantReadonlyFolderAnswer,
  pickAndGrantReadonlyFolder,
} from "../grantReadonlyFolder";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: vi.fn(() => true),
}));

vi.mock("@/lib/revokeExternalGrant", () => ({
  revokeExternalGrant: vi.fn(),
}));

vi.mock("@/services/externalGrants", () => ({
  invalidateExternalGrants: vi.fn(),
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

describe("formatGrantReadonlyFolderAnswer", () => {
  it("mentions readonly session scope without absolute paths", () => {
    const text = formatGrantReadonlyFolderAnswer(
      "授权只读访问",
      "6月报表",
      "external/6月报表",
    );
    expect(text).toContain("只读");
    expect(text).toContain("仅本次对话");
    expect(text).toContain("可撤销");
    expect(text).toContain("external/6月报表");
    expect(text).not.toMatch(/^[A-Za-z]:\\/);
  });
});

describe("pickAndGrantReadonlyFolder resolve failures", () => {
  beforeEach(() => {
    window.fsApi = {
      grantSessionReadonlyRoot: vi.fn(),
    } as unknown as typeof window.fsApi;
  });

  it("maps not_found (≠ cancelled)", async () => {
    vi.mocked(window.fsApi.grantSessionReadonlyRoot).mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
    const result = await pickAndGrantReadonlyFolder("conv-1", {
      wellKnown: "desktop",
      targetName: "失踪",
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
  });

  it("maps not_directory when path hits a file", async () => {
    vi.mocked(window.fsApi.grantSessionReadonlyRoot).mockResolvedValue({
      ok: false,
      reason: "not_directory",
      message: "路径指向的是文件，不是目录",
    });
    const result = await pickAndGrantReadonlyFolder("conv-1", {
      path: "C:\\tmp\\file.txt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_directory");
  });

  it("blank hints still invoke IPC and surface not_found (no silent cancel)", async () => {
    vi.mocked(window.fsApi.grantSessionReadonlyRoot).mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
    const result = await pickAndGrantReadonlyFolder("conv-1");
    expect(window.fsApi.grantSessionReadonlyRoot).toHaveBeenCalledWith({
      conversationId: "conv-1",
      mode: "readonly",
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });
  });
});
