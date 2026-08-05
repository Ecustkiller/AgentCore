/**
 * U2/U3：「改动」tab 内 Git 轨 —— staged/unstaged 列表 + stage/commit/push/pull/fetch。
 * 与回合 zip 轨正交；冲突仅诚实横幅 + 打开文件（否决三方 merge UI）。
 */
import { Button, Textarea } from "@/components/ui";
import type { PresentGitRepoStatus } from "@/lib/gitRepoStatus";
import {
  deleteUntrackedFiles,
  gitCommit,
  gitDiffText,
  gitDiscard,
  gitFetch,
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
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useState } from "react";

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function splitRepoPath(path: string): { dir: string; name: string } {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i), name: norm.slice(i + 1) };
}

/** Porcelain XY → 主状态字母（列表侧已拆成 staged/unstaged）。 */
export function primaryStatusChar(code: string): string {
  const c = (code.length >= 2 ? code : `${code} `).slice(0, 2);
  if (c === "??") return "?";
  if (c[0] !== " ") return c[0];
  if (c[1] !== " ") return c[1];
  return (code.trim()[0] ?? "·").toUpperCase();
}

/** 行业 SCM：M 警示色 / A·? 成功色 / D 破坏色。 */
export function statusCharClass(ch: string): string {
  switch (ch) {
    case "M":
      return "text-warning";
    case "A":
    case "?":
      return "text-success";
    case "D":
      return "text-destructive";
    case "R":
    case "C":
      return "text-primary";
    case "U":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

/** 仅未暂存已跟踪文件可 discard（未跟踪需 clean，产品禁）。 */
export function canDiscardChange(
  entry: GitChangeEntry,
  staged: boolean,
): boolean {
  if (staged) return false;
  return primaryStatusChar(entry.code) !== "?";
}

export function isUntrackedChange(entry: GitChangeEntry): boolean {
  return primaryStatusChar(entry.code) === "?";
}

/** 按父目录分组（仓根文件 dir=""）；目录按 localeCompare，根文件置顶。 */
export function groupGitChangesByDir(
  entries: GitChangeEntry[],
): { dir: string; entries: GitChangeEntry[] }[] {
  const map = new Map<string, GitChangeEntry[]>();
  for (const e of entries) {
    const { dir } = splitRepoPath(e.path);
    const list = map.get(dir);
    if (list) list.push(e);
    else map.set(dir, [e]);
  }
  const dirs = [...map.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });
  return dirs.map((dir) => ({
    dir,
    entries: map.get(dir) ?? [],
  }));
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
  subpath,
  onMutated,
  onOpenFile,
  hideDir = false,
}: {
  entry: GitChangeEntry;
  staged: boolean;
  rootId: string;
  subpath: string;
  onMutated: () => void;
  onOpenFile: (repoPath: string) => void;
  /** 目录分组标题已展示时隐藏行内目录。 */
  hideDir?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const { dir, name } = splitRepoPath(entry.path);
  const statusCh = primaryStatusChar(entry.code);
  const untracked = isUntrackedChange(entry);
  const showDiscard = canDiscardChange(entry, staged);

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

  const onDiscard = useCallback(async () => {
    setBusy(true);
    const ok = await gitDiscard(rootId, entry.path);
    setBusy(false);
    if (ok) onMutated();
  }, [rootId, entry.path, onMutated]);

  const onDeleteUntracked = useCallback(async () => {
    const wsRel = repoPathToWorkspaceRel(entry.path, subpath);
    if (wsRel == null || wsRel === "") {
      notifyInfo("该文件不在当前工作区内", { description: entry.path });
      return;
    }
    setBusy(true);
    const ok = await deleteUntrackedFiles(rootId, [wsRel]);
    setBusy(false);
    if (ok) onMutated();
  }, [rootId, entry.path, subpath, onMutated]);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="group flex items-center gap-0.5 px-2 py-0.5">
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void toggleDiff()}
          aria-expanded={open}
          aria-label={open ? "收起差异" : "展开差异"}
          title={open ? "收起差异" : "展开差异"}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span
          className={`w-3.5 shrink-0 text-center font-mono text-xs font-medium leading-none ${statusCharClass(statusCh)}`}
          title={entry.code}
        >
          {statusCh}
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-xs hover:text-foreground"
          onClick={() => onOpenFile(entry.path)}
          title={entry.path}
        >
          <span className="min-w-0 truncate text-foreground">{name}</span>
          {!hideDir && dir ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground/80">
              {dir}
            </span>
          ) : null}
        </button>
        {!staged && untracked ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={busy}
            onClick={() => void onDeleteUntracked()}
            aria-label="删除未跟踪文件"
            title="移入系统回收站"
          >
            <Trash2 size={12} className="text-muted-foreground" />
          </Button>
        ) : showDiscard ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={busy}
            onClick={() => void onDiscard()}
            aria-label="丢弃改动"
            title="丢弃未暂存改动"
          >
            <Undo2 size={12} className="text-muted-foreground" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1 opacity-70 group-hover:opacity-100"
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
        <div className="px-2 pb-2 pl-7">
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

function ChangeGroupList({
  entries,
  staged,
  rootId,
  subpath,
  onMutated,
  onOpenFile,
  keyPrefix,
}: {
  entries: GitChangeEntry[];
  staged: boolean;
  rootId: string;
  subpath: string;
  onMutated: () => void;
  onOpenFile: (repoPath: string) => void;
  keyPrefix: string;
}) {
  const groups = groupGitChangesByDir(entries);
  const multiGroup = groups.length > 1;

  return (
    <>
      {groups.map((g) => {
        const showHeader = Boolean(g.dir) || multiGroup;
        const paths = g.entries.map((e) => e.path);
        const discardable = g.entries.filter((e) =>
          canDiscardChange(e, staged),
        );
        const untracked = g.entries.filter((e) => isUntrackedChange(e));

        return (
          <div key={`${keyPrefix}:${g.dir || "."}`} className="group/dir">
            {showHeader ? (
              <div className="flex items-center gap-0.5 px-2 py-0.5">
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70"
                  title={g.dir || "仓根"}
                >
                  {g.dir || "仓根"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 shrink-0 px-1 opacity-0 group-hover/dir:opacity-100 focus-visible:opacity-100"
                  onClick={() =>
                    void (
                      staged
                        ? gitUnstage(rootId, paths)
                        : gitStage(rootId, paths)
                    ).then((ok) => ok && onMutated())
                  }
                  aria-label={staged ? "取消暂存本组" : "暂存本组"}
                  title={staged ? "取消暂存本组" : "暂存本组"}
                >
                  {staged ? <Minus size={11} /> : <Plus size={11} />}
                </Button>
                {!staged && discardable.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 shrink-0 px-1 opacity-0 group-hover/dir:opacity-100 focus-visible:opacity-100"
                    onClick={() =>
                      void gitDiscard(
                        rootId,
                        discardable.map((e) => e.path),
                      ).then((ok) => ok && onMutated())
                    }
                    aria-label="丢弃本组改动"
                    title="丢弃本组未暂存改动"
                  >
                    <Undo2 size={11} className="text-muted-foreground" />
                  </Button>
                ) : null}
                {!staged && untracked.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 shrink-0 px-1 opacity-0 group-hover/dir:opacity-100 focus-visible:opacity-100"
                    onClick={() => {
                      const rels = untracked
                        .map((e) => repoPathToWorkspaceRel(e.path, subpath))
                        .filter((p): p is string => p != null && p !== "");
                      void deleteUntrackedFiles(rootId, rels).then(
                        (ok) => ok && onMutated(),
                      );
                    }}
                    aria-label="删除本组未跟踪文件"
                    title="本组未跟踪文件移入回收站"
                  >
                    <Trash2 size={11} className="text-muted-foreground" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            {g.entries.map((e) => (
              <ChangeRow
                key={`${keyPrefix}:${e.path}:${e.code}`}
                entry={e}
                staged={staged}
                rootId={rootId}
                subpath={subpath}
                onMutated={onMutated}
                onOpenFile={onOpenFile}
                hideDir={showHeader}
              />
            ))}
          </div>
        );
      })}
    </>
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
  const [busy, setBusy] = useState<"commit" | "push" | "pull" | "fetch" | null>(
    null,
  );
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
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
  const discardableUnstaged = status.unstaged.filter((e) =>
    canDiscardChange(e, false),
  );

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

  const onFetch = async () => {
    setBusy("fetch");
    const ok = await gitFetch(rootId);
    setBusy(null);
    if (ok) onRefresh();
  };

  return (
    <section
      className="rounded-xl border border-border bg-card"
      data-testid="git-changes-section"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
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
        <div className="flex shrink-0 gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            disabled={busy !== null}
            onClick={() => void onFetch()}
            title="获取远端（不合并）"
          >
            {busy === "fetch" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              "Fetch"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
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
            className="h-6 px-1.5 text-xs"
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
                  {basename(p)}
                  {p.includes("/") ? (
                    <span className="ml-1 text-muted-foreground">
                      {p.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </output>
      ) : null}

      {/* Commit 置顶：对齐 VS Code / JetBrains SCM 工作流入口 */}
      <div className="space-y-1.5 border-b border-border p-2.5">
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
          className="h-7 w-full"
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

      {hasStaged ? (
        <div className="border-b border-border">
          <div className="flex items-center gap-1 px-1.5 py-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-left hover:bg-muted/60"
              onClick={() => setStagedOpen((v) => !v)}
              aria-expanded={stagedOpen}
            >
              {stagedOpen ? (
                <ChevronDown
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <ChevronRight
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <span className="text-xs text-muted-foreground">
                已暂存 · {status.staged.length}
              </span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-xs"
              onClick={() =>
                void gitUnstage(rootId).then((ok) => ok && onRefresh())
              }
            >
              全部取消
            </Button>
          </div>
          {stagedOpen ? (
            <ChangeGroupList
              entries={status.staged}
              staged
              rootId={rootId}
              subpath={subpath}
              onMutated={onRefresh}
              onOpenFile={openRepoFile}
              keyPrefix="s"
            />
          ) : null}
        </div>
      ) : null}

      {hasUnstaged ? (
        <div>
          <div className="flex items-center gap-1 px-1.5 py-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-left hover:bg-muted/60"
              onClick={() => setUnstagedOpen((v) => !v)}
              aria-expanded={unstagedOpen}
            >
              {unstagedOpen ? (
                <ChevronDown
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <ChevronRight
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <span className="text-xs text-muted-foreground">
                未暂存 · {status.unstaged.length}
              </span>
            </button>
            {discardableUnstaged.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-1.5 text-xs"
                onClick={() =>
                  void gitDiscard(
                    rootId,
                    discardableUnstaged.map((e) => e.path),
                  ).then((ok) => ok && onRefresh())
                }
                title="丢弃全部已跟踪的未暂存改动"
              >
                全部丢弃
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-xs"
              onClick={() =>
                void gitStage(rootId).then((ok) => ok && onRefresh())
              }
            >
              全部暂存
            </Button>
          </div>
          {unstagedOpen ? (
            <ChangeGroupList
              entries={status.unstaged}
              staged={false}
              rootId={rootId}
              subpath={subpath}
              onMutated={onRefresh}
              onOpenFile={openRepoFile}
              keyPrefix="u"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
