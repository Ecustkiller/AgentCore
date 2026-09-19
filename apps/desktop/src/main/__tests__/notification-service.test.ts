import { beforeEach, describe, expect, it, vi } from "vitest";

const showMock = vi.fn();
const notificationHandlers: Record<string, () => void> = {};
const notificationOpts: Record<string, unknown>[] = [];
const mainSend = vi.fn();
const mainRestore = vi.fn();
const mainFocus = vi.fn();
const mainShow = vi.fn();

const notificationInstances: Array<{
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("electron", () => ({
  Notification: class {
    static isSupported = () => true;
    close = vi.fn();
    constructor(opts: Record<string, unknown>) {
      notificationOpts.push(opts);
      notificationInstances.push(
        this as unknown as { close: ReturnType<typeof vi.fn> },
      );
    }
    on(event: string, cb: () => void) {
      notificationHandlers[event] = cb;
    }
    show = showMock;
  },
  BrowserWindow: {
    getFocusedWindow: () => ({
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    }),
    getAllWindows: () => [],
  },
  ipcMain: { handle: vi.fn() },
}));

import {
  configureNotificationService,
  osNotificationTag,
  showOsNotification,
} from "../notification-service";

beforeEach(() => {
  showMock.mockClear();
  notificationOpts.length = 0;
  notificationInstances.length = 0;
  mainSend.mockClear();
  mainRestore.mockClear();
  mainFocus.mockClear();
  mainShow.mockClear();
  for (const k of Object.keys(notificationHandlers))
    delete notificationHandlers[k];
  configureNotificationService({
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        restore: mainRestore,
        show: mainShow,
        focus: mainFocus,
        webContents: { send: mainSend },
      }) as never,
  });
});

describe("showOsNotification", () => {
  it("shows a native notification without an app icon override", () => {
    const result = showOsNotification({
      title: "测试",
      body: "已完成",
      conversationId: "conv-1",
    });
    expect(result).toEqual({ ok: true });
    expect(showMock).toHaveBeenCalledTimes(1);
    expect(notificationOpts).toEqual([
      { title: "测试", body: "已完成", tag: osNotificationTag("conv-1") },
    ]);
  });

  it("omits empty body", () => {
    showOsNotification({
      title: "需要审批",
      body: "",
      conversationId: "conv-empty",
    });
    expect(notificationOpts).toEqual([
      { title: "需要审批", tag: osNotificationTag("conv-empty") },
    ]);
  });

  it("click restores the main window and sends conversationId there", () => {
    showOsNotification({
      title: "需要审批",
      body: "",
      conversationId: "conv-2",
    });
    expect(notificationHandlers.click).toBeTypeOf("function");
    notificationHandlers.click();
    expect(mainFocus).toHaveBeenCalled();
    expect(mainSend).toHaveBeenCalledWith("notification:clicked", {
      conversationId: "conv-2",
    });
  });

  it("same conversation replaces the previous toast instead of stacking", () => {
    showOsNotification({
      title: "测试提问功能",
      body: "需要你的回应",
      conversationId: "conv-ask",
    });
    showOsNotification({
      title: "测试提问功能",
      body: "需要你的回应",
      conversationId: "conv-ask",
    });
    expect(showMock).toHaveBeenCalledTimes(2);
    expect(notificationInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(notificationOpts[0]?.tag).toBe(osNotificationTag("conv-ask"));
    expect(notificationOpts[1]?.tag).toBe(notificationOpts[0]?.tag);
  });

  it("different conversations keep distinct tags", () => {
    expect(osNotificationTag("conv-a")).not.toBe(osNotificationTag("conv-b"));
    expect(osNotificationTag("conv-a")).toHaveLength(16);
  });
});
