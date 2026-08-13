import {
  FILE_NOT_IN_CLOUD_TREE,
  LOCAL_WORKSPACE_MOBILE_HINT,
  workspaceFileDownloadError,
} from "@/lib/fileDownloadError";
import { describe, expect, it } from "vitest";

describe("workspaceFileDownloadError", () => {
  it("maps 404/409 to actionable copy", () => {
    expect(workspaceFileDownloadError(404)).toMatch(/云端工作区没有这个文件/);
    expect(workspaceFileDownloadError(404, { scope: "workspace" })).toMatch(
      /别的文件夹桌/,
    );
    expect(workspaceFileDownloadError(409)).toMatch(/仅桌面端可打开/);
    expect(workspaceFileDownloadError(500)).toBe("下载文件失败 (500)");
  });

  it("exports stable deep-link / local hints", () => {
    expect(FILE_NOT_IN_CLOUD_TREE).toMatch(/云端工作区暂无此文件/);
    expect(LOCAL_WORKSPACE_MOBILE_HINT).toMatch(/本机文件夹/);
  });
});
