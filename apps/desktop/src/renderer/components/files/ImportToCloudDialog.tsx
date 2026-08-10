import { Button, Input } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pickLocalFolderRoot } from "@/lib/bindLocalFolder";
import {
  isImportToCloudJobRunning,
  startImportToCloudJob,
} from "@/lib/importToCloudJob";
import { notifyInfo } from "@/lib/toast";
import { type ImportToCloudPrefill, useFoldersStore } from "@/stores/folders";
import type { FsRoot } from "@shared/ipc-contract";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * AppShell host for Composer / 命令面板「导入到云」——与 {@link ConnectGitDialogHost}
 * 同构：store 开关 + Dialog。遗留 local 迁移可带 prefill（localRootId）。
 */
export function ImportToCloudDialogHost() {
  const open = useFoldersStore((s) => s.importToCloudOpen);
  const prefill = useFoldersStore((s) => s.importToCloudPrefill);
  const close = useFoldersStore((s) => s.closeImportToCloud);

  return (
    <ImportToCloudDialog
      open={open}
      prefill={prefill}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    />
  );
}

type OwnedRoot = { root: FsRoot; owns: boolean };

/**
 * 导入到云 MVP：选本机夹 → 填名 → 点导入即关窗；上传在后台 job（toast 进度 / 可取消）。
 * Prefill 根来自遗留 Folder.localRootId 时不 removeRoot（共享本机绑定）。
 */
export function ImportToCloudDialog({
  open,
  onOpenChange,
  onImported,
  prefill = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (folderId: string) => void;
  prefill?: ImportToCloudPrefill | null;
}) {
  const [projectName, setProjectName] = useState("");
  const [owned, setOwned] = useState<OwnedRoot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefillAppliedForOpen = useRef(false);
  /** Sync ownership so reset after submit handoff does not removeRoot. */
  const ownedRef = useRef<OwnedRoot | null>(null);

  const setOwnedSync = useCallback((next: OwnedRoot | null) => {
    ownedRef.current = next;
    setOwned(next);
  }, []);

  const root = owned?.root ?? null;

  const clearOwned = async (prev: OwnedRoot | null) => {
    if (prev?.owns) {
      try {
        await window.fsApi?.removeRoot?.(prev.root.id);
      } catch {
        // ignore
      }
    }
  };

  const reset = async () => {
    const prev = ownedRef.current;
    ownedRef.current = null;
    setProjectName("");
    setOwned(null);
    setError(null);
    prefillAppliedForOpen.current = false;
    await clearOwned(prev);
  };

  useEffect(() => {
    if (!open) {
      prefillAppliedForOpen.current = false;
      return;
    }
    if (prefillAppliedForOpen.current) return;
    prefillAppliedForOpen.current = true;

    const nameHint = prefill?.projectName?.trim() || "";
    if (nameHint) setProjectName(nameHint);

    const rootId = prefill?.rootId?.trim();
    if (!rootId) return;

    let cancelled = false;
    void (async () => {
      try {
        const roots = (await window.fsApi?.listRoots?.()) ?? [];
        if (cancelled) return;
        const found = roots.find((r) => r.id === rootId);
        if (!found) return;
        setOwnedSync({ root: found, owns: false });
        if (!nameHint) setProjectName(found.name);
      } catch {
        // Prefill miss → user still picks manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, prefill, setOwnedSync]);

  const pickFolder = async () => {
    setError(null);
    const picked = await pickLocalFolderRoot();
    if (!picked.ok) {
      if (picked.reason === "cancelled") return;
      setError(picked.message);
      return;
    }
    const prev = ownedRef.current;
    setOwnedSync({ root: picked.root, owns: true });
    void clearOwned(prev);
    if (!projectName.trim()) {
      setProjectName(picked.root.name);
    }
  };

  const requestClose = () => {
    void reset();
    onOpenChange(false);
  };

  const submit = () => {
    const handoff = ownedRef.current;
    if (!handoff) {
      setError("请先选择本机文件夹");
      return;
    }
    // Keep dialog + root if a job is already running (avoid handoff leak).
    if (isImportToCloudJobRunning()) {
      notifyInfo("导入到云进行中", {
        description: "请等待当前任务完成或在进度提示中取消后再试",
      });
      return;
    }
    const name = projectName.trim() || handoff.root.name;
    // Transfer root ownership to the job before close/reset can clearOwned.
    ownedRef.current = null;
    setOwned(null);
    setError(null);
    setProjectName("");
    prefillAppliedForOpen.current = false;
    // Close without reset clearOwned — root now belongs to the job.
    onOpenChange(false);

    const started = startImportToCloudJob({
      root: handoff.root,
      ownsRoot: handoff.owns,
      projectName: name,
      onImported,
    });
    // Rare race: begin lost after pre-check — reclaim temp root ourselves.
    if (!started && handoff.owns) {
      void clearOwned(handoff);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>导入本机项目到云</DialogTitle>
          <DialogDescription>
            将本机文件夹快照上传到新建云项目（套用 ignore；打包上限 100MiB / 2
            万文件，单文件 PUT 上限 25MiB）。之后只认云桌，不建本地工作区。
            本会话仍挂旧归属，请在新云项目继续。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="import-folder">
              本机文件夹
            </label>
            <div className="flex gap-2">
              <Button
                id="import-folder"
                type="button"
                variant="neutral"
                className="min-w-0 flex-1 justify-start gap-2"
                onClick={() => void pickFolder()}
              >
                <FolderOpen size={14} className="shrink-0" />
                <span className="truncate">
                  {root ? root.name : "选择文件夹…"}
                </span>
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="import-name">
              云项目名称
            </label>
            <Input
              id="import-name"
              placeholder="默认取文件夹名"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="neutral" onClick={() => requestClose()}>
            取消
          </Button>
          <Button disabled={!root} onClick={() => submit()}>
            导入到云
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
