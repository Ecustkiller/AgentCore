import { electronAPI } from "@electron-toolkit/preload";
import {
  FS_CHANNELS,
  type FsApi,
  type FsChangedEvent,
} from "@shared/ipc-contract";
import { contextBridge, ipcRenderer } from "electron";

const fsApi: FsApi = {
  addRoot: () => ipcRenderer.invoke(FS_CHANNELS.addRoot),
  listRoots: () => ipcRenderer.invoke(FS_CHANNELS.listRoots),
  removeRoot: (rootId) =>
    ipcRenderer.invoke(FS_CHANNELS.removeRoot, { rootId }),
  listDir: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.listDir, { rootId, relPath }),
  listFiles: (rootId) => ipcRenderer.invoke(FS_CHANNELS.listFiles, { rootId }),
  readFile: (rootId, relPath) =>
    ipcRenderer.invoke(FS_CHANNELS.readFile, { rootId, relPath }),
  rename: (rootId, relPath, newName) =>
    ipcRenderer.invoke(FS_CHANNELS.rename, { rootId, relPath, newName }),
  move: (rootId, srcRelPath, destRelPath) =>
    ipcRenderer.invoke(FS_CHANNELS.move, { rootId, srcRelPath, destRelPath }),
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
};

const windowApi = {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("fsApi", fsApi);
    contextBridge.exposeInMainWorld("windowApi", windowApi);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore - 非隔离环境下直接挂载
  window.electron = electronAPI;
  // @ts-ignore - 非隔离环境下直接挂载
  window.fsApi = fsApi;
  // @ts-ignore - 非隔离环境下直接挂载
  window.windowApi = windowApi;
}
