// M-04: 登出竞态 — late FCM registration 不得把设备挂回已登出用户；
// disablePush 在 currentToken===null 时仍应用 lastToken / 持久化 token 做 unregister。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerDevice = vi.fn(async () => {});
const unregisterDevice = vi.fn(async () => {});

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();

const PushNotifications = {
  addListener: vi.fn(async (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return { remove: vi.fn(async () => {}) };
  }),
  checkPermissions: vi.fn(async () => ({ receive: "granted" as const })),
  requestPermissions: vi.fn(async () => ({ receive: "granted" as const })),
  register: vi.fn(async () => {}),
};

vi.mock("@/api/devices", () => ({
  registerDevice,
  unregisterDevice,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications,
}));

const memoryStore = new Map<string, string>();

function stubLocalStorage(): void {
  memoryStore.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memoryStore.set(k, v);
    },
    removeItem: (k: string) => {
      memoryStore.delete(k);
    },
  });
}

async function loadPush() {
  vi.resetModules();
  listeners.clear();
  registerDevice.mockClear();
  unregisterDevice.mockClear();
  PushNotifications.addListener.mockClear();
  PushNotifications.checkPermissions.mockClear();
  PushNotifications.requestPermissions.mockClear();
  PushNotifications.register.mockClear();
  // Re-bind mocks after resetModules (factories re-run, but our vi.fn refs stay).
  vi.doMock("@/api/devices", () => ({
    registerDevice,
    unregisterDevice,
  }));
  vi.doMock("@capacitor/core", () => ({
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    },
  }));
  vi.doMock("@capacitor/push-notifications", () => ({
    PushNotifications,
  }));
  return import("../push");
}

beforeEach(() => {
  vi.stubEnv("VITE_PUSH_ENABLED", "true");
  stubLocalStorage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("push M-04 logout ↔ registration race", () => {
  it("late registration after logout does not POST registerDevice", async () => {
    const { initPush, enablePush, disablePush } = await loadPush();
    await initPush(() => {});
    await enablePush();
    await disablePush();

    expect(unregisterDevice).not.toHaveBeenCalled();

    listeners.get("registration")?.({ value: "tok-late" });
    await Promise.resolve();
    await Promise.resolve();

    expect(registerDevice).not.toHaveBeenCalled();
    expect(unregisterDevice).not.toHaveBeenCalled();
  });

  it("disablePush with null currentToken still DELETEs persisted last token", async () => {
    const { initPush, enablePush } = await loadPush();
    await initPush(() => {});
    await enablePush();

    listeners.get("registration")?.({ value: "tok-persisted" });
    await vi.waitFor(() =>
      expect(registerDevice).toHaveBeenCalledWith("tok-persisted", "android"),
    );

    // Simulate process restart: new module, currentToken gone, last token on disk.
    const again = await loadPush();
    await again.initPush(() => {});
    await again.disablePush();

    expect(unregisterDevice).toHaveBeenCalledWith("tok-persisted");
    expect(memoryStore.has("agentcore.push.lastToken")).toBe(false);
  });

  it("login then quick logout: in-flight registerDevice is compensated by unregister", async () => {
    let finishRegister!: () => void;
    const gate = new Promise<void>((r) => {
      finishRegister = r;
    });
    registerDevice.mockImplementationOnce(async () => {
      await gate;
    });

    const { initPush, enablePush, disablePush } = await loadPush();
    await initPush(() => {});
    await enablePush();

    listeners.get("registration")?.({ value: "tok-inflight" });
    // Let the async registerIfStillDesired start and hit the gate.
    await Promise.resolve();
    await Promise.resolve();

    const disableDone = disablePush();
    finishRegister();
    await disableDone;
    await vi.waitFor(() =>
      expect(unregisterDevice).toHaveBeenCalledWith("tok-inflight"),
    );

    expect(registerDevice).toHaveBeenCalledWith("tok-inflight", "android");
  });
});
