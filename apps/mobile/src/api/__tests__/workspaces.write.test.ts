import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  createWorkspaceDirByWs,
  deleteWorkspaceEntryByWs,
  listWorkspaceTrashByWs,
  moveWorkspaceEntryByWs,
  readWorkspaceFileForEditByWs,
  restoreWorkspaceTrashByWs,
  writeWorkspaceFileTextByWs,
} from "../workspaces";

const WS = "folder:f1";

describe("cloud workspace writes (by ws_id)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
  });

  it("move posts src/dst to the workspace move endpoint", async () => {
    await moveWorkspaceEntryByWs(WS, "docs/a.md", "archive/a.md");
    expect(apiFetch).toHaveBeenCalledWith("/v1/workspaces/folder%3Af1/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: "docs/a.md", dst: "archive/a.md" }),
    });
  });

  it("delete targets the file path with segments encoded", async () => {
    await deleteWorkspaceEntryByWs(WS, "文档/a b.md");
    expect(apiFetch).toHaveBeenCalledWith(
      `/v1/workspaces/folder%3Af1/files/${encodeURIComponent("文档")}/a%20b.md`,
      { method: "DELETE" },
    );
  });

  it("createDir posts the path", async () => {
    await createWorkspaceDirByWs(WS, "docs/新建");
    expect(apiFetch).toHaveBeenCalledWith("/v1/workspaces/folder%3Af1/dirs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "docs/新建" }),
    });
  });

  it("readForEdit maps the wire doc to the camelCase CAS baseline", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: "hi", mtime_ms: 1710, eol: "crlf" }),
    });
    await expect(
      readWorkspaceFileForEditByWs(WS, "docs/a.md"),
    ).resolves.toEqual({ text: "hi", mtimeMs: 1710, eol: "crlf" });
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/workspaces/folder%3Af1/edit/docs/a.md",
    );
  });

  it("writeText sends the baseline mtime as the CAS precondition", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, mtime_ms: 1800, conflict: false }),
    });
    await expect(
      writeWorkspaceFileTextByWs(WS, "docs/a.md", {
        content: "next",
        baselineMtimeMs: 1710,
        eol: "lf",
      }),
    ).resolves.toEqual({ ok: true, mtimeMs: 1800, conflict: false });
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/workspaces/folder%3Af1/edit/docs/a.md",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "next",
          baseline_mtime_ms: 1710,
          eol: "lf",
        }),
      },
    );
  });

  it("a conflict is reported, not thrown — the caller has to decide", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, mtime_ms: 1900, conflict: true }),
    });
    await expect(
      writeWorkspaceFileTextByWs(WS, "docs/a.md", {
        content: "mine",
        baselineMtimeMs: 1710,
        eol: "lf",
      }),
    ).resolves.toEqual({ ok: false, mtimeMs: 1900, conflict: true });
  });

  it("surfaces the backend's own refusal message", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: { message: "已存在同名文件" } }),
    });
    await expect(moveWorkspaceEntryByWs(WS, "a.md", "b.md")).rejects.toThrow(
      "已存在同名文件",
    );
  });

  it("falls back to the status code when the body is not JSON", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(deleteWorkspaceEntryByWs(WS, "a.md")).rejects.toThrow(
      "删除失败 (409)",
    );
  });
});

describe("workspace trash (by ws_id)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("lists the same soft-delete zone the chat file page restores from", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            entry_id: "e1",
            original_path: "docs/a.md",
            name: "a.md",
            is_dir: false,
            deleted_at: "2026-08-01T00:00:00Z",
          },
        ],
        retention_days: 30,
        total: 1,
      }),
    });
    await expect(listWorkspaceTrashByWs(WS)).resolves.toEqual({
      entries: [
        {
          entryId: "e1",
          originalPath: "docs/a.md",
          name: "a.md",
          isDir: false,
          deletedAt: "2026-08-01T00:00:00Z",
        },
      ],
      retentionDays: 30,
    });
    expect(apiFetch).toHaveBeenCalledWith("/v1/workspaces/folder%3Af1/trash");
  });

  it("restores one entry by id", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(restoreWorkspaceTrashByWs(WS, "e1")).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/workspaces/folder%3Af1/trash/e1/restore",
      { method: "POST" },
    );
  });
});
