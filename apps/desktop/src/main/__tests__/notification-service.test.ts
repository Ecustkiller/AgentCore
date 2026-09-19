import { beforeEach, describe, expect, it, vi } from "vitest";

const showMock = vi.fn();
const notificationHandlers: Record<string, () => void> = {};
const notificationOpts: Record<string, unknown>[] = [];
const mainSend = vi.fn();
const mainRestore = vi.fn();
const mainFocus = vi.fn();
const mainShow = vi.fn();

vi.mock("electron", () => ({
  Notification: class {
    static isSupported = () => true;
    constructor(opts: Record<string, unknown>) {
      notificationOpts.push(opts);
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
  showOsNotification,
} from "../notification-service";

beforeEach(() => {
  showMock.mockClear();
  notificationOpts.length = 0;
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
    expect(notificationOpts).toEqual([{ title: "测试", body: "已完成" }]);
  });

  it("omits empty body", () => {
    showOsNotification({
      title: "需要审批",
      body: "",
      conversationId: "conv-empty",
    });
    expect(notificationOpts).toEqual([{ title: "需要审批" }]);
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
});
