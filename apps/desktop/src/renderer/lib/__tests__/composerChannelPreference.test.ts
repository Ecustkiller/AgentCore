import {
  getComposerChannelPreference,
  setComposerChannelPreference,
} from "@/lib/composerChannelPreference";
import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
  uiStorageKey,
} from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const memory = new Map<string, string>();

describe("composerChannelPreference", () => {
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

  it("defaults to cloud when unset", () => {
    expect(getComposerChannelPreference()).toBe("cloud");
  });

  it("persists cloud and local_traditional", () => {
    setComposerChannelPreference("local_traditional");
    expect(getComposerChannelPreference()).toBe("local_traditional");

    setComposerChannelPreference("cloud");
    expect(getComposerChannelPreference()).toBe("cloud");
  });

  it("treats corrupt storage as cloud default", () => {
    memory.set(uiStorageKey("composer-channel"), JSON.stringify("nope"));
    expect(getComposerChannelPreference()).toBe("cloud");

    memory.set(uiStorageKey("composer-channel"), "not-json");
    expect(getComposerChannelPreference()).toBe("cloud");
  });
});
