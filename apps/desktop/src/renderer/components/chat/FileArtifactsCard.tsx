import { FileAuditTrail } from "@/components/audit/FileAuditTrail";
import { AutoFolderNoticeLine } from "@/components/chat/AutoFolderNoticeCard";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { Button, IconButton } from "@/components/ui";
import {
  type StatusTone,
  statusAccentText,
  statusPillSoft,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useConversationFileSource } from "@/hooks/useConversationFileSource";
import { useFileAudit } from "@/hooks/useFileAudit";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import {
  type FileArtifact,
  type FileOp,
  hasChangePreviews,
  splitExportedSources,
  splitPromotedProducts,
} from "@/lib/fileArtifacts";
import { isHtmlPath } from "@/lib/fileSource";
import { openWorkspaceHtmlInBrowser } from "@/lib/openWorkspaceHtmlInBrowser";
import { stageFileLabel } from "@/lib/stageDirs";
import type { AutoFolderNotice } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Diff,
  FilePlus,
  FolderOpen,
  History,
  type LucideIcon,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * 「本回合产出文件」卡 —— 主清单只认路径验收态（delivery_status.artifacts），挂在
 * 答复正文下方（前端UX设计.md §九「回合内文件呈现」）。点任一可预览行 → 经 {@link useSidePanelStore}
 * 的 `showFile` 开右坞顶栏 File 内容 tab（可带 artifact.workspaceId 跟落地桌）。例外：HTML 产物在会话具备应用内「完整预览」能力时
 * **直达**内置浏览器 tab（`workspace://` + BrowserPanel；desk 优先 artifact.workspaceId，
 * 否则会话工作区 wsId）。「查看改动」聚焦右坞「改动」tab（无则先挂；与
 * {@link TurnFileChangesReview} 同源，前端UX设计.md §十）。
 *
 * 裸聊自动建桌的回合另带 `autoFolder`：落点告知作为卡头一行（{@link AutoFolderNoticeLine}），
 * 因为文件正是落进那个文件夹——同一件事不再在气泡顶部另开一张卡说第二遍。
 *
 * 导出件（`报告.md` → `报告.docx`）主推、源文件降级为中间稿收进折叠区
 * （{@link splitExportedSources} 只认工具自报的 `derivedFrom`）：用户要的是那份 Word，
 * 并列两份会让人点开 .md 以为被糊弄。中间稿仍在卡里可展开——降级不是藏起来。
 *
 * 清单按「成品 / 过程材料」分组（{@link splitPromotedProducts}），与文件页「AI 工作间」
 * 同一套心智：归位过的是给用户的东西，其余是 AI 干活留下的材料。零归位（多幕协作中间幕）
 * 不渲染成品组——空组占位会把合法状态演成异常。
 */

const OP_META: Record<
  FileOp,
  {
    label: string;
    Icon: LucideIcon;
    tone: StatusTone;
    preview: boolean;
  }
> = {
  write: {
    label: "写入",
    Icon: FilePlus,
    tone: "success",
    preview: true,
  },
  edit: {
    label: "编辑",
    Icon: Pencil,
    tone: "primary",
    preview: true,
  },
  delete: {
    label: "删除",
    Icon: Trash2,
    tone: "destructive",
    preview: false,
  },
  move: {
    label: "移动",
    Icon: ArrowRight,
    tone: "muted",
    preview: true,
  },
};

function rowVisual(artifact: FileArtifact): {
  icon: ReactNode;
  tone: StatusTone;
  badge: string | null;
  preview: boolean;
  badgeTitle?: string;
} {
  if (artifact.acceptance === "accepted") {
    return {
      icon: (
        <Check size={14} className={`shrink-0 ${statusAccentText.success}`} />
      ),
      tone: "success",
      badge: "已验收",
      preview: true,
    };
  }
  if (artifact.acceptance === "rejected") {
    const detail =
      artifact.acceptanceDetail || artifact.acceptanceReason || undefined;
    return {
      icon: (
        <X size={14} className={`shrink-0 ${statusAccentText.destructive}`} />
      ),
      tone: "destructive",
      badge: "未通过",
      preview: true,
      badgeTitle: detail,
    };
  }
  // 无验收态时：删除/移动仍标操作；写入/编辑不显示（勿用工具名冒充交付成功）。
  if (artifact.op === "delete" || artifact.op === "move") {
    const meta = OP_META[artifact.op];
    const OpIcon = meta.Icon;
    return {
      icon: (
        <OpIcon
          size={14}
          className={`shrink-0 ${statusAccentText[meta.tone]}`}
        />
      ),
      tone: meta.tone,
      badge: meta.label,
      preview: meta.preview,
    };
  }
  return {
    icon: <FileTypeIcon name={artifact.name} size={14} />,
    tone: "muted",
    badge: null,
    preview: true,
  };
}

function FileRow({
  artifact,
  conversationId,
  turnKey,
  onOpen,
  opensFullPreview = false,
}: {
  artifact: FileArtifact;
  conversationId: string | null;
  turnKey?: string;
  onOpen: () => void;
  /** 该行点击直达应用内「完整预览」（HTML + 会话具备能力）——仅影响提示文案。 */
  opensFullPreview?: boolean;
}) {
  const [auditOpen, setAuditOpen] = usePersistentDisclosure(
    turnKey ? `${turnKey}:file-audit:${artifact.path}` : null,
    false,
  );
  const visual = rowVisual(artifact);
  const isDelete = artifact.op === "delete";
  const auditState = useFileAudit(
    conversationId,
    artifact.path,
    auditOpen && !isDelete,
  );
  const dir = artifact.path.slice(
    0,
    artifact.path.length - artifact.name.length,
  );
  const stageLabel = stageFileLabel(artifact.path);
  const body = (
    <>
      {visual.icon}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {artifact.op === "move" && artifact.fromPath ? (
          <span className="text-muted-foreground/70">
            {artifact.fromPath} →{" "}
          </span>
        ) : dir ? (
          <span className="text-muted-foreground/60">{dir}</span>
        ) : null}
        <span className="font-medium">{artifact.name}</span>
      </span>
      {stageLabel && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none ${statusPillSoft.muted}`}
        >
          {stageLabel}
        </span>
      )}
      {visual.badge && (
        <span
          title={visual.badgeTitle}
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none ${statusPillSoft[visual.tone]}`}
        >
          {visual.badge}
        </span>
      )}
    </>
  );

  // 删除态无可预览的文件 → 仅留痕、不可点。
  if (!visual.preview || isDelete) {
    return (
      <li className="flex items-center gap-2 px-3 py-2 opacity-70">{body}</li>
    );
  }
  return (
    <li>
      <div className="flex items-center">
        <Button
          variant="ghost"
          onClick={onOpen}
          title={
            opensFullPreview
              ? `打开完整预览 ${artifact.path}`
              : stageLabel
                ? `在文件页查看约定文档 ${artifact.path}`
                : `在工作区预览 ${artifact.path}`
          }
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-3 py-2 hover:bg-accent"
        >
          <span className="flex w-full items-center gap-2 text-left">
            {body}
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground/50"
            />
          </span>
        </Button>
        {conversationId && (
          <SimpleTooltip label="查看写入归因">
            <IconButton
              className="mr-2 shrink-0"
              aria-label="查看写入归因"
              aria-expanded={auditOpen}
              onClick={() => setAuditOpen((v) => !v)}
            >
              <History size={14} />
            </IconButton>
          </SimpleTooltip>
        )}
      </div>
      {auditOpen && conversationId && (
        <div className="border-t border-border bg-muted/30 px-3 py-2">
          <FileAuditTrail state={auditState} compact />
        </div>
      )}
    </li>
  );
}

/**
 * 分组小标题。只在该组有行时渲染；过程材料组用次要样式（与文件页「AI 工作间」行同款
 * `text-muted-foreground`），成品组保持正文色——用户要的东西不该退到背景里。
 */
function GroupHeader({
  label,
  hint,
  secondary = false,
}: {
  label: string;
  hint: string;
  secondary?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5 border-t border-border px-3 pt-2 pb-1 text-xs">
      <span
        className={`shrink-0 font-medium ${secondary ? "text-muted-foreground" : "text-foreground"}`}
      >
        {label}
      </span>
      <span className="min-w-0 truncate text-muted-foreground/70">{hint}</span>
    </div>
  );
}

export function FileArtifactsCard({
  artifacts,
  conversationId = null,
  turnKey,
  autoFolder,
}: {
  artifacts: FileArtifact[];
  conversationId?: string | null;
  /** 回合作用域（= messageId）：给了才把整卡/审计行开合持久化。 */
  turnKey?: string;
  /** 裸聊自动建桌的落点告知——文件落在这里，所以并进本卡头部而非另起一卡。 */
  autoFolder?: AutoFolderNotice;
}) {
  // 文件不多（≤4）默认展开一目了然；多了先收起，避免长清单淹没答复。
  const [expanded, setExpanded] = usePersistentDisclosure(
    turnKey ? `${turnKey}:files` : null,
    artifacts.length <= 4,
  );
  // 中间稿默认收着：要的是导出件，源稿一般无需打开（但一键就能翻出来）。
  const [draftsOpen, setDraftsOpen] = usePersistentDisclosure(
    turnKey ? `${turnKey}:files:drafts` : null,
    false,
  );
  const showFile = useSidePanelStore((s) => s.showFile);
  const showChanges = useSidePanelStore((s) => s.showChanges);
  // 与对话侧栏同一套能力判定：hook 只对云端会话源且 hasInAppPreview 时挂 openInAppPreview。
  const canFullPreview =
    !!useConversationFileSource(conversationId)?.openInAppPreview;
  // 与侧栏同源落地 desk；产物可带独立 workspaceId 覆盖。
  const sessionWsId = useConversationWorkspace(conversationId)?.wsId;

  if (artifacts.length === 0) return null;

  // 主推件 / 中间稿分区（只认自报 derivedFrom，与后端 fold_exported_sources 同口径）。
  const { primary, intermediate } = splitExportedSources(artifacts);
  // 主推件再按位置态分组（只认 promoted，不由路径推断产物地位）。
  const { products, materials, rejected } = splitPromotedProducts(primary);
  const canReview =
    hasChangePreviews(artifacts) || (!!conversationId && !!turnKey);

  const openArtifact = (a: FileArtifact) => {
    // HTML 直达完整预览（内置浏览器 tab）；desk 优先 artifact，否则会话工作区。
    if (canFullPreview && conversationId && isHtmlPath(a.path)) {
      void openWorkspaceHtmlInBrowser(
        conversationId,
        a.path,
        a.workspaceId ?? sessionWsId,
      );
      return;
    }
    // 非 HTML / 无完整预览能力：File tab 跟落地 desk（无 workspaceId → 会话出生桌）。
    showFile(a.path, a.name, a.workspaceId);
  };

  const fileRow = (a: FileArtifact) => (
    <FileRow
      key={`${a.acceptance ?? a.op ?? "file"}:${a.path}`}
      artifact={a}
      conversationId={conversationId}
      turnKey={turnKey}
      onOpen={() => openArtifact(a)}
      opensFullPreview={canFullPreview && isHtmlPath(a.path)}
    />
  );

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-stretch border-border">
        <Button
          variant="ghost"
          onClick={() => setExpanded((v) => !v)}
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-3 py-2.5 hover:bg-accent/50"
        >
          <span className="flex w-full items-center gap-2 text-left">
            <FolderOpen
              size={15}
              className={`shrink-0 ${statusAccentText.primary}`}
            />
            <span className="flex-1 text-sm font-medium text-foreground">
              本回合产出文件
            </span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none text-muted-foreground">
              {artifacts.length}
            </span>
            {expanded ? (
              <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown
                size={15}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </span>
        </Button>
        {canReview && (
          <SimpleTooltip label="在右坞查看改动（只读）">
            <Button
              variant="ghost"
              onClick={() => showChanges(turnKey)}
              aria-label="查看改动"
              className="h-auto shrink-0 rounded-none px-3 py-2.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <Diff size={14} className="mr-1.5 shrink-0" />
              查看改动
            </Button>
          </SimpleTooltip>
        )}
      </div>
      {/* 落点先于清单，且不随清单折叠——收起文件也得看得见文件去哪了。 */}
      {autoFolder && <AutoFolderNoticeLine notice={autoFolder} />}
      {expanded && (
        <>
          {/* 无行间横线（统一两卡列表语言）：单行可点行有 hover 底色 + 图标锚点，保持现有密度。 */}
          {products.length > 0 && (
            <>
              <GroupHeader label="成品" hint="已归位到你的工作区" />
              <ul>{products.map(fileRow)}</ul>
            </>
          )}
          {materials.length > 0 && (
            <>
              <GroupHeader
                label="过程材料"
                hint="AI 干活留下的，平时不必打开"
                secondary
              />
              <ul>{materials.map(fileRow)}</ul>
            </>
          )}
          {/* 未通过：两组都不进，末尾单列（行本身维持原样：X + 未通过徽章 + 事由）。 */}
          {rejected.length > 0 && (
            <ul className="border-t border-border">{rejected.map(fileRow)}</ul>
          )}
          {intermediate.length > 0 && (
            <div className="border-t border-border">
              <Button
                variant="ghost"
                onClick={() => setDraftsOpen((v) => !v)}
                aria-expanded={draftsOpen}
                className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-2 text-xs text-muted-foreground hover:bg-accent/50"
              >
                <span className="flex w-full items-center gap-1.5 text-left">
                  {draftsOpen ? (
                    <ChevronUp size={14} className="shrink-0" />
                  ) : (
                    <ChevronDown size={14} className="shrink-0" />
                  )}
                  <span>中间稿 {intermediate.length} 份</span>
                  <span className="min-w-0 truncate text-muted-foreground/70">
                    已导出为上述文件，一般无需打开
                  </span>
                </span>
              </Button>
              {draftsOpen && (
                <ul className="opacity-70">{intermediate.map(fileRow)}</ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
