import { Button } from "@/components/ui";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useCreateFolder } from "@/hooks/useFolders";
import { notifyError } from "@/lib/toast";
import type { FolderMeta } from "@/services/folders";
import { useConversationStore } from "@/stores/conversation";
import { type CreateFolderAnchorRect, useFoldersStore } from "@/stores/folders";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * 「新建项目」锚点级联：仅云端空白（§五：桌面不再主推本机文件夹/本机空白）。
 * 入口（chip / 侧栏 + / 命令面板）共用；AppShell 挂载 {@link CreateFolderMenuHost}。
 */
export function CreateFolderMenuHost() {
  const open = useFoldersStore((s) => s.createFolderOpen);
  const anchor = useFoldersStore((s) => s.createFolderAnchor);
  const close = useFoldersStore((s) => s.closeCreateFolder);
  /** Swallow the outside-dismiss from the menu/dropdown that just opened us. */
  const ignoreOutsideUntil = useRef(0);

  useEffect(() => {
    if (open) ignoreOutsideUntil.current = Date.now() + 200;
  }, [open]);

  const guardOutside = (e: Event) => {
    if (Date.now() < ignoreOutsideUntil.current) e.preventDefault();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor asChild>
        <VirtualAnchor rect={anchor} />
      </PopoverAnchor>
      <PopoverContent
        align={anchor ? "start" : "center"}
        side="bottom"
        sideOffset={anchor ? 6 : 0}
        avoidCollisions={false}
        className="w-auto p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={guardOutside}
        onInteractOutside={guardOutside}
      >
        {open ? <CreateFolderCascadePanel onClose={close} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function VirtualAnchor({ rect }: { rect: CreateFolderAnchorRect | null }) {
  if (rect) {
    return (
      <div
        aria-hidden
        className="pointer-events-none fixed z-50"
        style={{
          top: rect.top,
          left: rect.left,
          width: Math.max(rect.width, 1),
          height: Math.max(rect.height, 1),
        }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-1/2 top-[18%] z-50 h-0 w-0 -translate-x-1/2"
    />
  );
}

export function CreateFolderCascadePanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const createFolder = useCreateFolder();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const applyDraftProjectIntent = (folderId: string) => {
    const draft =
      useConversationStore.getState().currentConversationId === null;
    if (draft) {
      useFoldersStore.getState().setDraftWorkspaceIntent({
        kind: "project",
        folderId,
      });
    }
  };

  const finishCreated = (folder: FolderMeta) => {
    applyDraftProjectIntent(folder.id);
    useFoldersStore.getState().setPendingRename(folder.id);
    onClose();
  };

  const handleSubmitCloud = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy || createFolder.isPending) return;
    setBusy(true);
    try {
      const { folder } = await createFolder.mutateAsync({
        name: trimmed,
        mode: "cloud",
      });
      finishCreated(folder);
    } catch (e) {
      notifyError(e, "创建项目失败");
    } finally {
      setBusy(false);
    }
  };

  const pending = busy || createFolder.isPending;

  return (
    <div className="w-72 p-3">
      <div className="mb-2 text-xs font-medium text-foreground">新建云项目</div>
      <NamePane
        inputRef={nameRef}
        name={name}
        setName={setName}
        pending={pending}
        hint="云端空间 · 团队共享"
        onSubmit={() => void handleSubmitCloud()}
      />
    </div>
  );
}

function NamePane({
  inputRef,
  name,
  setName,
  pending,
  hint,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  name: string;
  setName: (v: string) => void;
  pending: boolean;
  hint: string;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && name.trim()) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="项目名称"
        aria-label="项目名称"
        disabled={pending}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      <p className="truncate text-xs text-muted-foreground">{hint}</p>
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={!name.trim() || pending}
          onClick={onSubmit}
        >
          {pending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              创建中…
            </>
          ) : (
            "创建"
          )}
        </Button>
      </div>
    </div>
  );
}
