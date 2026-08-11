import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
  uiGet,
  uiSet,
  uiStorageKey,
} from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSidecarPreference, parseSidecarPreference } from "../ui";

const SIDECAR_KEY = "sidecar-enabled";
const SIDECAR_OFF_CLEARED_KEY = "sidecar-off-cleared-v1";

const memory = new Map<string, string>();

describe("parseSidecarPreference", () => {
  it("三态字符串", () => {
    expect(parseSidecarPreference("on")).toBe("on");
    expect(parseSidecarPreference("off")).toBe("off");
    expect(parseSidecarPreference(undefined)).toBe("unset");
    expect(parseSidecarPreference("maybe")).toBe("unset");
  });

  it("兼容毕业前 boolean：false=显式关，true=显式开", () => {
    expect(parseSidecarPreference(false)).toBe("off");
    expect(parseSidecarPreference(true)).toBe("on");
  });
});

describe("loadSidecarPreference 一次性 off→unset 迁移", () => {
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

  it("历史 off 加载后变 unset 且写 flag", () => {
    uiSet(SIDECAR_KEY, "off");
    expect(loadSidecarPreference()).toBe("unset");
    expect(uiGet(SIDECAR_KEY)).toBeUndefined();
    expect(memory.has(uiStorageKey(SIDECAR_KEY))).toBe(false);
    expect(uiGet<boolean>(SIDECAR_OFF_CLEARED_KEY)).toBe(true);
  });

  it("旧 boolean false 经 parse 成 off 后同样清成 unset", () => {
    uiSet(SIDECAR_KEY, false);
    expect(loadSidecarPreference()).toBe("unset");
    expect(uiGet(SIDECAR_KEY)).toBeUndefined();
    expect(uiGet<boolean>(SIDECAR_OFF_CLEARED_KEY)).toBe(true);
  });

  it("on / unset 也写 flag，但不改偏好", () => {
    uiSet(SIDECAR_KEY, "on");
    expect(loadSidecarPreference()).toBe("on");
    expect(uiGet(SIDECAR_KEY)).toBe("on");
    expect(uiGet<boolean>(SIDECAR_OFF_CLEARED_KEY)).toBe(true);

    memory.clear();
    expect(loadSidecarPreference()).toBe("unset");
    expect(uiGet<boolean>(SIDECAR_OFF_CLEARED_KEY)).toBe(true);
  });

  it("flag 已写后，再次显式 off 不被二次清掉", () => {
    uiSet(SIDECAR_OFF_CLEARED_KEY, true);
    uiSet(SIDECAR_KEY, "off");
    expect(loadSidecarPreference()).toBe("off");
    expect(uiGet(SIDECAR_KEY)).toBe("off");
  });
});
