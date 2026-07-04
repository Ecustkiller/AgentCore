import { FileWorkbench } from "@/components/files/FileWorkbench";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import { useMemo } from "react";
import { useLocation } from "react-router-dom";

/**
 * The 文件 hub (跨工作区文件总览) — one place to browse files across every
 * conversation scratch workspace (cloud + local) without first opening a
 * conversation. Layout is VSCode 式左树右详情: the left rail stacks each scratch
 * as a flat, collapsible section over its own {@link FileSource}.
 *
 * Folder lifecycle (sidebar grouping) lives on `/conversations`; this page is purely
 * the file lens. `/conversations`「浏览文件」jumps here with `focusWsId`
 * (`conv:<conversationId>`) so the target section expands + highlights.
 */
export function FilesPage() {
  const location = useLocation();
  const query = useWorkspaces();
  const workspaces = useMemo(() => query.data ?? [], [query.data]);

  const focusWsId =
    (location.state as { focusWsId?: string } | null)?.focusWsId ?? null;

  const openMemoryLeaf =
    (
      location.state as {
        openMemoryLeaf?: { path: string; name: string };
      } | null
    )?.openMemoryLeaf ?? null;

  return (
    <FileWorkbench
      workspaces={workspaces}
      isLoading={query.isLoading}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      fsAvailable={hasLocalFiles()}
      showMemory
      focusWsId={focusWsId}
      openMemoryLeaf={openMemoryLeaf}
      focusKey={location.key}
    />
  );
}
