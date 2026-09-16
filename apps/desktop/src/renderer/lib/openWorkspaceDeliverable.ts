import { hasInAppPreview } from "@/lib/capabilities";
import { baseName, isHtmlPath } from "@/lib/fileSource";
import {
  isSeededCsvCandidate,
  tryNavigateSeededCsv,
} from "@/lib/openSeededCsvTable";
import { openWorkspaceHtmlInBrowser } from "@/lib/openWorkspaceHtmlInBrowser";
import { useSidePanelStore } from "@/stores/sidePanel";

/**
 * 终稿路径点击：HTML（且会话具备应用内预览）直达浏览器壳，已灌数 csv 进活表，其余开 File tab。
 */
export function openWorkspaceDeliverable(
  conversationId: string | null,
  path: string,
  workspaceId?: string | null,
): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  if (conversationId && hasInAppPreview() && isHtmlPath(trimmed)) {
    void openWorkspaceHtmlInBrowser(
      conversationId,
      trimmed,
      workspaceId ?? undefined,
    );
    return;
  }
  const openFile = () =>
    useSidePanelStore
      .getState()
      .openFileTab(trimmed, baseName(trimmed) || trimmed, workspaceId);
  if (!isSeededCsvCandidate(trimmed)) {
    openFile();
    return;
  }
  void tryNavigateSeededCsv({
    path: trimmed,
    workspaceId,
    conversationId,
  }).then((opened) => {
    if (!opened) openFile();
  });
}
