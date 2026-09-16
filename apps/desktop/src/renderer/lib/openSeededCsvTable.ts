import {
  conversationIdOf,
  folderIdOf,
} from "@/components/files/fileWorkbench/storage";
import { appNavigate } from "@/lib/appNavigate";
import { isWebPreview } from "@/lib/preview";
import { lookupTableBySource } from "@/services/tables";

export function seededCsvRelPath(path: string): string | null {
  const p = path.replace(/\\/g, "/").trim().replace(/^\.\//, "");
  if (!p) return null;
  const lower = p.toLowerCase();
  if (lower === "attachments" || lower.startsWith("attachments/")) return null;
  const name = p.split("/").pop()?.toLowerCase() ?? "";
  if (!name.endsWith(".csv")) return null;
  return p;
}

export function isSeededCsvCandidate(path: string): boolean {
  return seededCsvRelPath(path) !== null;
}

export type SeededCsvDesk = {
  path: string;
  folderId?: string | null;
  conversationId?: string | null;
  workspaceId?: string | null;
};

function resolveDesk(opts: SeededCsvDesk): {
  folderId?: string;
  conversationId?: string;
} | null {
  const ws = opts.workspaceId?.trim();
  if (ws) {
    const folderId = folderIdOf(ws);
    if (folderId) return { folderId };
    const conversationId = conversationIdOf(ws);
    if (conversationId) return { conversationId };
  }
  const conversationId = opts.conversationId?.trim();
  if (conversationId) return { conversationId };
  const folderId = opts.folderId?.trim();
  if (folderId) return { folderId };
  return null;
}

export async function lookupSeededCsvTableId(
  opts: SeededCsvDesk,
): Promise<string | null> {
  if (isWebPreview()) return null;
  const path = seededCsvRelPath(opts.path);
  if (!path) return null;
  const desk = resolveDesk(opts);
  if (!desk) return null;
  try {
    const hit = await lookupTableBySource({
      path,
      folderId: desk.folderId ?? null,
      conversationId: desk.conversationId ?? null,
    });
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

export async function tryNavigateSeededCsv(
  opts: SeededCsvDesk,
  go?: (to: string) => void,
): Promise<boolean> {
  const id = await lookupSeededCsvTableId(opts);
  if (!id) return false;
  const to = `/tables/${id}`;
  if (go) go(to);
  else appNavigate(to);
  return true;
}
