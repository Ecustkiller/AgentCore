import {
  FS_CHANNELS,
  type FsApi,
  type FsChangedEvent,
} from "@shared/ipc-contract";
import { LOG_CHANNELS, type LogApi } from "@shared/log-contract";
import {
  SIDECAR_CHANNELS,
  type SidecarApi,
  type SidecarEventPush,
  type SidecarStatusPush,
} from "@shared/sidecar-contract";
import {
  UPDATER_CHANNELS,
  type UpdaterApi,
  type UpdaterStatus,
} from "@shared/updater-contract";
import {
  WINDOW_CHANNELS,
  type WindowApi,
  type WindowFramePreset,
} from "@shared/window-contract";
import { contextBridge, ipcRenderer } from "electron";

const fsApi: FsApi = {
  addRoot: () => ipcRenderer.invoke(FS_CHANNELS.addRoot),
  ensureDefaultRoot: () => ipcRenderer.invoke(FS_CHANNELS.ensureDefaultRoot),
  listRoots: () => ipcRenderer.invoke(FS_CHANNELS.listRoots),
  removeRoot: (rootId) =>
    ipcRenderer.invoke(FS_CHANNELS.removeRoot, { rootId }),
  listDir: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.listDir, { rootId, relPath }),
  listFiles: (rootId) => ipcRenderer.invoke(FS_CHANNELS.listFiles, { rootId }),
  readFile: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.readFile, { rootId, relPath }),
  readTextFile: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.readTextFile, { rootId, relPath }),
  writeFile: (rootId, relPath, input) =>
    ipcRenderer.invoke(FS_CHANNELS.writeFile, { rootId, relPath, input }),
  rename: (rootId, relPath, newName) =>
    ipcRenderer.invoke(FS_CHANNELS.rename, { rootId, relPath, newName }),
  move: (rootId, srcRelPath, destRelPath) =>
    ipcRenderer.invoke(FS_CHANNELS.move, { rootId, srcRelPath, destRelPath }),
  copy: (rootId, srcRelPath, destRelPath) =>
    ipcRenderer.invoke(FS_CHANNELS.copy, { rootId, srcRelPath, destRelPath }),
  create: (rootId, relPath, kind) =>
    ipcRenderer.invoke(FS_CHANNELS.create, { rootId, relPath, kind }),
  delete: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.delete, { rootId, relPath }),
  watch: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.watch, { rootId, relPath }),
  unwatch: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.unwatch, { rootId, relPath }),
  onChanged: (cb) => {
    const listener = (_e: unknown, payload: FsChangedEvent) => cb(payload);
    ipcRenderer.on(FS_CHANNELS.changed, listener);
    return () => ipcRenderer.removeListener(FS_CHANNELS.changed, listener);
  },
  workspaceOp: (rootId, op, args) =>
    ipcRenderer.invoke(FS_CHANNELS.workspaceOp, { rootId, op, args }),
  reveal: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.reveal, { rootId, relPath }),
  openPath: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.openPath, { rootId, relPath }),
  copyPath: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.copyPath, { rootId, relPath }),
};

const sidecarApi: SidecarApi = {
  startTurn: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.startTurn, req),
  cancel: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.cancel, req),
  respond: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.respond, req),
  runRedirect: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.runRedirect, req),
  resume: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.resume, req),
  listPaused: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.listPaused, req),
  probe: (req) => ipcRenderer.invoke(SIDECAR_CHANNELS.probe, req),
  onEvent: (cb) => {
    const listener = (_e: unknown, payload: SidecarEventPush) => cb(payload);
    ipcRenderer.on(SIDECAR_CHANNELS.event, listener);
    return () => ipcRenderer.removeListener(SIDECAR_CHANNELS.event, listener);
  },
  onStatus: (cb) => {
    const listener = (_e: unknown, payload: SidecarStatusPush) => cb(payload);
    ipcRenderer.on(SIDECAR_CHANNELS.status, listener);
    return () => ipcRenderer.removeListener(SIDECAR_CHANNELS.status, listener);
  },
};

const updaterApi: UpdaterApi = {
  configure: (apiBaseUrl) =>
    ipcRenderer.invoke(UPDATER_CHANNELS.configure, apiBaseUrl),
  check: () => ipcRenderer.invoke(UPDATER_CHANNELS.check),
  quitAndInstall: () => ipcRenderer.invoke(UPDATER_CHANNELS.quitAndInstall),
  getStatus: () => ipcRenderer.invoke(UPDATER_CHANNELS.getStatus),
  onStatus: (cb) => {
    const listener = (_e: unknown, payload: UpdaterStatus) => cb(payload);
    ipcRenderer.on(UPDATER_CHANNELS.status, listener);
    return () => ipcRenderer.removeListener(UPDATER_CHANNELS.status, listener);
  },
};

const logApi: LogApi = {
  write: (entry) => ipcRenderer.send(LOG_CHANNELS.write, entry),
};

const windowApi: WindowApi = {
  minimize: () => ipcRenderer.send(WINDOW_CHANNELS.minimize),
  maximize: () => ipcRenderer.send(WINDOW_CHANNELS.maximize),
  close: () => ipcRenderer.send(WINDOW_CHANNELS.close),
  applyFramePreset: (preset: WindowFramePreset) =>
    ipcRenderer.invoke(WINDOW_CHANNELS.applyFramePreset, preset),
  getFramePreset: () => ipcRenderer.invoke(WINDOW_CHANNELS.getFramePreset),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("fsApi", fsApi);
    contextBridge.exposeInMainWorld("sidecarApi", sidecarApi);
    contextBridge.exposeInMainWorld("updaterApi", updaterApi);
    contextBridge.exposeInMainWorld("logApi", logApi);
    contextBridge.exposeInMainWorld("windowApi", windowApi);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore - 非隔离环境下直接挂载
  window.fsApi = fsApi;
  // @ts-ignore - 非隔离环境下直接挂载
  window.sidecarApi = sidecarApi;
  // @ts-ignore - 非隔离环境下直接挂载
  window.updaterApi = updaterApi;
  // @ts-ignore - 非隔离环境下直接挂载
  window.logApi = logApi;
  // @ts-ignore - 非隔离环境下直接挂载
  window.windowApi = windowApi;
}
