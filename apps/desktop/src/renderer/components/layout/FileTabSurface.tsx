import { FileDetail, type FileDirtyState } from "@/components/files/FileDetail";
import { EmptyHint } from "@/components/files/parts";
import { useFileTabSourceState } from "@/hooks/useConversationFileSource";
import { createDocumentSource } from "@/services/sources/documentSource";
import { useConversationStore } from "@/stores/conversation";
import { type FileTabChannel, useSidePanelStore } from "@/stores/sidePanel";
import { FileText } from "lucide-react";
import { useCallback, useMemo } from "react";

/**
 * File content-tab body for the docked SidePanel and float hosts.
 * Disk tabs resolve via {@link useFileTabSourceState}; entry tabs (document)
 * use the same FileSource + FileDetail pair as the files page.
 */
export function FileTabSurface({
  tabId,
  path,
  name,
  workspaceId,
  channel,
  onClose,
}: {
  tabId: string;
  path: string;
  name: string;
  workspaceId?: string;
  channel?: FileTabChannel;
  onClose: () => void;
}) {
  const currentConversationId = useConversationStore(
    (s) => s.currentConversationId,
  );
  const setFileTabChrome = useSidePanelStore((s) => s.setFileTabChrome);
  const onDirtyChange = useCallback(
    (state: FileDirtyState) => {
      setFileTabChrome(tabId, state);
    },
    [setFileTabChrome, tabId],
  );
  // Entry tabs don't need the conversation desk; skip so opening 设定 doesn't
  // wait on / 404 a workspace path that isn't theirs.
  const disk = useFileTabSourceState(
    channel ? null : currentConversationId,
    channel ? undefined : workspaceId,
  );
  const documentSource = useMemo(() => createDocumentSource(), []);

  const source = channel === "document" ? documentSource : disk.source;
  const pending = channel ? false : disk.pending;

  if (!path || !name) {
    return (
      <EmptyHint
        inline
        icon={<FileText size={26} className="text-muted-foreground/40" />}
        title="打开文件"
      />
    );
  }
  if (!source) {
    return (
      <EmptyHint
        inline
        icon={<FileText size={26} className="text-muted-foreground/40" />}
        title={name}
        hint={pending ? "正在定位文件…" : "当前会话尚无可用文件源。"}
      />
    );
  }
  return (
    <FileDetail
      key={`${channel ?? ""}:${workspaceId ?? ""}:${path}`}
      source={source}
      path={path}
      name={name}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
    />
  );
}
