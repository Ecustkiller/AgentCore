import {
  clearMergeLanding,
  getMergeLanding,
  resolveMergeLandingScope,
  setMergeLanding,
} from "@/lib/mergeLandingPreference";
import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
} from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const memory = new Map<string, string>();

describe("mergeLandingPreference", () => {
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
    __setUiStorageBackendForTests(null);
    __clearMemoryUiStorageForTests();
  });

  it("resolves folder scope when folderId present, else conv", () => {
    expect(resolveMergeLandingScope("c1", "f1")).toEqual({
      kind: "folder",
      folderId: "f1",
    });
    expect(resolveMergeLandingScope("c1", null)).toEqual({
      kind: "conv",
      conversationId: "c1",
    });
    expect(resolveMergeLandingScope("c1", "  ")).toEqual({
      kind: "conv",
      conversationId: "c1",
    });
  });

  it("stores and clears by scope key", () => {
    const folderScope = resolveMergeLandingScope("c1", "f1");
    const convScope = resolveMergeLandingScope("c2", null);

    setMergeLanding(folderScope, "root-a");
    setMergeLanding(convScope, "root-b");

    expect(getMergeLanding(folderScope)).toEqual({ rootId: "root-a" });
    expect(getMergeLanding(convScope)).toEqual({ rootId: "root-b" });

    // Same project folder shares landing across conversations.
    expect(getMergeLanding(resolveMergeLandingScope("c9", "f1"))).toEqual({
      rootId: "root-a",
    });

    clearMergeLanding(folderScope);
    expect(getMergeLanding(folderScope)).toBeNull();
    expect(getMergeLanding(convScope)).toEqual({ rootId: "root-b" });
  });

  it("ignores empty rootId writes", () => {
    const scope = resolveMergeLandingScope("c1", null);
    setMergeLanding(scope, "  ");
    expect(getMergeLanding(scope)).toBeNull();
  });
});
