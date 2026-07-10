import { describe, expect, it } from "vitest";
import {
  deriveGroupWorkspaceIsLocal,
  isConversationLocal,
  shouldShowConversationCloudIcon,
} from "../conversationWorkspaceMode";

describe("conversationWorkspaceMode", () => {
  it("isConversationLocal follows localContainerRootId", () => {
    expect(isConversationLocal({ localContainerRootId: null })).toBe(false);
    expect(isConversationLocal({ localContainerRootId: "root-1" })).toBe(true);
    expect(isConversationLocal({})).toBe(false);
  });

  it("deriveGroupWorkspaceIsLocal prefers folder.localDir", () => {
    expect(
      deriveGroupWorkspaceIsLocal(
        { localDir: "/home/proj" },
        [{ localContainerRootId: null }],
      ),
    ).toBe(true);
  });

  it("deriveGroupWorkspaceIsLocal uses majority of conversations", () => {
    const folder = { localDir: null };
    expect(
      deriveGroupWorkspaceIsLocal(folder, [
        { localContainerRootId: "a" },
        { localContainerRootId: "b" },
        { localContainerRootId: null },
      ]),
    ).toBe(true);
    expect(
      deriveGroupWorkspaceIsLocal(folder, [
        { localContainerRootId: null },
        { localContainerRootId: null },
        { localContainerRootId: "a" },
      ]),
    ).toBe(false);
  });

  it("deriveGroupWorkspaceIsLocal breaks ties on most recent conv", () => {
    expect(
      deriveGroupWorkspaceIsLocal(
        { localDir: null },
        [
          { localContainerRootId: "a" },
          { localContainerRootId: null },
        ],
      ),
    ).toBe(true);
  });

  it("shouldShowConversationCloudIcon for bare and grouped rows", () => {
    const cloud = { localContainerRootId: null };
    const local = { localContainerRootId: "root" };

    expect(shouldShowConversationCloudIcon(cloud)).toBe(true);
    expect(shouldShowConversationCloudIcon(local)).toBe(false);

    expect(shouldShowConversationCloudIcon(local, true)).toBe(false);
    expect(shouldShowConversationCloudIcon(cloud, true)).toBe(true);
    expect(shouldShowConversationCloudIcon(local, false)).toBe(false);
    expect(shouldShowConversationCloudIcon(cloud, false)).toBe(false);
  });
});
