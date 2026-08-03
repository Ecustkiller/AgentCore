import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useConversations", () => ({
  patchConversationCache: vi.fn(),
}));

vi.mock("@/services/conversations", () => ({
  requestAutoTitle: vi.fn(),
}));

vi.mock("@/services/sidecarRouting", () => ({
  resolveSidecarRoot: vi.fn(),
}));

import { patchConversationCache } from "@/hooks/useConversations";
import { requestAutoTitle } from "@/services/conversations";
import { resolveSidecarRoot } from "@/services/sidecarRouting";
import { scheduleLocalAutoTitle } from "../useComposerSend";

const resolveRoot = vi.mocked(resolveSidecarRoot);
const autoTitle = vi.mocked(requestAutoTitle);
const patchCache = vi.mocked(patchConversationCache);

beforeEach(() => {
  resolveRoot.mockReset();
  autoTitle.mockReset();
  patchCache.mockReset();
});

describe("scheduleLocalAutoTitle", () => {
  it("mints and patches when the conversation routes to sidecar", async () => {
    resolveRoot.mockResolvedValueOnce({
      rootId: "r1",
      subpath: "conversations/c1",
    });
    autoTitle.mockResolvedValueOnce("周报提纲");

    scheduleLocalAutoTitle("c1", "帮我写周报");
    await vi.waitFor(() => {
      expect(autoTitle).toHaveBeenCalledWith("c1", "帮我写周报");
      expect(patchCache).toHaveBeenCalledWith("c1", { title: "周报提纲" });
    });
  });

  it("skips mint when the conversation would stay on cloud", async () => {
    resolveRoot.mockResolvedValueOnce(null);

    scheduleLocalAutoTitle("c1", "帮我写周报");
    await Promise.resolve();
    await Promise.resolve();

    expect(autoTitle).not.toHaveBeenCalled();
    expect(patchCache).not.toHaveBeenCalled();
  });

  it("does not patch when mint returns null", async () => {
    resolveRoot.mockResolvedValueOnce({ rootId: "r1", subpath: "" });
    autoTitle.mockResolvedValueOnce(null);

    scheduleLocalAutoTitle("c1", "hi");
    await vi.waitFor(() => {
      expect(autoTitle).toHaveBeenCalled();
    });
    expect(patchCache).not.toHaveBeenCalled();
  });
});
