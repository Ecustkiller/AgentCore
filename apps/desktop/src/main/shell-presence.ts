/**
 * 主进程壳在场：主窗可见性 + 本应用任一产品窗焦点。
 * 快照只推给主窗 renderer（协作感知订阅在 AppShell，不在真窗）。
 */
import {
  NOTIFICATION_CHANNELS,
  type ShellPresenceSnapshot,
} from "@shared/notification-contract";
import { computeShellPresence } from "@shared/shell-presence";
import { type BrowserWindow, ipcMain } from "electron";

type FloatEntry = { win: BrowserWindow; conversationId: string };

let getMainWindow: () => BrowserWindow | null = () => null;
let listFloatEntries: () => readonly FloatEntry[] = () => [];
const watched = new WeakSet<BrowserWindow>();
let ipcRegistered = false;

function bitsOf(win: BrowserWindow): {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  focused: boolean;
} {
  if (win.isDestroyed()) {
    return {
      destroyed: true,
      minimized: false,
      visible: false,
      focused: false,
    };
  }
  return {
    destroyed: false,
    minimized: win.isMinimized(),
    visible: win.isVisible(),
    focused: win.isFocused(),
  };
}

export function snapshotShellPresence(): ShellPresenceSnapshot {
  const main = getMainWindow();
  return computeShellPresence({
    main: main ? bitsOf(main) : null,
    floats: listFloatEntries().map((e) => ({
      ...bitsOf(e.win),
      conversationId: e.conversationId,
    })),
  });
}

export function broadcastShellPresence(): void {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return;
  main.webContents.send(
    NOTIFICATION_CHANNELS.presenceChanged,
    snapshotShellPresence(),
  );
}

export function configureShellPresence(deps: {
  getMainWindow: () => BrowserWindow | null;
  listFloatEntries: () => readonly FloatEntry[];
}): void {
  getMainWindow = deps.getMainWindow;
  listFloatEntries = deps.listFloatEntries;
}

export function watchWindowForShellPresence(win: BrowserWindow): void {
  if (win.isDestroyed() || watched.has(win)) return;
  watched.add(win);
  const bump = (): void => broadcastShellPresence();
  win.on("focus", bump);
  win.on("blur", bump);
  win.on("minimize", bump);
  win.on("restore", bump);
  win.on("hide", bump);
  win.on("show", bump);
  win.on("closed", bump);
}

export function registerShellPresenceIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle(NOTIFICATION_CHANNELS.presenceGet, () =>
    snapshotShellPresence(),
  );
}
