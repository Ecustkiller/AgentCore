import { useFilesStore } from "@/stores/files";
import { FileTreeNode } from "./FileTreeNode";

export function FileTree() {
  const roots = useFilesStore((s) => s.roots);
  const removeRootFromStore = useFilesStore((s) => s.removeRoot);

  const handleRemoveRoot = async (id: string) => {
    await window.fsApi.removeRoot(id);
    removeRootFromStore(id);
  };

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      {roots.map((root) => (
        <FileTreeNode
          key={root.id}
          rootId={root.id}
          name={root.name}
          relPath=""
          kind="dir"
          depth={0}
          isRoot
          onRemoveRoot={() => handleRemoveRoot(root.id)}
        />
      ))}
    </div>
  );
}
