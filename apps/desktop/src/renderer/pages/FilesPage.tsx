import { FilePreview } from "@/components/files/FilePreview";
import { FileTree } from "@/components/files/FileTree";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { useFilesStore } from "@/stores/files";
import { Folder, FolderPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * The Files page — a hub over the user's local roots (文件中枢统一 §二). Each root
 * is a {@link FileSource}; the rail picks the active one and the shared FileTree
 * renders it, with the right pane previewing the selected file. (Cloud workspace
 * sources join this rail in Step 2; for now it lists local roots only.)
 */
export function FilesPage() {
  const roots = useFilesStore((s) => s.roots);
  const setRoots = useFilesStore((s) => s.setRoots);
  const addRoot = useFilesStore((s) => s.addRoot);
  const removeRoot = useFilesStore((s) => s.removeRoot);
  const selected = useFilesStore((s) => s.selected);
  const select = useFilesStore((s) => s.select);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);

  useEffect(() => {
    window.fsApi.listRoots().then(setRoots);
  }, [setRoots]);

  // Keep an active root selected whenever the list changes.
  useEffect(() => {
    if (roots.length === 0) {
      setActiveRootId(null);
      return;
    }
    setActiveRootId((cur) =>
      cur && roots.some((r) => r.id === cur) ? cur : roots[0].id,
    );
  }, [roots]);

  const activeRoot = roots.find((r) => r.id === activeRootId) ?? null;
  const source = useMemo(
    () =>
      activeRoot ? createLocalRootSource(activeRoot.id, activeRoot.name) : null,
    [activeRoot],
  );

  const handleAddFolder = async () => {
    const root = await window.fsApi.addRoot();
    if (root) {
      addRoot(root);
      setActiveRootId(root.id);
    }
  };

  const handleRemoveRoot = async (id: string) => {
    await window.fsApi.removeRoot(id);
    removeRoot(id);
  };

  return (
    <div className="flex h-full w-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-base font-medium text-foreground">文件</span>
          <SimpleTooltip label="添加文件夹">
            <button
              type="button"
              aria-label="添加文件夹"
              onClick={handleAddFolder}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
            >
              <FolderPlus size={16} />
            </button>
          </SimpleTooltip>
        </div>

        {roots.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <FolderPlus size={24} className="text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">未连接本地文件夹</p>
            <p className="text-xs text-muted-foreground/70">
              添加文件夹后即可浏览、预览与管理本地文件
            </p>
            <button
              type="button"
              onClick={handleAddFolder}
              className="mt-2 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              添加文件夹
            </button>
          </div>
        ) : (
          <>
            {roots.length > 1 && (
              <div className="shrink-0 border-b border-border px-2 pb-2">
                {roots.map((root) => {
                  const active = root.id === activeRootId;
                  return (
                    <div
                      key={root.id}
                      className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveRootId(root.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <Folder
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {root.name}
                        </span>
                      </button>
                      <SimpleTooltip label="移除该文件夹">
                        <button
                          type="button"
                          aria-label="移除该文件夹"
                          onClick={() => void handleRemoveRoot(root.id)}
                          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/0 hover:bg-background hover:text-foreground group-hover:text-muted-foreground"
                        >
                          <X size={13} />
                        </button>
                      </SimpleTooltip>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="min-h-0 flex-1">
              {source && activeRoot && (
                <FileTree
                  key={activeRoot.id}
                  source={source}
                  onOpenFile={(path, name) =>
                    select({ rootId: activeRoot.id, relPath: path, name })
                  }
                  activePath={
                    selected?.rootId === activeRoot.id ? selected.relPath : null
                  }
                  headerExtra={
                    roots.length === 1 ? (
                      <SimpleTooltip label="移除该文件夹">
                        <button
                          type="button"
                          aria-label="移除该文件夹"
                          onClick={() => void handleRemoveRoot(activeRoot.id)}
                          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <X size={14} />
                        </button>
                      </SimpleTooltip>
                    ) : undefined
                  }
                />
              )}
            </div>
          </>
        )}
      </aside>

      <section className="min-w-0 flex-1">
        <FilePreview />
      </section>
    </div>
  );
}
