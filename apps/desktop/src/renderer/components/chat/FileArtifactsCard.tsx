import type { FileArtifact, FileOp } from "@/lib/fileArtifacts";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FilePlus,
  FolderOpen,
  type LucideIcon,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";

/**
 * 「本回合产出文件」卡 —— 把一回合内成功的文件写/改/删/移聚合成一张回合级清单，挂在
 * 答复正文下方（前端展示完善规划.md P1）。点任一可预览行 → 经 {@link useSidePanelStore}
 * 的 `showFile` 把右侧工作区面板切到该文件预览，与文件树/详情共用同一套预览（不另起编辑器）。
 *
 * 删除态无文件可看 → 该行不可点（仅留痕）。卡只读已折好的运行时状态、不持久化，真相仍以
 * 工作区文件树为准；故重载后由各回合 journal 重建 process/execution 时清单自然复现。
 */

const OP_META: Record<
  FileOp,
  {
    label: string;
    Icon: LucideIcon;
    tint: string;
    pill: string;
    preview: boolean;
  }
> = {
  write: {
    label: "写入",
    Icon: FilePlus,
    tint: "text-success",
    pill: "bg-success/10 text-success",
    preview: true,
  },
  edit: {
    label: "编辑",
    Icon: Pencil,
    tint: "text-info",
    pill: "bg-info/10 text-info",
    preview: true,
  },
  delete: {
    label: "删除",
    Icon: Trash2,
    tint: "text-destructive",
    pill: "bg-destructive/10 text-destructive",
    preview: false,
  },
  move: {
    label: "移动",
    Icon: ArrowRight,
    tint: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
    preview: true,
  },
};

function FileRow({
  artifact,
  onOpen,
}: {
  artifact: FileArtifact;
  onOpen: () => void;
}) {
  const meta = OP_META[artifact.op];
  const dir = artifact.path.slice(
    0,
    artifact.path.length - artifact.name.length,
  );
  const body = (
    <>
      <meta.Icon size={14} className={`shrink-0 ${meta.tint}`} />
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
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none ${meta.pill}`}
      >
        {meta.label}
      </span>
    </>
  );

  // 删除态无可预览的文件 → 仅留痕、不可点。
  if (!meta.preview) {
    return (
      <li className="flex items-center gap-2 px-3 py-2 opacity-70">{body}</li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`在工作区预览 ${artifact.path}`}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent"
      >
        {body}
        <ChevronRight size={14} className="shrink-0 text-muted-foreground/50" />
      </button>
    </li>
  );
}

export function FileArtifactsCard({
  artifacts,
}: {
  artifacts: FileArtifact[];
}) {
  // 文件不多（≤4）默认展开一目了然；多了先收起，避免长清单淹没答复。
  const [expanded, setExpanded] = useState(artifacts.length <= 4);
  const showFile = useSidePanelStore((s) => s.showFile);

  if (artifacts.length === 0) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
      >
        <FolderOpen size={15} className="shrink-0 text-info" />
        <span className="flex-1 text-sm font-medium text-foreground">
          本回合产出文件
        </span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
          {artifacts.length}
        </span>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <ul className="divide-y divide-border border-t border-border">
          {artifacts.map((a) => (
            <FileRow
              key={`${a.op}:${a.path}`}
              artifact={a}
              onOpen={() => showFile(a.path, a.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
