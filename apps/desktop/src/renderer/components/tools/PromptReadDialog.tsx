import { PromptDocument } from "@/components/prompt/PromptDocument";
import { PromptWorkbench } from "@/components/prompt/PromptWorkbench";
import type { BindableToolOption } from "@/components/prompt/PromptWorkbench";
import { PublishSkillDialog } from "@/components/tools/PublishSkillDialog";
import { ToolInspector } from "@/components/tools/ToolInspector";
import { Badge, Button, SegmentedControl } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PromptCatalogItem } from "@/lib/promptCatalog";
import {
  promptItemShelfCopy,
  promptMineShelfOpts,
  promptReadHeaderChips,
} from "@/lib/promptShelfTile";
import { publishBlockReason } from "@/lib/skillStoreCopy";
import { cn } from "@/lib/utils";
import {
  ConnectorInspector,
  ConnectorStatusBadge,
  NEW_CONNECTOR_ID,
} from "@/pages/toolbox/ConnectorsPage";
import { getDocument } from "@/services/documents";
import {
  type SkillCatalog,
  parseOffersTools,
  skillBodyFromContent,
} from "@/services/skillCatalog";
import type { SkillStoreGroup, SkillStoreListing } from "@/services/skillStore";
import type { McpServerListItem } from "@shared/mcp-contract";
import { useEffect, useState } from "react";

export type ConnectorPick = {
  kind: "connector";
  id: string;
  label: string;
  server: McpServerListItem | null;
};

export type PromptReadLeaf = PromptCatalogItem | ConnectorPick;

type MineView = "preview" | "edit";

export function PromptReadDialog({
  open,
  item,
  overlay,
  listings,
  installedListings,
  busy,
  showToolsHint,
  toolsHint,
  toolCallingNames,
  mcpApi,
  mcpBusyId,
  bindableTools = [],
  onOpenChange,
  onMcpBusy,
  onMcpSaved,
  onCloseNewConnector,
  onSaveMine,
  onPublishMine,
  onUnpublishMine,
}: {
  open: boolean;
  item: PromptReadLeaf | null;
  overlay: SkillCatalog;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
  busy: boolean;
  showToolsHint: boolean;
  toolsHint: string;
  toolCallingNames: ReadonlySet<string>;
  mcpApi: Window["mcpApi"];
  mcpBusyId: string | null;
  bindableTools?: BindableToolOption[];
  onOpenChange: (open: boolean) => void;
  onMcpBusy: (id: string | null) => void;
  onMcpSaved: () => Promise<void>;
  onCloseNewConnector: () => void;
  onSaveMine: (
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    draft: {
      name: string;
      description: string;
      body: string;
      offeredTools: string[];
    },
  ) => Promise<boolean>;
  onPublishMine: (
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    group: SkillStoreGroup,
  ) => void;
  onUnpublishMine: (item: Extract<PromptCatalogItem, { kind: "mine" }>) => void;
}) {
  const [publishOpen, setPublishOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: item id is an intentional re-run key
  useEffect(() => {
    setPublishOpen(false);
  }, [item && "id" in item ? item.id : null]);

  const showItem = item != null;
  const mineItem =
    item?.kind === "mine"
      ? (item as Extract<PromptCatalogItem, { kind: "mine" }>)
      : null;
  const fromMarket = Boolean(
    mineItem?.mineId &&
      installedListings.some(
        (row) => row.installDocumentId === mineItem.mineId,
      ),
  );
  const listing = mineItem
    ? (listings.find((row) => row.documentId === mineItem.mineId) ?? null)
    : null;
  const header = readHeader({
    showItem,
    item,
    listings,
    installedListings,
  });
  const canPublish =
    Boolean(mineItem) &&
    overlay.writable &&
    !fromMarket &&
    mineItem?.applyMode === "on_demand" &&
    listing?.status !== "taken_down";
  const canUnpublish =
    Boolean(mineItem) &&
    overlay.writable &&
    !fromMarket &&
    listing?.status === "published";
  const showPublish = Boolean(mineItem) && showItem;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && publishOpen) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        size={mineItem ? "2xl" : "lg"}
        className={cn(
          "flex flex-col",
          mineItem
            ? "h-[min(85vh,52rem)] max-h-[min(85vh,52rem)]"
            : "max-h-[min(80vh,36rem)]",
        )}
        data-testid="prompt-read-dialog"
        onPointerDownOutside={(event) => {
          if (publishOpen) event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (publishOpen) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (publishOpen) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>{header.title}</DialogTitle>
                {header.chips.map((chip) => (
                  <Badge key={chip.label} tone={chip.tone ?? "muted"} pill>
                    {chip.label}
                  </Badge>
                ))}
                {item?.kind === "connector" && item.server ? (
                  <ConnectorStatusBadge server={item.server} />
                ) : null}
              </div>
              {canPublish || canUnpublish ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {canPublish ? (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setPublishOpen(true)}
                    >
                      上架
                    </Button>
                  ) : null}
                  {canUnpublish ? (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => mineItem && onUnpublishMine(mineItem)}
                    >
                      下架
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <DialogDescription className="sr-only">
            {header.description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            mineItem ? "overflow-hidden px-0 pb-0" : "pb-5",
          )}
        >
          {showItem && item ? (
            <ReadBody
              item={item}
              overlay={overlay}
              showToolsHint={showToolsHint}
              toolsHint={toolsHint}
              toolCallingNames={toolCallingNames}
              mcpApi={mcpApi}
              mcpBusyId={mcpBusyId}
              bindableTools={bindableTools}
              onMcpBusy={onMcpBusy}
              onMcpSaved={onMcpSaved}
              onCloseNewConnector={onCloseNewConnector}
              onSaveMine={onSaveMine}
            />
          ) : null}
        </DialogBody>
        {showPublish && mineItem ? (
          <PublishSkillDialog
            open={publishOpen}
            busy={busy}
            initialGroup={listing?.group ?? null}
            blockReason={publishBlockReason(
              mineItem.description,
              mineItem.content,
            )}
            onOpenChange={setPublishOpen}
            onConfirm={(group) => {
              setPublishOpen(false);
              onPublishMine(mineItem, group);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function readHeader({
  showItem,
  item,
  listings,
  installedListings,
}: {
  showItem: boolean;
  item: PromptReadLeaf | null;
  listings: SkillStoreListing[];
  installedListings: SkillStoreListing[];
}): {
  title: string;
  chips: ReturnType<typeof promptReadHeaderChips>;
  description: string;
} {
  if (showItem && item) {
    if (item.kind === "connector") {
      return {
        title: item.id === NEW_CONNECTOR_ID ? "新建连接器" : "编辑连接器",
        chips: [],
        description: item.label,
      };
    }
    const mineOpts =
      item.kind === "mine"
        ? promptMineShelfOpts(item, listings, installedListings)
        : {};
    const copy = promptItemShelfCopy(item, mineOpts);
    return {
      title: copy.title,
      chips: promptReadHeaderChips(copy, item),
      description: copy.description || copy.title,
    };
  }
  return {
    title: "提示词",
    chips: [],
    description: "提示词",
  };
}

function ReadBody({
  item,
  overlay,
  showToolsHint,
  toolsHint,
  toolCallingNames,
  mcpApi,
  mcpBusyId,
  bindableTools,
  onMcpBusy,
  onMcpSaved,
  onCloseNewConnector,
  onSaveMine,
}: {
  item: PromptReadLeaf;
  overlay: SkillCatalog;
  showToolsHint: boolean;
  toolsHint: string;
  toolCallingNames: ReadonlySet<string>;
  mcpApi: Window["mcpApi"];
  mcpBusyId: string | null;
  bindableTools?: BindableToolOption[];
  onMcpBusy: (id: string | null) => void;
  onMcpSaved: () => Promise<void>;
  onCloseNewConnector: () => void;
  onSaveMine: (
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    draft: {
      name: string;
      description: string;
      body: string;
      offeredTools: string[];
    },
  ) => Promise<boolean>;
}) {
  if (item.kind === "connector") {
    if (!mcpApi) return null;
    return (
      <ConnectorInspector
        key={item.id}
        server={item.server}
        api={mcpApi}
        busyId={mcpBusyId}
        onBusy={onMcpBusy}
        onCloseNew={onCloseNewConnector}
        onSaved={onMcpSaved}
        hideChrome
      />
    );
  }

  if (item.kind === "tool") {
    return (
      <ToolInspector
        key={item.id}
        tool={item.tool}
        hideChrome
        capabilityHint={
          showToolsHint && toolCallingNames.has(item.tool.name)
            ? toolsHint
            : undefined
        }
      />
    );
  }

  if (item.kind === "shared") {
    return (
      <PromptDocument
        text={item.text}
        compact={false}
        framed={false}
        maxHeightClass="max-h-none"
      />
    );
  }

  if (item.kind === "skill") {
    return (
      <div data-testid="factory-skill-editor">
        <PromptDocument
          text={item.skill.body}
          compact={false}
          framed={false}
          maxHeightClass="max-h-none"
        />
      </div>
    );
  }

  if (item.kind === "mine") {
    return (
      <MineSkillEditor
        key={item.id}
        item={item}
        writable={overlay.writable}
        bindableTools={bindableTools}
        onSave={onSaveMine}
      />
    );
  }

  return null;
}

function initialMineView(content: string): MineView {
  return skillBodyFromContent(content).trim() ? "preview" : "edit";
}

function MineSkillEditor({
  item,
  writable,
  bindableTools,
  onSave,
}: {
  item: Extract<PromptCatalogItem, { kind: "mine" }>;
  writable: boolean;
  bindableTools?: BindableToolOption[];
  onSave: (
    item: Extract<PromptCatalogItem, { kind: "mine" }>,
    draft: {
      name: string;
      description: string;
      body: string;
      offeredTools: string[];
    },
  ) => Promise<boolean>;
}) {
  const onDemand = item.applyMode === "on_demand";
  const pendingBody = Boolean(item.mineId) && !item.content;
  const [view, setView] = useState<MineView>(() =>
    pendingBody ? "preview" : initialMineView(item.content),
  );
  const [body, setBody] = useState(() => skillBodyFromContent(item.content));
  const [offeredTools, setOfferedTools] = useState(() =>
    parseOffersTools(item.content),
  );
  const [version, setVersion] = useState(item.version);
  const [loading, setLoading] = useState(Boolean(item.mineId) && !item.content);

  useEffect(() => {
    if (!item.mineId || item.content) {
      setBody(skillBodyFromContent(item.content));
      setOfferedTools(parseOffersTools(item.content));
      setVersion(item.version);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getDocument(item.mineId)
      .then((doc) => {
        if (cancelled) return;
        setBody(skillBodyFromContent(doc.content));
        setOfferedTools(parseOffersTools(doc.content));
        setVersion(doc.version);
        setLoading(false);
        setView((current) =>
          current === "edit" ? current : initialMineView(doc.content),
        );
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.mineId, item.content, item.version]);

  return (
    <PromptWorkbench
      key={loading ? `${item.id}-loading` : item.id}
      testId="mine-skill-editor"
      title={item.label}
      titleEditable
      badges={null}
      leading={
        <SegmentedControl
          aria-label="阅读方式"
          value={view}
          onChange={setView}
          items={[
            { value: "preview", label: "预览" },
            { value: "edit", label: "编辑" },
          ]}
          className="w-auto"
        />
      }
      previewing={view === "preview"}
      initialTrigger={item.description}
      triggerEnabled={onDemand}
      initialOfferedTools={offeredTools}
      bindableTools={bindableTools}
      canAddOfferedTools={onDemand}
      initialBody={body}
      bodyLoading={loading}
      readOnly={!writable}
      onSave={
        writable
          ? (draft) =>
              onSave(
                { ...item, version },
                {
                  name: draft.title,
                  description: onDemand ? draft.trigger : item.description,
                  body: draft.body,
                  offeredTools: draft.offeredTools,
                },
              )
          : undefined
      }
    />
  );
}
