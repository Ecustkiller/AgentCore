import { FilePreview } from "@/components/files/FilePreview";
import { FileTree } from "@/components/files/FileTree";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useFilesStore } from "@/stores/files";
import { FolderPlus } from "lucide-react";
import { useEffect } from "react";

export function FilesPage() {
  const roots = useFilesStore((s) => s.roots);
  const setRoots = useFilesStore((s) => s.setRoots);
  const addRoot = useFilesStore((s) => s.addRoot);

  useEffect(() => {
    window.fsApi.listRoots().then(setRoots);
  }, [setRoots]);

  const handleAddFolder = async () => {
    const root = await window.fsApi.addRoot();
    if (root) addRoot(root);
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
          <div className="min-h-0 flex-1 overflow-auto">
            <FileTree />
          </div>
        )}
      </aside>

      <section className="min-w-0 flex-1">
        <FilePreview />
      </section>
    </div>
  );
}
