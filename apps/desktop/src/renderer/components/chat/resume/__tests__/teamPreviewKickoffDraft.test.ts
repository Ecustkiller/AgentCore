import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
  conversationUiGet,
} from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTeamPreviewKickoffDraft,
  loadTeamPreviewKickoffDraft,
  persistTeamPreviewKickoffDraft,
} from "../teamPreviewKickoffDraft";

const CID = "c-draft";
const CP = "cp-draft";
const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  __setUiStorageBackendForTests({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
    keys: () => [...memory.keys()],
  });
});

afterEach(() => {
  clearTeamPreviewKickoffDraft(CID, CP);
  __setUiStorageBackendForTests(null);
  __clearMemoryUiStorageForTests();
});

describe("teamPreviewKickoffDraft", () => {
  it("调整态空意见也会落盘，重载仍在调整态", () => {
    persistTeamPreviewKickoffDraft(CID, CP, {
      mode: "adjust",
      continueNote: "",
      adjustNote: "",
    });
    expect(loadTeamPreviewKickoffDraft(CID, CP)).toEqual({
      mode: "adjust",
      continueNote: "",
      adjustNote: "",
    });
  });

  it("确认态空草稿不占存储", () => {
    persistTeamPreviewKickoffDraft(CID, CP, {
      mode: "confirm",
      continueNote: "  ",
      adjustNote: "",
    });
    expect(conversationUiGet(CID, `kickoff-draft:${CP}`)).toBeUndefined();
    expect(loadTeamPreviewKickoffDraft(CID, CP).mode).toBe("confirm");
  });
});
