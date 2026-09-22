import { InlineInput } from "@/components/files/FileTreeInline";
import {
  UNTITLED_PROMPT_FOLDER_NAME,
  uniqueNumberedName,
} from "@/components/files/dedupeName";
import {
  type MineBatchConfirmState,
  type MineBatchFailure,
  type MineBatchFailureState,
  PromptCatalogBatchDialogs,
} from "@/components/tools/PromptCatalogBatchDialogs";
import { PromptCatalogSelectionBar } from "@/components/tools/PromptCatalogSelectionBar";
import {
  type PromptDropDest,
  PromptOverview,
} from "@/components/tools/PromptOverview";
import { PromptReadDialog } from "@/components/tools/PromptReadDialog";
import { Button, SearchField } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLlmProviders } from "@/hooks/useLlmProviders";
import { useModels } from "@/hooks/useModels";
import {
  TOOLS_GATE_HINT,
  TOOL_CALLING_TOOL_NAMES,
  needsToolsGateHint,
} from "@/lib/llmToolsGate";
import {
  type AccountScopeEntry,
  OTHER_FOLDER_NAME,
  OVERVIEW_CATALOG_ID,
  type PromptCatalogItem,
  type PromptRailFolder,
  buildMineCatalogRows,
  buildPromptRail,
  flattenPromptRail,
  mineCatalogId,
  onDemandDropFolder,
  skillCatalogId,
  toolCatalogId,
} from "@/lib/promptCatalog";
import {
  PROMPT_DRAG_MIME,
  isPromptDrag,
  parsePromptDragPayload,
  promptDragPayload,
} from "@/lib/promptCatalogDrag";
import {
  EMPTY_MINE_SELECTION,
  type MineSelectedItem,
  clickIntent,
  dropFromSelection,
  flattenVisibleMineItems,
  isSelectionOnlyClick,
  mineItemOf,
  selectRow,
  selectionCatalogIds,
  selectionForContextMenu,
  selectionHas,
} from "@/lib/promptCatalogSelection";
import { ToolboxSourceTabs } from "@/pages/toolbox/ToolboxSourceTabs";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { ApiError } from "@/services/api";
import type { Capabilities } from "@/services/capabilities";
import {
  createRuleDocument,
  createRuleFolder,
  deleteDocument,
  listAccountPromptTree,
  listScopeEntries,
  renameDocument,
  reparentDocument,
  writeDocument,
} from "@/services/documents";
import { defaultChatSupportsTools } from "@/services/llmProviders";
import {
  EMPTY_SKILL_CATALOG,
  type SkillCatalog,
  composeOnDemandSkillContent,
  composeSkillContent,
  getSkillCatalog,
  skillFileName,
} from "@/services/skillCatalog";
import {
  type SkillStoreListing,
  listInstalledSkills,
  listMySkillListings,
  publishSkill,
  publishSkillVersion,
  unpublishSkill,
} from "@/services/skillStore";
import { Pencil, Trash2 } from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

function overlayErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.serverMessage?.trim()) return err.serverMessage;
    try {
      const parsed = JSON.parse(err.body) as { detail?: unknown };
      if (typeof parsed.detail === "string" && parsed.detail.trim()) {
        return parsed.detail;
      }
    } catch {
      /* keep falling through */
    }
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return "没保存成功";
}

function hasPromptDrag(event: DragEvent): boolean {
  return isPromptDrag(Array.from(event.dataTransfer.types));
}

function promptDragTypes(event: DragEvent): string[] {
  return Array.from(event.dataTransfer.types);
}

function readPromptDrag(event: DragEvent) {
  return parsePromptDragPayload(event.dataTransfer.getData(PROMPT_DRAG_MIME));
}

function toScopeEntry(
  doc: Awaited<ReturnType<typeof listScopeEntries>>[number],
): AccountScopeEntry {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    applyMode: doc.applyMode,
    aiMaintained: doc.aiMaintained,
    disputedAt: doc.disputedAt,
    alwaysChars: doc.alwaysChars,
    parentId: doc.parentId,
  };
}

/** Portrait overview + centered read dialog for the 工具箱「提示词」page. */
export function PromptCatalog({ data }: { data: Capabilities }) {
  const location = useLocation();
  const pane = location.pathname.startsWith(APP_PATHS.toolbox.official)
    ? "official"
    : "mine";
  const [searchParams, setSearchParams] = useSearchParams();
  const [overlay, setOverlay] = useState<SkillCatalog>(EMPTY_SKILL_CATALOG);
  const [accountEntries, setAccountEntries] = useState<AccountScopeEntry[]>([]);
  const [listings, setListings] = useState<SkillStoreListing[]>([]);
  const [installedListings, setInstalledListings] = useState<
    SkillStoreListing[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulesDirId, setRulesDirId] = useState<string | null>(null);
  const [promptFolders, setPromptFolders] = useState<
    { id: string; name: string }[]
  >([]);
  const [createFolderId, setCreateFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingMineId, setRenamingMineId] = useState<string | null>(null);
  const [dropDest, setDropDest] = useState<PromptDropDest | null>(null);
  const { data: llmProviders } = useLlmProviders();
  const { data: modelCatalog } = useModels();
  const showToolsHint = needsToolsGateHint(
    defaultChatSupportsTools(llmProviders, modelCatalog?.current?.provider_id),
  );

  const mineRows = useMemo(
    () => buildMineCatalogRows(overlay.mine, accountEntries),
    [overlay.mine, accountEntries],
  );
  const rail = useMemo(
    () => buildPromptRail(data, mineRows, promptFolders, rulesDirId),
    [data, mineRows, promptFolders, rulesDirId],
  );
  const items = useMemo(() => flattenPromptRail(rail), [rail]);
  const otherDrop = useMemo(() => onDemandDropFolder(rail), [rail]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(() => {
    const tool = searchParams.get("tool");
    if (tool) return toolCatalogId(tool);
    const skill = searchParams.get("skill");
    if (skill) return skillCatalogId(skill);
    return OVERVIEW_CATALOG_ID;
  });
  const [selection, setSelection] = useState(EMPTY_MINE_SELECTION);
  const [deleteConfirm, setDeleteConfirm] =
    useState<MineBatchConfirmState | null>(null);
  const [batchFailure, setBatchFailure] =
    useState<MineBatchFailureState | null>(null);

  const visibleMine = useMemo(
    () => flattenVisibleMineItems(rail, query),
    [rail, query],
  );
  const pickedIds = useMemo(() => selectionCatalogIds(selection), [selection]);

  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const dialogOpen = selectedItem != null;

  useEffect(() => {
    const live = new Set(
      items.filter((row) => row.kind === "mine").map((row) => row.id),
    );
    setSelection((sel) =>
      dropFromSelection(
        sel,
        sel.items
          .filter((row) => !live.has(row.catalogId))
          .map((row) => row.catalogId),
      ),
    );
  }, [items]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteConfirm || batchFailure) return;
      if (dialogOpen) return;
      if (selection.items.length === 0) return;
      setSelection(EMPTY_MINE_SELECTION);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [batchFailure, deleteConfirm, dialogOpen, selection.items.length]);

  const closeDialog = useCallback(() => {
    setSelectedId(OVERVIEW_CATALOG_ID);
    setCreateFolderId(null);
    setRenamingMineId(null);
    setRenamingFolderId(null);
    if (searchParams.has("tool") || searchParams.has("skill")) {
      const next = new URLSearchParams(searchParams);
      next.delete("tool");
      next.delete("skill");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const loadAccountLayer = useCallback(async (): Promise<SkillCatalog> => {
    const [catalog, entries, tree] = await Promise.all([
      getSkillCatalog(null),
      listScopeEntries(null).catch(() => []),
      listAccountPromptTree().catch(() => ({
        rulesDirId: null,
        folders: [] as { id: string; name: string }[],
        documents: [],
      })),
    ]);
    setAccountEntries(entries.map(toScopeEntry));
    setRulesDirId(tree.rulesDirId);
    setPromptFolders(
      tree.folders.map((folder) => ({ id: folder.id, name: folder.name })),
    );
    return catalog;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAccountLayer()
      .then((catalog) => {
        if (!cancelled) setOverlay(catalog);
      })
      .catch(() => {
        if (!cancelled) {
          setOverlay(EMPTY_SKILL_CATALOG);
          setAccountEntries([]);
        }
      });
    void Promise.all([listMySkillListings(), listInstalledSkills()])
      .then(([mine, installed]) => {
        if (cancelled) return;
        setListings(mine);
        setInstalledListings(installed);
      })
      .catch(() => {
        if (cancelled) return;
        setListings([]);
        setInstalledListings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAccountLayer]);

  async function persist(
    action: () => Promise<SkillCatalog | undefined>,
    opts?: { lock?: boolean },
  ): Promise<boolean> {
    const lock = opts?.lock !== false;
    if (lock) setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        setOverlay(next);
        const [entries, tree] = await Promise.all([
          listScopeEntries(null).catch(() => []),
          listAccountPromptTree().catch(() => ({
            rulesDirId: null,
            folders: [] as { id: string; name: string }[],
            documents: [],
          })),
        ]);
        setAccountEntries(entries.map(toScopeEntry));
        setRulesDirId(tree.rulesDirId);
        setPromptFolders(
          tree.folders.map((folder) => ({ id: folder.id, name: folder.name })),
        );
      } else {
        setOverlay(await loadAccountLayer());
      }
      return true;
    } catch (err) {
      setError(overlayErrorMessage(err));
      return false;
    } finally {
      if (lock) setBusy(false);
    }
  }

  async function ensureNamedFolder(name: string): Promise<string> {
    const existing = promptFolders.find((folder) => folder.name === name);
    if (existing) return existing.id;
    const created = await createRuleFolder(name);
    return created.id;
  }

  async function onCreateMine() {
    setRenamingFolderId(null);
    setRenamingMineId(null);
    await persist(async () => {
      const parentId =
        createFolderId ?? (await ensureNamedFolder(OTHER_FOLDER_NAME));
      const created = await createRuleDocument(
        skillFileName("未命名提示词"),
        null,
        composeOnDemandSkillContent("", ""),
        "on_demand",
        parentId,
      );
      const catalog = await loadAccountLayer();
      setSelectedId(mineCatalogId(created.id));
      return catalog;
    });
  }

  async function createUntitledPromptFolder() {
    setRenamingMineId(null);
    let createdId: string | null = null;
    const ok = await persist(async () => {
      const name = uniqueNumberedName(
        UNTITLED_PROMPT_FOLDER_NAME,
        promptFolders.map((folder) => folder.name),
      );
      const created = await createRuleFolder(name);
      createdId = created.id;
      setCreateFolderId(created.id);
      return undefined;
    });
    if (ok && createdId) setRenamingFolderId(createdId);
  }

  async function submitRenameFolder(id: string, raw: string) {
    setRenamingFolderId(null);
    const name = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!name || name.includes("/")) return;
    const current = promptFolders.find((folder) => folder.id === id);
    if (current && current.name === name) return;
    await persist(async () => {
      await renameDocument(id, name);
      return undefined;
    });
  }

  function alreadyAtDest(
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    dest: PromptRailFolder | "root",
  ): boolean {
    if (dest === "root") return item.applyMode === "always";
    return Boolean(dest.documentId && item.parentId === dest.documentId);
  }

  async function reparentMine(
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    dest: PromptRailFolder | "root",
  ) {
    if (dest === "root") {
      let parent = rulesDirId;
      if (!parent) {
        await createRuleFolder(OTHER_FOLDER_NAME);
        parent = (await listAccountPromptTree()).rulesDirId;
      }
      if (!parent) throw new Error("没找到常驻目录");
      await reparentDocument(item.mineId, parent, "always");
      return;
    }
    let folderId = dest.documentId;
    if (!folderId) folderId = await ensureNamedFolder(dest.name);
    await reparentDocument(item.mineId, folderId, "on_demand");
  }

  async function moveMineItems(
    mineIds: readonly string[],
    dest: PromptRailFolder | "root",
  ) {
    const failures: MineBatchFailure[] = [];
    setBusy(true);
    setError(null);
    try {
      for (const mineId of mineIds) {
        const item = items.find(
          (row) => row.kind === "mine" && row.mineId === mineId,
        );
        if (!item || item.kind !== "mine") continue;
        if (alreadyAtDest(item, dest)) continue;
        try {
          await reparentMine(item, dest);
        } catch (err) {
          failures.push({
            id: item.id,
            name: item.label,
            reason: overlayErrorMessage(err),
          });
        }
      }
      setOverlay(await loadAccountLayer());
      if (failures.length > 0) {
        setBatchFailure({ title: "有些条目没有移过去", failures });
      }
    } catch (err) {
      setError(overlayErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function acceptPromptDrag(event: DragEvent, dest: PromptDropDest) {
    const types = promptDragTypes(event);
    if (!isPromptDrag(types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropDest(dest);
  }

  function dropPromptFile(event: DragEvent, dest: PromptRailFolder | "root") {
    event.preventDefault();
    event.stopPropagation();
    setDropDest(null);
    const payload = readPromptDrag(event);
    if (!payload || payload.kind === "skill") return;
    void moveMineItems(payload.mineIds, dest);
  }

  function rejectPromptDrag(event: DragEvent) {
    if (!hasPromptDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "none";
    setDropDest(null);
  }

  function handleActivate(
    id: string,
    event?: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
  ) {
    const item = items.find((row) => row.id === id);
    const mine = item ? mineItemOf(item) : null;
    const intent = event ? clickIntent(event) : { toggle: false, range: false };
    if (mine) {
      setSelection((sel) => selectRow(sel, mine, intent, visibleMine));
      if (isSelectionOnlyClick(intent)) return;
      setSelectedId(id);
      return;
    }
    if (isSelectionOnlyClick(intent)) return;
    setSelection(EMPTY_MINE_SELECTION);
    setSelectedId(id);
  }

  function startRenameMine(item: PromptCatalogItem) {
    if (item.kind !== "mine" || !item.mineId || item.aiMaintained) return;
    setRenamingFolderId(null);
    setRenamingMineId(item.mineId);
  }

  async function submitRenameMine(item: PromptCatalogItem, raw: string) {
    if (item.kind !== "mine" || !item.mineId || item.aiMaintained) return;
    setRenamingMineId(null);
    const name = skillFileName(raw.trim());
    if (name === ".md" || name === skillFileName(item.label)) return;
    await persist(async () => {
      await renameDocument(item.mineId, name);
      return undefined;
    });
  }

  function requestDelete(rows: readonly MineSelectedItem[]) {
    if (rows.length === 0) return;
    const hasMarket = rows.some((row) =>
      installedListings.some(
        (listing) => listing.installDocumentId === row.mineId,
      ),
    );
    setDeleteConfirm({ items: rows, hasMarket, busy: false });
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    const doomed = deleteConfirm.items;
    setDeleteConfirm({ ...deleteConfirm, busy: true });
    const failures: MineBatchFailure[] = [];
    const deleted: string[] = [];
    setError(null);
    try {
      for (const row of doomed) {
        try {
          await deleteDocument(row.mineId);
          deleted.push(row.catalogId);
        } catch (err) {
          failures.push({
            id: row.catalogId,
            name: row.label,
            reason: overlayErrorMessage(err),
          });
        }
      }
      setOverlay(await loadAccountLayer());
      setSelection((sel) => dropFromSelection(sel, deleted));
      if (doomed.some((row) => row.catalogId === selectedId)) {
        setSelectedId(OVERVIEW_CATALOG_ID);
      }
      setDeleteConfirm(null);
      if (failures.length > 0) {
        setBatchFailure({ title: "有些条目没有删掉", failures });
      }
    } catch (err) {
      setError(overlayErrorMessage(err));
      setDeleteConfirm((current) =>
        current ? { ...current, busy: false } : null,
      );
    }
  }

  function wrapMineTile({
    item,
    children,
  }: {
    item: PromptCatalogItem;
    children: ReactNode;
  }) {
    if (item.kind !== "mine" || !item.mineId) {
      return children;
    }
    if (item.mineId === renamingMineId) {
      return (
        <div className="flex min-h-10 items-center rounded-xl border border-border px-4">
          <InlineInput
            initial={item.label}
            ariaLabel="条目名称"
            onSubmit={(value) => void submitRenameMine(item, value)}
            onCancel={() => setRenamingMineId(null)}
          />
        </div>
      );
    }
    const mine = mineItemOf(item);
    const inBatch =
      Boolean(mine) &&
      selection.items.length >= 2 &&
      selectionHas(selection, item.id);
    const inner = (
      <div
        className="min-h-10 min-w-0"
        draggable
        onContextMenu={() => {
          if (mine) setSelection((sel) => selectionForContextMenu(sel, mine));
        }}
        onDragStart={(event) => {
          const inSelection =
            selectionHas(selection, item.id) && selection.items.length > 0;
          const mineIds = inSelection
            ? selection.items.map((row) => row.mineId)
            : [item.mineId];
          event.dataTransfer.setData(
            PROMPT_DRAG_MIME,
            promptDragPayload({ kind: "mine", mineIds }),
          );
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDropDest(null)}
      >
        {children}
      </div>
    );
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>
        <ContextMenuContent>
          {inBatch ? (
            <ContextMenuItem
              variant="danger"
              onSelect={() => requestDelete(selection.items)}
            >
              <Trash2 size={14} className="shrink-0" />
              删除 {selection.items.length} 项
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem onSelect={() => startRenameMine(item)}>
                <Pencil size={14} className="shrink-0" />
                重命名
              </ContextMenuItem>
              <ContextMenuItem
                variant="danger"
                onSelect={() => {
                  if (mine) requestDelete([mine]);
                }}
              >
                <Trash2 size={14} className="shrink-0" />
                删除
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (
    pane === "mine" &&
    (searchParams.get("tool") || searchParams.get("skill"))
  ) {
    const qs = searchParams.toString();
    return (
      <Navigate
        to={`${APP_PATHS.toolbox.official}${qs ? `?${qs}` : ""}`}
        replace
      />
    );
  }
  return (
    <div className="w-full" data-testid="prompt-catalog">
      <ToolboxSourceTabs
        action={
          <>
            <SearchField
              aria-label={pane === "official" ? "搜提示词、工具" : "搜提示词"}
              placeholder={pane === "official" ? "搜提示词、工具" : "搜提示词"}
              value={query}
              onValueChange={setQuery}
              className="w-52"
            />
            {pane === "mine" ? (
              <Button
                size="md"
                disabled={busy}
                onClick={() => void onCreateMine()}
              >
                新建
              </Button>
            ) : null}
          </>
        }
      />
      {error ? (
        <p className="mb-3 text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {selection.items.length >= 2 ? (
        <PromptCatalogSelectionBar
          count={selection.items.length}
          busy={busy || Boolean(deleteConfirm?.busy)}
          onDelete={() => requestDelete(selection.items)}
          onClear={() => setSelection(EMPTY_MINE_SELECTION)}
        />
      ) : null}
      <div
        onDragOver={(event) => {
          if (!hasPromptDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "none";
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDropDest(null);
        }}
      >
        <PromptOverview
          pane={pane}
          rail={rail}
          selectedId={selectedId === OVERVIEW_CATALOG_ID ? null : selectedId}
          pickedIds={pickedIds}
          dropDest={dropDest}
          otherFolder={otherDrop}
          renamingFolderId={renamingFolderId}
          busy={busy}
          listings={listings}
          installedListings={installedListings}
          query={query}
          onOpenItem={handleActivate}
          onCreateMine={() => void onCreateMine()}
          onCreateFolder={() => void createUntitledPromptFolder()}
          onSubmitRenameFolder={(id, name) => void submitRenameFolder(id, name)}
          onCancelRenameFolder={() => setRenamingFolderId(null)}
          onAcceptAlwaysDrag={(event) =>
            acceptPromptDrag(event, { kind: "root" })
          }
          onDropAlways={(event) => dropPromptFile(event, "root")}
          onAcceptFolderDrag={(event, folder) =>
            acceptPromptDrag(event, { kind: "folder", folder })
          }
          onDropFolder={(event, folder) => dropPromptFile(event, folder)}
          onRejectDrag={rejectPromptDrag}
          renderMineTile={wrapMineTile}
        />
      </div>
      <PromptReadDialog
        open={dialogOpen}
        item={selectedItem}
        overlay={overlay}
        listings={listings}
        installedListings={installedListings}
        busy={busy}
        showToolsHint={showToolsHint}
        toolsHint={TOOLS_GATE_HINT}
        toolCallingNames={TOOL_CALLING_TOOL_NAMES}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onSaveMine={(item, draft) =>
          persist(
            async () => {
              const fileName = skillFileName(draft.name);
              if (fileName !== skillFileName(item.label)) {
                await renameDocument(item.mineId, fileName);
              }
              const mode = draft.applyMode ?? item.applyMode;
              if (mode === "paths" && !draft.paths.trim()) {
                throw new Error("碰到文件要写路径，比如 **/*.tsx");
              }
              const written = await writeDocument(
                item.mineId,
                composeSkillContent(
                  mode,
                  draft.description,
                  draft.body,
                  draft.paths,
                ),
                item.version,
              );
              if (written.conflict) {
                throw new Error("刚有更新，刷新后再保存");
              }
              if (!written.ok) {
                throw new Error("没保存成功");
              }
              return undefined;
            },
            { lock: false },
          )
        }
        onPublishMine={(item, group) =>
          void persist(async () => {
            const existing = listings.find(
              (row) => row.documentId === item.mineId,
            );
            if (existing?.status === "taken_down") return undefined;
            if (existing?.status === "published") {
              await publishSkillVersion(existing.id, item.mineId, group);
            } else {
              await publishSkill(item.mineId, group);
            }
            setListings(await listMySkillListings());
            return undefined;
          })
        }
        onUnpublishMine={(item) =>
          void persist(async () => {
            const existing = listings.find(
              (row) => row.documentId === item.mineId,
            );
            if (!existing) return undefined;
            await unpublishSkill(existing.id);
            setListings(await listMySkillListings());
            return undefined;
          })
        }
      />
      <PromptCatalogBatchDialogs
        confirm={deleteConfirm}
        onConfirmDelete={() => void confirmDelete()}
        onCancelDelete={() => {
          if (!deleteConfirm?.busy) setDeleteConfirm(null);
        }}
        failure={batchFailure}
        onCloseFailure={() => setBatchFailure(null)}
      />
    </div>
  );
}
