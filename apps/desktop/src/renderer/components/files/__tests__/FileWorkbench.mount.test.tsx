import { FileWorkbench } from "@/components/files/FileWorkbench";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { useConversationStore } from "@/stores/conversation";
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSharedSpaces", () => ({
  useSharedSpaces: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => [],
  getConversations: () => [],
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => [],
  getFolders: () => [],
}));

vi.mock("@/components/files/sharedSpaces/PendingSharedInvites", () => ({
  PendingSharedInvites: () => null,
}));

describe("FileWorkbench mount", () => {
  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: null });
  });

  afterEach(cleanup);

  it("does not invalidate workspace list on open", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <FileWorkbench
        workspaces={[]}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
        fsAvailable={false}
      />,
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: workspaceKeys.list }),
    );
    spy.mockRestore();
  });
});
