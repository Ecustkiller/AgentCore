/**
 * Local host type/click 回执 + CDP Input.insertText 接线。
 * Electron 主进程侧无真 Chromium 测试设施，沿用 vi.mock('electron')（与
 * browserAttachment 同形）；React 受控更新见 browserTypeReact.test.tsx。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  WebContentsView: vi.fn().mockImplementation(() => {
    let url = "about:blank";
    let debuggerAttached = false;
    const sendCommand = vi.fn(async () => ({}));
    return {
      webContents: {
        isDestroyed: () => false,
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        loadURL: vi.fn(async (next: string) => {
          url = next;
        }),
        getURL: () => url,
        getTitle: () => "",
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
        },
        close: vi.fn(),
        isLoadingMainFrame: () => false,
        reload: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => debuggerAttached,
          attach: vi.fn(() => {
            debuggerAttached = true;
          }),
          detach: vi.fn(() => {
            debuggerAttached = false;
          }),
          sendCommand,
        },
        executeJavaScript: vi.fn(async (code: string) => {
          if (typeof code === "string" && code.includes("querySelectorAll")) {
            return '[e1] textarea: composer | placeholder="Type…" | value="你好👋"\n[e2] button disabled: Send';
          }
          if (typeof code === "string" && code.includes("was_disabled")) {
            if (code.includes('"e2"')) {
              return {
                was_disabled: true,
                role: "button",
                name: "Send",
              };
            }
            return { was_disabled: false, role: "button", name: "Go" };
          }
          if (typeof code === "string" && code.includes("masked")) {
            return {
              chars: Array.from("你好👋").length,
              masked: false,
              text: "你好👋",
            };
          }
          if (
            typeof code === "string" &&
            (code.includes("selectNodeContents") ||
              code.includes("setSelectionRange") ||
              code.includes("el.select"))
          ) {
            return true;
          }
          if (typeof code === "string" && code.includes("autocomplete")) {
            return false;
          }
          return undefined;
        }),
      },
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    };
  }),
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      protocol: { handle: vi.fn(), isProtocolHandled: () => false },
      on: vi.fn(),
    })),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../browser/workspace-protocol", () => ({
  registerWorkspaceProtocolFor: vi.fn(),
}));

import {
  bridgeDispatchLocalBrowser,
  closeAllLocalBrowserPages,
  resetLegacyBrowserClearForTests,
  setBeforeAttachCheckForTests,
  showLocalBrowserPage,
} from "../browser/host";

const BOUNDS = { x: 10, y: 20, width: 400, height: 300 };

function mockWin() {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    once: vi.fn(),
    webContents: { send: vi.fn() },
  } as never;
}

type WebContentsMock = {
  debugger: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    isAttached: () => boolean;
  };
  executeJavaScript: ReturnType<typeof vi.fn>;
};

describe("Local browser type/click falsifiable receipts", () => {
  beforeEach(() => {
    closeAllLocalBrowserPages();
    resetLegacyBrowserClearForTests();
    setBeforeAttachCheckForTests(null);
  });

  it("type 走 CDP Input.insertText，回执 typed 可证伪（CJK/emoji）", async () => {
    const win = mockWin();
    expect(
      showLocalBrowserPage(win, "page-in", BOUNDS, "conv-1"),
    ).toMatchObject({ ok: true });
    const text = "你好👋";
    const result = await bridgeDispatchLocalBrowser(
      "page-in",
      "type",
      { ref: "e1", text, snapshot_version: 0, capture: false },
      "conv-1",
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        typed: {
          ref: "e1",
          requested_chars: Array.from(text).length,
          actual_chars: Array.from(text).length,
          matched: true,
          method: "cdp_insertText",
        },
      },
    });

    const { WebContentsView } = await import("electron");
    const wc = vi.mocked(WebContentsView).mock.results.at(-1)?.value as {
      webContents: WebContentsMock;
    };
    const cmds = wc.webContents.debugger.sendCommand.mock.calls.map(
      (c) => c[0],
    );
    expect(cmds).toContain("Input.insertText");
    const insert = wc.webContents.debugger.sendCommand.mock.calls.find(
      (c) => c[0] === "Input.insertText",
    );
    expect(insert?.[1]).toEqual({ text });
    expect(
      cmds.filter((m) => m === "Input.dispatchKeyEvent").length,
    ).toBeGreaterThanOrEqual(2);
    expect(wc.webContents.debugger.attach).toHaveBeenCalled();
    expect(wc.webContents.debugger.detach).toHaveBeenCalled();
  });

  it("click 禁用按钮回执 was_disabled=true", async () => {
    const win = mockWin();
    showLocalBrowserPage(win, "page-click", BOUNDS, "conv-1");
    await bridgeDispatchLocalBrowser("page-click", "snapshot", {}, "conv-1");
    const result = await bridgeDispatchLocalBrowser(
      "page-click",
      "click",
      { ref: "e2", snapshot_version: 1, capture: false },
      "conv-1",
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        clicked: {
          ref: "e2",
          was_disabled: true,
          role: "button",
          name: "Send",
        },
      },
    });
  });

  it("password 仍硬拒，不走 CDP", async () => {
    const win = mockWin();
    showLocalBrowserPage(win, "page-pw", BOUNDS, "conv-1");
    const { WebContentsView } = await import("electron");
    const wc = vi.mocked(WebContentsView).mock.results.at(-1)?.value as {
      webContents: WebContentsMock;
    };
    wc.webContents.executeJavaScript.mockImplementation(
      async (code: string) => {
        if (typeof code === "string" && code.includes("querySelectorAll")) {
          return "[e-pw] password";
        }
        if (typeof code === "string" && code.includes("autocomplete")) {
          return true;
        }
        return undefined;
      },
    );
    const blocked = await bridgeDispatchLocalBrowser(
      "page-pw",
      "type",
      { ref: "e-pw", text: "secret", snapshot_version: 0, capture: false },
      "conv-1",
    );
    expect(blocked.ok).toBe(false);
    expect(String((blocked as { error?: string }).error)).toContain(
      "password_blocked",
    );
    expect(wc.webContents.debugger.sendCommand).not.toHaveBeenCalled();
  });
});
