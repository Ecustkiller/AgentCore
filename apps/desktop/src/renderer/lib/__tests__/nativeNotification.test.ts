// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyShellPresenceSnapshot,
  isShellPresent,
  openFloatConversationIds,
  readDomShellPresent,
} from "../nativeNotification";

vi.mock("@/lib/capabilities", () => ({
  hasNativeNotification: vi.fn(() => false),
  isNativeRuntime: vi.fn(() => false),
  isWebRuntime: vi.fn(() => true),
}));

describe("readDomShellPresent", () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const originalHasFocus = document.hasFocus;

  beforeEach(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.hasFocus = () => true;
  });

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(document, "hidden", originalHidden);
    }
    document.hasFocus = originalHasFocus;
    applyShellPresenceSnapshot(null);
  });

  it("is present when the document is focused and visible", () => {
    expect(readDomShellPresent()).toBe(true);
    expect(isShellPresent()).toBe(true);
  });

  it("is away when the document is hidden", () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    expect(isShellPresent()).toBe(false);
  });

  it("is away when the document is visible but not focused", () => {
    document.hasFocus = () => false;
    expect(isShellPresent()).toBe(false);
  });
});

describe("openFloatConversationIds", () => {
  afterEach(() => applyShellPresenceSnapshot(null));

  it("reads ids from the main-process snapshot", () => {
    applyShellPresenceSnapshot({
      present: true,
      floatConversationIds: ["c1"],
    });
    expect(openFloatConversationIds()).toEqual(["c1"]);
  });
});
