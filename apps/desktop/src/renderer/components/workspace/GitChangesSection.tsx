/**
 * U2/U3：「改动」tab 内 Git 轨 —— staged/unstaged 列表 + stage/commit/push/pull。
 * 与回合 zip 轨正交；冲突仅诚实横幅 + 打开文件（否决三方 merge UI）。
 */
import { Button, Textarea } from "@/components/ui";
import type { PresentGitRepoStatus } from "@/lib/gitRepoStatus";
import {
  gitCommit,
  gitDiffText,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
} from "@/lib/gitScm";
import { repoPathToWorkspaceRel } from "@/lib/repoPathToWorkspaceRel";
import { notifyInfo } from "@/lib/toast";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { GitChangeEntry } from "@shared/ipc-contract";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";
import { useCallback, useState } from "react";

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function parseUnifiedDiff(
  text: string,
): { type: "add" | "del" | "context"; text: string }[] {
  const rows: { type: "add" | "del" | "context"; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("@@")
    ) {
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({ type: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      rows.push({ type: "del", text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      rows.push({
        type: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
    } else {
      rows.push({ type: "context", text: raw });
    }
  }
  return rows;
}

function DiffPreview({ text }: { text: string }) {
  const rows = parseUnifiedDiff(text);
  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">无差异</p>;
  }
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-border font-mono text-xs leading-relaxed">
      {rows.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
          key={i}
          className={`flex ${
            l.type === "add"
              ? "bg-success/10 text-foreground"
              : l.type === "del"
                ? "bg-destructive/10 text-foreground"
                : "text-muted-foreground"
          }`}
        >
          <span className="w-5 shrink-0 select-none text-center text-muted-foreground/50">
            {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
          </span>
          <span className="whitespace-pre-wrap break-words pr-2">
            {l.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChangeRow({
  entry,
  staged,
  rootId,
  onMutated,
}: {
  entry: GitChangeEntry;
  staged: boolean;
  rootId: string;
  onMutated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggleDiff = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (diff != null) return;
    setLoadingDiff(true);
    const text = await gitDiffText(rootId, entry.path, staged);
    setDiff(text ?? "");
    setLoadingDiff(false);
  }, [open, diff, rootId, entry.path, staged]);

  const onToggleStage = useCallback(async () => {
    setBusy(true);
    const ok = staged
      ? await gitUnstage(rootId, [entry.path])
      : await gitStage(rootId, [entry.path]);
    setBusy(false);
    if (ok) onMutated();
  }, [staged, rootId, entry.path, onMutated]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs hover:text-foreground"
          onClick={() => void toggleDiff()}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="shrink-0 font-mono text-muted-foreground">
            {entry.code.trim() || "·"}
          </span>
          <span className="min-w-0 truncate" title={entry.path}>
            {entry.path}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-1.5"
          disabled={busy}
          onClick={() => void onToggleStage()}
          aria-label={staged ? "取消暂存" : "暂存"}
          title={staged ? "取消暂存" : "暂存"}
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : staged ? (
            <Minus size={12} />
          ) : (
            <Plus size={12} />
          )}
        </Button>
      </div>
      {open && (
        <div className="px-2 pb-2">
          {loadingDiff ? (
            <p className="text-xs text-muted-foreground">读取 diff…</p>
          ) : (
            <DiffPreview text={diff ?? ""} />
          )}
        </div>
      )}
    </div>
  );
}

export function GitChangesSection({
  rootId,
  status,
  onRefresh,
  subpath = "",
}: {
  rootId: string;
  status: PresentGitRepoStatus;
  onRefresh: () => void;
  /** Workspace subpath under the container root; git paths stay repo-root relative. */
  subpath?: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | "pull" | null>(null);
  const openFileTab = useSidePanelStore((s) => s.openFileTab);

  const openRepoFile = useCallback(
    (repoPath: string) => {
      const wsRel = repoPathToWorkspaceRel(repoPath, subpath);
      if (wsRel == null) {
        notifyInfo("该文件不在当前工作区内", { description: repoPath });
        return;
      }
      openFileTab(wsRel, basename(wsRel) || basename(repoPath));
    },
    [subpath, openFileTab],
  );

  const hasStaged = status.staged.length > 0;
  const hasUnstaged = status.unstaged.length > 0;
  const hasConflict = status.conflicted.length > 0;

  const onCommit = async () => {
    const msg = message.trim();
    if (!msg || !hasStaged) return;
    setBusy("commit");
    const ok = await gitCommit(rootId, msg);
    setBusy(null);
    if (ok) {
      setMessage("");
      onRefresh();
    }
  };

  const onPush = async () => {
    setBusy("push");
    const ok = await gitPush(rootId);
    setBusy(null);
    if (ok) onRefresh();
  };

  const onPull = async () => {
    setBusy("pull");
    const ok = await gitPull(rootId);
    setBusy(null);
    if (ok) onRefresh();
  };

  return (
    <section
      className="rounded-xl border border-border bg-card"
      data-testid="git-changes-section"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <GitBranch size={12} className="shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          Git · {status.branch}
          {status.ahead > 0 || status.behind > 0 ? (
            <span className="ml-2 tabular-nums text-muted-foreground/80">
              {status.ahead > 0 ? `↑${status.ahead}` : ""}
              {status.ahead > 0 && status.behind > 0 ? " " : ""}
              {status.behind > 0 ? `↓${status.behind}` : ""}
            </span>
          ) : null}
        </h3>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy !== null}
            onClick={() => void onPull()}
          >
            {busy === "pull" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              "Pull"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy !== null}
            onClick={() => void onPush()}
          >
            {busy === "push" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              "Push"
            )}
          </Button>
        </div>
      </header>

      {hasConflict ? (
        <output
          className="block border-b border-border bg-warning/10 px-3 py-2 text-xs text-foreground"
          data-testid="git-conflict-banner"
        >
          <p className="font-medium">存在合并冲突</p>
          <p className="mt-0.5 text-muted-foreground">
            请打开文件手动解决后暂存提交（不做三方合并 UI）。
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {status.conflicted.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className="text-left text-primary underline-offset-2 hover:underline"
                  onClick={() => openRepoFile(p)}
                >
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </output>
      ) : null}

      {hasStaged ? (
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs text-muted-foreground">
              已暂存 · {status.staged.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() =>
                void gitUnstage(rootId).then((ok) => ok && onRefresh())
              }
            >
              全部取消
            </Button>
          </div>
          {status.staged.map((e) => (
            <ChangeRow
              key={`s:${e.path}:${e.code}`}
              entry={e}
              staged
              rootId={rootId}
              onMutated={onRefresh}
            />
          ))}
        </div>
      ) : null}

      {hasUnstaged ? (
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs text-muted-foreground">
              未暂存 · {status.unstaged.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() =>
                void gitStage(rootId).then((ok) => ok && onRefresh())
              }
            >
              全部暂存
            </Button>
          </div>
          {status.unstaged.map((e) => (
            <ChangeRow
              key={`u:${e.path}:${e.code}`}
              entry={e}
              staged={false}
              rootId={rootId}
              onMutated={onRefresh}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2 p-3">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="提交说明"
          rows={2}
          className="min-h-0 resize-none text-xs"
          disabled={busy !== null}
          data-testid="git-commit-message"
        />
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={!hasStaged || !message.trim() || busy !== null}
          onClick={() => void onCommit()}
          data-testid="git-commit-button"
        >
          {busy === "commit" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            "提交"
          )}
        </Button>
      </div>
    </section>
  );
}
