import { PageContainer } from "@/components/layout/PageContainer";
import {
  Button,
  Card,
  CatalogIconShell,
  SearchField,
  SurfaceRowButton,
} from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { artifactColorVar } from "@/lib/catalogColors";
import { promptConnectorShelfCopy } from "@/lib/promptShelfTile";
import { cn } from "@/lib/utils";
import {
  ConnectorInspector,
  ConnectorStatusBadge,
  NEW_CONNECTOR_ID,
  connectorCatalogId,
  useMcpConnectors,
} from "@/pages/toolbox/ConnectorsPage";
import { ToolboxSourceTabs } from "@/pages/toolbox/ToolboxSourceTabs";
import type { McpServerListItem } from "@shared/mcp-contract";
import { Unplug } from "lucide-react";
import { useState } from "react";

function matchServer(query: string, server: McpServerListItem): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    server.name.toLowerCase().includes(q) ||
    (server.runtimeError ?? "").toLowerCase().includes(q)
  );
}

/**
 * 工具箱 MCP 栏：本机 stdio Server 列表。没有 mcpApi 时不假装已接上。
 * 不把插头报出的动作再铺一层。
 */
export function McpPage() {
  const mcp = useMcpConnectors();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const hits = mcp.servers.filter((server) => matchServer(query, server));
  const creating = openId === NEW_CONNECTOR_ID;
  const editing = creating
    ? null
    : (mcp.servers.find((server) => connectorCatalogId(server.id) === openId) ??
      null);
  const dialogOpen = Boolean(mcp.api) && (creating || editing != null);

  const closeDialog = () => {
    setOpenId(null);
  };

  return (
    <PageContainer width="canvas" padding="page">
      <div className="w-full" data-testid="mcp-page">
        <ToolboxSourceTabs
          action={
            mcp.api ? (
              <>
                <SearchField
                  aria-label="搜 MCP"
                  placeholder="搜 MCP"
                  value={query}
                  onValueChange={setQuery}
                  className="w-52"
                />
                <Button size="md" onClick={() => setOpenId(NEW_CONNECTOR_ID)}>
                  添加 MCP
                </Button>
              </>
            ) : null
          }
        />
        <McpBody
          api={mcp.api}
          loaded={mcp.loaded}
          error={mcp.error}
          query={query}
          hits={hits}
          selectedId={openId}
          onOpen={(id) => setOpenId(id)}
        />
        {mcp.api ? (
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
          >
            <DialogContent
              size="lg"
              className="flex max-h-[min(80vh,36rem)] flex-col"
              data-testid="mcp-dialog"
            >
              <DialogHeader className="shrink-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle>
                    {creating ? "新建 MCP" : "编辑 MCP"}
                  </DialogTitle>
                  {editing ? <ConnectorStatusBadge server={editing} /> : null}
                </div>
                <DialogDescription className="sr-only">
                  {creating ? "新建 MCP" : (editing?.name ?? "编辑 MCP")}
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="flex min-h-0 flex-1 flex-col pb-5">
                {dialogOpen ? (
                  <ConnectorInspector
                    key={openId ?? NEW_CONNECTOR_ID}
                    server={editing}
                    api={mcp.api}
                    busyId={busyId}
                    onBusy={setBusyId}
                    onCloseNew={closeDialog}
                    onSaved={mcp.reload}
                    hideChrome
                  />
                ) : null}
              </DialogBody>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    </PageContainer>
  );
}

function McpBody({
  api,
  loaded,
  error,
  query,
  hits,
  selectedId,
  onOpen,
}: {
  api: Window["mcpApi"];
  loaded: boolean;
  error: string | null;
  query: string;
  hits: McpServerListItem[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  if (!api) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        MCP 只在桌面本机可用。
      </p>
    );
  }
  if (!loaded) return null;
  if (error) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="alert">
        {error}
      </p>
    );
  }
  if (hits.length === 0) {
    return (
      <div className="mt-3 flex min-h-[4.5rem] items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground">
        {query.trim() ? "没有匹配的 MCP。" : "还没有 MCP。"}
      </div>
    );
  }
  return (
    <Card className="mt-3 overflow-hidden" data-testid="mcp-list">
      <div className="divide-y divide-border">
        {hits.map((server) => {
          const id = connectorCatalogId(server.id);
          const copy = promptConnectorShelfCopy({
            label: server.name,
            runtimeError: server.runtimeError,
          });
          return (
            <SurfaceRowButton
              key={id}
              variant="default"
              aria-label={copy.title}
              className={cn(
                "w-full gap-3 rounded-none px-3 py-2.5 text-left",
                selectedId === id && "bg-accent text-accent-foreground",
              )}
              onClick={() => onOpen(id)}
            >
              <CatalogIconShell
                colorVar={artifactColorVar("connectors")}
                className="size-8 rounded-lg"
              >
                <Unplug size={18} />
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
              <ConnectorStatusBadge server={server} />
            </SurfaceRowButton>
          );
        })}
      </div>
    </Card>
  );
}
