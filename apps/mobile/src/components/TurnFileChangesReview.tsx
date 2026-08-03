/**
 * A1 / A1+ 只读「查看改动」——挂在产物卡内展开（手机无右坞）。
 * 优先拉回合基线真 diff（A1+）；无基线 / 失败则降级工具参数预览（A1）。
 * 标签按路径相对回合初是否存在（新建/更新/删除），不按 file_write/str_replace 工具名。
 * 恢复 = 整回合云 overlay 基线（restoreSnapshot），非单文件；无 Local sidecar。
 */
import { type TurnFileChange, getTurnFilesDiff } from "@/api/turnFilesDiff";
import { restoreSnapshot } from "@/api/workspace";
import type { FileArtifact, FileChangePreview } from "@/lib/fileArtifacts";
import { type DiffLine, lineDiff } from "@/lib/lineDiff";
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

const WRITE_PREVIEW_LINES = 300;

/** 能力边界诚实文案（基线 = 回合开始 overlay；忽略目录不进包）。 */
const BASELINE_RESTORE_HINT =
  "尽最大努力回到本回合开始（覆盖当前工作区 overlay；未进基线的目录如 node_modules/.venv 等不会还原）";

function turnChangeLabel(changeType: TurnFileChange["changeType"]): string {
  if (changeType === "added") return "新建";
  if (changeType === "deleted") return "删除";
  return "更新";
}

/**
 * 无基线降级：工具参数预览无法判定「回合初是否存在」，
 * write/edit 一律标「更新」，勿用写入/编辑冒充用户语义。
 */
function previewKindLabel(change: FileChangePreview): string {
  if (change.kind === "delete") return "删除";
  if (change.kind === "move") return "移动";
  return "更新";
}

function writeModeLabel(mode: "overwrite" | "append"): string {
  if (mode === "append") return "追加";
  return "更新";
}

function diffSign(type: DiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "del") return "-";
  return " ";
}

function summarizeLineDiff(
  oldText: string,
  newText: string,
): {
  lines: DiffLine[];
  adds: number;
  dels: number;
} {
  const lines = lineDiff(oldText, newText);
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.type === "add") adds += 1;
    else if (l.type === "del") dels += 1;
  }
  return { lines, adds, dels };
}

function DiffBody({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="tfc-diff">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: stable positional diff rows
          key={i}
          className={`tfc-diff-row tfc-diff-${l.type}`}
        >
          <span className="tfc-diff-sign">{diffSign(l.type)}</span>
          <span className="tfc-diff-text">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function WriteBody({ content }: { content: string }) {
  const allLines = content.split("\n");
  const shown = allLines.slice(0, WRITE_PREVIEW_LINES);
  const hidden = allLines.length - shown.length;
  return (
    <div className="tfc-write">
      <div className="tfc-write-body">
        {shown.map((line, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional preview
            key={i}
            className="tfc-write-row"
          >
            <span className="tfc-write-ln">{i + 1}</span>
            <span className="tfc-write-text">{line || " "}</span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <div className="tfc-write-more">
          … 还有 {hidden} 行（共 {allLines.length} 行）
        </div>
      )}
    </div>
  );
}

function MetaBody({ detail }: { detail: string }) {
  return <div className="tfc-meta">{detail}</div>;
}

function FileChangeChrome({
  path,
  open,
  onToggle,
  trailing,
}: {
  path: string;
  open: boolean;
  onToggle: () => void;
  trailing: ReactNode;
}) {
  return (
    <button type="button" className="tfc-chrome" onClick={onToggle}>
      {open ? (
        <ChevronDown size={12} className="tfc-chrome-chevron" aria-hidden />
      ) : (
        <ChevronRight size={12} className="tfc-chrome-chevron" aria-hidden />
      )}
      <span className="tfc-chrome-path" title={path}>
        {path}
      </span>
      <span className="tfc-chrome-trail">{trailing}</span>
    </button>
  );
}

function EditTrailing({
  adds,
  dels,
  label,
}: { adds: number; dels: number; label: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="tfc-add">+{adds}</span>
      <span className="tfc-del">-{dels}</span>
    </>
  );
}

function ArtifactChangeRow({ artifact }: { artifact: FileArtifact }) {
  const [open, setOpen] = useState(false);
  const change = artifact.change;
  const editDiff = useMemo(() => {
    if (!change || change.kind !== "edit") return null;
    return summarizeLineDiff(change.oldText, change.newText);
  }, [change]);

  if (!change) {
    return (
      <div className="tfc-bare">
        <span className="tfc-bare-path">{artifact.path}</span>
        <span className="tfc-bare-sep">·</span>
        无参数侧预览（可打开工作区查看终态）
      </div>
    );
  }

  const label = previewKindLabel(change);
  let trailing: ReactNode = label;
  if (change.kind === "edit" && editDiff) {
    trailing = (
      <EditTrailing adds={editDiff.adds} dels={editDiff.dels} label={label} />
    );
  } else if (change.kind === "write") {
    const lines = change.content.split("\n").length;
    trailing = (
      <>
        <span>{writeModeLabel(change.mode)}</span>
        <span>{lines} 行</span>
      </>
    );
  }

  return (
    <div className="tfc-row">
      <FileChangeChrome
        path={artifact.path}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        trailing={trailing}
      />
      {open && change.kind === "edit" && editDiff && (
        <DiffBody lines={editDiff.lines} />
      )}
      {open && change.kind === "write" && (
        <WriteBody content={change.content} />
      )}
      {open && change.kind === "delete" && <MetaBody detail="已删除" />}
      {open && change.kind === "move" && (
        <MetaBody
          detail={`移动：${change.fromPath || "?"} → ${artifact.path}`}
        />
      )}
    </div>
  );
}

function TrueDiffRow({ change }: { change: TurnFileChange }) {
  const [open, setOpen] = useState(false);
  const editDiff = useMemo(() => {
    if (
      change.changeType !== "modified" ||
      change.isBinary ||
      change.baseContent == null ||
      change.content == null
    ) {
      return null;
    }
    return summarizeLineDiff(change.baseContent, change.content);
  }, [change]);

  const label = turnChangeLabel(change.changeType);
  let trailing: ReactNode = label;
  if (editDiff) {
    trailing = (
      <EditTrailing adds={editDiff.adds} dels={editDiff.dels} label={label} />
    );
  } else if (
    change.changeType === "added" &&
    !change.isBinary &&
    change.content != null
  ) {
    const lines = change.content.split("\n").length;
    trailing = (
      <>
        <span>{label}</span>
        <span>{lines} 行</span>
      </>
    );
  }

  return (
    <div className="tfc-row">
      <FileChangeChrome
        path={change.path}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        trailing={trailing}
      />
      {open && editDiff && <DiffBody lines={editDiff.lines} />}
      {open &&
        change.changeType === "added" &&
        !change.isBinary &&
        change.content != null && <WriteBody content={change.content} />}
      {open && change.changeType === "deleted" && <MetaBody detail="已删除" />}
      {open && change.isBinary && change.changeType !== "deleted" && (
        <div className="tfc-meta">
          二进制文件（{change.sizeBytes} 字节）— 请在工作区打开查看
        </div>
      )}
    </div>
  );
}

function ToolArgFallback({ artifacts }: { artifacts: FileArtifact[] }) {
  return (
    <>
      <p className="tfc-hint">
        改动已写入工作区。以下为工具参数侧预览（非云→本地「应用」）。
      </p>
      {artifacts.map((a) => (
        <ArtifactChangeRow key={`${a.op}:${a.path}`} artifact={a} />
      ))}
    </>
  );
}

export function TurnFileChangesReview({
  artifacts,
  conversationId = null,
  messageId = null,
}: {
  artifacts: FileArtifact[];
  conversationId?: string | null;
  /** Assistant message id；有则尝试 A1+ 真 diff。 */
  messageId?: string | null;
}) {
  const [phase, setPhase] = useState<"loading" | "true" | "fallback">(
    conversationId && messageId ? "loading" : "fallback",
  );
  const [trueChanges, setTrueChanges] = useState<TurnFileChange[] | null>(null);
  const [baselineSnapshotId, setBaselineSnapshotId] = useState<string | null>(
    null,
  );
  const [counts, setCounts] = useState<{
    added: number;
    modified: number;
    deleted: number;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is an intentional re-run key after rollback
  useEffect(() => {
    if (!conversationId || !messageId) {
      setPhase("fallback");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    void getTurnFilesDiff(conversationId, messageId)
      .then((diff) => {
        if (cancelled) return;
        if (diff.available) {
          setTrueChanges(diff.changes);
          setBaselineSnapshotId(diff.baselineSnapshotId);
          setCounts({
            added: diff.added,
            modified: diff.modified,
            deleted: diff.deleted,
          });
          setPhase("true");
        } else {
          setBaselineSnapshotId(null);
          setPhase("fallback");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBaselineSnapshotId(null);
          setPhase("fallback");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId, reloadToken]);

  const onRollback = async () => {
    if (!conversationId || !baselineSnapshotId || restoring) return;
    const confirmMsg = `${BASELINE_RESTORE_HINT}。将覆盖当前工作区内基线所含文件，确定继续？`;
    if (!window.confirm(confirmMsg)) return;
    setRestoring(true);
    setStatusMsg(null);
    try {
      await restoreSnapshot(conversationId, baselineSnapshotId);
      setStatusMsg("已尽力恢复到本回合开始");
      setReloadToken((n) => n + 1);
    } catch (e) {
      setStatusMsg(e instanceof Error ? `恢复失败：${e.message}` : "恢复失败");
    } finally {
      setRestoring(false);
    }
  };

  if (artifacts.length === 0 && phase !== "true" && phase !== "loading") {
    return null;
  }

  return (
    <div className="tfc-review">
      {phase === "loading" && (
        <div className="tfc-loading">
          <Loader2 size={13} className="tfc-spin" aria-hidden />
          正在读取相对基线的改动…
        </div>
      )}
      {phase === "true" && trueChanges && (
        <>
          <div className="tfc-true-head">
            <p className="tfc-hint">
              相对本回合开始时的工作区基线（只读 overlay；非云→本地应用）。
              {counts && (
                <span className="tfc-counts">
                  <span className="tfc-add">+{counts.added}</span>
                  <span className="tfc-mod">~{counts.modified}</span>
                  <span className="tfc-del">-{counts.deleted}</span>
                </span>
              )}
            </p>
            {baselineSnapshotId && conversationId && (
              <button
                type="button"
                className="tfc-restore"
                disabled={restoring}
                onClick={() => void onRollback()}
                aria-label="恢复到本回合开始"
                title={BASELINE_RESTORE_HINT}
              >
                {restoring ? (
                  <Loader2 size={13} className="tfc-spin" aria-hidden />
                ) : (
                  <RotateCcw size={13} aria-hidden />
                )}
                恢复到本回合开始
              </button>
            )}
          </div>
          {trueChanges.length === 0 ? (
            <p className="tfc-hint">相对基线无文件差异。</p>
          ) : (
            trueChanges.map((c) => (
              <TrueDiffRow key={`${c.changeType}:${c.path}`} change={c} />
            ))
          )}
        </>
      )}
      {phase === "fallback" && <ToolArgFallback artifacts={artifacts} />}
      {statusMsg && <p className="tfc-status">{statusMsg}</p>}
    </div>
  );
}
