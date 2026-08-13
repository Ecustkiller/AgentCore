// @vitest-environment jsdom
import { ImportToCloudCancelledError } from "@/lib/importToCloud";
import { startImportToCloudJob } from "@/lib/importToCloudJob";
import { openDraftConversation } from "@/lib/newConversation";
import { useImportToCloudJobStore } from "@/stores/importToCloudJob";
import type { FsRoot } from "@shared/ipc-contract";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/importToCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/importToCloud")>();
  return {
    ...actual,
    runImportToCloud: vi.fn(),
  };
});

vi.mock("@/lib/newConversation", () => ({
  openDraftConversation: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
}));

const root = { id: "root-1" } as FsRoot;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startImportToCloudJob toasts", () => {
  beforeEach(() => {
    useImportToCloudJobStore.setState({
      running: false,
      controller: null,
    });
    vi.clearAllMocks();
  });

  it("progress toast keeps cancel action", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockImplementation(() => new Promise(() => {}));
    expect(
      startImportToCloudJob({
        root,
        ownsRoot: true,
        folderName: "Demo",
      }),
    ).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({ label: "取消" }),
        duration: Number.POSITIVE_INFINITY,
      }),
    );
  });

  it("success toast has 打开; auto-dismiss 5s; click opens draft; no auto jump", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockResolvedValue({
      folderId: "f-cloud",
      folderName: "Demo",
      wsId: "folder:f-cloud",
      uploaded: 2,
      skippedOversized: [],
      archiveTruncated: false,
      partial: false,
    });
    window.location.hash = "#/conversations/stay-here";
    startImportToCloudJob({
      root,
      ownsRoot: true,
      folderName: "Demo",
    });
    await flush();
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Demo"),
      expect.objectContaining({
        duration: 5_000,
        action: expect.objectContaining({ label: "打开" }),
      }),
    );
    expect(window.location.hash).toBe("#/conversations/stay-here");
    expect(openDraftConversation).not.toHaveBeenCalled();

    const successCall = vi.mocked(toast.success).mock.calls[0];
    expect(successCall).toBeTruthy();
    if (!successCall) return;
    const opts = successCall[1] as unknown as {
      action: { onClick: () => void };
    };
    opts.action.onClick();
    expect(openDraftConversation).toHaveBeenCalledWith("f-cloud");
  });

  it("partial success uses longer duration", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockResolvedValue({
      folderId: "f-part",
      folderName: "Part",
      wsId: "folder:f-part",
      uploaded: 1,
      skippedOversized: ["big.bin"],
      archiveTruncated: false,
      partial: true,
    });
    startImportToCloudJob({
      root,
      ownsRoot: true,
      folderName: "Part",
    });
    await flush();
    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        duration: 8_000,
        action: expect.objectContaining({ label: "打开" }),
      }),
    );
  });

  it("cancel warning with folderId also offers 打开", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockRejectedValue(
      new ImportToCloudCancelledError({
        folderId: "f-keep",
        folderName: "Partial",
      }),
    );
    startImportToCloudJob({
      root,
      ownsRoot: true,
      folderName: "Partial",
    });
    await flush();
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("Partial"),
      expect.objectContaining({
        duration: 8_000,
        action: expect.objectContaining({ label: "打开" }),
      }),
    );
    const warningCall = vi.mocked(toast.warning).mock.calls[0];
    expect(warningCall).toBeTruthy();
    if (!warningCall) return;
    const opts = warningCall[1] as unknown as {
      action: { onClick: () => void };
    };
    opts.action.onClick();
    expect(openDraftConversation).toHaveBeenCalledWith("f-keep");
  });

  it("cancel without folder clears action and auto-dismisses", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockRejectedValue(
      new ImportToCloudCancelledError(),
    );
    startImportToCloudJob({
      root,
      ownsRoot: true,
      folderName: "Demo",
    });
    await flush();
    expect(toast).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        duration: 3_000,
        action: undefined,
      }),
    );
  });

  it("error toast clears cancel action and auto-dismisses", async () => {
    const { runImportToCloud } = await import("@/lib/importToCloud");
    vi.mocked(runImportToCloud).mockRejectedValue(new Error("network down"));
    startImportToCloudJob({
      root,
      ownsRoot: true,
      folderName: "Demo",
    });
    await flush();
    expect(toast.error).toHaveBeenCalledWith(
      "导入到「我的文件」失败",
      expect.objectContaining({
        duration: 8_000,
        action: undefined,
        description: "network down",
      }),
    );
  });
});
