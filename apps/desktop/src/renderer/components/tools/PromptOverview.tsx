import { InlineInput } from "@/components/files/FileTreeInline";
import { FACE_META } from "@/components/tools/catalogMeta";
import { Badge, CATALOG_GRID_CLASS, CatalogTile } from "@/components/ui";
import { artifactColorVar, catalogCategoryColorVar } from "@/lib/catalogColors";
import type {
  PromptCatalogItem,
  PromptRail,
  PromptRailFolder,
} from "@/lib/promptCatalog";
import {
  PROMPT_SHELF_AFFORDANCE,
  type PromptShelfChip,
  promptConnectorShelfCopy,
  promptItemShelfCopy,
  promptMineShelfOpts,
} from "@/lib/promptShelfTile";
import { buildAlwaysRows } from "@/lib/promptSizes";
import { cn } from "@/lib/utils";
import type { SkillStoreListing } from "@/services/skillStore";
import {
  BookOpen,
  FileText,
  FolderPlus,
  Plus,
  ScrollText,
  Unplug,
  Wrench,
} from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { useMemo } from "react";

export type PromptDropDest =
  | { kind: "root" }
  | { kind: "folder"; folder: PromptRailFolder };

export type PromptOverviewConnector = {
  id: string;
  label: string;
  runtimeError?: string | null;
  accessory?: ReactNode;
};

const RAIL_SHELL = "rounded-xl border border-border bg-card/60 p-4";

export function PromptOverview({
  rail,
  selectedId,
  dropDest,
  otherFolder,
  connectors,
  connectorError,
  showConnectors,
  busy,
  listings = [],
  installedListings = [],
  renamingFolderId = null,
  onOpenItem,
  onCreateMine,
  onCreateFolder,
  onSubmitRenameFolder,
  onCancelRenameFolder,
  onAddConnector,
  onAcceptAlwaysDrag,
  onDropAlways,
  onAcceptFolderDrag,
  onDropFolder,
  onRejectDrag,
  renderMineTile,
}: {
  rail: PromptRail;
  selectedId: string | null;
  dropDest: PromptDropDest | null;
  otherFolder: PromptRailFolder;
  connectors: PromptOverviewConnector[];
  connectorError: string | null;
  showConnectors: boolean;
  busy: boolean;
  listings?: SkillStoreListing[];
  installedListings?: SkillStoreListing[];
  renamingFolderId?: string | null;
  onOpenItem: (id: string) => void;
  onCreateMine: () => void;
  onCreateFolder: () => void;
  onSubmitRenameFolder: (id: string, name: string) => void;
  onCancelRenameFolder: () => void;
  onAddConnector: (() => void) | null;
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
  const alwaysRows = useMemo(() => buildAlwaysRows(rail), [rail]);
  const constitutionRows = alwaysRows.filter(
    (row) => row.item.kind === "shared",
  );
  const alwaysMineRows = alwaysRows.filter((row) => row.item.kind === "mine");
  const residentTools = useMemo(
    () => rail.tools.filter((item) => item.tool.resident),
    [rail.tools],
  );
  const onDemandTools = useMemo(
    () => rail.tools.filter((item) => !item.tool.resident),
    [rail.tools],
  );

  return (
    <div className="flex w-full flex-col gap-8" data-testid="prompt-overview">
      <section
        data-testid="prompt-rail-always"
        data-prompt-drop="root"
        className={cn(
          RAIL_SHELL,
          dropDest?.kind === "root" && "ring-1 ring-inset ring-primary",
        )}
        onDragOver={onAcceptAlwaysDrag}
        onDrop={onDropAlways}
      >
        <RailHeading description="每回合都带着">常驻</RailHeading>
        <div className={CATALOG_GRID_CLASS}>
          {constitutionRows.map((row) => (
            <ItemTile
              key={row.catalogId}
              item={row.item}
              alwaysChars={row.chars}
              selected={selectedId === row.catalogId}
              listings={listings}
              installedListings={installedListings}
              onOpen={() => onOpenItem(row.catalogId)}
              renderMineTile={renderMineTile}
            />
          ))}
          {alwaysMineRows.map((row) => (
            <ItemTile
              key={row.catalogId}
              item={row.item}
              alwaysChars={row.chars}
              selected={selectedId === row.catalogId}
              listings={listings}
              installedListings={installedListings}
              onOpen={() => onOpenItem(row.catalogId)}
              renderMineTile={renderMineTile}
            />
          ))}
          {residentTools.map((item) => (
            <ItemTile
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              listings={listings}
              installedListings={installedListings}
              onOpen={() => onOpenItem(item.id)}
            />
          ))}
        </div>
      </section>

      <section
        data-testid="prompt-rail-on-demand"
        data-prompt-drop="folder"
        className={RAIL_SHELL}
        onDragOver={(event) => onAcceptFolderDrag(event, otherFolder)}
        onDrop={(event) => onDropFolder(event, otherFolder)}
      >
        <RailHeading description="用到才翻">按需</RailHeading>
        <div data-testid="prompt-rail-create" className={CATALOG_GRID_CLASS}>
          <CatalogTile
            icon={<Plus size={18} />}
            colorVar={artifactColorVar("guidelines")}
            title={PROMPT_SHELF_AFFORDANCE.createEntry.title}
            description={PROMPT_SHELF_AFFORDANCE.createEntry.description}
            onClick={busy ? undefined : onCreateMine}
          />
          <CatalogTile
            icon={<FolderPlus size={18} />}
            colorVar={artifactColorVar("guidelines")}
            title={PROMPT_SHELF_AFFORDANCE.createFolder.title}
            description={PROMPT_SHELF_AFFORDANCE.createFolder.description}
            onClick={busy ? undefined : onCreateFolder}
          />
        </div>

        {rail.folders.length > 0 ? (
          <div data-testid="my-skills">
            {rail.folders.map((folder) => {
              const highlighted =
                dropDest?.kind === "folder" && dropDest.folder.id === folder.id;
              return (
                <ShelfBlock
                  key={folder.id}
                  title={
                    renamingFolderId &&
                    renamingFolderId === folder.documentId ? (
                      <InlineInput
                        initial={folder.name}
                        ariaLabel="夹名称"
                        commitOnBlur
                        onSubmit={(value) => {
                          if (!folder.documentId) return;
                          onSubmitRenameFolder(folder.documentId, value);
                        }}
                        onCancel={onCancelRenameFolder}
                      />
                    ) : (
                      folder.name
                    )
                  }
                  highlighted={highlighted}
                  onDragOver={(event) => onAcceptFolderDrag(event, folder)}
                  onDrop={(event) => onDropFolder(event, folder)}
                >
                  {folder.items.length === 0 ? (
                    <CatalogTile
                      icon={<Plus size={18} />}
                      colorVar={artifactColorVar("guidelines")}
                      title={PROMPT_SHELF_AFFORDANCE.dropHere.title}
                      description={PROMPT_SHELF_AFFORDANCE.dropHere.description}
                      className="border-dashed"
                    />
                  ) : (
                    folder.items.map((item) => (
                      <ItemTile
                        key={item.id}
                        item={item}
                        selected={selectedId === item.id}
                        listings={listings}
                        installedListings={installedListings}
                        onOpen={() => onOpenItem(item.id)}
                        renderMineTile={renderMineTile}
                      />
                    ))
                  )}
                </ShelfBlock>
              );
            })}
          </div>
        ) : null}

        {rail.official.length > 0 ? (
          <ShelfBlock
            testId="prompt-rail-official"
            highlighted={false}
            onDragOver={onRejectDrag}
            onDrop={onRejectDrag}
          >
            {rail.official.map((item) => (
              <ItemTile
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                listings={listings}
                installedListings={installedListings}
                onOpen={() => onOpenItem(item.id)}
              />
            ))}
          </ShelfBlock>
        ) : null}

        <FactoryToolShelf
          testId="prompt-rail-on-demand-tools"
          tools={onDemandTools}
          selectedId={selectedId}
          listings={listings}
          installedListings={installedListings}
          onOpenItem={onOpenItem}
          onDragOver={onRejectDrag}
          onDrop={onRejectDrag}
        />

        {showConnectors ? (
          <ShelfBlock
            testId="prompt-rail-connectors"
            title="连接器"
            highlighted={false}
          >
            {connectors.map((row) => {
              const copy = promptConnectorShelfCopy(row);
              return (
                <CatalogTile
                  key={row.id}
                  icon={<Unplug size={18} />}
                  colorVar={artifactColorVar("connectors")}
                  title={copy.title}
                  description={copy.description}
                  accessory={row.accessory}
                  tags={shelfTags(copy.tags)}
                  className={
                    selectedId === row.id
                      ? "ring-1 ring-inset ring-primary"
                      : undefined
                  }
                  onClick={() => onOpenItem(row.id)}
                />
              );
            })}
            {onAddConnector ? (
              <CatalogTile
                icon={<Plus size={18} />}
                colorVar={artifactColorVar("connectors")}
                title={PROMPT_SHELF_AFFORDANCE.addConnector.title}
                description={PROMPT_SHELF_AFFORDANCE.addConnector.description}
                onClick={onAddConnector}
              />
            ) : null}
            {connectorError ? (
              <p
                className="col-span-full text-xs text-muted-foreground"
                role="alert"
              >
                {connectorError}
              </p>
            ) : null}
          </ShelfBlock>
        ) : null}
      </section>
    </div>
  );
}

function FactoryToolShelf({
  testId,
  tools,
  selectedId,
  listings,
  installedListings,
  onOpenItem,
  onDragOver,
  onDrop,
}: {
  testId: string;
  tools: Extract<PromptCatalogItem, { kind: "tool" }>[];
  selectedId: string | null;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
  onOpenItem: (id: string) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <ShelfBlock
      testId={testId}
      highlighted={false}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {tools.map((item) => (
        <ItemTile
          key={item.id}
          item={item}
          selected={selectedId === item.id}
          listings={listings}
          installedListings={installedListings}
          onOpen={() => onOpenItem(item.id)}
        />
      ))}
    </ShelfBlock>
  );
}

function RailHeading({
  children,
  description,
  actions,
}: {
  children: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-medium text-foreground">{children}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

function ShelfHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
      {children}
    </h3>
  );
}

function TileShelf({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {title ? <ShelfHeading>{title}</ShelfHeading> : null}
      <div className={CATALOG_GRID_CLASS}>{children}</div>
    </>
  );
}

function ShelfBlock({
  title,
  testId,
  highlighted,
  className,
  onDragOver,
  onDrop,
  children,
}: {
  title?: ReactNode;
  testId?: string;
  highlighted: boolean;
  className?: string;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "mt-5",
        className,
        highlighted && "rounded-xl ring-1 ring-inset ring-primary",
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <TileShelf title={title}>{children}</TileShelf>
    </div>
  );
}

function ItemTile({
  item,
  alwaysChars,
  selected,
  listings,
  installedListings,
  onOpen,
  renderMineTile,
}: {
  item: PromptCatalogItem;
  alwaysChars?: number;
  selected: boolean;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
  onOpen: () => void;
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
  const tile = (
    <CatalogTile
      icon={visual.icon}
      colorVar={visual.colorVar}
      title={copy.title}
      subtitle={copy.subtitle}
      description={copy.description}
      accessory={shelfChips(copy.accessory)}
      tags={shelfTags(copy.tags)}
      className={selected ? "ring-1 ring-inset ring-primary" : undefined}
      onClick={onOpen}
    />
  );
  const wrapped = renderMineTile
    ? renderMineTile({ item, children: tile })
    : tile;
  return (
    <div
      data-testid={`prompt-tile-${item.id}`}
      data-prompt-tile={item.id}
      className="h-full min-w-0"
    >
      {wrapped}
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
  if (item.kind === "mine") {
    return {
      icon: <FileText size={18} />,
      colorVar: artifactColorVar("guidelines"),
    };
  }
  return {
    icon: <FileText size={18} />,
    colorVar: artifactColorVar("guidelines"),
  };
}

function shelfTags(tags: string[]) {
  return shelfChips(tags.map((label) => ({ label })));
}

function shelfChips(chips: PromptShelfChip[]) {
  if (!chips.length) return undefined;
  return chips.map((chip) => (
    <Badge key={chip.label} tone={chip.tone ?? "muted"} pill>
      {chip.label}
    </Badge>
  ));
}
