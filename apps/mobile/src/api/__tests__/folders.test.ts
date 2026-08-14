import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { listCloudFolders, listFolders, renameFolder } from "../folders";

describe("folders API", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("lists folders and keeps only cloud ones for the mobile picker", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "c1", name: "云桌", mode: "cloud" },
        { id: "l1", name: "本机仓", mode: "local", local_root_id: "r" },
      ],
    });
    await expect(listFolders()).resolves.toHaveLength(2);
    await expect(listCloudFolders()).resolves.toEqual([
      expect.objectContaining({ id: "c1", mode: "cloud" }),
    ]);
    expect(apiFetch).toHaveBeenCalledWith("/v1/folders");
  });

  it("renames via PATCH and surfaces the server message on failure", async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "c1", name: "新名", mode: "cloud" }),
    });
    await expect(renameFolder("c1", "新名")).resolves.toEqual(
      expect.objectContaining({ name: "新名" }),
    );
    expect(apiFetch).toHaveBeenCalledWith("/v1/folders/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新名" }),
    });

    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: "工作区正忙" } }),
    });
    await expect(renameFolder("c1", "x")).rejects.toThrow("工作区正忙");
  });
});
