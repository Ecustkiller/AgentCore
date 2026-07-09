import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateFolder } from "@/hooks/useFolders";
import { hasLocalFiles } from "@/lib/capabilities";
import { notifyError, notifySuccess } from "@/lib/toast";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const isDesktop = hasLocalFiles();

/**
 * Canonical「新建项目」dialog — mounted once at the app shell, opened from the
 * command palette (and other folder-lifecycle entry points). Draft workspace
 * picker only selects existing projects; creation lives here.
 */
export function CreateProjectDialog() {
  const open = useFoldersStore((s) => s.createProjectOpen);
  const close = useFoldersStore((s) => s.closeCreateProject);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {open && <CreateProjectDialogBody onClose={close} />}
    </Dialog>
  );
}

function CreateProjectDialogBody({ onClose }: { onClose: () => void }) {
  const createFolder = useCreateFolder();
  const [name, setName] = useState("");
  const [pickedRoot, setPickedRoot] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handlePickLocalDir = async () => {
    if (!window.fsApi) return;
    const root = await window.fsApi.addRoot();
    if (root) setPickedRoot(root);
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed || createFolder.isPending) return;
    try {
      const folder = await createFolder.mutateAsync({
        name: trimmed,
        localDir: pickedRoot?.name ?? null,
      });
      const draft =
        useConversationStore.getState().currentConversationId === null;
      if (draft) {
        useFoldersStore.getState().setPendingNewChatFolder(folder.id);
        useFoldersStore.getState().setPendingNewChatCloud(false);
      }
      useFoldersStore.getState().setPendingRename(folder.id);
      notifySuccess(`已创建项目「${folder.name}」`);
      onClose();
    } catch (e) {
      notifyError(e, "创建项目失败");
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>新建项目</DialogTitle>
        <DialogDescription>
          侧栏分组容器，可选绑定本机文件夹。创建后可在对话草稿里归入该项目。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-1">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="项目名称"
          aria-label="项目名称"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {isDesktop && (
          <button
            type="button"
            onClick={() => void handlePickLocalDir()}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <FolderOpen size={14} />
            {pickedRoot ? pickedRoot.name : "绑定本地文件夹（可选）"}
          </button>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={createFolder.isPending}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={!name.trim() || createFolder.isPending}
        >
          {createFolder.isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              创建中…
            </>
          ) : (
            "创建"
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
