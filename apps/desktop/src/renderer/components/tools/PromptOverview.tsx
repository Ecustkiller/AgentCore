import { InlineInput } from "@/components/files/FileTreeInline";
import { FACE_META } from "@/components/tools/catalogMeta";
import {
  Badge,
  CATALOG_GRID_CLASS,
  Card,
  CatalogIconShell,
  CatalogTile,
  SurfaceRowButton,
} from "@/components/ui";
import { artifactColorVar, catalogCategoryColorVar } from "@/lib/catalogColors";
import type {
  PromptCatalogItem,
  PromptRail,
  PromptRailFolder,
} from "@/lib/promptCatalog";
import {
  PROMPT_SHELF_AFFORDANCE,
  type PromptShelfChip,
  promptItemShelfCopy,
  promptMineShelfOpts,
  promptShelfHeaderChips,
} from "@/lib/promptShelfTile";
import { buildAlwaysRows, formatAlwaysRowChars } from "@/lib/promptSizes";
import { cn } from "@/lib/utils";
import type { SkillStoreListing } from "@/services/skillStore";
import { BookOpen, FileText, ScrollText, Wrench } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { useMemo } from "react";

const EMPTY_PICKED: ReadonlySet<string> = new Set();

export type PromptDropDest =
  | { kind: "root" }
  | { kind: "folder"; folder: PromptRailFolder };

export type PromptOverviewPane = "official" | "mine";

function matchQuery(
  query: string,
  ...parts: Array<string | undefined>
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some((part) => part?.toLowerCase().includes(q));
}

export function PromptOverview({
  pane,
  rail,
  selectedId,
  pickedIds,
  dropDest,
  otherFolder,
  busy,
  listings = [],
  installedListings = [],
  renamingFolderId = null,
  query = "",
  onOpenItem,
  onCreateMine: _onCreateMine,
  onCreateFolder,
  onSubmitRenameFolder,
  onCancelRenameFolder,
  onAcceptAlwaysDrag,
  onDropAlways,
  onAcceptFolderDrag,
  onDropFolder,
  onRejectDrag,
  renderMineTile,
}: {
  pane: PromptOverviewPane;
  rail: PromptRail;
  selectedId: string | null;
  /** 我的 / 市场多选高亮（catalog id）。与 selectedId（当前读卡）分开。 */
  pickedIds?: ReadonlySet<string>;
  dropDest: PromptDropDest | null;
  otherFolder: PromptRailFolder;
  busy: boolean;
  listings?: SkillStoreListing[];
  installedListings?: SkillStoreListing[];
  renamingFolderId?: string | null;
  query?: string;
  onOpenItem: (
    id: string,
    event?: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
  ) => void;
  onCreateMine: () => void;
  onCreateFolder: () => void;
  onSubmitRenameFolder: (id: string, name: string) => void;
  onCancelRenameFolder: () => void;
  onAcceptAlwaysDrag: (event: DragEvent) => void;
  onDropAlways: (event: DragEvent) => void;
  onAcceptFolderDrag: (event: DragEvent, folder: PromptRailFolder) => void;
  onDropFolder: (event: DragEvent, folder: PromptRailFolder) => void;
  onRejectDrag: (event: DragEvent) => void;
  renderMineTile?: (row: {
    item: PromptCatalogItem;
    children: ReactNode;
  }) => ReactNode;
}) {
  const picked = pickedIds ?? EMPTY_PICKED;
  const q = query.trim();
  const alwaysRows = useMemo(() => {
    const rows = buildAlwaysRows(rail);
    if (pane === "official") {
      return rows.filter((row) => row.item.kind === "shared");
    }
    return rows.filter((row) => row.item.kind === "mine");
  }, [rail, pane]);
  const visibleAlways = alwaysRows.filter((row) => {
    const copy = promptItemShelfCopy(row.item, { alwaysChars: row.chars });
    return matchQuery(q, copy.title, copy.description, row.label);
  });
  const folders = rail.folders
    .map((folder) => ({
      ...folder,
      items: folder.items.filter((item) => {
        const copy = promptItemShelfCopy(item);
        return matchQuery(
          q,
          folder.name,
          copy.title,
          copy.description,
          item.label,
        );
      }),
    }))
    .filter(
      (folder) => !q || folder.items.length > 0 || matchQuery(q, folder.name),
    );
  const factoryTools = rail.tools.filter(
    (item) =>
      item.tool.resident &&
      matchQuery(
        q,
        item.label,
        item.tool.summary,
        item.tool.blurb,
        item.tool.description,
      ),
  );
  const deferredTools = rail.tools.filter(
    (item) =>
      !item.tool.resident &&
      matchQuery(
        q,
        item.label,
        item.tool.summary,
        item.tool.blurb,
        item.tool.description,
      ),
  );
  const howItems = rail.official.filter((item) => {
    const copy = promptItemShelfCopy(item);
    return matchQuery(q, copy.title, copy.description, item.label);
  });
  const promptItems =
    pane === "official"
      ? [...visibleAlways.map((row) => row.item), ...howItems]
      : [];
  const showDemand = pane === "mine" && (!q || folders.length > 0);
  const toolItems = [...factoryTools, ...deferredTools];
  const showPrompts = promptItems.length > 0;
  const showTools = pane === "official" && toolItems.length > 0;
  const emptySearch =
    Boolean(q) &&
    (pane === "mine" ? visibleAlways.length === 0 : promptItems.length === 0) &&
    !showDemand &&
    !showTools;

  return (
    <div className="flex w-full flex-col gap-8" data-testid="prompt-overview">
      {pane === "mine" ? (
        <section
          data-testid="prompt-rail-always"
          data-prompt-drop="root"
          className="min-w-0"
          onDragOver={onAcceptAlwaysDrag}
          onDrop={onDropAlways}
        >
          <RailHeading meta={`${visibleAlways.length} 条`}>必带</RailHeading>
          {visibleAlways.length === 0 ? (
            <DropWell highlighted={dropDest?.kind === "root"}>
              {q ? "没有匹配的必带条目。" : "拖一条进来，下一回合就会带上。"}
            </DropWell>
          ) : (
            <div
              className={cn(
                "mt-3 grid grid-cols-3 gap-3",
                dropDest?.kind === "root" && "rounded-xl ring-2 ring-ring",
              )}
            >
              {visibleAlways.map((row) => (
                <ItemCard
                  key={row.catalogId}
                  item={row.item}
                  alwaysChars={row.chars}
                  selected={selectedId === row.catalogId}
                  picked={picked.has(row.catalogId)}
                  listings={listings}
                  installedListings={installedListings}
                  onOpen={(event) => onOpenItem(row.catalogId, event)}
                  renderMineTile={renderMineTile}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {showDemand ? (
        <section
          data-testid="prompt-rail-on-demand"
          data-prompt-drop="folder"
          className="min-w-0"
          onDragOver={(event) => onAcceptFolderDrag(event, otherFolder)}
          onDrop={(event) => onDropFolder(event, otherFolder)}
        >
          <RailHeading
            meta={`${folders.reduce((sum, folder) => sum + folder.items.length, 0)} 条`}
            actions={
              busy || q ? null : (
                <div
                  className="flex items-center gap-1"
                  data-testid="prompt-rail-create"
                >
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={onCreateFolder}
                  >
                    新建夹
                  </button>
                </div>
              )
            }
          >
            按需
          </RailHeading>
          {folders.length === 0 ? (
            <DropWell
              highlighted={
                dropDest?.kind === "folder" &&
                dropDest.folder.id === otherFolder.id
              }
            >
              还没有夹。
            </DropWell>
          ) : (
            <div data-testid="my-skills" className="mt-3 flex flex-col gap-4">
              {folders.map((folder) => {
                const highlighted =
                  dropDest?.kind === "folder" &&
                  dropDest.folder.id === folder.id;
                const renaming =
                  Boolean(renamingFolderId) &&
                  renamingFolderId === folder.documentId;
                return (
                  <Card
                    key={folder.id}
                    className={cn(
                      "overflow-hidden",
                      highlighted && "ring-2 ring-ring",
                    )}
                    onDragOver={(event) => onAcceptFolderDrag(event, folder)}
                    onDrop={(event) => onDropFolder(event, folder)}
                  >
                    {renaming && folder.documentId ? (
                      <div className="px-3 py-2.5">
                        <InlineInput
                          initial={folder.name}
                          ariaLabel="夹名称"
                          commitOnBlur
                          onSubmit={(value) =>
                            onSubmitRenameFolder(
                              folder.documentId as string,
                              value,
                            )
                          }
                          onCancel={onCancelRenameFolder}
                        />
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-2 px-3 py-2.5">
                        <h3 className="text-sm font-medium text-foreground">
                          {folder.name}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          {folder.items.length} 条
                        </span>
                      </div>
                    )}
                    {folder.items.length === 0 ? (
                      <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">
                        {PROMPT_SHELF_AFFORDANCE.dropHere.title}
                      </p>
                    ) : (
                      <div className="divide-y divide-border border-t border-border">
                        {folder.items.map((item) => (
                          <ItemRow
                            key={item.id}
                            item={item}
                            selected={selectedId === item.id}
                            picked={picked.has(item.id)}
                            listings={listings}
                            installedListings={installedListings}
                            onOpen={(event) => onOpenItem(item.id, event)}
                            renderMineTile={renderMineTile}
                          />
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {showPrompts ? (
        <section
          className="min-w-0"
          data-testid="prompt-rail-prompts"
          onDragOver={onRejectDrag}
          onDrop={onRejectDrag}
        >
          <RailHeading meta={`${promptItems.length} 条`}>提示词</RailHeading>
          <div className={`mt-3 ${CATALOG_GRID_CLASS}`}>
            {promptItems.map((item) => (
              <HandsTile
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={(event) => onOpenItem(item.id, event)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {showTools ? (
        <section
          className="min-w-0"
          data-testid="prompt-rail-tools"
          onDragOver={onRejectDrag}
          onDrop={onRejectDrag}
        >
          <RailHeading meta="出厂自带，点开说明书">工具</RailHeading>
          <div className={`mt-3 ${CATALOG_GRID_CLASS}`}>
            {toolItems.map((item) => (
              <HandsTile
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={(event) => onOpenItem(item.id, event)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {emptySearch ? (
        <p className="text-sm text-muted-foreground">没有匹配「{q}」的条目。</p>
      ) : null}
    </div>
  );
}

function DropWell({
  children,
  highlighted,
}: {
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-3 flex min-h-[4.5rem] items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground",
        highlighted && "ring-2 ring-ring",
      )}
    >
      {children}
    </div>
  );
}

function RailHeading({
  children,
  meta,
  actions,
}: {
  children: ReactNode;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-sm font-semibold text-foreground">{children}</h2>
      {meta ? (
        <span className="text-xs text-muted-foreground">{meta}</span>
      ) : null}
      {actions ? <div className="ml-auto">{actions}</div> : null}
    </div>
  );
}

function ItemCard({
  item,
  alwaysChars,
  selected,
  picked,
  listings,
  installedListings,
  onOpen,
  renderMineTile,
}: {
  item: PromptCatalogItem;
  alwaysChars?: number;
  selected: boolean;
  picked?: boolean;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  renderMineTile?: (row: {
    item: PromptCatalogItem;
    children: ReactNode;
  }) => ReactNode;
}) {
  const mineOpts =
    item.kind === "mine"
      ? promptMineShelfOpts(item, listings, installedListings)
      : {};
  const copy = promptItemShelfCopy(item, { ...mineOpts, alwaysChars });
  const visual = tileVisual(item);
  const chars = alwaysChars == null ? null : formatAlwaysRowChars(alwaysChars);
  const card = (
    <button
      type="button"
      aria-label={copy.title}
      aria-selected={picked || selected}
      onClick={onOpen}
      className={cn(
        "flex min-h-[4.5rem] w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        "hover:border-foreground/15 hover:bg-muted/40",
        picked
          ? "border-foreground/20 bg-accent text-accent-foreground"
          : selected
            ? "border-foreground/20 bg-muted/50"
            : "border-border/70 bg-card",
      )}
    >
      <CatalogIconShell
        className="mt-0.5 shrink-0"
        colorVar={visual.colorVar}
        size="md"
      >
        {visual.icon}
      </CatalogIconShell>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {copy.title}
        </span>
        {chars ? (
          <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
            {chars}
          </span>
        ) : null}
      </span>
    </button>
  );
  const wrapped = renderMineTile
    ? renderMineTile({ item, children: card })
    : card;
  return (
    <div
      data-testid={`prompt-tile-${item.id}`}
      data-prompt-tile={item.id}
      className="min-w-0"
    >
      {wrapped}
    </div>
  );
}

function ItemRow({
  item,
  selected,
  picked,
  listings,
  installedListings,
  onOpen,
  renderMineTile,
}: {
  item: PromptCatalogItem;
  selected: boolean;
  picked?: boolean;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  renderMineTile?: (row: {
    item: PromptCatalogItem;
    children: ReactNode;
  }) => ReactNode;
}) {
  const mineOpts =
    item.kind === "mine"
      ? promptMineShelfOpts(item, listings, installedListings)
      : {};
  const copy = promptItemShelfCopy(item, mineOpts);
  const visual = tileVisual(item);
  const chips = shelfChips(promptShelfHeaderChips(copy));
  const row = (
    <SurfaceRowButton
      variant="default"
      aria-label={copy.title}
      aria-selected={picked || selected}
      className={cn(
        "w-full gap-3 rounded-none px-3 py-2.5 text-left",
        (picked || selected) && "bg-accent text-accent-foreground",
      )}
      onClick={onOpen}
    >
      <CatalogIconShell
        colorVar={visual.colorVar}
        className="size-8 rounded-lg"
      >
        {visual.icon}
      </CatalogIconShell>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {copy.title}
        </span>
        {copy.description ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {copy.description}
          </span>
        ) : null}
      </span>
      {chips}
    </SurfaceRowButton>
  );
  const wrapped = renderMineTile
    ? renderMineTile({ item, children: row })
    : row;
  return (
    <div
      data-testid={`prompt-tile-${item.id}`}
      data-prompt-tile={item.id}
      className="min-w-0"
    >
      {wrapped}
    </div>
  );
}

function HandsTile({
  item,
  selected,
  onOpen,
}: {
  item: PromptCatalogItem;
  selected: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const copy = promptItemShelfCopy(item);
  const visual = tileVisual(item);
  const accessory = copy.accessory.length ? (
    <>{shelfBadgeList(copy.accessory)}</>
  ) : undefined;
  const tags = copy.tags.length ? (
    <>{shelfBadgeList(copy.tags.map((label) => ({ label })))}</>
  ) : undefined;
  return (
    <div
      data-prompt-tile={item.id}
      data-testid={`prompt-tile-${item.id}`}
      className="min-w-0"
    >
      <CatalogTile
        icon={visual.icon}
        colorVar={visual.colorVar}
        title={copy.title}
        description={copy.description}
        accessory={accessory}
        tags={tags}
        onClick={onOpen}
        className={selected ? "border-foreground/20 bg-muted/50" : undefined}
      />
    </div>
  );
}

function tileVisual(item: PromptCatalogItem): {
  icon: ReactNode;
  colorVar: string;
} {
  if (item.kind === "shared") {
    return {
      icon: <ScrollText size={18} />,
      colorVar: artifactColorVar("guidelines"),
    };
  }
  if (item.kind === "skill") {
    return {
      icon: <BookOpen size={18} />,
      colorVar: artifactColorVar("guidelines"),
    };
  }
  if (item.kind === "tool") {
    const meta = FACE_META[item.tool.face];
    const Icon = meta?.icon ?? Wrench;
    return {
      icon: <Icon size={18} />,
      colorVar: catalogCategoryColorVar(item.tool.face),
    };
  }
  return {
    icon: <FileText size={18} />,
    colorVar: artifactColorVar("guidelines"),
  };
}

function shelfBadgeList(chips: PromptShelfChip[]) {
  return chips.map((chip) => (
    <Badge key={chip.label} tone={chip.tone ?? "muted"} pill>
      {chip.label}
    </Badge>
  ));
}

function shelfChips(chips: PromptShelfChip[]) {
  if (!chips.length) return null;
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {shelfBadgeList(chips)}
    </span>
  );
}
