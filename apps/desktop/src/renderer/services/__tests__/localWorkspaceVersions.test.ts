// @vitest-environment jsdom

import {
  LocalVersionError,
  createLocalVersion,
  deleteLocalVersion,
  listLocalVersions,
  restoreLocalVersion,
} from "@/services/localWorkspaceVersions";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本地命名版本 service：两条 IPC 分工 —— 创建 / 恢复走 sidecar（zip/unzip 只在 Python
 * 侧一份），列举 / 删除走更轻的 fsApi。失败一律抛出（用户显式动作，不静默）。
 */

const listWorkspaceVersions = vi.fn();
const deleteWorkspaceVersion = vi.fn();
const createWorkspaceVersion = vi.fn();
const restoreWorkspaceVersion = vi.fn();

const TARGET = { rootId: "r1", subpath: "conversations/c1" };

beforeEach(() => {
  listWorkspaceVersions.mockReset();
  deleteWorkspaceVersion.mockReset();
  createWorkspaceVersion.mockReset();
  restoreWorkspaceVersion.mockReset();
  window.fsApi = {
    listWorkspaceVersions,
    deleteWorkspaceVersion,
  } as unknown as typeof window.fsApi;
  window.sidecarApi = {
    createWorkspaceVersion,
    restoreWorkspaceVersion,
  } as unknown as typeof window.sidecarApi;
});

describe("listLocalVersions", () => {
  it("passes rootId + subpath through and returns the entries", async () => {
    listWorkspaceVersions.mockResolvedValue({
      ok: true,
      data: [
        {
          versionId: "20260202T000000Z-bbbbbbbb",
          name: "第二版",
          createdAt: "2026-02-02T00:00:00+00:00",
          sizeBytes: 42,
        },
      ],
    });
    await expect(listLocalVersions(TARGET)).resolves.toEqual([
      {
        versionId: "20260202T000000Z-bbbbbbbb",
        name: "第二版",
        createdAt: "2026-02-02T00:00:00+00:00",
        sizeBytes: 42,
      },
    ]);
    expect(listWorkspaceVersions).toHaveBeenCalledWith(
      "r1",
      "conversations/c1",
    );
  });

  it("defaults a missing subpath to the root itself", async () => {
    listWorkspaceVersions.mockResolvedValue({ ok: true, data: [] });
    await listLocalVersions({ rootId: "r1" });
    expect(listWorkspaceVersions).toHaveBeenCalledWith("r1", "");
  });

  it("throws with the fs code instead of showing an unreadable zone as empty", async () => {
    listWorkspaceVersions.mockResolvedValue({
      ok: false,
      reason: "读取版本区失败",
      code: "denied",
    });
    await expect(listLocalVersions(TARGET)).rejects.toBeInstanceOf(
      LocalVersionError,
    );
    await expect(listLocalVersions(TARGET)).rejects.toMatchObject({
      code: "denied",
    });
  });
});

describe("createLocalVersion", () => {
  it("goes through sidecar and maps the snake_case wire shape", async () => {
    createWorkspaceVersion.mockResolvedValue({
      version_id: "20260814T010203Z-a1b2c3d4",
      name: "发布前",
      created_at: "2026-08-14T01:02:03+00:00",
      size_bytes: 1024,
    });
    await expect(createLocalVersion(TARGET, "发布前")).resolves.toEqual({
      versionId: "20260814T010203Z-a1b2c3d4",
      name: "发布前",
      createdAt: "2026-08-14T01:02:03+00:00",
      sizeBytes: 1024,
    });
    expect(createWorkspaceVersion).toHaveBeenCalledWith({
      rootId: "r1",
      subpath: "conversations/c1",
      name: "发布前",
    });
    expect(listWorkspaceVersions).not.toHaveBeenCalled();
  });

  it("propagates a sidecar failure (never a silent fake success)", async () => {
    createWorkspaceVersion.mockRejectedValue(
      new Error("工作区过大，无法留版本"),
    );
    await expect(createLocalVersion(TARGET, "发布前")).rejects.toThrow(
      "工作区过大",
    );
  });
});

describe("restoreLocalVersion", () => {
  it("goes through sidecar with the version id", async () => {
    restoreWorkspaceVersion.mockResolvedValue({
      version_id: "20260814T010203Z-a1b2c3d4",
      name: "发布前",
      created_at: "2026-08-14T01:02:03+00:00",
      size_bytes: 1024,
    });
    const restored = await restoreLocalVersion(
      TARGET,
      "20260814T010203Z-a1b2c3d4",
    );
    expect(restored.name).toBe("发布前");
    expect(restoreWorkspaceVersion).toHaveBeenCalledWith({
      rootId: "r1",
      subpath: "conversations/c1",
      versionId: "20260814T010203Z-a1b2c3d4",
    });
  });

  it("propagates a sidecar failure", async () => {
    restoreWorkspaceVersion.mockRejectedValue(
      new Error("workspace version not found"),
    );
    await expect(restoreLocalVersion(TARGET, "nope")).rejects.toThrow(
      "not found",
    );
  });
});

describe("deleteLocalVersion", () => {
  it("goes through the lighter fs IPC", async () => {
    deleteWorkspaceVersion.mockResolvedValue({ ok: true, data: undefined });
    await deleteLocalVersion(TARGET, "20260814T010203Z-a1b2c3d4");
    expect(deleteWorkspaceVersion).toHaveBeenCalledWith(
      "r1",
      "conversations/c1",
      "20260814T010203Z-a1b2c3d4",
    );
  });

  it("throws with the fs code on failure", async () => {
    deleteWorkspaceVersion.mockResolvedValue({
      ok: false,
      reason: "版本不存在",
      code: "not_found",
    });
    await expect(
      deleteLocalVersion(TARGET, "20260814T010203Z-a1b2c3d4"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
