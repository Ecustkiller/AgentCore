import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import {
  FS_CHANNELS,
  type FsCreateKind,
  type FsRoot,
  type FsWriteInput,
  type WorkspaceOpName,
} from "@shared/ipc-contract";
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { readFile, readTextFile, writeTextFile } from "./preview";
import {
  deleteRoot,
  ensureReady,
  findRootByAbsPath,
  getAllRoots,
  initRoots,
  saveRoots,
  setRoot,
} from "./roots";
import { copyPath, openWithDefaultApp, reveal } from "./shell";
import { copy, create, listDir, listFiles, move, remove, rename } from "./tree";
import { closeWatchersForRoot, unwatchDir, watchDir } from "./watch";
import { workspaceOp } from "./workspace/dispatch";

/** 注册全部 fs IPC handler。须在 app ready 后调用。 */
export function registerFsIpc(): void {
  initRoots();

  ipcMain.handle(FS_CHANNELS.addRoot, async (): Promise<FsRoot | null> => {
    await ensureReady();
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;

    let absPath: string;
    try {
      absPath = await fs.realpath(result.filePaths[0]);
    } catch {
      absPath = result.filePaths[0];
    }

    const existing = findRootByAbsPath(absPath);
    if (existing) return { id: existing.id, name: existing.name };

    const id = randomUUID();
    const name = basename(absPath) || absPath;
    setRoot({ id, name, absPath });
    await saveRoots();
    return { id, name };
  });

  // 桌面 local-first 地基（双模式工作区 决策 #11）：取得默认本地工作区根，必要时自动
  // 创建 ~/Documents/AgentCore 并登记为授权根——无需用户走目录选择器，给新对话一个
  // 开箱即用的本地落地处。幂等：已存在同路径的根则复用（不重复登记）。
  ipcMain.handle(FS_CHANNELS.ensureDefaultRoot, async (): Promise<FsRoot> => {
    await ensureReady();
    const base = join(app.getPath("documents"), "AgentCore");
    await fs.mkdir(base, { recursive: true });
    let absPath: string;
    try {
      absPath = await fs.realpath(base);
    } catch {
      absPath = base;
    }
    const existing = findRootByAbsPath(absPath);
    if (existing) return { id: existing.id, name: existing.name };

    const id = randomUUID();
    const name = basename(absPath) || absPath;
    setRoot({ id, name, absPath });
    await saveRoots();
    return { id, name };
  });

  ipcMain.handle(FS_CHANNELS.listRoots, async (): Promise<FsRoot[]> => {
    await ensureReady();
    return getAllRoots().map((r) => ({ id: r.id, name: r.name }));
  });

  ipcMain.handle(
    FS_CHANNELS.removeRoot,
    async (_e, payload: { rootId: string }) => {
      await ensureReady();
      closeWatchersForRoot(payload.rootId);
      deleteRoot(payload.rootId);
      await saveRoots();
    },
  );

  ipcMain.handle(
    FS_CHANNELS.listDir,
    (_e, p: { rootId: string; relPath: string }) =>
      listDir(p.rootId, p.relPath),
  );

  ipcMain.handle(FS_CHANNELS.listFiles, (_e, p: { rootId: string }) =>
    listFiles(p.rootId),
  );

  ipcMain.handle(
    FS_CHANNELS.readFile,
    (_e, p: { rootId: string; relPath: string }) =>
      readFile(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.readTextFile,
    (_e, p: { rootId: string; relPath: string }) =>
      readTextFile(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.writeFile,
    (_e, p: { rootId: string; relPath: string; input: FsWriteInput }) =>
      writeTextFile(p.rootId, p.relPath, p.input),
  );

  ipcMain.handle(
    FS_CHANNELS.rename,
    (_e, p: { rootId: string; relPath: string; newName: string }) =>
      rename(p.rootId, p.relPath, p.newName),
  );

  ipcMain.handle(
    FS_CHANNELS.move,
    (_e, p: { rootId: string; srcRelPath: string; destRelPath: string }) =>
      move(p.rootId, p.srcRelPath, p.destRelPath),
  );

  ipcMain.handle(
    FS_CHANNELS.copy,
    (_e, p: { rootId: string; srcRelPath: string; destRelPath: string }) =>
      copy(p.rootId, p.srcRelPath, p.destRelPath),
  );

  ipcMain.handle(
    FS_CHANNELS.create,
    (_e, p: { rootId: string; relPath: string; kind: FsCreateKind }) =>
      create(p.rootId, p.relPath, p.kind),
  );

  ipcMain.handle(
    FS_CHANNELS.delete,
    (_e, p: { rootId: string; relPath: string }) => remove(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.watch,
    (e, p: { rootId: string; relPath: string }) => {
      watchDir(e.sender, p.rootId, p.relPath);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.unwatch,
    (_e, p: { rootId: string; relPath: string }) => {
      unwatchDir(p.rootId, p.relPath);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.workspaceOp,
    (
      _e,
      p: { rootId: string; op: WorkspaceOpName; args: Record<string, unknown> },
    ) => workspaceOp(p),
  );

  ipcMain.handle(
    FS_CHANNELS.reveal,
    (_e, p: { rootId: string; relPath: string }) => reveal(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.openPath,
    (_e, p: { rootId: string; relPath: string }) =>
      openWithDefaultApp(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.copyPath,
    (_e, p: { rootId: string; relPath: string }) =>
      copyPath(p.rootId, p.relPath),
  );
}
