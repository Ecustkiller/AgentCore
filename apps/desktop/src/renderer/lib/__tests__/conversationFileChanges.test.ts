import {
  conversationHasFileArtifacts,
  conversationHasRestorableEntry,
  conversationSupportsChangesTab,
  shouldBounceChangesTabToWorkspace,
  shouldIncludeChangesTurn,
  shouldPinChangesTab,
} from "@/lib/conversationFileChanges";
import type { Message } from "@/stores/conversation/types";
import { CHANGES_TAB_ID, WORKSPACE_TAB_ID } from "@/stores/sidePanel/types";
import type { ProcessStep } from "@/types/events";
import { describe, expect, it } from "vitest";

function toolStep(
  tool_name: string,
  args: Record<string, unknown>,
): ProcessStep {
  return {
    kind: "tool",
    id: `t-${tool_name}`,
    tool_name,
    arguments: args,
    result: null,
    status: "success",
  };
}

function msg(
  partial: Partial<Message> & Pick<Message, "id" | "role">,
): Message {
  return {
    content: "",
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
    ...partial,
  };
}

describe("conversationHasFileArtifacts", () => {
  it("is false when there are no assistant file ops", () => {
    expect(
      conversationHasFileArtifacts(
        [
          msg({ id: "u1", role: "user", content: "hi" }),
          msg({ id: "a1", role: "assistant", content: "ok" }),
        ],
        {},
      ),
    ).toBe(false);
  });

  it("is true when process has a successful file write", () => {
    expect(
      conversationHasFileArtifacts(
        [
          msg({
            id: "a1",
            role: "assistant",
            process: [toolStep("file_write", { path: "a.ts", content: "x" })],
          }),
        ],
        {},
      ),
    ).toBe(true);
  });
});

describe("conversationHasRestorableEntry (P0c)", () => {
  it("is true when only a Local baseline exists (no file_*)", () => {
    expect(
      conversationHasRestorableEntry(
        [
          msg({ id: "u1", role: "user", content: "hi" }),
          msg({ id: "a1", role: "assistant", content: "ran script" }),
        ],
        {},
        new Set(["a1"]),
      ),
    ).toBe(true);
  });

  it("is false when baseline ids do not match this conversation", () => {
    expect(
      conversationHasRestorableEntry(
        [msg({ id: "a1", role: "assistant", content: "ok" })],
        {},
        new Set(["other-turn"]),
      ),
    ).toBe(false);
  });
});

describe("shouldIncludeChangesTurn (P0c)", () => {
  it("includes baseline-only turns", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 0,
        messageId: "m1",
        baselineMessageIds: new Set(["m1"]),
        focusMessageId: null,
      }),
    ).toBe(true);
  });

  it("still includes file_* turns without baseline", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 2,
        messageId: "m1",
        baselineMessageIds: new Set(),
        focusMessageId: null,
      }),
    ).toBe(true);
  });

  it("skips turns with neither artifacts nor baseline nor focus", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 0,
        messageId: "m1",
        baselineMessageIds: new Set(["other"]),
        focusMessageId: null,
      }),
    ).toBe(false);
  });
});

const pinBase = {
  conversationId: "c1" as string | null,
  hasRestorableEntry: false,
  changesFocusMessageId: null as string | null,
  isChangesFloating: false,
  activeTabId: WORKSPACE_TAB_ID,
};

describe("shouldPinChangesTab (P0c)", () => {
  it("is false for drafts even with restorable / focus / float / active", () => {
    expect(
      shouldPinChangesTab({
        ...pinBase,
        conversationId: null,
        hasRestorableEntry: true,
        changesFocusMessageId: "m1",
        isChangesFloating: true,
        activeTabId: CHANGES_TAB_ID,
      }),
    ).toBe(false);
  });

  it("pins when restorable without requiring the tab to be active", () => {
    expect(
      shouldPinChangesTab({ ...pinBase, hasRestorableEntry: true }),
    ).toBe(true);
  });

  it("pins on deep-link focus", () => {
    expect(
      shouldPinChangesTab({ ...pinBase, changesFocusMessageId: "m1" }),
    ).toBe(true);
  });

  it("pins while the tab is floating", () => {
    expect(
      shouldPinChangesTab({ ...pinBase, isChangesFloating: true }),
    ).toBe(true);
  });

  it("pins when showChanges already made it the active dock tab", () => {
    expect(
      shouldPinChangesTab({ ...pinBase, activeTabId: CHANGES_TAB_ID }),
    ).toBe(true);
  });

  it("is false when nothing supports the tab", () => {
    expect(shouldPinChangesTab(pinBase)).toBe(false);
  });
});

describe("conversationSupportsChangesTab", () => {
  it("does not treat active-tab crutch as independent support", () => {
    expect(
      conversationSupportsChangesTab({
        conversationId: "c1",
        hasRestorableEntry: false,
        changesFocusMessageId: null,
        isChangesFloating: false,
      }),
    ).toBe(false);
  });
});

describe("shouldBounceChangesTabToWorkspace", () => {
  it("bounces when the new conversation cannot support 改动 and dock is still on it", () => {
    expect(
      shouldBounceChangesTabToWorkspace({
        conversationId: "c2",
        hasRestorableEntry: false,
        activeTabId: CHANGES_TAB_ID,
      }),
    ).toBe(true);
  });

  it("does not bounce when the new conversation has restorable entries", () => {
    expect(
      shouldBounceChangesTabToWorkspace({
        conversationId: "c2",
        hasRestorableEntry: true,
        activeTabId: CHANGES_TAB_ID,
      }),
    ).toBe(false);
  });

  it("does not bounce when dock is not on 改动 (empty Git-chip open stays until switch)", () => {
    expect(
      shouldBounceChangesTabToWorkspace({
        conversationId: "c1",
        hasRestorableEntry: false,
        activeTabId: WORKSPACE_TAB_ID,
      }),
    ).toBe(false);
  });

  it("bounces when leaving to a draft while on 改动", () => {
    expect(
      shouldBounceChangesTabToWorkspace({
        conversationId: null,
        hasRestorableEntry: false,
        activeTabId: CHANGES_TAB_ID,
      }),
    ).toBe(true);
  });
});
